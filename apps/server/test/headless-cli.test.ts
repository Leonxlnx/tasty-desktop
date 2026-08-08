import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { callRemote, loadCredentials, normalizeRemoteEndpoint, parseCli, saveCredentials } from "../src/headless-cli.js";

describe("headless CLI", () => {
  it("parses remote commands without putting credentials in URLs", () => {
    const submissionId = "01234567-89ab-4def-8123-456789abcdef";
    expect(parseCli(["send", "thread-1", "fix", "the", "tests"])).toEqual({ name: "send", threadId: "thread-1", text: "fix the tests" });
    expect(parseCli(["steer", "--submission-id", submissionId, "thread-1", "change", "direction"])).toEqual({ name: "steer", submissionId, threadId: "thread-1", text: "change direction" });
    expect(() => parseCli(["send", "--submission-id", "not-a-uuid", "thread-1", "fix"])).toThrow("--submission-id must be a UUID");
    expect(parseCli(["watch", "thread-1"])).toEqual({ name: "watch", threadId: "thread-1" });
    expect(normalizeRemoteEndpoint("wss://tasty.example/remote")).toBe("wss://tasty.example");
    expect(normalizeRemoteEndpoint("ws://localhost:4318/remote")).toBe("ws://localhost:4318");
    expect(normalizeRemoteEndpoint("ws://127.1:4318")).toBe("ws://127.0.0.1:4318");
    expect(normalizeRemoteEndpoint("ws://[::1]:4318")).toBe("ws://[::1]:4318");
    expect(() => normalizeRemoteEndpoint("ws://remote.example:4318")).toThrow("only on loopback");
    expect(() => normalizeRemoteEndpoint("ws://user:secret@host:4318?token=bad")).toThrow("plain ws:// or wss://");
    expect(parseCli(["pair", "ws://127.0.0.1:4318", "ABCD-EFGH"])).toMatchObject({ deviceName: "Kimi Code headless CLI" });
  });

  it("reconnects once after a lost ACK with the identical submission payload", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    const attempts: Array<Record<string, unknown>> = [];
    server.on("connection", (socket) => socket.once("message", (data) => {
      const payload = JSON.parse(data.toString()) as Record<string, unknown>;
      attempts.push(payload);
      if (attempts.length === 1) socket.close();
      else socket.send(JSON.stringify({ id: payload.id, result: { accepted: true } }));
    }));
    try {
      const port = (server.address() as AddressInfo).port;
      const credentials = { endpoint: `ws://127.0.0.1:${port}`, token: "headless-test-token-123456", deviceName: "test" };
      const params = { threadId: "thread", text: "run once", submissionId: "01234567-89ab-4def-8123-456789abcdef" };
      await expect(callRemote(credentials, "threads.sendTurn", params, true)).resolves.toEqual({ accepted: true });
      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("does not retry an RPC error", async () => {
    const server = new WebSocketServer({ port: 0 });
    await once(server, "listening");
    let attempts = 0;
    server.on("connection", (socket) => socket.once("message", (data) => {
      attempts += 1;
      const payload = JSON.parse(data.toString()) as { id: number };
      socket.send(JSON.stringify({ id: payload.id, error: { message: "rejected" } }));
    }));
    try {
      const port = (server.address() as AddressInfo).port;
      const credentials = { endpoint: `ws://127.0.0.1:${port}`, token: "headless-test-token-123456", deviceName: "test" };
      await expect(callRemote(credentials, "threads.sendTurn", { submissionId: "01234567-89ab-4def-8123-456789abcdef" }, true)).rejects.toThrow("rejected");
      expect(attempts).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("prefers Kimi credentials and reads legacy credentials only as a fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-headless-"));
    const current = join(directory, ".kimi-code-desktop", "headless.json");
    const legacy = join(directory, ".tasty", "headless.json");
    const oldCredentials = { endpoint: "wss://legacy.example:4318", token: "legacy-device-token-123456", deviceName: "Legacy device" };
    await mkdir(dirname(legacy), { recursive: true });
    await writeFile(legacy, JSON.stringify(oldCredentials), "utf8");
    expect(await loadCredentials(directory, {})).toEqual(oldCredentials);

    const currentCredentials = { endpoint: "wss://current.example:4318", token: "current-device-token-123456", deviceName: "Kimi device" };
    await saveCredentials(currentCredentials, directory);
    expect(await loadCredentials(directory, {})).toEqual(currentCredentials);
    expect(JSON.parse(await readFile(current, "utf8"))).toEqual(currentCredentials);

    await writeFile(current, "not json", "utf8");
    await expect(loadCredentials(directory, {})).rejects.toBeInstanceOf(SyntaxError);
  });

  it("prefers Kimi environment credentials and keeps the legacy pair as a fallback", async () => {
    const environment: NodeJS.ProcessEnv = {
      KIMI_DESKTOP_REMOTE_URL: "wss://kimi.example/remote",
      KIMI_DESKTOP_REMOTE_TOKEN: "kimi-environment-token-123456",
      TASTY_REMOTE_URL: "wss://legacy.example/remote",
      TASTY_REMOTE_TOKEN: "legacy-environment-token-123456",
    };
    expect(await loadCredentials("unused", environment)).toMatchObject({ endpoint: "wss://kimi.example", token: environment.KIMI_DESKTOP_REMOTE_TOKEN });
    delete environment.KIMI_DESKTOP_REMOTE_URL;
    delete environment.KIMI_DESKTOP_REMOTE_TOKEN;
    expect(await loadCredentials("unused", environment)).toMatchObject({ endpoint: "wss://legacy.example", token: environment.TASTY_REMOTE_TOKEN });
  });
});
