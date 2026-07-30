import { describe, expect, it } from "vitest";
import { isAllowedSocketOrigin, isAuthorizedSocketRequest } from "../src/socket-origin.js";
import { TerminalService, terminateWindowsTree, type TerminalEvent } from "../src/terminal-service.js";

describe("terminal service", () => {
  it("keeps a workspace shell alive and streams command output", async () => {
    const events: TerminalEvent[] = [];
    const service = new TerminalService();
    const session = service.start(process.cwd(), (event) => events.push(event));
    expect(service.activeCount).toBe(1);

    service.write(session.sessionId, process.platform === "win32" ? "Write-Output KIMI_TERMINAL_OK" : "printf 'KIMI_TERMINAL_OK\\n'");
    await waitFor(() => events.some((event) => event.text?.includes("KIMI_TERMINAL_OK")) === true);

    expect(session.cwd).toBe(process.cwd());
    expect(events.some((event) => event.type === "stdout")).toBe(true);
    const stopped = service.stop(session.sessionId);
    expect(service.activeCount).toBe(1);
    await stopped;
    expect(service.activeCount).toBe(0);
  }, 30_000);

  it("terminates the app-owned shell process tree before becoming inactive", async () => {
    const events: TerminalEvent[] = [];
    const service = new TerminalService();
    const session = service.start(process.cwd(), (event) => events.push(event));
    service.write(
      session.sessionId,
      process.platform === "win32"
        ? "$child = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30' -PassThru; Write-Output \"TREE_PID=$($child.Id)\""
        : "sleep 30 & echo TREE_PID=$!",
    );
    await waitFor(() => events.some((event) => event.text?.includes("TREE_PID=")) === true);
    const pid = Number(events.map((event) => event.text).join("").match(/TREE_PID=(\d+)/)?.[1]);
    expect(Number.isSafeInteger(pid)).toBe(true);
    expect(processExists(pid)).toBe(true);

    const stopped = service.stop(session.sessionId);
    expect(service.activeCount).toBe(1);
    await stopped;

    expect(service.activeCount).toBe(0);
    expect(processExists(pid)).toBe(false);
  }, 30_000);

  it("accepts a child exit that wins the Windows termination race", async () => {
    let exitCodeReads = 0;
    const child = {
      pid: 1,
      get exitCode() {
        exitCodeReads += 1;
        return exitCodeReads > 1 ? 0 : null;
      },
      signalCode: null,
    } as unknown as import("node:child_process").ChildProcess;

    await expect(terminateWindowsTree(child)).resolves.toBe(true);
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
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal output");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
