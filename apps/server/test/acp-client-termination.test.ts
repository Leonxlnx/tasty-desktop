import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("@agentclientprotocol/sdk", () => ({
  PROTOCOL_VERSION: 1,
  RequestError: class RequestError extends Error {
    constructor(readonly code: number, message: string) { super(message); }
  },
  ClientSideConnection: class ClientSideConnection {
    readonly closed = new Promise<void>(() => undefined);

    initialize() {
      return Promise.resolve({ protocolVersion: 1, agentCapabilities: { promptCapabilities: {} }, authMethods: [] });
    }
  },
  ndJsonStream: () => ({}),
}));

import { AcpClient } from "../src/acp-client.js";

type TaskkillPlan = { exitCode: number; exitTarget?: boolean; targetMissing?: boolean };

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn(() => true);

  constructor(readonly pid: number) { super(); }

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
}

describe.runIf(process.platform === "win32")("ACP Windows process-tree termination", () => {
  const children = new Map<number, FakeChild>();
  const plans: TaskkillPlan[] = [];
  let nextPid = 100;

  beforeEach(() => {
    vi.useFakeTimers();
    children.clear();
    plans.length = 0;
    nextPid = 100;
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (children.has(pid)) return true;
      throw Object.assign(new Error("No such process"), { code: "ESRCH" });
    });
    spawnMock.mockReset().mockImplementation((command: string, args: string[] = []) => {
      if (command.toLowerCase().endsWith("taskkill.exe")) {
        const killer = new FakeChild(nextPid++);
        const plan = plans.shift();
        if (!plan) throw new Error("Missing taskkill test plan");
        const target = children.get(Number(args[1]));
        setTimeout(() => {
          killer.exit(plan.exitCode);
          if (plan.exitTarget) target?.exit(0);
          if (plan.targetMissing) children.delete(Number(args[1]));
        }, 0);
        return killer;
      }
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      return child;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retains a live ACP child after taskkill fails and retries the same ownership", async () => {
    const diagnostics: string[] = [];
    const client = new AcpClient({
      binary: process.execPath,
      onEvent: (event) => event.type === "diagnostic" && diagnostics.push(event.message),
    });
    await client.start();
    const owned = [...children.values()][0]!;
    plans.push({ exitCode: 1 });

    const firstClose = client.close();
    const failedClose = expect(firstClose).rejects.toThrow("taskkill exited with code 1");
    expect(client.close()).toBe(firstClose);
    await vi.runAllTimersAsync();
    await failedClose;
    expect(owned.kill).not.toHaveBeenCalled();
    await expect(client.start()).rejects.toThrow("ACP client already started");
    expect(diagnostics).toContain("Could not terminate ACP process tree: taskkill exited with code 1");

    plans.push({ exitCode: 0, exitTarget: true });
    const retriedClose = client.close();
    await vi.runAllTimersAsync();
    await expect(retriedClose).resolves.toBeUndefined();
  });

  it("rejects taskkill success until the owned ACP child actually exits", async () => {
    const client = new AcpClient({ binary: process.execPath, onEvent: () => undefined });
    await client.start();
    plans.push({ exitCode: 0 });

    const closing = expect(client.close()).rejects.toThrow("ACP child process remained alive after taskkill succeeded");
    await vi.runAllTimersAsync();
    await closing;

    plans.push({ exitCode: 0, exitTarget: true });
    const cleanup = client.close();
    await vi.runAllTimersAsync();
    await expect(cleanup).resolves.toBeUndefined();
  });

  it("accepts taskkill exit 1 only after the owned ACP child is gone", async () => {
    const client = new AcpClient({ binary: process.execPath, onEvent: () => undefined });
    await client.start();
    plans.push({ exitCode: 1, targetMissing: true });

    const closing = client.close();
    await vi.runAllTimersAsync();
    await expect(closing).resolves.toBeUndefined();
  });
});
