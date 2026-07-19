import { describe, expect, it } from "vitest";
import { isAllowedSocketOrigin, isAuthorizedSocketRequest } from "../src/socket-origin.js";
import { TerminalService, type TerminalEvent } from "../src/terminal-service.js";

describe("terminal service", () => {
  it("keeps a workspace shell alive and streams command output", async () => {
    const events: TerminalEvent[] = [];
    const service = new TerminalService();
    const session = service.start(process.cwd(), (event) => events.push(event));

    service.write(session.sessionId, process.platform === "win32" ? "Write-Output KIMI_TERMINAL_OK" : "printf 'KIMI_TERMINAL_OK\\n'");
    await waitFor(() => events.some((event) => event.text?.includes("KIMI_TERMINAL_OK")) === true);

    expect(session.cwd).toBe(process.cwd());
    expect(events.some((event) => event.type === "stdout")).toBe(true);
    service.stop(session.sessionId);
  });

  it("accepts the desktop origins but rejects arbitrary browser pages", () => {
    expect(isAllowedSocketOrigin(undefined)).toBe(false);
    expect(isAllowedSocketOrigin("http://tauri.localhost")).toBe(true);
    expect(isAllowedSocketOrigin("http://127.0.0.1:1420")).toBe(true);
    expect(isAllowedSocketOrigin("https://example.com")).toBe(false);
    expect(isAllowedSocketOrigin("http://localhost:3000")).toBe(false);
    expect(isAuthorizedSocketRequest("http://tauri.localhost", "/?token=correct", "correct")).toBe(true);
    expect(isAuthorizedSocketRequest("http://tauri.localhost", "/?token=wrong", "correct")).toBe(false);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
