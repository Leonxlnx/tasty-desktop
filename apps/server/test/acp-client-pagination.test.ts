import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Session = { sessionId: string; cwd: string; title: string };
type Page = { sessions: Session[]; nextCursor?: string | null };

const spawnMock = vi.hoisted(() => vi.fn());
const sdkState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  pages: [] as Page[],
}));

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

    listSessions(params: Record<string, unknown>) {
      sdkState.calls.push(params);
      const page = sdkState.pages.shift();
      if (!page) throw new Error("Missing session-list test page");
      return Promise.resolve(page);
    }
  },
  ndJsonStream: () => ({}),
}));

import { AcpClient } from "../src/acp-client.js";

class ExitedChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 100;
  readonly exitCode = 0;
  readonly signalCode = null;
}

describe("ACP session pagination", () => {
  beforeEach(() => {
    sdkState.calls.length = 0;
    sdkState.pages.length = 0;
    spawnMock.mockReset().mockImplementation(() => new ExitedChild());
  });

  it("aggregates finite pages in order", async () => {
    sdkState.pages.push(
      { sessions: [session("one")], nextCursor: "next" },
      { sessions: [session("two")] },
    );
    const client = createClient();
    try {
      await client.start();
      await expect(client.listSessions()).resolves.toEqual({ sessions: [session("one"), session("two")] });
      expect(sdkState.calls).toEqual([{}, { cursor: "next" }]);
    } finally {
      await client.close();
    }
  });

  it("rejects a repeated pagination cursor", async () => {
    sdkState.pages.push(
      { sessions: [], nextCursor: "same" },
      { sessions: [], nextCursor: "same" },
    );
    const client = createClient();
    try {
      await client.start();
      await expect(client.listSessions()).rejects.toThrow("ACP session/list returned a repeated cursor");
    } finally {
      await client.close();
    }
  });

  it("caps pagination at one hundred pages", async () => {
    sdkState.pages.push(...Array.from({ length: 100 }, (_, index) => ({
      sessions: [],
      nextCursor: `cursor-${index}`,
    })));
    const client = createClient();
    try {
      await client.start();
      await expect(client.listSessions()).rejects.toThrow("ACP session/list exceeded 100 pages");
      expect(sdkState.calls).toHaveLength(100);
    } finally {
      await client.close();
    }
  });

  it("caps the aggregate before retaining excessive session results", async () => {
    sdkState.pages.push({
      sessions: Array.from({ length: 10_001 }, (_, index) => session(String(index))),
    });
    const client = createClient();
    try {
      await client.start();
      await expect(client.listSessions()).rejects.toThrow("ACP session/list exceeded 10000 sessions");
    } finally {
      await client.close();
    }
  });
});

function createClient(): AcpClient {
  return new AcpClient({ binary: process.execPath, onEvent: () => undefined });
}

function session(sessionId: string): Session {
  return { sessionId, cwd: process.cwd(), title: sessionId };
}
