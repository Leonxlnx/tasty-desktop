import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  AuthService,
  clearKimiCredentials,
  hasKimiCredentials,
  KIMI_INSTALL_URL,
  parseLoginLine,
  terminateAuthProcess,
} from "../src/auth-service.js";

function fakeAuthProcess(killResult = true) {
  return Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal?: number | NodeJS.Signals) => killResult),
  });
}

describe("AuthService", () => {
  it("extracts device pairing URLs and codes without reading credentials", () => {
    expect(parseLoginLine("Visit https://auth.kimi.com/device and enter code ABCD-EFGH")).toEqual({
      message: "Visit https://auth.kimi.com/device and enter code ABCD-EFGH",
      url: "https://auth.kimi.com/device",
      code: "ABCD-EFGH",
    });
  });

  it("detects credential presence only from filesystem metadata", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-auth-"));
    expect(hasKimiCredentials(home)).toBe(false);
    await mkdir(join(home, "credentials"));
    await writeFile(join(home, "credentials", "kimi-code.json"), "secret");
    await writeFile(join(home, "credentials", "mcp-auth.json"), "keep me");
    expect(hasKimiCredentials(home)).toBe(true);
    expect(new AuthService("kimi", home, () => undefined).status()).toMatchObject({ installed: false, authenticated: true, loginRunning: false });
    clearKimiCredentials(home);
    expect(hasKimiCredentials(home)).toBe(false);
    expect(await import("node:fs/promises").then(({ readFile }) => readFile(join(home, "credentials", "mcp-auth.json"), "utf8"))).toBe("keep me");
  });

  it("returns official manual installation guidance without executing remote code", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-auth-manual-install-"));
    const events: unknown[] = [];
    const service = new AuthService(join(home, "missing-kimi.exe"), home, (event) => events.push(event));
    expect(service.beginInstall()).toMatchObject({
      installed: false,
      installRunning: false,
      installMode: "manual",
      installUrl: KIMI_INSTALL_URL,
    });
    expect(events).toEqual([]);
    await writeFile(join(home, "missing-kimi.exe"), "installed");
    expect(service.beginInstall()).toMatchObject({ installed: true, installRunning: false });
  });

  it("only completes auth shutdown after exit and rejects errors, failed signals, and timeouts", async () => {
    const exiting = fakeAuthProcess();
    const exitingClose = terminateAuthProcess(exiting, 50);
    let completed = false;
    void exitingClose.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);
    exiting.exitCode = 0;
    exiting.emit("exit", 0, null);
    await expect(exitingClose).resolves.toBeUndefined();
    expect(exiting.kill).toHaveBeenCalledOnce();

    const errored = fakeAuthProcess();
    const erroredClose = terminateAuthProcess(errored, 50);
    errored.emit("error", new Error("spawn failure"));
    await expect(erroredClose).rejects.toThrow("failed while stopping");

    const unsignalled = fakeAuthProcess(false);
    await expect(terminateAuthProcess(unsignalled, 50)).rejects.toThrow("could not be signalled");

    const stuck = fakeAuthProcess();
    await expect(terminateAuthProcess(stuck, 10)).rejects.toThrow("did not stop within 10ms");
  });
});
