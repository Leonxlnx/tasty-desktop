import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ContentBlock, SessionConfigOption } from "@agentclientprotocol/sdk";
import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from "ws";
import { z } from "zod";
import { AcpClient, type RuntimeEvent } from "./acp-client.js";
import { ConfigDefaults, sanitizeSessionConfig } from "./config-defaults.js";
import { EventStore } from "./event-store.js";
import { OrchestrationEngine, titleFromPrompt, type ThreadProjection } from "./orchestration.js";
import { hasConfiguredModel, RuntimeIngestion } from "./runtime-ingestion.js";
import { CheckpointReactor, findGitBinary, type Checkpoint } from "./checkpoint-reactor.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./workspace-files.js";
import { AuthService } from "./auth-service.js";
import { GitService } from "./git-service.js";
import { isKimiQuotaProbePath, readKimiQuota, readLatestKimiUsage } from "./kimi-usage.js";
import { isAuthorizedSocketRequest } from "./socket-origin.js";
import { TerminalService } from "./terminal-service.js";
import { readKimiCapabilities, readKimiMcpServers } from "./kimi-capabilities.js";
import { createDesktopPreviewMcpServer, desktopPreviewMcpName, isPreviewBridgeRequest, normalizeDesktopPreviewUrl } from "./desktop-preview.js";

