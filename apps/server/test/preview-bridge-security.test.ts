import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";

describe("preview bridge socket isolation", () => {
  const children: ReturnType<typeof spawn>[] = [];
  const sockets: WebSocket[] = [];

  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const child of children.splice(0)) child.kill();
  });

  it("allows preview commands but denies app RPCs and global pushes", async () => {
    const port = "45135";
    const serverToken = "server-token";
    const previewToken = "preview-token";
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-preview-security-"));
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
    const child = spawn(process.execPath, ["--import", tsx, serverPath], {
      env: {
        ...process.env,
        KIMI_FAKE: "1",
        KIMI_SERVER_PORT: port,
        KIMI_SERVER_TOKEN: serverToken,
        KIMI_PREVIEW_BRIDGE_TOKEN: previewToken,
        KIMI_DESKTOP_HOME: dataHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    await waitForServer(child);

    await expect(connect(`ws://127.0.0.1:${port}?token=${serverToken}`, "https://example.com", [])).rejects.toThrow();
    await expect(connect(`ws://127.0.0.1:${port}?preview-token=wrong`, undefined, [])).rejects.toThrow();

    const appMessages: Message[] = [];
    const app = await connect(`ws://127.0.0.1:${port}?token=${serverToken}`, "http://127.0.0.1:1420", appMessages);
    sockets.push(app);
    await waitFor(app, appMessages, (message) => message.channel === "server.welcome");

    const bridgeMessages: Message[] = [];
    const bridge = await connect(`ws://127.0.0.1:${port}?preview-token=${previewToken}`, undefined, bridgeMessages);
    sockets.push(bridge);

    for (const request of [
      { id: 1, method: "threads.list", params: {} },
      { id: 2, method: "git.status", params: { cwd: process.cwd() } },
      { id: 3, method: "terminal.start", params: { cwd: process.cwd() } },
      { id: 30, method: "skills.install", params: { cwd: process.cwd(), source: process.cwd() } },
    ]) {
      bridge.send(JSON.stringify(request));
      expect(await waitFor(bridge, bridgeMessages, (message) => message.id === request.id)).toMatchObject({
        id: request.id,
        error: { code: -32601, message: "Preview bridge may only call preview.agentCommand" },
      });
    }

    bridge.send(JSON.stringify({
      id: 4,
      method: "preview.agentCommand",
      params: { action: "open", url: "localhost:4173", panelWidth: 960 },
    }));
    expect(await waitFor(bridge, bridgeMessages, (message) => message.id === 4)).toMatchObject({
      id: 4,
      result: { accepted: true, command: { action: "open", url: "http://localhost:4173/", panelWidth: 960 } },
    });
    expect(await waitFor(app, appMessages, (message) => message.channel === "preview.command")).toMatchObject({
      payload: { action: "open", url: "http://localhost:4173/", panelWidth: 960 },
    });

    bridge.send(JSON.stringify({
      id: 5,
      method: "preview.agentCommand",
      params: { action: "request_skill_install", cwd: process.cwd(), source: join(process.cwd(), "skill"), name: "example" },
    }));
    expect(await waitFor(bridge, bridgeMessages, (message) => message.id === 5)).toMatchObject({
      id: 5,
      result: { accepted: true },
    });
    expect(await waitFor(app, appMessages, (message) => message.channel === "skill.installRequested")).toMatchObject({
      payload: { action: "request_skill_install", cwd: process.cwd(), source: join(process.cwd(), "skill"), name: "example" },
    });

    expect(bridgeMessages.some((message) => "channel" in message)).toBe(false);
  });
});

type Message = Record<string, unknown>;

async function waitForServer(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) return reject(new Error("Server stdout is unavailable"));
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => chunk.includes("listening") && resolve());
    child.once("error", reject);
    child.once("exit", (code) => code && reject(new Error(`Server exited with ${code}`)));
  });
}

async function connect(url: string, origin: string | undefined, messages: Message[]): Promise<WebSocket> {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Message));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("unexpected-response", (_request, response) => reject(new Error(`Unexpected response ${response.statusCode}`)));
  });
  return socket;
}

function waitFor(socket: WebSocket, messages: Message[], predicate: (message: Message) => boolean): Promise<Message> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for WebSocket message; recent=${JSON.stringify(messages.slice(-5))}`));
    }, 10_000);
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString()) as Message;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}
