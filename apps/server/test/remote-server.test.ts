import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

describe("remote server", () => {
  let child: ChildProcess | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    child?.kill();
    await new Promise((resolve) => child?.once("exit", resolve) ?? resolve(undefined));
  });

  it("pairs, limits methods, reconnects with a device token, and revokes", async () => {
    const localPort = await freePort();
    const remotePort = await freePort();
    const dataHome = await mkdtemp(join(tmpdir(), "tasty-remote-server-"));
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    child = spawn(process.execPath, ["--import", "tsx", serverPath], {
      env: { ...process.env, KIMI_FAKE: "1", KIMI_SERVER_PORT: String(localPort), KIMI_DESKTOP_HOME: dataHome },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    const local = await connect(`ws://127.0.0.1:${localPort}`, undefined, { origin: "http://127.0.0.1:1420" });
    sockets.push(local);
    await request(local, { id: 1, method: "remote.configure", params: { enabled: true, bind: "127.0.0.1", port: remotePort } });
    const pairing = await request(local, { id: 2, method: "remote.createPairing", params: {} }) as { code: string };

    const claimSocket = await connect(`ws://127.0.0.1:${remotePort}/pair`);
    sockets.push(claimSocket);
    const claimed = await request(claimSocket, { id: 3, method: "remote.claim", params: { code: pairing.code, name: "Test phone" } }) as { token: string; device: { id: string } };
    claimSocket.close();

    const remote = await connect(`ws://127.0.0.1:${remotePort}/remote`, ["tasty.remote.v1", `tasty-token.${claimed.token}`]);
    sockets.push(remote);
    const threads = await request(remote, { id: 4, method: "threads.list", params: {} }) as { threads: unknown[] };
    expect(threads.threads).toEqual([]);
    await expect(request(remote, { id: 5, method: "threads.create", params: { cwd: join(dataHome, "unapproved"), standalone: false, isolate: false, provider: "kimi" } })).rejects.toThrow("existing Kimi Code workspace");
    await expect(request(remote, { id: 6, method: "terminal.start", params: { cwd: dataHome } })).rejects.toThrow("not available to remote devices");

    const closed = new Promise<number>((resolve) => remote.once("close", (code) => resolve(code)));
    await request(local, { id: 7, method: "remote.revokeDevice", params: { deviceId: claimed.device.id } });
    await expect(closed).resolves.toBe(4003);
  }, 20_000);
});

function connect(url: string, protocols?: string[], options?: { origin: string }): Promise<WebSocket> {
  const deadline = Date.now() + 8_000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new WebSocket(url, protocols, options);
      socket.once("open", () => resolve(socket));
      socket.once("error", (error) => {
        socket.terminate();
        if (Date.now() < deadline) setTimeout(attempt, 50);
        else reject(new Error(`Timed out connecting to ${url}: ${error.message}`));
      });
    };
    attempt();
  });
}

function request(socket: WebSocket, input: { id: number; method: string; params: unknown }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`Timed out waiting for ${input.method}`)); }, 8_000);
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id !== input.id) return;
      clearTimeout(timer);
      socket.off("message", receive);
      if (message.error) reject(new Error(message.error.message ?? "Remote request failed"));
      else resolve(message.result);
    };
    socket.on("message", receive);
    socket.send(JSON.stringify(input));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