const id = z.union([z.string(), z.number()]);
const requestSchema = z.discriminatedUnion("method", [
  z.object({ id, method: z.literal("env.bootstrap"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("env.installCli"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("auth.beginLogin"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("auth.cancel"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("auth.logout"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("threads.list"), params: z.object({ cwd: z.string().optional() }).default({}) }),
  z.object({ id, method: z.literal("threads.create"), params: z.object({ cwd: z.string().min(1).optional(), standalone: z.boolean().default(false), config: z.record(z.string(), z.union([z.string(), z.boolean()])).optional() }) }),
  z.object({ id, method: z.literal("threads.resume"), params: z.object({ threadId: z.string().min(1), sessionId: z.string().min(1), cwd: z.string().min(1), replay: z.boolean().default(false) }) }),
  z.object({ id, method: z.literal("threads.rename"), params: z.object({ threadId: z.string().min(1), title: z.string().trim().min(1).max(120) }) }),
  z.object({ id, method: z.literal("threads.delete"), params: z.object({ threadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("threads.sendTurn"), params: z.object({
    threadId: z.string().min(1), text: z.string().min(1), mentions: z.array(z.string()).max(20).default([]),
    images: z.array(z.object({ name: z.string().min(1), mimeType: z.string().regex(/^image\//), data: z.string().min(1).max(30_000_000) })).max(5).default([]),
    mode: z.enum(["queue", "steer"]).default("queue"),
  }) }),
  z.object({ id, method: z.literal("threads.updateQueuedTurn"), params: z.object({ threadId: z.string().min(1), queuedId: z.string().uuid(), text: z.string().trim().min(1).max(100_000) }) }),
  z.object({ id, method: z.literal("threads.steerQueuedTurn"), params: z.object({ threadId: z.string().min(1), queuedId: z.string().uuid() }) }),
  z.object({ id, method: z.literal("threads.removeQueuedTurn"), params: z.object({ threadId: z.string().min(1), queuedId: z.string().uuid() }) }),
  z.object({ id, method: z.literal("threads.clearQueue"), params: z.object({ threadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("threads.interruptTurn"), params: z.object({ threadId: z.string().min(1), clearQueue: z.boolean().default(true) }) }),
  z.object({ id, method: z.literal("threads.respondToRequest"), params: z.object({ threadId: z.string().min(1), requestId: z.string().min(1), optionId: z.string().optional() }) }),
  z.object({ id, method: z.literal("threads.setConfigOption"), params: z.object({ threadId: z.string().min(1), configId: z.string().min(1), value: z.union([z.string(), z.boolean()]) }) }),
  z.object({ id, method: z.literal("runtime.configDefaults"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("checkpoints.list"), params: z.object({ threadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("checkpoints.revert"), params: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("files.tree"), params: z.object({ cwd: z.string().min(1), query: z.string().max(200).default("") }) }),
  z.object({ id, method: z.literal("files.read"), params: z.object({ cwd: z.string().min(1), path: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.status"), params: z.object({ cwd: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.diff"), params: z.object({ cwd: z.string().min(1), path: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.stage"), params: z.object({ cwd: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(500) }) }),
  z.object({ id, method: z.literal("git.unstage"), params: z.object({ cwd: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(500) }) }),
  z.object({ id, method: z.literal("git.commit"), params: z.object({ cwd: z.string().min(1), message: z.string().trim().min(1).max(2000) }) }),
  z.object({ id, method: z.literal("terminal.start"), params: z.object({ cwd: z.string().min(1) }) }),
  z.object({ id, method: z.literal("terminal.write"), params: z.object({ sessionId: z.string().uuid(), command: z.string().min(1).max(4000) }) }),
  z.object({ id, method: z.literal("terminal.stop"), params: z.object({ sessionId: z.string().uuid() }) }),
  z.object({ id, method: z.literal("preview.agentCommand"), params: z.object({
    action: z.enum(["open", "resize"]),
    url: z.string().max(2_048).optional(),
    panelWidth: z.number().int().min(320).max(1_200).optional(),
    viewportWidth: z.number().int().min(320).max(1_920).optional(),
    viewportHeight: z.number().int().min(240).max(1_200).optional(),
  }) }),
  z.object({ id, method: z.literal("usage.quota"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("capabilities.list"), params: z.object({}).default({}) }),
]);
const persistedQueueSchema = z.record(z.string(), z.array(z.object({
  queuedId: z.string().uuid(),
  text: z.string().min(1).max(100_000),
  mentions: z.array(z.string()).max(20),
  mode: z.enum(["queue", "steer"]),
  createdAt: z.string().datetime(),
})));

const port = Number(process.env.KIMI_SERVER_PORT ?? 4317);
const serverToken = process.env.KIMI_SERVER_TOKEN;
const previewBridgeToken = randomBytes(32).toString("hex");
const defaultCwd = resolve(process.env.KIMI_WORKSPACE ?? process.cwd());
const dataHome = resolve(process.env.KIMI_DESKTOP_HOME ?? join(process.env.APPDATA ?? homedir(), "KimiCodeDesktop"));
const kimiHome = resolve(process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"));
const kimiShareHome = resolve(process.env.KIMI_SHARE_DIR ?? join(homedir(), ".kimi"));
const quotaProbeCwd = join(dataHome, "runtime", "quota-probe");
const standaloneChatCwd = join(dataHome, "runtime", "chats");
const configProbeCwd = join(dataHome, "runtime", "config-probe");
const quotaCachePath = join(dataHome, "quota-cache.json");
const queuePath = join(dataHome, "pending-queues.json");
const sockets = new Set<WebSocket>();
const socketSeq = new WeakMap<WebSocket, number>();
const engine = new OrchestrationEngine(new EventStore(join(dataHome, "events.jsonl")));
const ingestion = new RuntimeIngestion(engine, (error) => {
  pushAll("server.diagnostics", { type: "diagnostic", level: "error", message: error instanceof Error ? error.message : String(error) });
});
const checkpointReactor = new CheckpointReactor(findGitBinary(), dataHome);
const configDefaults = new ConfigDefaults(join(dataHome, "runtime-defaults.json"));
const git = new GitService(findGitBinary());
const terminal = new TerminalService();
const socketTerminals = new WeakMap<WebSocket, Set<string>>();
type QueuedTurn = {
  queuedId: string;
  text: string;
  mentions: string[];
  images: Array<{ name: string; mimeType: string; data: string }>;
  mode: "queue" | "steer";
  createdAt: string;
};
const turnQueues = new Map<string, QueuedTurn[]>();
const queueRunners = new Set<string>();
const sessionResumes = new Map<string, Promise<SessionConfigOption[]>>();
let queueWrite: Promise<void> = Promise.resolve();
let runtime: AcpClient | undefined;
let initializeResult: Awaited<ReturnType<AcpClient["start"]>> | undefined;
let quotaRead: Promise<Awaited<ReturnType<typeof readKimiQuota>>> | undefined;
let configDefaultsLive = false;
const auth = new AuthService(runtimeBinaryDescription(), process.env.KIMI_CODE_HOME, (event) => void handleAuthEvent(event));

await engine.open();
await loadQueues();
engine.setPublisher((event) => {
  pushAll("orchestration.domainEvent", event);
  if (event.type === "ConfigOptionsReplaced") {
    const options = (event.payload as { options: SessionConfigOption[] }).options;
    pushAll("thread.configUpdated", { threadId: event.threadId, options });
    void rememberLiveConfigOptions(options);
  }
});

function sendPush(socket: WebSocket, channel: string, payload: unknown): void {
  const seq = (socketSeq.get(socket) ?? 0) + 1;
  socketSeq.set(socket, seq);
  socket.send(JSON.stringify({ channel, seq, payload }));
}

function pushAll(channel: string, payload: unknown): void {
  for (const socket of sockets) if (socket.readyState === socket.OPEN) sendPush(socket, channel, payload);
}

function reply(socket: WebSocket, requestId: string | number, result?: unknown, error?: unknown): void {
  socket.send(JSON.stringify(error ? { id: requestId, error } : { id: requestId, result }));
}

async function ensureRuntime(): Promise<AcpClient> {
  if (runtime) return runtime;
  const currentFile = fileURLToPath(import.meta.url);
  const useFake = process.env.KIMI_FAKE === "1";
  const fakePath = join(dirname(currentFile), currentFile.endsWith(".ts") ? "fake-acp.ts" : "fake-acp.js");
  runtime = new AcpClient({
    binary: useFake ? process.execPath : resolveKimiBinary(),
    args: useFake ? (currentFile.endsWith(".ts") ? ["--import", "tsx", fakePath] : [fakePath]) : ["acp"],
    ...(process.env.KIMI_CODE_HOME ? { kimiCodeHome: resolve(process.env.KIMI_CODE_HOME) } : {}),
    mcpServers: async () => {
      const configured = await readKimiMcpServers(kimiShareHome);
      return [
        createDesktopPreviewMcpServer(import.meta.url, `ws://127.0.0.1:${port}?preview-token=${previewBridgeToken}`),
        ...configured.filter((server) => server.name !== desktopPreviewMcpName),
      ];
    },
    onEvent: (event) => void onRuntimeEvent(event),
  });
  initializeResult = await runtime.start();
  return runtime;
}

async function onRuntimeEvent(event: RuntimeEvent): Promise<void> {
  if (event.type === "diagnostic") {
    pushAll("server.diagnostics", event);
    return;
  }
  await ingestion.ingest(event);
}

async function handle(socket: WebSocket, input: unknown): Promise<void> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    socket.send(JSON.stringify({ error: { code: -32602, message: "Invalid request", details: parsed.error.issues } }));
    return;
  }
  const request = parsed.data;
  try {
    if (request.method === "env.bootstrap") {
      const authStatus = process.env.KIMI_FAKE === "1" ? { ...auth.status(), installed: true, authenticated: true } : auth.status();
      if (process.env.KIMI_FAKE === "1" || authStatus.authenticated) await ensureRuntime();
      for (const threadId of turnQueues.keys()) void runNextQueued(threadId);
      reply(socket, request.id, { initialize: initializeResult, binary: runtimeBinaryDescription(), defaultCwd, auth: authStatus });
      return;
    }
    if (request.method === "env.installCli") {
      reply(socket, request.id, auth.beginInstall());
      return;
    }
    if (request.method === "auth.beginLogin") {
      reply(socket, request.id, auth.beginLogin());
      return;
    }
    if (request.method === "auth.cancel") {
      auth.cancel();
      reply(socket, request.id, auth.status());
      return;
    }
    if (request.method === "auth.logout") {
      await resetRuntime();
      reply(socket, request.id, auth.logout());
      return;
    }
    if (request.method === "preview.agentCommand") {
      const url = request.params.url ? normalizeDesktopPreviewUrl(request.params.url) : undefined;
      if (request.params.url && !url) throw new Error("Preview accepts localhost or 127.0.0.1 URLs only");
      if (request.params.action === "open" && !url) throw new Error("A localhost preview URL is required");
      const command = { ...request.params, ...(url ? { url } : {}) };
      pushAll("preview.command", command);
      reply(socket, request.id, { accepted: true, command });
      return;
    }
    if (request.method === "files.tree") {
      reply(socket, request.id, { files: await listWorkspaceFiles(resolve(request.params.cwd), request.params.query) });
      return;
    }
    if (request.method === "files.read") {
      reply(socket, request.id, await readWorkspaceFile(resolve(request.params.cwd), request.params.path));
      return;
    }
    if (request.method === "git.status") {
      reply(socket, request.id, await git.status(request.params.cwd));
      return;
    }
    if (request.method === "git.diff") {
      reply(socket, request.id, await git.diff(request.params.cwd, request.params.path));
      return;
    }
    if (request.method === "git.stage") {
      reply(socket, request.id, await git.stage(request.params.cwd, request.params.paths));
      return;
    }
    if (request.method === "git.unstage") {
      reply(socket, request.id, await git.unstage(request.params.cwd, request.params.paths));
      return;
    }
    if (request.method === "git.commit") {
      reply(socket, request.id, await git.commit(request.params.cwd, request.params.message));
      return;
    }
    if (request.method === "usage.quota") {
      quotaRead ??= readKimiQuota({
        binary: runtimeBinaryDescription(),
        kimiHome,
        cwd: quotaProbeCwd,
        cachePath: quotaCachePath,
      }).finally(() => { quotaRead = undefined; });
      reply(socket, request.id, await quotaRead);
      return;
    }
    if (request.method === "capabilities.list") {
      const capabilities = await readKimiCapabilities(kimiShareHome);
      reply(socket, request.id, { ...capabilities, mcpServers: [{
        name: desktopPreviewMcpName,
        transport: "stdio" as const,
        target: "Built into Kimi Code Desktop",
        needsAuthorization: false,
        connectable: true,
      }, ...capabilities.mcpServers.filter((server) => server.name !== desktopPreviewMcpName)] });
      return;
    }
    if (request.method === "runtime.configDefaults") {
      const cached = await configDefaults.load();
      const fromThreads = engine.threads().map((thread) => thread.configOptions).find((options) => options.length);
      const fallback = cached ?? fromThreads ?? [];
      if (configDefaultsLive) {
        reply(socket, request.id, { configOptions: fallback });
        return;
      }
      if (process.env.KIMI_FAKE !== "1" && !auth.status().authenticated) {
        reply(socket, request.id, { configOptions: fallback });
        return;
      }
      try {
        const acp = await ensureRuntime();
        await mkdir(configProbeCwd, { recursive: true });
        const probed = (await acp.newSession(configProbeCwd)).configOptions ?? [];
        await rememberLiveConfigOptions(probed);
        reply(socket, request.id, { configOptions: probed });
      } catch {
        reply(socket, request.id, { configOptions: fallback });
      }
      return;
    }
    if (request.method === "terminal.start") {
      const session = terminal.start(request.params.cwd, (event) => {
        if (socket.readyState === socket.OPEN) sendPush(socket, "terminal.output", event);
      });
      const sessions = socketTerminals.get(socket) ?? new Set<string>();
      sessions.add(session.sessionId);
      socketTerminals.set(socket, sessions);
      reply(socket, request.id, session);
      return;
    }
    if (request.method === "terminal.write") {
      if (!socketTerminals.get(socket)?.has(request.params.sessionId)) throw new Error("Unknown terminal session");
      terminal.write(request.params.sessionId, request.params.command);
      reply(socket, request.id, { accepted: true });
      return;
    }
    if (request.method === "terminal.stop") {
      if (!socketTerminals.get(socket)?.has(request.params.sessionId)) throw new Error("Unknown terminal session");
      terminal.stop(request.params.sessionId);
      socketTerminals.get(socket)?.delete(request.params.sessionId);
      reply(socket, request.id, {});
      return;
    }
    const acp = await ensureRuntime();
    if (request.method === "threads.list") {
      let runtimeSessions: unknown[] = [];
      try {
        runtimeSessions = (await acp.listSessions(request.params.cwd)).sessions.filter((session) => !isInternalProbeSession(session)).map(classifyRuntimeSession);
      } catch (error) {
        pushAll("server.diagnostics", { type: "diagnostic", level: "error", message: error instanceof Error ? error.message : String(error) });
      }
      const threads = await Promise.all(engine.threads().map(async (thread) => {
        const local = await readLatestKimiUsage(kimiHome, thread.sessionId);
        const projected = { ...thread, queue: queueSummary(thread.threadId) };
        return local ? { ...projected, usage: { context: local.context, tokens: local.tokens } } : projected;
      }));
      reply(socket, request.id, { threads, runtimeSessions });
      return;
    }
    if (request.method === "threads.create") {
      if (!request.params.standalone && !request.params.cwd) throw new Error("Workspace path is required for a project chat");
      const targetCwd = request.params.standalone ? standaloneChatCwd : resolve(request.params.cwd!);
      if (request.params.standalone) await mkdir(targetCwd, { recursive: true });
      const session = await acp.newSession(targetCwd);
      let configOptions = session.configOptions ?? [];
      if (!hasConfiguredModel(configOptions)) throw new Error("Kimi Code has no configured model. Complete login with an active Kimi Code membership, then retry.");
      for (const [configId, value] of sanitizeSessionConfig(request.params.config, configOptions)) {
        if (!sanitizeSessionConfig({ [configId]: value }, configOptions).length) continue;
        const applied = await acp.setConfigOption(session.sessionId, configId, value);
        if (applied.configOptions) configOptions = applied.configOptions;
      }
      void rememberLiveConfigOptions(configOptions);
      const threadId = crypto.randomUUID();
      await engine.append(threadId, { type: "ThreadCreated", payload: { sessionId: session.sessionId, cwd: targetCwd, kind: request.params.standalone ? "chat" : "project", title: request.params.standalone ? "New chat" : "New Kimi session", configOptions } });
      reply(socket, request.id, { thread: engine.thread(threadId) });
      return;
    }
    if (request.method === "threads.resume") {
      const existing = engine.thread(request.params.threadId);
      const configOptions = existing && !request.params.replay
        ? await ensureThreadSession(acp, existing)
        : (request.params.replay
          ? await acp.loadSession(request.params.sessionId, resolve(request.params.cwd))
          : await acp.resumeSession(request.params.sessionId, resolve(request.params.cwd))).configOptions ?? [];
      if (!hasConfiguredModel(configOptions)) throw new Error("Kimi Code has no configured model. Complete login with an active Kimi Code membership, then retry.");
      void rememberLiveConfigOptions(configOptions);
      if (!existing) await engine.append(request.params.threadId, { type: "ThreadCreated", payload: { sessionId: request.params.sessionId, cwd: resolve(request.params.cwd), kind: isStandaloneChatPath(request.params.cwd) ? "chat" : "project", title: "Resumed Kimi session", configOptions } });
      else if (request.params.replay) await engine.append(existing.threadId, { type: "ConfigOptionsReplaced", payload: { options: configOptions } });
      reply(socket, request.id, { thread: engine.thread(request.params.threadId) });
      return;
    }
    const thread = engine.thread(request.params.threadId);
    if (!thread) throw new Error(`Unknown thread ${request.params.threadId}`);
    if (request.method === "threads.rename") {
      await engine.append(thread.threadId, { type: "ThreadRenamed", payload: { title: request.params.title } });
      reply(socket, request.id, { thread: engine.thread(thread.threadId) });
      return;
    }
    if (request.method === "threads.delete") {
      turnQueues.delete(thread.threadId);
      await persistQueues();
      publishQueue(thread.threadId);
      if (thread.running) await acp.cancel(thread.sessionId);
      await ingestion.flush(thread.sessionId);
      await engine.append(thread.threadId, { type: "ThreadDeleted", payload: {} });
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "checkpoints.list") {
      reply(socket, request.id, { checkpoints: thread.checkpoints });
      return;
    }
    if (request.method === "checkpoints.revert") {
      const before = thread.checkpoints.find((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "before");
      const after = thread.checkpoints.findLast((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "after");
      if (!before || !after) throw new Error("Turn checkpoints are incomplete");
      const reverted = await checkpointReactor.revert(thread.threadId, request.params.turnId, before, after);
      if (reverted) await engine.append(thread.threadId, { type: "CheckpointReverted", payload: { checkpoint: reverted } });
      pushAll("receipt", { type: "checkpoint.reverted", threadId: thread.threadId, turnId: request.params.turnId });
      reply(socket, request.id, { checkpoint: reverted });
      return;
    }
    if (request.method === "threads.sendTurn") {
      const queued: QueuedTurn = {
        queuedId: crypto.randomUUID(),
        text: request.params.text,
        mentions: request.params.mentions,
        images: request.params.images,
        mode: request.params.mode,
        createdAt: new Date().toISOString(),
      };
      const queue = turnQueues.get(thread.threadId) ?? [];
      if (queued.mode === "steer" && thread.running) queue.unshift(queued);
      else queue.push(queued);
      turnQueues.set(thread.threadId, queue);
      await persistQueues();
      publishQueue(thread.threadId);
      if (queued.mode === "steer" && thread.running) {
        await resolveThreadApprovals(thread.threadId);
        await acp.cancel(thread.sessionId);
      }
      else void runNextQueued(thread.threadId);
      reply(socket, request.id, { accepted: true, queuedId: queued.queuedId, queued: thread.running || queue.length > 1 });
      return;
    }
    if (request.method === "threads.updateQueuedTurn") {
      const queue = turnQueues.get(thread.threadId) ?? [];
      const index = queue.findIndex((item) => item.queuedId === request.params.queuedId);
      if (index < 0) throw new Error("Queued prompt no longer exists");
      if (index === 0 && queueRunners.has(thread.threadId)) throw new Error("Queued prompt is already starting");
      const text = request.params.text;
      queue[index] = { ...queue[index]!, text, mentions: mentionsFromText(text) };
      await persistQueues();
      publishQueue(thread.threadId);
      reply(socket, request.id, { queued: queueSummary(thread.threadId) });
      return;
    }
    if (request.method === "threads.steerQueuedTurn") {
      const queue = turnQueues.get(thread.threadId) ?? [];
      const index = queue.findIndex((item) => item.queuedId === request.params.queuedId);
      if (index < 0) throw new Error("Queued prompt no longer exists");
      if (queueRunners.has(thread.threadId)) throw new Error("A queued prompt is already starting");
      const [queued] = queue.splice(index, 1);
      queue.unshift({ ...queued!, mode: "steer" });
      turnQueues.set(thread.threadId, queue);
      await persistQueues();
      publishQueue(thread.threadId);
      if (thread.running) {
        await resolveThreadApprovals(thread.threadId);
        await acp.cancel(thread.sessionId);
      } else {
        void runNextQueued(thread.threadId);
      }
      reply(socket, request.id, { accepted: true });
      return;
    }
    if (request.method === "threads.removeQueuedTurn") {
      const queue = turnQueues.get(thread.threadId) ?? [];
      turnQueues.set(thread.threadId, queue.filter((item) => item.queuedId !== request.params.queuedId));
      await persistQueues();
      publishQueue(thread.threadId);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "threads.clearQueue") {
      turnQueues.delete(thread.threadId);
      await persistQueues();
      publishQueue(thread.threadId);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "threads.respondToRequest") {
      await engine.append(thread.threadId, { type: "ApprovalResolved", payload: request.params.optionId ? { requestId: request.params.requestId, optionId: request.params.optionId } : { requestId: request.params.requestId } });
      acp.respondToPermission(request.params.requestId, request.params.optionId);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "threads.interruptTurn") {
      if (request.params.clearQueue) {
        turnQueues.delete(thread.threadId);
        await persistQueues();
        publishQueue(thread.threadId);
      }
      await resolveThreadApprovals(thread.threadId);
      await acp.cancel(thread.sessionId);
      reply(socket, request.id, {});
      return;
    }
    const liveOptions = await ensureThreadSession(acp, thread);
    const option = liveOptions.find((candidate) => candidate.id === request.params.configId);
    const applicable = sanitizeSessionConfig({ [request.params.configId]: request.params.value }, liveOptions);
    if (!applicable.length) {
      if (option && String(option.currentValue) === String(request.params.value)) {
        reply(socket, request.id, { configOptions: liveOptions });
        return;
      }
      throw new Error(`${request.params.configId} is not supported by this Kimi session`);
    }
    const result = await acp.setConfigOption(thread.sessionId, request.params.configId, request.params.value);
    if (result.configOptions) void rememberLiveConfigOptions(result.configOptions);
    reply(socket, request.id, result);
  } catch (error) {
    reply(socket, request.id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) });
  }
}

function queueSummary(threadId: string) {
  return (turnQueues.get(threadId) ?? []).map(({ queuedId, text, mode, createdAt, images }) => ({
    queuedId,
    text,
    mode,
    createdAt,
    images: images.map(({ name, mimeType }) => ({ name, mimeType })),
  }));
}

function mentionsFromText(text: string): string[] {
  return [...text.matchAll(/@\{([^}]+)\}/g)].map((match) => match[1]!).slice(0, 20);
}

async function resolveThreadApprovals(threadId: string): Promise<void> {
  for (const approval of engine.thread(threadId)?.approvals ?? []) {
    await engine.append(threadId, { type: "ApprovalResolved", payload: { requestId: approval.requestId } });
  }
}

function publishQueue(threadId: string): void {
  pushAll("thread.queueUpdated", { threadId, queue: queueSummary(threadId) });
}

async function runNextQueued(threadId: string): Promise<void> {
  if (queueRunners.has(threadId)) return;
  const thread = engine.thread(threadId);
  const queue = turnQueues.get(threadId) ?? [];
  if (!thread || thread.running || !queue.length) return;
  const queued = queue[0]!;
  queueRunners.add(threadId);
  try {
    await startQueuedTurn(threadId, queued);
    const remaining = (turnQueues.get(threadId) ?? []).filter((item) => item.queuedId !== queued.queuedId);
    if (remaining.length) turnQueues.set(threadId, remaining);
    else turnQueues.delete(threadId);
    await persistQueues();
    publishQueue(threadId);
  } catch (error) {
    pushAll("server.diagnostics", { type: "diagnostic", level: "error", message: error instanceof Error ? error.message : String(error) });
  } finally {
    queueRunners.delete(threadId);
  }
}

async function startQueuedTurn(threadId: string, queued: QueuedTurn): Promise<void> {
  const acp = await ensureRuntime();
  const thread = engine.thread(threadId);
  if (!thread) throw new Error(`Unknown thread ${threadId}`);
  if (thread.running) throw new Error("A turn is already running");
  const configOptions = await ensureThreadSession(acp, thread);
  if (!hasConfiguredModel(configOptions)) throw new Error("Kimi Code has no configured model. Complete login with an active Kimi Code membership, then retry.");
  const turnId = crypto.randomUUID();
  const prompt: ContentBlock[] = [{ type: "text", text: queued.text }];
  const resourcePaths: string[] = [];
  for (const mention of queued.mentions) {
    const resource = await readWorkspaceFile(thread.cwd, mention);
    resourcePaths.push(resource.path);
    prompt.push({ type: "resource", resource: { uri: pathToFileURL(resource.path).href, text: resource.content, mimeType: "text/plain" } });
  }
  for (const image of queued.images) prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
  const before = await captureCheckpoint(thread.threadId, turnId, "before", thread.cwd);
  await engine.append(thread.threadId, { type: "TurnStarted", payload: {
    turnId,
    text: queued.text,
    ...(thread.turns.length === 0 ? { title: titleFromPrompt(queued.text) } : {}),
    ...(resourcePaths.length ? { resources: resourcePaths } : {}),
    ...(queued.images.length ? { images: queued.images.map(({ name, mimeType }) => ({ name, mimeType })) } : {}),
  } });
  void acp.prompt(thread.sessionId, prompt).then(async (result) => {
    if (!engine.thread(thread.threadId)) return;
    await ingestion.flush(thread.sessionId);
    const after = await captureCheckpoint(thread.threadId, turnId, "after", thread.cwd, before);
    const localUsage = result.usage ? undefined : await readLatestKimiUsage(kimiHome, thread.sessionId);
    if (!engine.thread(thread.threadId)) return;
    if (localUsage) await engine.append(thread.threadId, { type: "UsageUpdated", payload: { usage: localUsage.context } });
    await engine.append(thread.threadId, result.stopReason === "cancelled"
      ? { type: "TurnCancelled", payload: { turnId } }
      : { type: "TurnCompleted", payload: { turnId, stopReason: result.stopReason, ...(result.usage ? { usage: result.usage } : localUsage ? { usage: localUsage.tokens } : {}) } });
    pushAll("receipt", { type: "turn.quiescent", threadId: thread.threadId, turnId });
    void runNextQueued(thread.threadId);
  }).catch(async (error: Error) => {
    pushAll("server.diagnostics", { type: "diagnostic", level: "error", message: error.message });
    await ingestion.flush(thread.sessionId);
    const current = engine.thread(thread.threadId);
    if (current?.activeTurnId === turnId) await engine.append(thread.threadId, { type: "TurnCompleted", payload: { turnId, stopReason: "error" } });
    void runNextQueued(thread.threadId);
  });
}

async function ensureThreadSession(acp: AcpClient, thread: ThreadProjection): Promise<SessionConfigOption[]> {
  if (acp.hasSession(thread.sessionId)) return thread.configOptions;
  const pending = sessionResumes.get(thread.sessionId);
  if (pending) return pending;
  const resume = (async () => {
    const configOptions = (await acp.resumeSession(thread.sessionId, thread.cwd)).configOptions ?? thread.configOptions;
    await engine.append(thread.threadId, { type: "ConfigOptionsReplaced", payload: { options: configOptions } });
    return configOptions;
  })().finally(() => sessionResumes.delete(thread.sessionId));
  sessionResumes.set(thread.sessionId, resume);
  return resume;
}

function rememberLiveConfigOptions(options: SessionConfigOption[]): Promise<void> {
  if (options.length) configDefaultsLive = true;
  return configDefaults.update(options);
}

const verifyClient: VerifyClientCallbackSync = ({ origin, req }) => isAuthorizedSocketRequest(origin, req.url, serverToken)
  || isPreviewBridgeRequest(req.url, previewBridgeToken);
const server = new WebSocketServer({ host: "127.0.0.1", port, verifyClient });
server.on("connection", (socket) => {
  sockets.add(socket);
  socketSeq.set(socket, 0);
  sendPush(socket, "server.welcome", { defaultCwd, protocolVersion: 1 });
  socket.on("message", (data) => {
    try {
      void handle(socket, JSON.parse(data.toString()));
    } catch (error) {
      socket.send(JSON.stringify({ error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }));
    }
  });
  socket.on("close", () => {
    sockets.delete(socket);
    for (const sessionId of socketTerminals.get(socket) ?? []) terminal.stop(sessionId);
  });
});
server.on("listening", () => console.log(`Kimi Code orchestration server listening on ws://127.0.0.1:${port}`));

function resolveKimiBinary(): string {
  if (process.env.KIMI_BINARY) {
    return resolve(process.env.KIMI_BINARY);
  }
  const candidate = process.platform === "win32" ? join(homedir(), ".kimi-code", "bin", "kimi.exe") : join(homedir(), ".kimi-code", "bin", "kimi");
  return resolve(candidate);
}

function runtimeBinaryDescription(): string {
  return process.env.KIMI_FAKE === "1" ? "fake" : resolveKimiBinary();
}

function isInternalProbeSession(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const cwd = (session as { cwd?: unknown }).cwd;
  if (typeof cwd !== "string") return false;
  if (isKimiQuotaProbePath(cwd, quotaProbeCwd)) return true;
  const normalize = (value: string) => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return normalize(cwd) === normalize(configProbeCwd);
}

function isStandaloneChatPath(path: string): boolean {
  const normalize = (value: string) => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  return normalize(path) === normalize(standaloneChatCwd);
}

function classifyRuntimeSession(session: unknown): unknown {
  if (!session || typeof session !== "object") return session;
  const cwd = (session as { cwd?: unknown }).cwd;
  return typeof cwd === "string" ? { ...session, kind: isStandaloneChatPath(cwd) ? "chat" : "project" } : session;
}

async function captureCheckpoint(threadId: string, turnId: string, phase: Checkpoint["phase"], cwd: string, before?: Checkpoint): Promise<Checkpoint | undefined> {
  try {
    const checkpoint = await checkpointReactor.capture(threadId, turnId, phase, cwd);
    if (!checkpoint) return undefined;
    const diff = before ? await checkpointReactor.diff(before, checkpoint) : undefined;
    await engine.append(threadId, { type: "CheckpointCaptured", payload: diff ? { checkpoint, diff } : { checkpoint } });
    pushAll("receipt", { type: "checkpoint.captured", threadId, turnId, phase });
    return checkpoint;
  } catch (error) {
    pushAll("server.diagnostics", { type: "diagnostic", level: "error", message: `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}` });
    return undefined;
  }
}

async function shutdown(): Promise<void> {
  auth.close();
  terminal.close();
  await persistQueues();
  await ingestion.flushAll();
  await runtime?.close();
  server.close();
}

async function resetRuntime(): Promise<void> {
  await runtime?.close();
  runtime = undefined;
  initializeResult = undefined;
}

async function handleAuthEvent(event: import("./auth-service.js").AuthEvent): Promise<void> {
  if (event.type === "complete") await resetRuntime();
  pushAll("auth.status", { ...auth.status(), event });
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

async function loadQueues(): Promise<void> {
  try {
    const parsed = persistedQueueSchema.safeParse(JSON.parse(await readFile(queuePath, "utf8")));
    if (!parsed.success) return;
    for (const [threadId, queued] of Object.entries(parsed.data)) {
      if (!engine.thread(threadId) || !queued.length) continue;
      turnQueues.set(threadId, queued.map((item) => ({ ...item, images: [] })));
    }
  } catch {
    // A missing or interrupted best-effort queue cache must never block chat history.
  }
}

function persistQueues(): Promise<void> {
  const persisted = Object.fromEntries([...turnQueues].flatMap(([threadId, queued]) => {
    const textOnly = queued.filter((item) => item.images.length === 0).map(({ images: _images, ...item }) => item);
    return textOnly.length ? [[threadId, textOnly]] : [];
  }));
  queueWrite = queueWrite.then(async () => {
    await mkdir(dirname(queuePath), { recursive: true });
    await writeFile(queuePath, JSON.stringify(persisted), "utf8");
  }, async () => {
    await writeFile(queuePath, JSON.stringify(persisted), "utf8");
  });
  return queueWrite;
}
