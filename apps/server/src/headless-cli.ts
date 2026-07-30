import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket, { type RawData } from "ws";
import { z } from "zod";
import { remoteClientProtocols } from "./remote-access.js";

const credentialSchema = z.object({ endpoint: z.string().url(), token: z.string().min(20).max(200), deviceName: z.string().min(1).max(80) });
export type Credentials = z.infer<typeof credentialSchema>;
type Request = { id: number; method: string; params: Record<string, unknown> };
export type CliCommand =
  | { name: "pair"; endpoint: string; code: string; deviceName: string }
  | { name: "list" }
  | { name: "send" | "steer"; threadId: string; text: string }
  | { name: "stop"; threadId: string }
  | { name: "watch"; threadId?: string };

export function parseCli(args: string[]): CliCommand {
  const [name, ...rest] = args;
  if (name === "pair" && rest[0] && rest[1]) return { name, endpoint: normalizeRemoteEndpoint(rest[0]), code: rest[1], deviceName: rest.slice(2).join(" ") || "Kimi Code headless CLI" };
  if ((name === "send" || name === "steer") && rest[0] && rest.slice(1).join(" ").trim()) return { name, threadId: rest[0], text: rest.slice(1).join(" ").trim() };
  if (name === "stop" && rest[0]) return { name, threadId: rest[0] };
  if (name === "watch") return { name, ...(rest[0] ? { threadId: rest[0] } : {}) };
  if (name === "list") return { name };
  throw new Error("Usage: kimi-code-headless pair <ws[s]://host:port> <code> [device] | list | send <thread> <text> | steer <thread> <text> | stop <thread> | watch [thread]");
}

export function normalizeRemoteEndpoint(value: string): string {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Remote endpoint must be a plain ws:// or wss:// address");
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

async function main(): Promise<void> {
  const command = parseCli(process.argv.slice(2));
  if (command.name === "pair") {
    const result = await callPair(command.endpoint, command.code, command.deviceName);
    await saveCredentials({ endpoint: command.endpoint, token: result.token, deviceName: command.deviceName });
    process.stdout.write(`Paired ${result.device.name}. Credentials saved with user-only permissions.\n`);
    return;
  }
  const credentials = await loadCredentials();
  if (command.name === "watch") {
    await watch(credentials, command.threadId);
    return;
  }
  const result = command.name === "list"
    ? await callRemote(credentials, "threads.list", {})
    : command.name === "stop"
      ? await callRemote(credentials, "threads.interruptTurn", { threadId: command.threadId, clearQueue: true })
      : await callRemote(credentials, "threads.sendTurn", { threadId: command.threadId, text: command.text, mentions: [], images: [], mode: command.name === "steer" ? "steer" : "queue" });
  if (command.name === "list") {
    const threads = z.object({ threads: z.array(z.object({ threadId: z.string(), title: z.string(), provider: z.string(), cwd: z.string(), running: z.boolean() })) }).parse(result).threads;
    for (const thread of threads) process.stdout.write(`${thread.threadId}\t${thread.running ? "running" : "idle"}\t${thread.provider}\t${thread.title}\t${thread.cwd}\n`);
  } else process.stdout.write("Accepted.\n");
}

async function callPair(endpoint: string, code: string, deviceName: string): Promise<{ token: string; device: { name: string } }> {
  return z.object({ token: z.string(), device: z.object({ name: z.string() }) }).parse(await request(`${endpoint}/pair`, remoteClientProtocols(), { id: 1, method: "remote.claim", params: { code, name: deviceName } }));
}

async function callRemote(credentials: Credentials, method: string, params: Record<string, unknown>): Promise<unknown> {
  return request(`${credentials.endpoint}/remote`, remoteClientProtocols(credentials.token), { id: 1, method, params });
}

async function request(url: string, protocols: string[], payload: Request): Promise<unknown> {
  const socket = await connect(url, protocols);
  try {
    socket.send(JSON.stringify(payload));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Remote request timed out")), 15_000);
      socket.on("message", (data) => {
        const message = JSON.parse(data.toString()) as { id?: unknown; result?: unknown; error?: { message?: string } };
        if (message.id !== payload.id) return;
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message ?? "Remote request failed"));
        else resolve(message.result);
      });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("Remote connection closed")); });
    });
  } finally {
    socket.close();
  }
}

async function watch(credentials: Credentials, threadId?: string): Promise<void> {
  const socket = await connect(`${credentials.endpoint}/remote`, remoteClientProtocols(credentials.token));
  process.stdout.write("Watching remote events. Press Ctrl+C to stop.\n");
  socket.on("message", (data: RawData) => {
    const message = JSON.parse(data.toString()) as { channel?: string; payload?: { threadId?: string } };
    if (!threadId || message.payload?.threadId === threadId) process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("close", () => resolve());
    socket.once("error", reject);
  });
}

function connect(url: string, protocols: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, { handshakeTimeout: 10_000, maxPayload: 8 * 1024 * 1024 });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

export async function loadCredentials(home = homedir(), environment: NodeJS.ProcessEnv = process.env): Promise<Credentials> {
  const primary = environment.KIMI_DESKTOP_REMOTE_URL && environment.KIMI_DESKTOP_REMOTE_TOKEN
    ? { endpoint: environment.KIMI_DESKTOP_REMOTE_URL, token: environment.KIMI_DESKTOP_REMOTE_TOKEN }
    : undefined;
  const legacy = environment.TASTY_REMOTE_URL && environment.TASTY_REMOTE_TOKEN
    ? { endpoint: environment.TASTY_REMOTE_URL, token: environment.TASTY_REMOTE_TOKEN }
    : undefined;
  const configured = primary ?? legacy;
  if (configured) return credentialSchema.parse({ endpoint: normalizeRemoteEndpoint(configured.endpoint), token: configured.token, deviceName: "environment" });
  for (const path of [join(home, ".kimi-code-desktop", "headless.json"), join(home, ".tasty", "headless.json")]) {
    try {
      return credentialSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("No Kimi Code headless credentials found. Pair this device first.");
}

export async function saveCredentials(credentials: Credentials, home = homedir()): Promise<void> {
  const path = join(home, ".kimi-code-desktop", "headless.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(credentials, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
