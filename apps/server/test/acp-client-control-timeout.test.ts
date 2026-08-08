import { describe, expect, it, vi } from "vitest";

vi.mock("@agentclientprotocol/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentclientprotocol/sdk")>();
  class WedgedConnection {
    readonly closed = new Promise<void>(() => undefined);

    initialize() {
      return Promise.resolve({
        protocolVersion: actual.PROTOCOL_VERSION,
        agentCapabilities: { promptCapabilities: {} },
        authMethods: [],
      });
    }

    newSession() {
      return Promise.resolve({ sessionId: "mock-session" });
    }

    listSessions() {
      return new Promise<never>(() => undefined);
    }

    cancel() {
      return new Promise<never>(() => undefined);
    }
  }
  return {
    ...actual,
    ClientSideConnection: WedgedConnection,
    ndJsonStream: () => ({}),
  };
});

import { AcpClient } from "../src/acp-client.js";

describe("ACP control request deadlines", () => {
  it("invalidates a runtime whose session list never responds", async () => {
    const closed: number[] = [];
    const client = createClient(() => closed.push(1));
    try {
      await client.start();
      await expect(client.listSessions()).rejects.toThrow("ACP session/list timed out after 25ms");
      expect(client.isOpen()).toBe(false);
      expect(closed).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("invalidates a runtime whose cancel delivery never completes", async () => {
    const closed: number[] = [];
    const client = createClient(() => closed.push(1));
    try {
      await client.start();
      const session = await client.newSession(process.cwd());
      await expect(client.cancel(session.sessionId)).rejects.toThrow("ACP session/cancel timed out after 25ms");
      expect(client.isOpen()).toBe(false);
      expect(client.hasSession(session.sessionId)).toBe(false);
      expect(closed).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
});

function createClient(onClose: () => void): AcpClient {
  return new AcpClient({
    binary: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    controlRequestTimeoutMs: 25,
    onEvent: () => undefined,
    onClose,
  });
}
