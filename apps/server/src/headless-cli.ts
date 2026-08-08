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
  | { name: "send" | "steer"; threadId: string; text: string; submissionId?: string }
  | { name: "stop"; threadId: string }
  | { name: "watch"; threadId?: string };

export function parseCli(args: string[]): CliCommand {
  const [name, ...rest] = args;
  if (name === "pair" && rest[0] && rest[1]) return { name, endpoint: normalizeRemoteEndpoint(rest[0]), code: rest[1], deviceName: rest.slice(2).join(" ") || "Kimi Code headless CLI" };
  if (name === "send" || name === "steer") {
    const hasSubmissionId = rest[0] === "--submission-id";
    const submissionId = hasSubmissionId ? rest[1] : undefined;
    if (hasSubmissionId && !z.string().uuid().safeParse(submissionId).success) throw new Error("--submission-id must be a UUID");
    const command = hasSubmissionId ? rest.slice(2) : rest;
    if (command[0] && command.slice(1).join(" ").trim()) {
      return { name, threadId: command[0], text: command.slice(1).join(" ").trim(), ...(submissionId ? { submissionId } : {}) };
    }
  }
  if (name === "stop" && rest[0]) return { name, threadId: rest[0] };
  if (name === "watch") return { name, ...(rest[0] ? { threadId: rest[0] } : {}) };
  if (name === "list") return { name };
  throw new Error("Usage: kimi-code-headless pair <ws[s]://host:port> <code> [device] | list | send [--submission-id <uuid>] <thread> <text> | steer [--submission-id <uuid>] <thread> <text> | stop <thread> | watch [thread]");
}

export function normalizeRemoteEndpoint(value: string): string {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Remote endpoint must be a plain ws:// or wss:// address");
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) throw new Error("Unencrypted ws:// remote endpoints are allowed only on loopback");
  url.pathname = "";
  return url.toString().replace(/\/$/, "");
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(hostname);
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
  let result: unknown;
  if (command.name === "list") result = await callRemote(credentials, "threads.list", {});
  else if (command.name === "stop") result = await callRemote(credentials, "threads.interruptTurn", { threadId: command.threadId, clearQueue: true });
  else {
    const submissionId = command.submissionId ?? crypto.randomUUID();
    process.stdout.write(`Submission ID: ${submissionId}\n`);
    result = await callRemote(credentials, "threads.sendTurn", {
      threadId: command.threadId,
      text: command.text,
      mentions: [],
      images: [],
      mode: command.name === "steer" ? "steer" : "queue",
      submissionId,
    }, true);
  }
  if (command.name === "list") {
    const threads = z.object({ threads: z.array(z.object({ threadId: z.string(), title: z.string(), provider: z.string(), cwd: z.string(), running: z.boolean() })) }).parse(result).threads;
    for (const thread of threads) process.stdout.write(`${thread.threadId}\t${thread.running ? "running" : "idle"}\t${thread.provider}\t${thread.title}\t${thread.cwd}\n`);
  } else process.stdout.write("Accepted.\n");
}

async function callPair(endpoint: string, code: string, deviceName: string): Promise<{ token: string; device: { name: string } }> {
  return z.object({ token: z.string(), device: z.object({ name: z.string() }) }).parse(await request(`${endpoint}/pair`, remoteClientProtocols(), { id: 1, method: "remote.claim", params: { code, name: deviceName } }));
}

export async function callRemote(credentials: Credentials, method: string, params: Record<string, unknown>, retryTransport = false): Promise<unknown> {
  const payload = { id: 1, method, params } satisfies Request;
  const endpoint = normalizeRemoteEndpoint(credentials.endpoint);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request(`${endpoint}/remote`, remoteClientProtocols(credentials.token), payload);
    } catch (error) {
      if (!retryTransport || attempt >= 1 || !(error instanceof RemoteTransportError)) throw error;
    }
  }
}

async function request(url: string, protocols: string[], payload: Request): Promise<unknown> {
  let socket: WebSocket;
  try {
    socket = await connect(url, protocols);
  } catch (error) {
    throw new RemoteTransportError(`Remote connection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    socket.send(JSON.stringify(payload));
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RemoteTransportError("Remote request timed out")), 15_000);
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as { id?: unknown; result?: unknown; error?: { message?: string } };
          if (message.id !== payload.id) return;
          clearTimeout(timer);
          if (message.error) reject(new RemoteRpcError(message.error.message ?? "Remote request failed"));
          else resolve(message.result);
        } catch (error) {
          clearTimeout(timer);
          reject(error instanceof RemoteRpcError ? error : new RemoteRpcError("Remote returned an invalid response"));
        }
      });
      socket.once("close", () => { clearTimeout(timer); reject(new RemoteTransportError("Remote connection closed")); });
      socket.once("error", (error) => { clearTimeout(timer); reject(new RemoteTransportError(`Remote connection failed: ${error.message}`)); });
    });
  } finally {
    socket.close();
  }
}

class RemoteTransportError extends Error {}
class RemoteRpcError extends Error {}

async function watch(credentials: Credentials, threadId?: string): Promise<void> {
  const socket = await connect(`${normalizeRemoteEndpoint(credentials.endpoint)}/remote`, remoteClientProtocols(credentials.token));
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
      const credentials = credentialSchema.parse(JSON.parse(await readFile(path, "utf8")));
      return { ...credentials, endpoint: normalizeRemoteEndpoint(credentials.endpoint) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("No Kimi Code headless credentials found. Pair this device first.");
}

export async function saveCredentials(credentials: Credentials, home = homedir()): Promise<void> {
  const path = join(home, ".kimi-code-desktop", "headless.json");
  const normalized = credentialSchema.parse({ ...credentials, endpoint: normalizeRemoteEndpoint(credentials.endpoint) });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
