import { realpathSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RequestError, type ContentBlock, type SessionConfigOption } from "@agentclientprotocol/sdk";
import { WebSocketServer, type VerifyClientCallbackSync, type WebSocket } from "ws";
import { z } from "zod";
import { AcpClient, isTransientWindowsSpawnError, isUnknownAcpSessionError, type RuntimeEvent } from "./acp-client.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { ConfigDefaults, sanitizeSessionConfig } from "./config-defaults.js";
import { EventStore } from "./event-store.js";
import { OrchestrationEngine, titleFromPrompt, type ProviderId, type ThreadProjection, type ThreadWorktree } from "./orchestration.js";
import { hasConfiguredModel, RuntimeIngestion } from "./runtime-ingestion.js";
import { CheckpointReactor, findGitBinary, type Checkpoint } from "./checkpoint-reactor.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./workspace-files.js";
import { AuthService, type AuthEvent } from "./auth-service.js";
import { GitService } from "./git-service.js";
import { isKimiQuotaProbePath, readKimiQuota, readLatestKimiUsage } from "./kimi-usage.js";
import { isAuthorizedSocketRequest } from "./socket-origin.js";
import { TerminalService } from "./terminal-service.js";
import { findProjectRoot, installKimiSkill, readKimiCapabilities, readKimiMcpServers, readProjectMcpBundle, readWslKimiCapabilities } from "./kimi-capabilities.js";
import { McpApprovalStore } from "./mcp-approvals.js";
import { createDesktopPreviewMcpServer, desktopPreviewMcpName, isPreviewBridgeRequest, normalizeDesktopPreviewUrl } from "./desktop-preview.js";
import { readRecoverableJson, writeRecoverableJson } from "./recoverable-json.js";
import { assertKimiProvider, providerDescriptors, providerName, readProviderInstances, requireProviderBinary, resolveProviderBinary, type ProviderInstance } from "./provider-runtime.js";
import { DiagnosticJournal, redactDiagnosticText, redactPrivateErrorText, type DiagnosticLevel } from "./diagnostics.js";
import { WslEnvironments } from "./wsl-environments.js";
import { RemoteAccess, remoteMethodAllowed, remoteProtocolOffered, remoteProtocolToken, selectRemoteProtocol, type RemoteConfig, type RemoteDevice } from "./remote-access.js";
import { ScheduleStore, scheduleTarget, type Schedule } from "./schedule-store.js";
import { exportSessionArchive } from "./session-export.js";
import { acceptQueuedInsertion, persistQueuedInsertion, persistQueueSnapshot, QueueInsertionGate, readQueueAfterPreflight, reconcileMissingSubmissionPayloads, removeQueuedItem, withStableQueueWrites } from "./queue-safety.js";
import {
  BackgroundTaskMonitor,
  MAX_ACTIVE_BACKGROUND_TASKS,
  MAX_MONITORED_BACKGROUND_TASKS,
  backgroundTaskCandidates,
  readKimiBackgroundTask,
  type BackgroundTaskResult,
  type PendingBackgroundTask,
} from "./background-tasks.js";

const id = z.union([z.string(), z.number()]);
const activeProvider = z.literal("kimi");
const requestSchema = z.discriminatedUnion("method", [
  z.object({ id, method: z.literal("env.bootstrap"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("env.prepareUpdate"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("env.confirmUpdate"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("env.cancelUpdate"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("env.installCli"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("auth.beginLogin"), params: z.object({ provider: activeProvider.default("kimi") }).default({ provider: "kimi" }) }),
  z.object({ id, method: z.literal("auth.cancel"), params: z.object({ provider: activeProvider.default("kimi") }).default({ provider: "kimi" }) }),
  z.object({ id, method: z.literal("auth.logout"), params: z.object({ provider: activeProvider.default("kimi") }).default({ provider: "kimi" }) }),
  z.object({ id, method: z.literal("providers.list"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("threads.list"), params: z.object({ cwd: z.string().optional(), provider: activeProvider.optional(), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional() }).default({}) }),
  z.object({ id, method: z.literal("threads.export"), params: z.object({ threadIds: z.array(z.string().min(1)).max(100).optional() }).default({}) }),
  z.object({ id, method: z.literal("threads.create"), params: z.object({ cwd: z.string().min(1).optional(), standalone: z.boolean().default(false), isolate: z.boolean().default(false), provider: activeProvider.default("kimi"), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional(), config: z.record(z.string(), z.union([z.string(), z.boolean()])).optional(), creationId: z.string().uuid().optional() }) }),
  z.object({ id, method: z.literal("threads.createSide"), params: z.object({ threadId: z.string().min(1), title: z.string().trim().min(1).max(120).optional(), creationId: z.string().uuid().optional() }) }),
  z.object({ id, method: z.literal("threads.resume"), params: z.object({ threadId: z.string().min(1), sessionId: z.string().min(1), cwd: z.string().min(1), provider: activeProvider.default("kimi"), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional(), replay: z.boolean().default(false) }) }),
  z.object({ id, method: z.literal("threads.rename"), params: z.object({ threadId: z.string().min(1), title: z.string().trim().min(1).max(120) }) }),
  z.object({ id, method: z.literal("threads.setGoal"), params: z.object({ threadId: z.string().min(1), objective: z.string().trim().min(1).max(20_000) }) }),
  z.object({ id, method: z.literal("threads.clearGoal"), params: z.object({ threadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("subagents.inspect"), params: z.object({ threadId: z.string().min(1), agentThreadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("subagents.stop"), params: z.object({ threadId: z.string().min(1), agentThreadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("threads.delete"), params: z.object({ threadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("threads.archive"), params: z.object({ threadId: z.string().min(1), archived: z.boolean() }) }),
  z.object({ id, method: z.literal("threads.sendTurn"), params: z.object({
    threadId: z.string().min(1), text: z.string().min(1), mentions: z.array(z.string()).max(20).default([]),
    images: z.array(z.object({ name: z.string().min(1), mimeType: z.string().regex(/^image\//), data: z.string().min(1).max(30_000_000) })).max(5).default([]),
    mode: z.enum(["queue", "steer"]).default("queue"),
    submissionId: z.string().uuid().optional(),
  }) }),
  z.object({ id, method: z.literal("threads.updateQueuedTurn"), params: z.object({ threadId: z.string().min(1), queuedId: z.string().uuid(), text: z.string().trim().min(1).max(100_000) }) }),
  z.object({ id, method: z.literal("threads.steerQueuedTurn"), params: z.object({ threadId: z.string().min(1), queuedId: z.string().uuid() }) }),
  z.object({ id, method: z.literal("threads.removeQueuedTurn"), params: z.object({ threadId: z.string().min(1), queuedId: z.string().uuid() }) }),
  z.object({ id, method: z.literal("threads.clearQueue"), params: z.object({ threadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("threads.interruptTurn"), params: z.object({ threadId: z.string().min(1), clearQueue: z.boolean().default(true) }) }),
  z.object({ id, method: z.literal("threads.respondToRequest"), params: z.object({ threadId: z.string().min(1), requestId: z.string().min(1), optionId: z.string().optional() }) }),
  z.object({ id, method: z.literal("threads.setConfigOption"), params: z.object({ threadId: z.string().min(1), configId: z.string().min(1), value: z.union([z.string(), z.boolean()]) }) }),
  z.object({ id, method: z.literal("runtime.configDefaults"), params: z.object({ provider: activeProvider.default("kimi"), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional() }).default({ provider: "kimi" }) }),
  z.object({ id, method: z.literal("checkpoints.list"), params: z.object({ threadId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("checkpoints.revert"), params: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("checkpoints.review"), params: z.object({ threadId: z.string().min(1), turnId: z.string().min(1) }) }),
  z.object({ id, method: z.literal("checkpoints.revertPart"), params: z.object({ threadId: z.string().min(1), turnId: z.string().min(1), path: z.string().min(1).max(32_768), hunkIndex: z.number().int().min(0).optional() }) }),
  z.object({ id, method: z.literal("files.tree"), params: z.object({ cwd: z.string().min(1), query: z.string().max(200).default("") }) }),
  z.object({ id, method: z.literal("files.read"), params: z.object({ cwd: z.string().min(1), path: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.status"), params: z.object({ cwd: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.diff"), params: z.object({ cwd: z.string().min(1), path: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.stage"), params: z.object({ cwd: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(500) }) }),
  z.object({ id, method: z.literal("git.unstage"), params: z.object({ cwd: z.string().min(1), paths: z.array(z.string().min(1)).min(1).max(500) }) }),
  z.object({ id, method: z.literal("git.commit"), params: z.object({ cwd: z.string().min(1), message: z.string().trim().min(1).max(2000) }) }),
  z.object({ id, method: z.literal("git.repository"), params: z.object({ cwd: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.fetch"), params: z.object({ cwd: z.string().min(1), remote: z.string().trim().min(1).max(100) }) }),
  z.object({ id, method: z.literal("git.createBranch"), params: z.object({ cwd: z.string().min(1), branch: z.string().trim().min(1).max(200) }) }),
  z.object({ id, method: z.literal("git.switchBranch"), params: z.object({ cwd: z.string().min(1), branch: z.string().trim().min(1).max(200) }) }),
  z.object({ id, method: z.literal("git.checkoutRemoteBranch"), params: z.object({ cwd: z.string().min(1), remote: z.string().trim().min(1).max(100), branch: z.string().trim().min(1).max(200), localBranch: z.string().trim().min(1).max(200).optional() }) }),
  z.object({ id, method: z.literal("git.renameBranch"), params: z.object({ cwd: z.string().min(1), branch: z.string().trim().min(1).max(200), newBranch: z.string().trim().min(1).max(200) }) }),
  z.object({ id, method: z.literal("git.deleteBranch"), params: z.object({ cwd: z.string().min(1), branch: z.string().trim().min(1).max(200) }) }),
  z.object({ id, method: z.literal("git.push"), params: z.object({ cwd: z.string().min(1), remote: z.string().trim().min(1).max(100).optional() }) }),
  z.object({ id, method: z.literal("git.pull"), params: z.object({ cwd: z.string().min(1) }) }),
  z.object({ id, method: z.literal("git.clone"), params: z.object({ url: z.string().trim().min(1).max(2048), destination: z.string().min(1).max(32768) }) }),
  z.object({ id, method: z.literal("git.publish"), params: z.object({ cwd: z.string().min(1), name: z.string().trim().min(1).max(200), visibility: z.enum(["private", "public"]) }) }),
  z.object({ id, method: z.literal("git.createPullRequest"), params: z.object({ cwd: z.string().min(1), title: z.string().trim().min(1).max(300), body: z.string().max(20000).default(""), draft: z.boolean().default(true) }) }),
  z.object({ id, method: z.literal("terminal.start"), params: z.object({ cwd: z.string().min(1) }) }),
  z.object({ id, method: z.literal("terminal.write"), params: z.object({ sessionId: z.string().uuid(), command: z.string().min(1).max(4000) }) }),
  z.object({ id, method: z.literal("terminal.stop"), params: z.object({ sessionId: z.string().uuid() }) }),
  z.object({ id, method: z.literal("preview.agentCommand"), params: z.discriminatedUnion("action", [
    z.object({
      action: z.enum(["open", "resize"]),
      url: z.string().max(2_048).optional(),
      panelWidth: z.number().int().min(320).max(1_200).optional(),
      viewportWidth: z.number().int().min(320).max(1_920).optional(),
      viewportHeight: z.number().int().min(240).max(1_200).optional(),
    }),
    z.object({
      action: z.literal("request_skill_install"),
      cwd: z.string().min(1).max(32_768),
      source: z.string().min(1).max(32_768),
      name: z.string().trim().min(1).max(120),
    }),
  ]) }),
  z.object({ id, method: z.literal("usage.quota"), params: z.object({ instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional() }).default({}) }),
  z.object({ id, method: z.literal("diagnostics.snapshot"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("diagnostics.export"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("schedules.list"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("schedules.create"), params: z.object({ threadId: z.string().min(1), name: z.string().trim().min(1).max(120), text: z.string().trim().min(1).max(100_000), recurrence: z.enum(["once", "daily", "weekly"]), nextRunAt: z.string().datetime() }) }),
  z.object({ id, method: z.literal("schedules.update"), params: z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(120).optional(), text: z.string().trim().min(1).max(100_000).optional(), recurrence: z.enum(["once", "daily", "weekly"]).optional(), nextRunAt: z.string().datetime().optional(), enabled: z.boolean().optional() }) }),
  z.object({ id, method: z.literal("schedules.delete"), params: z.object({ id: z.string().uuid() }) }),
  z.object({ id, method: z.literal("schedules.run"), params: z.object({ id: z.string().uuid() }) }),
  z.object({ id, method: z.literal("environments.list"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("remote.status"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("remote.configure"), params: z.object({ enabled: z.boolean(), bind: z.enum(["127.0.0.1", "0.0.0.0"]), port: z.number().int().min(1024).max(65_535) }) }),
  z.object({ id, method: z.literal("remote.createPairing"), params: z.object({}).default({}) }),
  z.object({ id, method: z.literal("remote.revokeDevice"), params: z.object({ deviceId: z.string().uuid() }) }),
  z.object({ id, method: z.literal("capabilities.list"), params: z.object({ provider: activeProvider.default("kimi"), cwd: z.string().min(1).optional(), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional() }).default({ provider: "kimi" }) }),
  z.object({ id, method: z.literal("mcp.approveProject"), params: z.object({ cwd: z.string().min(1), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }) }),
  z.object({ id, method: z.literal("mcp.revokeProject"), params: z.object({ cwd: z.string().min(1), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional() }) }),
  z.object({ id, method: z.literal("skills.install"), params: z.object({ cwd: z.string().min(1), source: z.string().min(1), instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional() }) }),
]);
type ServerRequest = z.infer<typeof requestSchema>;
const persistedQueueSchema = z.record(z.string(), z.array(z.object({
  queuedId: z.string().uuid(),
  text: z.string().min(1).max(100_000),
  mentions: z.array(z.string()).max(20),
  mode: z.enum(["queue", "steer"]),
  createdAt: z.string().datetime(),
  origin: z.enum(["user", "background_task"]).optional(),
  submissionId: z.string().uuid().optional(),
})));
const threadCreationReservationSchema = z.object({
  creationId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: z.string().uuid(),
  provider: activeProvider,
  instanceId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i).optional(),
  standalone: z.boolean(),
  isolate: z.boolean(),
  targetCwd: z.string().min(1),
  sharedTargetKey: z.string().min(1).optional(),
  sourceCwd: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
  baselineSessionIds: z.array(z.string().min(1)).optional(),
  side: z.object({
    parentThreadId: z.string().min(1),
    title: z.string().min(1),
    kind: z.enum(["project", "chat"]),
    worktree: z.object({ sourceCwd: z.string().min(1), branch: z.string().min(1) }).optional(),
    inheritedConfig: z.record(z.string(), z.union([z.string(), z.boolean()])),
  }).optional(),
  stage: z.enum(["reserved", "ready", "requesting", "bound"]),
  sessionId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});
const threadCreationReceiptSchema = z.object({
  creationId: z.string().uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  threadId: z.string().uuid(),
});
const threadCreationJournalSchema = z.object({
  version: z.literal(1),
  reservations: z.array(threadCreationReservationSchema),
  receipts: z.array(threadCreationReceiptSchema).default([]),
});
type ThreadCreationReservation = z.infer<typeof threadCreationReservationSchema>;
type ThreadCreationReceipt = z.infer<typeof threadCreationReceiptSchema>;

const port = Number(process.env.KIMI_SERVER_PORT ?? 4317);
const serverToken = process.env.KIMI_SERVER_TOKEN;
const previewBridgeToken = process.env.KIMI_PREVIEW_BRIDGE_TOKEN || randomBytes(32).toString("hex");
const configuredDefaultCwd = process.env.KIMI_DEFAULT_CWD ?? process.env.KIMI_WORKSPACE;
const defaultCwd = configuredDefaultCwd === "" ? "" : resolve(configuredDefaultCwd ?? process.cwd());
const configuredDataHome = resolve(process.env.KIMI_DESKTOP_HOME ?? process.env.TASTY_HOME ?? join(process.env.APPDATA ?? homedir(), "KimiCodeDesktop"));
const configuredKimiHome = resolve(process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code"));
await mkdir(configuredDataHome, { recursive: true });
await mkdir(configuredKimiHome, { recursive: true });
const dataHome = await realpath(configuredDataHome);
const kimiHome = await realpath(configuredKimiHome);
const providerInstances = await readProviderInstances(join(dataHome, "provider-instances.json")).catch((error) => {
  console.error(`[providers] ${error instanceof Error ? error.message : String(error)}`);
  return [] as ProviderInstance[];
});
const privateKimiHomes = [...new Set([
  configuredKimiHome,
  kimiHome,
  ...providerInstances
    .filter((instance) => !instance.wsl && typeof instance.environment.KIMI_CODE_HOME === "string")
    .flatMap((instance) => {
      const alias = resolve(instance.environment.KIMI_CODE_HOME!);
      return [alias, canonicalExistingPath(alias)];
    }),
])];
const privateRuntimePaths = [
  defaultCwd,
  resolveKimiBinary(),
  ...providerInstances.flatMap((instance) => [instance.binary, instance.wsl?.binary, ...Object.values(instance.environment)]),
].filter((value): value is string => Boolean(value));
const diagnosticRedactionRoots = [homedir(), dataHome, kimiHome, ...privateKimiHomes, ...privateRuntimePaths];
const diagnostics = new DiagnosticJournal(diagnosticRedactionRoots);
const quotaProbeCwd = join(dataHome, "runtime", "quota-probe");
const standaloneChatCwd = join(dataHome, "runtime", "chats");
const configProbeCwd = join(dataHome, "runtime", "config-probe");
const queuePath = join(dataHome, "pending-queues.json");
const threadCreationJournalPath = join(dataHome, "pending-thread-creations.json");
const threadCreationReservations = new Map<string, ThreadCreationReservation>();
const threadCreationReceipts = new Map<string, ThreadCreationReceipt>();
let threadCreationJournalWrite: Promise<void> = Promise.resolve();
const sockets = new Set<WebSocket>();
const connectedSockets = new Set<WebSocket>();
const previewBridgeSockets = new WeakSet<WebSocket>();
const socketSeq = new WeakMap<WebSocket, number>();
const engine = new OrchestrationEngine(new EventStore(join(dataHome, "events.jsonl")));
const ingestion = new RuntimeIngestion(engine, (error) => {
  emitDiagnostic("error", error, "runtime-ingestion");
});
const checkpointReactor = new CheckpointReactor(findGitBinary(), dataHome);
const configDefaults = new Map<string, ConfigDefaults>();
const git = new GitService(findGitBinary());
const terminal = new TerminalService();
const wsl = new WslEnvironments();
const remoteAccess = new RemoteAccess(join(dataHome, "remote-access.json"));
await remoteAccess.open();
const schedules = new ScheduleStore(join(dataHome, "schedules.json"));
await schedules.open();
const mcpApprovals = new McpApprovalStore(join(dataHome, "project-mcp-approvals.json"));
await mcpApprovals.open();
const socketTerminals = new WeakMap<WebSocket, Set<string>>();
const remoteDeviceSockets = new Map<string, Set<WebSocket>>();
const remoteConnections = new Set<WebSocket>();
let remoteServer: WebSocketServer | undefined;
type QueuedTurn = {
  queuedId: string;
  text: string;
  mentions: string[];
  images: Array<{ name: string; mimeType: string; data: string }>;
  mode: "queue" | "steer";
  createdAt: string;
  origin: "user" | "background_task";
  submissionId?: string;
};
type SendTurnParams = Omit<QueuedTurn, "queuedId" | "createdAt" | "origin"> & { submissionId?: string };
type SendTurnResult = { accepted: true; queuedId: string; queued: boolean };
type CreateThreadParams = {
  cwd?: string | undefined;
  standalone: boolean;
  isolate: boolean;
  provider: "kimi";
  instanceId?: string | undefined;
  config?: Record<string, string | boolean> | undefined;
  creationId?: string | undefined;
  side?: {
    parentThreadId: string;
    title: string;
    kind: "project" | "chat";
    worktree?: ThreadWorktree;
    inheritedConfig: Record<string, string | boolean>;
  } | undefined;
};
type CreateSideThreadParams = { threadId: string; title?: string | undefined; creationId?: string | undefined };
const turnQueues = new Map<string, QueuedTurn[]>();
const queueInsertions = new QueueInsertionGate();
const submissionAdmissions = new Map<string, { fingerprint: string; promise: Promise<SendTurnResult> }>();
const creationAdmissions = new Map<string, { fingerprint: string; promise: Promise<ThreadProjection> }>();
const creationFingerprintAdmissions = new Map<string, string>();
const creationTargetAdmissions = new Map<string, string>();
type QueueAdmission = { queued: QueuedTurn; cancelled: boolean; restartRequested: boolean; turnId?: string };
const queueAdmissions = new Map<string, QueueAdmission>();
const gitWorkspaceActions = new Set([
  "git.stage", "git.unstage", "git.commit", "git.fetch", "git.createBranch", "git.switchBranch",
  "git.checkoutRemoteBranch", "git.renameBranch", "git.deleteBranch", "git.push", "git.pull",
  "git.publish", "git.createPullRequest",
]);
type GitWorkspaceLease = { root: string; commonDir?: string; pending: boolean };
const gitWorkspaceLeases = new Set<GitWorkspaceLease>();
type TurnCancellationOutcome = { safeToRestart: true } | { safeToRestart: false; error: string };
const turnCancellations = new Map<string, Promise<TurnCancellationOutcome>>();
const sessionResumes = new Map<string, Promise<SessionConfigOption[]>>();
const sessionConfigWrites = new Map<string, Promise<void>>();
type UpdateLease = { owner: WebSocket };
const queueWrites = { tail: Promise.resolve(), failureEpoch: 0 };
const runtimes = new Map<string, AgentRuntime>();
const runtimeStarts = new Map<string, Promise<AgentRuntime>>();
const runtimeEventSources = new Map<string, AgentRuntime>();
const lifecycleOperations = new Set<Promise<unknown>>();
let lifecycleOperationEpoch = 0;
const initializeResults = new Map<string, unknown>();
const runtimePolicyMutations = new Set<string>();
const runtimeOperationAdmissions = new Map<string, number>();
const quotaReads = new Map<string, Promise<Awaited<ReturnType<typeof readKimiQuota>>>>();
let backgroundTaskMutation: Promise<void> = Promise.resolve();
const configDefaultsProbes = new Map<string, { runtime: AgentRuntime; promise: Promise<SessionConfigOption[]> }>();
let updateLease: UpdateLease | undefined;
let authPolicyKeys: string[] | undefined;
let pendingSendAdmissions = 0;
let pendingThreadCreations = 0;
let scheduleMutationAdmissions = 0;
let shuttingDown = false;
let shutdownPromise: Promise<void> | undefined;
const auth = new AuthService(runtimeBinaryDescription(), process.env.KIMI_CODE_HOME, (event) => {
  startLifecycleOperation(() => handleAuthEvent(event), "auth-runtime-reset");
});

await engine.open();
await loadThreadCreationJournal();
await loadQueues();
engine.setPublisher((event) => {
  if (event.type !== "TurnSubmissionAccepted" && event.type !== "TurnSubmissionsRemoved" && event.type !== "TurnSubmissionsPayloadLost") {
    if (event.type === "ThreadCreated") {
      const { creationId: _creationId, creationFingerprint: _creationFingerprint, ...payload } = event.payload as Record<string, unknown>;
      const thread = engine.thread(event.threadId);
      const remotePayload = thread?.kind === "chat" ? { ...payload, cwd: remoteChatCwd(thread) } : payload;
      pushAll("orchestration.domainEvent", { ...event, payload }, { ...event, payload: remotePayload });
    } else if (event.type === "ThreadSnapshot") {
      const thread = (event.payload as { thread: ThreadProjection }).thread;
      pushAll(
        "orchestration.domainEvent",
        { ...event, payload: { thread: publicThread(thread) } },
        { ...event, payload: { thread: publicThread(thread, true) } },
      );
    } else if (event.type === "TurnStarted" || event.type === "MessageAppended" || event.type === "MessageDelta") {
      const payload = event.payload as { images?: Array<{ name: string; mimeType: string }> };
      pushAll("orchestration.domainEvent", {
        ...event,
        payload: {
          ...payload,
          ...(payload.images ? { images: publicImages(payload.images) } : {}),
        },
      });
    } else if (event.type === "TurnCompleted" || event.type === "TurnPhaseChanged") {
      const payload = event.payload as { error?: string };
      pushAll("orchestration.domainEvent", {
        ...event,
        payload: {
          ...payload,
          ...(payload.error ? { error: redactPrivateError(payload.error) } : {}),
        },
      });
    } else if (event.type === "BackgroundTaskRegistered") {
      const { kimiHome: _kimiHome, ...payload } = event.payload as Record<string, unknown>;
      pushAll("orchestration.domainEvent", { ...event, payload });
    } else if (event.type === "BackgroundTaskFinished") {
      const { outputPath: _outputPath, ...payload } = event.payload as Record<string, unknown>;
      pushAll("orchestration.domainEvent", { ...event, payload });
    } else if (event.type === "BackgroundTaskReportCancelled") {
      const payload = event.payload as { failure?: string };
      pushAll("orchestration.domainEvent", {
        ...event,
        payload: {
          ...payload,
          ...(payload.failure ? { failure: redactPrivateError(payload.failure) } : {}),
        },
      });
    } else {
      pushAll("orchestration.domainEvent", event);
    }
  }
  if (event.type === "ConfigOptionsReplaced") {
    const options = (event.payload as { options: SessionConfigOption[] }).options;
    pushAll("thread.configUpdated", { threadId: event.threadId, options });
  }
  if (event.type === "ThreadCreated" || event.type === "ConfigOptionsReplaced") {
    const thread = engine.thread(event.threadId);
    if (thread?.provider === "kimi") persistLiveConfigOptions(thread.provider, thread.instanceId, thread.configOptions);
  }
});
const backgroundTasks = new BackgroundTaskMonitor({
  pending: pendingBackgroundTasks,
  runOperation: trackLifecycleOperation,
  finished: async (task, result) => {
    await delayBackgroundTaskMonitorFinishForTest();
    await finishBackgroundTask(task, result);
  },
  onError: (error) => {
    emitDiagnostic("error", `Background task monitor failed: ${error instanceof Error ? error.message : String(error)}`, "background-tasks");
  },
});
await reconcileUnsupportedBackgroundTasks();
for (const thread of engine.threads()) {
  for (const task of thread.backgroundTasks.filter((candidate) => candidate.status !== "running" && !candidate.reportDeliveredAt && !candidate.reportCancelledAt)) {
    await engine.append(thread.threadId, { type: "BackgroundTaskReportCancelled", payload: { taskId: task.taskId } });
  }
}
backgroundTasks.start();
let checkingSchedules = false;
const scheduleTimer = setInterval(runDueSchedulesInBackground, 15_000);
scheduleTimer.unref();
runDueSchedulesInBackground();

function sendPush(socket: WebSocket, channel: string, payload: unknown): void {
  const seq = (socketSeq.get(socket) ?? 0) + 1;
  socketSeq.set(socket, seq);
  socket.send(JSON.stringify({ channel, seq, payload }));
}

function pushAll(channel: string, payload: unknown, remotePayload: unknown = payload): void {
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN) sendPush(socket, channel, remoteConnections.has(socket) ? remotePayload : payload);
  }
}

function pushLocal(channel: string, payload: unknown): void {
  for (const socket of sockets) {
    if (!remoteConnections.has(socket) && socket.readyState === socket.OPEN) sendPush(socket, channel, payload);
  }
}

function emitDiagnostic(level: DiagnosticLevel, message: unknown, source?: string): void {
  pushAll("server.diagnostics", { type: "diagnostic", ...diagnostics.record(level, message, source) });
}

function trackLifecycleOperation<T>(operation: () => Promise<T>): Promise<T> {
  let resolveTracked!: (value: T | PromiseLike<T>) => void;
  let rejectTracked!: (reason?: unknown) => void;
  const tracked = new Promise<T>((resolvePromise, rejectPromise) => {
    resolveTracked = resolvePromise;
    rejectTracked = rejectPromise;
  });
  lifecycleOperationEpoch += 1;
  lifecycleOperations.add(tracked);
  void tracked.then(
    () => { lifecycleOperations.delete(tracked); },
    () => { lifecycleOperations.delete(tracked); },
  );
  try {
    Promise.resolve(operation()).then(resolveTracked, rejectTracked);
  } catch (error) {
    rejectTracked(error);
  }
  return tracked;
}

function startLifecycleOperation(operation: () => Promise<unknown>, source: string): void {
  if (shuttingDown) return;
  void trackLifecycleOperation(operation).catch((error) => emitDiagnostic("error", error, source));
}

async function drainLifecycleOperations(): Promise<void> {
  while (true) {
    const epoch = lifecycleOperationEpoch;
    const tails = lifecycleMutationTails();
    await Promise.allSettled([...lifecycleOperations, ...runtimeStarts.values(), ...tails]);
    await Promise.resolve();
    const nextTails = lifecycleMutationTails();
    if (lifecycleOperations.size === 0
      && runtimeStarts.size === 0
      && lifecycleOperationEpoch === epoch
      && tails.length === nextTails.length
      && tails.every((tail, index) => tail === nextTails[index])) return;
  }
}

function lifecycleMutationTails(): Promise<unknown>[] {
  return [
    threadCreationJournalWrite,
    queueWrites.tail,
    backgroundTaskMutation,
    ...sessionConfigWrites.values(),
    ...Array.from(creationAdmissions.values(), (admission) => admission.promise),
    ...Array.from(submissionAdmissions.values(), (admission) => admission.promise),
  ];
}

function runDueSchedulesInBackground(): void {
  if (shuttingDown) return;
  startLifecycleOperation(runDueSchedules, "schedules");
}

function recordRemoteTelemetry(operation: () => Promise<unknown>): Promise<void> {
  return trackLifecycleOperation(operation)
    .then(() => undefined)
    .catch((error) => emitDiagnostic("error", error, "remote-access"));
}

function reply(socket: WebSocket, requestId: string | number, result?: unknown, error?: unknown): void {
  if (socket.readyState !== socket.OPEN) return;
  const projectedError = error && remoteConnections.has(socket) ? publicRpcError(error) : error;
  socket.send(JSON.stringify(projectedError ? { id: requestId, error: projectedError } : { id: requestId, result }));
}

function redactPrivateText(value: unknown, maxLength = 2_000): string {
  return redactDiagnosticText(value, diagnosticRedactionRoots, maxLength);
}

function redactPrivateError(value: unknown, maxLength = 2_000): string {
  return redactPrivateErrorText(value, diagnosticRedactionRoots, maxLength);
}

function publicRpcError(error: unknown): { code: number; message: string } {
  if (!error || typeof error !== "object") return { code: -32000, message: redactPrivateError(error) };
  const value = error as { code?: unknown; message?: unknown };
  return {
    code: typeof value.code === "number" ? value.code : -32000,
    message: redactPrivateError(value.message ?? "Request failed"),
  };
}

function acquireUpdateLease(owner: WebSocket): void {
  updateLease = { owner };
}

function releaseUpdateLease(owner: WebSocket): boolean {
  if (!updateLease || updateLease.owner !== owner) return false;
  updateLease = undefined;
  backgroundTasks.wake();
  runDueSchedulesInBackground();
  for (const threadId of turnQueues.keys()) startNextQueued(threadId);
  return true;
}

function runtimeKey(provider: ProviderId, instanceId?: string): string {
  return instanceId ? `${provider}:${instanceId}` : provider;
}

function runtimeSessionOperationKey(provider: ProviderId, instanceId: string | undefined, sessionId: string): string {
  return JSON.stringify([provider, instanceId ?? null, sessionId]);
}

function wakeRuntimePolicyWork(): void {
  backgroundTasks.wake();
  runDueSchedulesInBackground();
  for (const thread of engine.threads()) {
    if (!runtimePolicyMutations.has(runtimeKey(thread.provider, thread.instanceId)) && (turnQueues.get(thread.threadId)?.length ?? 0) > 0) {
      startNextQueued(thread.threadId);
    }
  }
}

function releaseRuntimePolicyMutations(keys: Iterable<string>, wake = true): void {
  let released = false;
  for (const key of keys) released = runtimePolicyMutations.delete(key) || released;
  if (released && wake) wakeRuntimePolicyWork();
}

function runtimePolicyBlockers(key: string, includeWorkspaceWork = true): Record<string, number> {
  const threads = engine.threads().filter((thread) => runtimeKey(thread.provider, thread.instanceId) === key);
  const sessionKeys = new Set(threads.map((thread) => runtimeSessionOperationKey(thread.provider, thread.instanceId, thread.sessionId)));
  return {
    update: Number(Boolean(updateLease)),
    operations: runtimeOperationAdmissions.get(key) ?? 0,
    runtimeStart: Number(runtimeStarts.has(key)),
    work: includeWorkspaceWork ? threads.filter((thread) => threadHasWorkspaceWork(thread)).length : 0,
    queueInsertions: threads.filter((thread) => queueInsertions.hasAny(thread.threadId)).length,
    schedules: Number(checkingSchedules),
    sessionResumes: [...sessionResumes.keys()].filter((sessionKey) => sessionKeys.has(sessionKey)).length,
    configWrites: [...sessionConfigWrites.keys()].filter((sessionKey) => sessionKeys.has(sessionKey)).length,
    configProbes: Number(configDefaultsProbes.has(key)),
    creations: [...threadCreationReservations.values()].filter((reservation) => runtimeKey(reservation.provider, reservation.instanceId) === key).length,
  };
}

function reserveRuntimePolicyMutations(targets: ReadonlyArray<{ provider: ProviderId; instanceId?: string }>): string[] {
  const keys = [...new Set(targets.map((target) => runtimeKey(target.provider, target.instanceId)))].sort();
  const added: string[] = [];
  for (const key of keys) {
    if (runtimePolicyMutations.has(key)) {
      for (const addedKey of added) runtimePolicyMutations.delete(addedKey);
      throw new Error("Project MCP policy is already being updated for an affected Kimi runtime");
    }
    runtimePolicyMutations.add(key);
    added.push(key);
  }
  return keys;
}

function acquireRuntimePolicyMutations(
  targets: ReadonlyArray<{ provider: ProviderId; instanceId?: string }>,
  includeWorkspaceWork = true,
  action = "changing project MCP access",
): string[] {
  const keys = reserveRuntimePolicyMutations(targets);
  const active = keys.flatMap((key) => Object.entries(runtimePolicyBlockers(key, includeWorkspaceWork))
    .filter(([, count]) => count > 0)
    .map(([name, count]) => [`${key}.${name}`, count] as const));
  if (active.length) {
    for (const key of keys) runtimePolicyMutations.delete(key);
    throw new Error(`Finish active Kimi work before ${action} (${active.map(([name, count]) => `${name}=${count}`).join(", ")})`);
  }
  return keys;
}

function allKnownKimiRuntimeTargets(): Array<{ provider: ProviderId; instanceId?: string }> {
  // ponytail: approval is rare; keep one global writer until measured contention justifies per-root gates.
  const keys = new Set<string>(["kimi", ...providerInstances.map((instance) => runtimeKey("kimi", instance.id))]);
  for (const key of [...runtimes.keys(), ...runtimeStarts.keys(), ...runtimeOperationAdmissions.keys(), ...configDefaultsProbes.keys()]) keys.add(key);
  for (const thread of engine.threads()) if (thread.provider === "kimi") keys.add(runtimeKey(thread.provider, thread.instanceId));
  for (const reservation of threadCreationReservations.values()) keys.add(runtimeKey(reservation.provider, reservation.instanceId));
  return [...keys].sort().map((key) => key === "kimi"
    ? { provider: "kimi" }
    : { provider: "kimi", instanceId: key.slice("kimi:".length) });
}

function affectedRuntimeTargets(root: string, selectedInstanceId?: string): Array<{ provider: ProviderId; instanceId?: string }> {
  const comparableRoot = comparablePath(root);
  const targets = new Map<string, { provider: ProviderId; instanceId?: string }>();
  const add = (provider: ProviderId, instanceId?: string) => {
    if (instanceId && providerInstances.find((instance) => instance.provider === provider && instance.id === instanceId)?.wsl) return;
    targets.set(runtimeKey(provider, instanceId), { provider, ...(instanceId ? { instanceId } : {}) });
  };
  add("kimi", selectedInstanceId);
  for (const thread of engine.threads()) {
    if (thread.provider === "kimi" && threadTouchesPath(thread, comparableRoot)) add(thread.provider, thread.instanceId);
  }
  for (const reservation of threadCreationReservations.values()) {
    const paths = [reservation.targetCwd, ...(reservation.sourceCwd ? [reservation.sourceCwd] : [])];
    if (reservation.provider === "kimi" && paths.some((path) => pathsOverlap(comparablePath(path), comparableRoot))) add(reservation.provider, reservation.instanceId);
  }
  return [...targets.values()];
}

function assertAffectedRuntimesIdle(targets: ReadonlyArray<{ provider: ProviderId; instanceId?: string }>): void {
  const keys = new Set(targets.map((target) => runtimeKey(target.provider, target.instanceId)));
  const active = engine.threads().filter((thread) => keys.has(runtimeKey(thread.provider, thread.instanceId)) && threadHasWorkspaceWork(thread));
  if (active.length) throw new Error(`Finish active Kimi work in this project before changing MCP access (work=${active.length})`);
}

function configDefaultsFor(provider: ProviderId, instanceId?: string): ConfigDefaults {
  const key = runtimeKey(provider, instanceId);
  let store = configDefaults.get(key);
  if (!store) {
    const filename = instanceId ? `runtime-defaults-${provider}-${instanceId}.json` : "runtime-defaults.json";
    store = new ConfigDefaults(join(dataHome, filename));
    configDefaults.set(key, store);
  }
  return store;
}

function providerInstance(provider: ProviderId, instanceId?: string): ProviderInstance | undefined {
  if (!instanceId) return undefined;
  const instance = providerInstances.find((candidate) => candidate.id === instanceId && candidate.provider === provider);
  if (!instance) throw new Error(`Unknown ${providerName(provider)} instance ${instanceId}`);
  return instance;
}

function effectiveKimiHome(provider: ProviderId, instanceId?: string): string {
  return providerInstance(provider, instanceId)?.environment.KIMI_CODE_HOME ?? kimiHome;
}

async function projectedKimiCapabilities(instanceId?: string, cwd?: string) {
  const instance = providerInstance("kimi", instanceId);
  if (instance?.wsl) return readWslKimiCapabilities(cwd);
  const capabilities = await readKimiCapabilities(effectiveKimiHome("kimi", instanceId), cwd);
  if (!capabilities.projectMcp) return capabilities;
  if (capabilities.projectMcp.status !== "required" || !capabilities.projectMcp.fingerprint) return capabilities;
  const approval = await mcpApprovals.status(capabilities.projectMcp.root, capabilities.projectMcp.fingerprint);
  const status = approval.approved ? "approved" as const : approval.changed ? "changed" as const : "required" as const;
  return { ...capabilities, projectMcp: { ...capabilities.projectMcp, status } };
}

function assertRuntimePolicyAvailable(provider: ProviderId, instanceId?: string): void {
  const key = runtimeKey(provider, instanceId);
  if (authPolicyKeys?.includes(key)) {
    throw new Error("Kimi sign-in is preparing a fresh runtime; retry when it finishes");
  }
  if (runtimePolicyMutations.has(key)) {
    throw new Error("Project MCP policy is being updated for this Kimi runtime; retry when it finishes");
  }
}

function providerRuntimeReady(provider: ProviderId): boolean {
  return [...runtimes].some(([key, runtime]) => (key === provider || key.startsWith(`${provider}:`)) && runtime.isOpen());
}

async function publicProviderInstances(): Promise<Array<{ id: string; name: string; provider: ProviderId; installed: boolean; runtimeReady: boolean; environment?: string }>> {
  const distributions = providerInstances.some((instance) => instance.wsl) ? await wsl.list() : [];
  return providerInstances.map(({ id, name, provider, binary, wsl: configuredWsl }) => ({
    id, name, provider,
    installed: configuredWsl ? Boolean(distributions.find((distribution) => distribution.name === configuredWsl.distribution)?.healthy) : Boolean(binary ?? resolveProviderBinary(provider)),
    runtimeReady: Boolean(runtimes.get(runtimeKey(provider, id))?.isOpen()),
    ...(configuredWsl ? { environment: `WSL · ${configuredWsl.distribution}` } : {}),
  }));
}

function remoteProviderDescriptors() {
  return providerDescriptors().map(({ binary: _binary, ...provider }) => provider);
}

function remoteAuthStatus(status = auth.status()) {
  const { home: _home, ...projected } = status;
  return projected;
}

async function ensureRuntime(provider: ProviderId = "kimi", instanceId?: string): Promise<AgentRuntime> {
  if (shuttingDown) throw new Error("Server is shutting down");
  assertKimiProvider(provider);
  assertRuntimePolicyAvailable(provider, instanceId);
  const key = runtimeKey(provider, instanceId);
  const current = runtimes.get(key);
  if (current?.isOpen()) return current;
  const pending = runtimeStarts.get(key);
  if (pending) return pending;
  const starting = startRuntime(provider, instanceId).finally(() => runtimeStarts.delete(key));
  runtimeStarts.set(key, starting);
  return starting;
}

async function startRuntime(provider: "kimi", instanceId?: string): Promise<AgentRuntime> {
  if (shuttingDown) throw new Error("Server is shutting down");
  const key = runtimeKey(provider, instanceId);
  const instance = providerInstance(provider, instanceId);
  const runtimeKimiHome = effectiveKimiHome(provider, instanceId);
  const stale = runtimes.get(key);
  if (stale) {
    await stale.close();
    if (runtimeEventSources.get(key) === stale) runtimeEventSources.delete(key);
    if (runtimes.get(key) === stale) runtimes.delete(key);
  }
  if (shuttingDown) throw new Error("Server is shutting down");
  initializeResults.delete(key);
  configDefaultsFor(provider, instanceId).invalidateLiveDefaults();
  const currentFile = fileURLToPath(import.meta.url);
  const useFake = process.env.KIMI_FAKE === "1";
  const fakePath = join(dirname(currentFile), currentFile.endsWith(".ts") ? "fake-acp.ts" : "fake-acp.js");
  let client: AgentRuntime;
  const runtimeEvents = {
    onEvent: (event: RuntimeEvent) => {
      if (shuttingDown) return Promise.resolve();
      return trackLifecycleOperation(async () => {
        try {
          await onRuntimeEvent(provider, instanceId, client, event);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[${provider}:event] ${message}`);
          emitDiagnostic("error", `Runtime event persistence failed: ${message}`, `${provider}-runtime`);
          throw error;
        }
      });
    },
    onClose: () => {
      if (runtimeEventSources.get(key) === client) runtimeEventSources.delete(key);
      if (runtimes.get(key) !== client) return;
      runtimes.delete(key);
      initializeResults.delete(key);
      configDefaultsFor(provider, instanceId).invalidateLiveDefaults();
      clearRuntimeSessionResumes(provider, instanceId);
    },
  };
  const wslRuntime = instance?.wsl;
  client = new AcpClient({
    binary: useFake ? process.execPath : wslRuntime ? wsl.binary : requireProviderBinary(provider, instance?.binary),
    args: useFake ? (currentFile.endsWith(".ts") ? ["--import", "tsx", fakePath] : [fakePath]) : wslRuntime ? ["--distribution", wslRuntime.distribution, "--exec", wslRuntime.binary, "acp"] : ["acp"],
    ...(instance ? { env: instance.environment } : {}),
    ...(wslRuntime ? {
      scrubWslHomeEnvironment: true,
      cwdToAgent: (path: string) => wsl.toLinux(wslRuntime.distribution, path),
      pathFromAgent: (path: string) => wsl.toWindows(wslRuntime.distribution, path),
    } : {}),
    ...(!wslRuntime ? { kimiCodeHome: runtimeKimiHome } : {}),
    ...(!wslRuntime ? { mcpServers: async (workspace: string) => {
      const project = await readProjectMcpBundle(workspace);
      const approval = project?.status === "required" && project.fingerprint
        ? await mcpApprovals.status(project.root, project.fingerprint)
        : undefined;
      const configured = await readKimiMcpServers(runtimeKimiHome, workspace, approval?.approved ? project?.fingerprint ?? undefined : undefined);
      return [
        createDesktopPreviewMcpServer(
          import.meta.url,
          `ws://127.0.0.1:${port}?preview-token=${previewBridgeToken}`,
          workspace,
          runtimeKimiHome,
        ),
        ...configured.filter((server) => server.name !== desktopPreviewMcpName),
      ];
    } } : {}),
    ...runtimeEvents,
  });
  if (shuttingDown) {
    await client.close();
    throw new Error("Server is shutting down");
  }
  runtimeEventSources.set(key, client);
  try {
    const initialized = await client.start();
    if (shuttingDown || runtimeEventSources.get(key) !== client) {
      await client.close();
      throw new Error("Server is shutting down");
    }
    initializeResults.set(key, initialized);
    runtimes.set(key, client);
    return client;
  } catch (error) {
    if (runtimeEventSources.get(key) === client) runtimeEventSources.delete(key);
    await client.close();
    throw error;
  }
}

async function onRuntimeEvent(provider: ProviderId, instanceId: string | undefined, sourceRuntime: AgentRuntime, event: RuntimeEvent): Promise<void> {
  if (process.env.KIMI_FAKE === "1" && event.type === "diagnostic" && event.message.includes("__STALE_RUNTIME_DIAGNOSTIC__")) {
    const delay = Number(process.env.KIMI_FAKE_STALE_DIAGNOSTIC_DELAY_MS ?? 0);
    if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
  }
  const key = runtimeKey(provider, instanceId);
  const sourceIsCurrent = () => runtimeEventSources.get(key) === sourceRuntime;
  if (!sourceIsCurrent()) return;
  if (event.type === "diagnostic") {
    (event.level === "error" ? console.error : console.info)(`[${key}:${event.level}] ${event.message}`);
    if (event.level === "error") {
      const diagnostic = diagnostics.record("error", event.message, `${key}-runtime`);
      if (!isTransientWindowsSpawnError(event.message)) pushAll("server.diagnostics", { type: "diagnostic", ...diagnostic });
    }
    return;
  }
  const threadId = await ingestion.ingest(event, { provider, ...(instanceId ? { instanceId } : {}) }, { generation: sourceRuntime, isCurrent: sourceIsCurrent });
  if (!threadId || !sourceIsCurrent()) return;
  if (event.type === "session_update"
    && (event.params.update.sessionUpdate === "tool_call" || event.params.update.sessionUpdate === "tool_call_update")) {
    await ingestion.flush(threadId);
    if (!sourceIsCurrent()) return;
    const thread = engine.thread(threadId);
    if (thread?.activeTurnId) {
      await registerBackgroundTasks(thread.threadId, event.params.sessionId, thread.activeTurnId, provider, instanceId, sourceIsCurrent);
    }
  }
}

function requestRuntimeTarget(request: ServerRequest): { provider: ProviderId; instanceId?: string } | undefined {
  if (request.method === "env.bootstrap") return { provider: "kimi" };
  if (request.method === "usage.quota") return { provider: "kimi", ...(request.params.instanceId ? { instanceId: request.params.instanceId } : {}) };
  if (request.method === "schedules.run") {
    const schedule = schedules.get(request.params.id);
    const thread = schedule ? engine.thread(schedule.threadId) : undefined;
    return thread ? { provider: thread.provider, ...(thread.instanceId ? { instanceId: thread.instanceId } : {}) } : undefined;
  }
  if (request.method === "threads.create" || request.method === "threads.list" || request.method === "runtime.configDefaults") {
    return { provider: "kimi", ...(request.params.instanceId ? { instanceId: request.params.instanceId } : {}) };
  }
  if (request.method === "threads.resume") {
    const existing = engine.thread(request.params.threadId);
    const instanceId = existing?.instanceId ?? request.params.instanceId;
    return { provider: existing?.provider ?? "kimi", ...(instanceId ? { instanceId } : {}) };
  }
  if ([
    "threads.createSide", "threads.delete", "threads.sendTurn", "threads.steerQueuedTurn", "threads.interruptTurn", "threads.respondToRequest", "threads.setConfigOption",
    "subagents.inspect", "subagents.stop",
  ].includes(request.method)) {
    const threadId = (request.params as { threadId: string }).threadId;
    const thread = engine.thread(threadId);
    const reservation = request.method === "threads.createSide" && request.params.creationId
      ? threadCreationReservations.get(request.params.creationId)
      : undefined;
    const target = thread ?? reservation;
    return target ? { provider: target.provider, ...(target.instanceId ? { instanceId: target.instanceId } : {}) } : undefined;
  }
  return undefined;
}

function beginRuntimeOperation(target: { provider: ProviderId; instanceId?: string }): string {
  if (updateLease) throw new Error("An app update is prepared; runtime operations are temporarily paused");
  assertRuntimePolicyAvailable(target.provider, target.instanceId);
  const key = runtimeKey(target.provider, target.instanceId);
  runtimeOperationAdmissions.set(key, (runtimeOperationAdmissions.get(key) ?? 0) + 1);
  return key;
}

function endRuntimeOperation(key: string): void {
  const remaining = (runtimeOperationAdmissions.get(key) ?? 1) - 1;
  if (remaining > 0) runtimeOperationAdmissions.set(key, remaining);
  else runtimeOperationAdmissions.delete(key);
}

async function handle(socket: WebSocket, input: unknown): Promise<void> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) {
    socket.send(JSON.stringify({ error: { code: -32602, message: "Invalid request", details: parsed.error.issues } }));
    return;
  }
  const request = parsed.data;
  if (shuttingDown) {
    reply(socket, request.id, undefined, { code: -32000, message: "Server is shutting down" });
    return;
  }
  if (previewBridgeSockets.has(socket) && request.method !== "preview.agentCommand") {
    reply(socket, request.id, undefined, { code: -32601, message: "Preview bridge may only call preview.agentCommand" });
    return;
  }
  let runtimeOperationKey: string | undefined;
  let sendAdmitted = false;
  let creationAdmitted = false;
  let scheduleMutationAdmitted = false;
  let gitWorkspaceLease: GitWorkspaceLease | undefined;
  if (request.method === "threads.sendTurn") {
    if (updateLease) {
      reply(socket, request.id, undefined, { code: -32000, message: "An app update is prepared; sending is temporarily paused" });
      return;
    }
    pendingSendAdmissions += 1;
    sendAdmitted = true;
  }
  if (request.method === "threads.create" || request.method === "threads.createSide") {
    if (updateLease) {
      reply(socket, request.id, undefined, { code: -32000, message: "An app update is prepared; creating chats is temporarily paused" });
      return;
    }
    pendingThreadCreations += 1;
    creationAdmitted = true;
  }
  if (request.method === "schedules.create" || request.method === "schedules.update" || request.method === "schedules.delete") {
    if (updateLease) {
      if (sendAdmitted) pendingSendAdmissions -= 1;
      if (creationAdmitted) pendingThreadCreations -= 1;
      reply(socket, request.id, undefined, { code: -32000, message: "An app update is prepared; schedule changes are temporarily paused" });
      return;
    }
    scheduleMutationAdmissions += 1;
    scheduleMutationAdmitted = true;
  }
  const runtimeTarget = requestRuntimeTarget(request);
  if (runtimeTarget) {
    try {
      runtimeOperationKey = beginRuntimeOperation(runtimeTarget);
    } catch (error) {
      if (sendAdmitted) pendingSendAdmissions -= 1;
      if (creationAdmitted) pendingThreadCreations -= 1;
      reply(socket, request.id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) });
      return;
    }
  }
  try {
    if (gitWorkspaceActions.has(request.method)) {
      gitWorkspaceLease = await acquireGitWorkspaceLease((request.params as { cwd: string }).cwd);
    }
    if (request.method === "env.prepareUpdate") {
      if (updateLease?.owner === socket) {
        reply(socket, request.id, { ready: true });
        return;
      }
      if (updateLease) throw new Error("Another app window is already preparing an update");
      acquireUpdateLease(socket);
      const blockers = updateBlockers();
      if (Object.values(blockers).some((count) => count > 0)) {
        releaseUpdateLease(socket);
        const active = Object.entries(blockers).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`).join(", ");
        throw new Error(`Cannot prepare update while work is active (${active})`);
      }
      reply(socket, request.id, { ready: true });
      return;
    }
    if (request.method === "env.confirmUpdate") {
      if (!updateLease || updateLease.owner !== socket) throw new Error("Only the app window preparing the update can confirm it");
      const blockers = updateBlockers();
      if (Object.values(blockers).some((count) => count > 0)) {
        const active = Object.entries(blockers).filter(([, count]) => count > 0).map(([name, count]) => `${name}=${count}`).join(", ");
        throw new Error(`Cannot install update while work is active (${active})`);
      }
      reply(socket, request.id, { ready: true });
      return;
    }
    if (request.method === "env.cancelUpdate") {
      if (updateLease && updateLease.owner !== socket) throw new Error("Only the app window preparing the update can cancel it");
      reply(socket, request.id, { cancelled: releaseUpdateLease(socket) });
      return;
    }
    if (request.method === "env.bootstrap") {
      const authStatus = process.env.KIMI_FAKE === "1" ? { ...auth.status(), installed: true, authenticated: true } : auth.status();
      let runtimeError: string | undefined;
      if (process.env.KIMI_FAKE === "1" || authStatus.authenticated) {
        try {
          await ensureRuntime();
        } catch (error) {
          runtimeError = error instanceof Error ? error.message : String(error);
        }
      }
      for (const threadId of turnQueues.keys()) startNextQueued(threadId);
      if (remoteConnections.has(socket)) {
        reply(socket, request.id, {
          providers: remoteProviderDescriptors(),
          instances: await publicProviderInstances(),
          auth: remoteAuthStatus(authStatus),
          degraded: Boolean(runtimeError),
          ...(runtimeError ? { runtimeError: "Kimi runtime is unavailable" } : {}),
        });
        return;
      }
      reply(socket, request.id, {
        initialize: initializeResults.get("kimi"),
        binary: runtimeBinaryDescription(),
        providers: providerDescriptors(),
        instances: await publicProviderInstances(),
        defaultCwd,
        auth: authStatus,
        degraded: Boolean(runtimeError),
        ...(runtimeError ? { runtimeError: runtimeError.slice(0, 2_000) } : {}),
      });
      return;
    }
    if (request.method === "env.installCli") {
      reply(socket, request.id, auth.beginInstall());
      return;
    }
    if (request.method === "auth.beginLogin") {
      if (updateLease) throw new Error("An app update is prepared; sign-in is temporarily paused");
      if (authPolicyKeys) throw new Error("Kimi sign-in is already preparing its runtime");
      const targets = allKnownKimiRuntimeTargets();
      const policyKeys = acquireRuntimePolicyMutations(targets, true, "signing in");
      authPolicyKeys = policyKeys;
      let status: ReturnType<AuthService["beginLogin"]>;
      try {
        await resetRuntimeTargets(targets);
        status = auth.beginLogin();
      } catch (error) {
        authPolicyKeys = undefined;
        releaseRuntimePolicyMutations(policyKeys);
        throw error;
      }
      reply(socket, request.id, status);
      return;
    }
    if (request.method === "auth.cancel") {
      auth.cancel();
      reply(socket, request.id, auth.status());
      return;
    }
    if (request.method === "auth.logout") {
      try {
        await resetRuntime();
        reply(socket, request.id, auth.logout());
      } finally {
        wakeRuntimePolicyWork();
      }
      return;
    }
    if (request.method === "preview.agentCommand") {
      if (request.params.action === "request_skill_install") {
        pushAll("skill.installRequested", request.params);
        reply(socket, request.id, { accepted: true });
        return;
      }
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
    if (request.method === "git.repository") {
      reply(socket, request.id, await git.repository(request.params.cwd));
      return;
    }
    if (request.method === "git.fetch") {
      reply(socket, request.id, await git.fetch(request.params.cwd, request.params.remote));
      return;
    }
    if (request.method === "git.createBranch") {
      reply(socket, request.id, await git.createBranch(request.params.cwd, request.params.branch));
      return;
    }
    if (request.method === "git.switchBranch") {
      reply(socket, request.id, await git.switchBranch(request.params.cwd, request.params.branch));
      return;
    }
    if (request.method === "git.checkoutRemoteBranch") {
      reply(socket, request.id, await git.checkoutRemoteBranch(request.params.cwd, request.params.remote, request.params.branch, request.params.localBranch));
      return;
    }
    if (request.method === "git.renameBranch") {
      reply(socket, request.id, await git.renameBranch(request.params.cwd, request.params.branch, request.params.newBranch));
      return;
    }
    if (request.method === "git.deleteBranch") {
      reply(socket, request.id, await git.deleteBranch(request.params.cwd, request.params.branch));
      return;
    }
    if (request.method === "git.push") {
      reply(socket, request.id, await git.push(request.params.cwd, request.params.remote));
      return;
    }
    if (request.method === "git.pull") {
      reply(socket, request.id, await git.pull(request.params.cwd));
      return;
    }
    if (request.method === "git.clone") {
      gitWorkspaceLease = acquireWorkspaceLease(comparablePath(request.params.destination));
      reply(socket, request.id, await git.clone(request.params.url, request.params.destination));
      return;
    }
    if (request.method === "git.publish") {
      reply(socket, request.id, await git.publish(request.params.cwd, request.params.name, request.params.visibility));
      return;
    }
    if (request.method === "git.createPullRequest") {
      reply(socket, request.id, await git.createPullRequest(request.params.cwd, request.params.title, request.params.body, request.params.draft));
      return;
    }
    if (request.method === "usage.quota") {
      const instance = providerInstance("kimi", request.params.instanceId);
      if (instance?.wsl) throw new Error("Quota probing is not supported for WSL Kimi instances yet");
      const key = runtimeKey("kimi", request.params.instanceId);
      let pending = quotaReads.get(key);
      if (!pending) {
        const runtimeHome = canonicalExistingPath(effectiveKimiHome("kimi", request.params.instanceId));
        const started = (async () => {
          if (process.env.KIMI_FAKE === "1") {
            const delay = Number(process.env.KIMI_FAKE_QUOTA_DELAY_MS ?? 0);
            if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
          }
          return readKimiQuota({
            binary: process.env.KIMI_FAKE === "1" ? "fake" : resolve(instance?.binary ?? resolveKimiBinary()),
            kimiHome: runtimeHome,
            cwd: quotaProbeCwd,
            cachePath: quotaCachePathFor(key, runtimeHome),
          });
        })();
        pending = started.finally(() => {
          if (quotaReads.get(key) === pending) quotaReads.delete(key);
        });
        quotaReads.set(key, pending);
      }
      reply(socket, request.id, await pending);
      return;
    }
    if (request.method === "diagnostics.snapshot") {
      reply(socket, request.id, { diagnostics: diagnostics.snapshot(), blockers: updateBlockers(), environments: await wsl.list() });
      return;
    }
    if (request.method === "diagnostics.export") {
      const threads = engine.threads();
      const path = await diagnostics.export(dataHome, {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        threadCount: threads.length,
        activeTurns: threads.filter((thread) => thread.running).length,
        queuedTurns: [...turnQueues.values()].reduce((total, queue) => total + queue.length, 0),
        runtimeProviders: [...runtimes.entries()].filter(([, runtime]) => runtime.isOpen()).map(([provider]) => provider).join(",") || "none",
      }, [...privateKimiHomes, ...privateRuntimePaths, ...storedTaskKimiHomes(threads), ...threadWorkspacePaths(threads)]);
      reply(socket, request.id, { path });
      return;
    }
    if (request.method === "threads.export") {
      const allThreads = engine.threads();
      const requested = request.params.threadIds ? new Set(request.params.threadIds) : undefined;
      const threads = allThreads.filter((candidate) => !requested || requested.has(candidate.threadId));
      if (requested && threads.length !== requested.size) throw new Error("One or more chats no longer exist");
      const path = await exportSessionArchive(
        join(dataHome, "exports"),
        threads.map((candidate) => ({ ...candidate, queue: queueSummary(candidate.threadId) })),
        [homedir(), dataHome, kimiHome, ...privateKimiHomes, ...privateRuntimePaths, ...storedTaskKimiHomes(allThreads), ...threadWorkspacePaths(allThreads)],
      );
      reply(socket, request.id, { path, threadCount: threads.length });
      return;
    }
    if (request.method === "schedules.list") {
      reply(socket, request.id, { schedules: schedules.list() });
      return;
    }
    if (request.method === "schedules.create") {
      const target = engine.thread(request.params.threadId);
      if (!target || target.archivedAt) throw new Error("Choose an active chat for this schedule");
      assertKimiProvider(target.provider);
      const permission = target.configOptions.find((option) => option.id.toLowerCase() === "mode" || option.category?.toLowerCase() === "mode")?.currentValue;
      await delayScheduleMutationForTest();
      const schedule = await schedules.create({
        ...request.params,
        ...scheduleTarget(target.provider, target.cwd, target.instanceId),
        ...(permission !== undefined ? { permission: String(permission) } : {}),
      });
      reply(socket, request.id, { schedule });
      return;
    }
    if (request.method === "schedules.update") {
      const { id: scheduleId, name, text, recurrence, nextRunAt, enabled } = request.params;
      if (enabled) {
        const schedule = schedules.get(scheduleId);
        const target = schedule ? engine.thread(schedule.threadId) : undefined;
        if (!schedule || !target) throw new Error("The scheduled chat is unavailable");
        assertKimiProvider(target.provider);
      }
      const patch = {
        ...(name !== undefined ? { name } : {}), ...(text !== undefined ? { text } : {}),
        ...(recurrence !== undefined ? { recurrence } : {}), ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      };
      await delayScheduleMutationForTest();
      reply(socket, request.id, { schedule: await schedules.update(scheduleId, patch) });
      return;
    }
    if (request.method === "schedules.delete") {
      await delayScheduleMutationForTest();
      await schedules.delete(request.params.id);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "schedules.run") {
      const schedule = schedules.get(request.params.id);
      if (!schedule) throw new Error("Schedule was not found");
      await enqueueScheduledTurn(schedule);
      reply(socket, request.id, { accepted: true });
      return;
    }
    if (request.method === "environments.list") {
      reply(socket, request.id, { environments: await wsl.list() });
      return;
    }
    if (request.method === "remote.status") {
      reply(socket, request.id, remoteStatus());
      return;
    }
    if (request.method === "remote.configure") {
      const config = request.params as RemoteConfig;
      if (config.enabled && config.bind === "0.0.0.0") throw new Error("Remote access requires TLS for non-loopback binding");
      const previous = remoteAccess.status().config;
      await replaceRemoteServer(config);
      try { await remoteAccess.configure(config); }
      catch (error) { await replaceRemoteServer(previous); throw error; }
      reply(socket, request.id, remoteStatus());
      return;
    }
    if (request.method === "remote.createPairing") {
      if (!remoteServer) throw new Error("Remote access must be enabled before pairing a device");
      const pairing = await remoteAccess.createPairing();
      reply(socket, request.id, { ...pairing, status: remoteStatus() });
      return;
    }
    if (request.method === "remote.revokeDevice") {
      await remoteAccess.revoke(request.params.deviceId);
      for (const remote of remoteDeviceSockets.get(request.params.deviceId) ?? []) remote.close(4003, "Device revoked");
      reply(socket, request.id, remoteStatus());
      return;
    }
    if (request.method === "mcp.approveProject" || request.method === "mcp.revokeProject") {
      if (remoteConnections.has(socket) || previewBridgeSockets.has(socket)) throw new Error("Project MCP access can only be changed from this desktop app");
      const instance = providerInstance("kimi", request.params.instanceId);
      if (instance?.wsl) throw new Error("Project MCP approval is not supported for WSL Kimi runtimes");
      if (request.method === "mcp.approveProject") {
        const policyKeys = acquireRuntimePolicyMutations(allKnownKimiRuntimeTargets(), false);
        try {
          const current = await readProjectMcpBundle(request.params.cwd);
          if (!current || current.status !== "required" || !current.approvable || !current.fingerprint) {
            throw new Error("This project has no valid MCP configuration to approve");
          }
          if (current.fingerprint !== request.params.fingerprint) throw new Error("The project MCP configuration changed; review it again before approving");
          const targets = affectedRuntimeTargets(current.root, request.params.instanceId);
          assertAffectedRuntimesIdle(targets);
          for (const target of targets.sort((left, right) => runtimeKey(left.provider, left.instanceId).localeCompare(runtimeKey(right.provider, right.instanceId)))) {
            await resetRuntimeInstance(target.provider, target.instanceId);
          }
          const verified = await readProjectMcpBundle(request.params.cwd);
          if (!verified || verified.root !== current.root || verified.status !== "required" || verified.fingerprint !== request.params.fingerprint) {
            throw new Error("The project MCP configuration changed; review it again before approving");
          }
          const approval = await mcpApprovals.approve(verified.root, verified.fingerprint);
          reply(socket, request.id, { root: approval.root, fingerprint: approval.fingerprint, status: "approved", approvedAt: approval.approvedAt });
        } finally {
          releaseRuntimePolicyMutations(policyKeys);
        }
      } else {
        const policyKeys = acquireRuntimePolicyMutations(allKnownKimiRuntimeTargets(), false);
        try {
          const root = await findProjectRoot(request.params.cwd);
          const targets = affectedRuntimeTargets(root, request.params.instanceId);
          assertAffectedRuntimesIdle(targets);
          for (const target of targets.sort((left, right) => runtimeKey(left.provider, left.instanceId).localeCompare(runtimeKey(right.provider, right.instanceId)))) {
            await resetRuntimeInstance(target.provider, target.instanceId);
          }
          reply(socket, request.id, { root, revoked: await mcpApprovals.revoke(root), status: "required" });
        } finally {
          releaseRuntimePolicyMutations(policyKeys);
        }
      }
      return;
    }
    if (request.method === "capabilities.list") {
      const descriptor = providerDescriptors()[0]!;
      const instance = providerInstance("kimi", request.params.instanceId);
      const capabilities = await projectedKimiCapabilities(request.params.instanceId, request.params.cwd);
      const mcpServers = instance?.wsl ? capabilities.mcpServers : [{
        name: desktopPreviewMcpName,
        transport: "stdio" as const,
        target: "Built into Kimi Code",
        needsAuthorization: false,
        connectable: true,
      }, ...capabilities.mcpServers.filter((server) => server.name !== desktopPreviewMcpName)];
      reply(socket, request.id, { provider: "kimi", support: descriptor.capabilities, instanceId: request.params.instanceId, ...capabilities, mcpServers });
      return;
    }
    if (request.method === "providers.list") {
      const descriptors = remoteConnections.has(socket) ? remoteProviderDescriptors() : providerDescriptors();
      const status = remoteConnections.has(socket) ? remoteAuthStatus() : auth.status();
      const providers = descriptors.map((provider) => ({ ...provider, provider: "kimi" as const, ...status, runtimeReady: providerRuntimeReady("kimi") }));
      const instances = await publicProviderInstances();
      reply(socket, request.id, { providers, instances });
      return;
    }
    if (request.method === "skills.install") {
      const instance = providerInstance("kimi", request.params.instanceId);
      if (instance?.wsl) throw new Error("Skill installation is not supported for WSL Kimi instances yet");
      reply(socket, request.id, await installKimiSkill(effectiveKimiHome("kimi", request.params.instanceId), request.params.cwd, request.params.source));
      return;
    }
    if (request.method === "runtime.configDefaults") {
      const provider = request.params.provider;
      const key = runtimeKey(provider, request.params.instanceId);
      const store = configDefaultsFor(provider, request.params.instanceId);
      const cached = await store.load();
      const fromThreads = engine.threads().filter((thread) => thread.provider === provider && thread.instanceId === request.params.instanceId).map((thread) => thread.configOptions).find((options) => options.length);
      if (store.hasLiveDefaults(runtimes.get(key))) {
        reply(socket, request.id, { configOptions: cached ?? fromThreads ?? [] });
        return;
      }
      const fallback = fromThreads ?? cached ?? [];
      if (process.env.KIMI_FAKE !== "1" && !auth.status().authenticated) {
        reply(socket, request.id, { configOptions: fallback });
        return;
      }
      try {
        const probed = await probeConfigDefaults(provider, request.params.instanceId);
        reply(socket, request.id, { configOptions: probed });
      } catch {
        reply(socket, request.id, { configOptions: fallback });
      }
      return;
    }
    if (request.method === "terminal.start") {
      if (updateLease) throw new Error("An app update is prepared; starting a terminal is temporarily paused");
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
      if (updateLease) throw new Error("An app update is prepared; terminal input is temporarily paused");
      if (!socketTerminals.get(socket)?.has(request.params.sessionId)) throw new Error("Unknown terminal session");
      terminal.write(request.params.sessionId, request.params.command);
      reply(socket, request.id, { accepted: true });
      return;
    }
    if (request.method === "terminal.stop") {
      if (!socketTerminals.get(socket)?.has(request.params.sessionId)) throw new Error("Unknown terminal session");
      await terminal.stop(request.params.sessionId);
      socketTerminals.get(socket)?.delete(request.params.sessionId);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "threads.list") {
      let runtimeSessions: unknown[] = [];
      const provider = request.params.provider ?? "kimi";
      const acp = runtimeForLocalCancellation(provider, request.params.instanceId);
      if (acp) {
        try {
          const reservedSessions = new Set([...threadCreationReservations.values()]
            .filter((reservation) => reservation.provider === provider && reservation.instanceId === request.params.instanceId)
            .flatMap((reservation) => reservation.sessionId ? [reservation.sessionId] : []));
          const remote = remoteConnections.has(socket);
          runtimeSessions = (await acp.listSessions(request.params.cwd)).sessions
            .filter((session) => !isInternalProbeSession(session) && !reservedSessions.has(session.sessionId))
            .map((session) => classifyRuntimeSession(session, {
              provider,
              ...(request.params.instanceId ? { instanceId: request.params.instanceId } : {}),
            }, remote))
            .filter((session) => session !== undefined);
        } catch (error) {
          emitDiagnostic("error", error, "session-list");
        }
      }
      const threads = await Promise.all(engine.threads().map(async (thread) => {
        const localHome = backgroundTaskRuntime(thread)?.kimiHome;
        const local = localHome ? await readLatestKimiUsage(localHome, thread.sessionId) : undefined;
        const projected = { ...publicThread(thread, remoteConnections.has(socket)), queue: queueSummary(thread.threadId) };
        return local ? { ...projected, usage: { context: local.context, tokens: local.tokens } } : projected;
      }));
      reply(socket, request.id, { threads, runtimeSessions });
      return;
    }
    if (request.method === "threads.create") {
      validateThreadCreation(request.params);
      const creationId = request.params.creationId;
      const targetAdmissionKey = threadCreationTargetAdmissionKey(request.params);
      if (!creationId) {
        if (conflictingThreadCreationReservation(request.params) || (targetAdmissionKey && creationTargetAdmissions.has(targetAdmissionKey))) {
          throw unresolvedThreadCreationTargetError();
        }
        const admissionId = `legacy:${crypto.randomUUID()}`;
        if (targetAdmissionKey) creationTargetAdmissions.set(targetAdmissionKey, admissionId);
        try {
          reply(socket, request.id, { thread: publicThread(await createThread(request.params), remoteConnections.has(socket)) });
        } finally {
          if (targetAdmissionKey && creationTargetAdmissions.get(targetAdmissionKey) === admissionId) creationTargetAdmissions.delete(targetAdmissionKey);
        }
        return;
      }
      const fingerprint = threadCreationFingerprint(request.params);
      const existing = engine.threads().find((thread) => thread.creationId === creationId);
      if (existing) {
        assertThreadCreationFingerprint(existing.creationFingerprint, fingerprint);
        const completedReservation = threadCreationReservations.get(creationId);
        if (completedReservation) {
          assertCompletedThreadCreationReservation(existing, completedReservation);
          await completeThreadCreationReservation(existing, completedReservation);
        }
        reply(socket, request.id, { thread: publicThread(existing, remoteConnections.has(socket)) });
        return;
      }
      const receipt = threadCreationReceipts.get(creationId);
      if (receipt) {
        assertThreadCreationFingerprint(receipt.fingerprint, fingerprint);
        throw new Error("creationId was already used by a thread that no longer exists");
      }
      const reserved = threadCreationReservations.get(creationId);
      if (reserved) assertThreadCreationFingerprint(reserved.fingerprint, fingerprint);
      const pending = creationAdmissions.get(creationId);
      if (pending) {
        assertThreadCreationFingerprint(pending.fingerprint, fingerprint);
        reply(socket, request.id, { thread: publicThread(await pending.promise, remoteConnections.has(socket)) });
        return;
      }
      if (conflictingThreadCreationReservation(request.params, creationId)
        || (targetAdmissionKey && creationTargetAdmissions.has(targetAdmissionKey))) throw unresolvedThreadCreationTargetError();
      const conflictingReservation = [...threadCreationReservations.values()].find((candidate) => candidate.fingerprint === fingerprint && candidate.creationId !== creationId);
      if (conflictingReservation || creationFingerprintAdmissions.has(fingerprint)) {
        throw new Error("An equivalent thread creation is unresolved; retry it with its original creationId");
      }
      const promise = createThread(request.params, fingerprint);
      creationAdmissions.set(creationId, { fingerprint, promise });
      creationFingerprintAdmissions.set(fingerprint, creationId);
      if (targetAdmissionKey) creationTargetAdmissions.set(targetAdmissionKey, creationId);
      try {
        reply(socket, request.id, { thread: publicThread(await promise, remoteConnections.has(socket)) });
      } finally {
        if (creationAdmissions.get(creationId)?.promise === promise) creationAdmissions.delete(creationId);
        if (creationFingerprintAdmissions.get(fingerprint) === creationId) creationFingerprintAdmissions.delete(fingerprint);
        if (targetAdmissionKey && creationTargetAdmissions.get(targetAdmissionKey) === creationId) creationTargetAdmissions.delete(targetAdmissionKey);
      }
      return;
    }
    if (request.method === "threads.resume") {
      const existing = engine.thread(request.params.threadId);
      const provider = existing?.provider ?? request.params.provider;
      const instanceId = existing?.instanceId ?? request.params.instanceId;
      const resumeCwd = remoteConnections.has(socket) && existing?.kind === "chat"
        ? existing.cwd
        : resolve(request.params.cwd);
      const acp = await ensureRuntime(provider, instanceId);
      assertSessionNotReservedForCreation(provider, instanceId, request.params.sessionId);
      engine.assertSessionAvailable(request.params.sessionId, request.params.threadId, { provider, ...(instanceId ? { instanceId } : {}) });
      const configOptions = existing && !request.params.replay
        ? await ensureThreadSession(acp, existing)
        : (request.params.replay
          ? await acp.loadSession(request.params.sessionId, resumeCwd)
          : await resumeRuntimeSession(acp, request.params.sessionId, resumeCwd)).configOptions ?? [];
      if (!hasConfiguredModel(configOptions)) throw new Error(`${providerName(provider)} has no configured model. Complete provider sign-in, then retry.`);
      if (!existing) await engine.append(request.params.threadId, { type: "ThreadCreated", payload: { sessionId: request.params.sessionId, provider, ...(instanceId ? { instanceId } : {}), cwd: resumeCwd, kind: isStandaloneChatPath(resumeCwd) ? "chat" : "project", title: "Resumed Kimi session", configOptions } });
      else if (request.params.replay) await engine.append(existing.threadId, { type: "ConfigOptionsReplaced", payload: { options: configOptions } });
      reply(socket, request.id, { thread: publicThread(engine.thread(request.params.threadId)!, remoteConnections.has(socket)) });
      return;
    }
    if (request.method === "threads.createSide") {
      const creationId = request.params.creationId;
      const fingerprint = sideThreadCreationFingerprint(request.params);
      if (creationId) {
        const existing = engine.threads().find((candidate) => candidate.creationId === creationId);
        if (existing) {
          assertThreadCreationFingerprint(existing.creationFingerprint, fingerprint);
          const completedReservation = threadCreationReservations.get(creationId);
          if (completedReservation) {
            assertCompletedThreadCreationReservation(existing, completedReservation);
            await completeThreadCreationReservation(existing, completedReservation);
          }
          reply(socket, request.id, { thread: publicThread(existing, remoteConnections.has(socket)) });
          return;
        }
        const receipt = threadCreationReceipts.get(creationId);
        if (receipt) {
          assertThreadCreationFingerprint(receipt.fingerprint, fingerprint);
          throw new Error("creationId was already used by a thread that no longer exists");
        }
        const reserved = threadCreationReservations.get(creationId);
        if (reserved) assertThreadCreationFingerprint(reserved.fingerprint, fingerprint);
        const pending = creationAdmissions.get(creationId);
        if (pending) {
          assertThreadCreationFingerprint(pending.fingerprint, fingerprint);
          reply(socket, request.id, { thread: publicThread(await pending.promise, remoteConnections.has(socket)) });
          return;
        }
        const parent = reserved ? undefined : engine.thread(request.params.threadId);
        if (!reserved && !parent) throw new Error(`Unknown thread ${request.params.threadId}`);
        const createParams = reserved
          ? sideThreadParamsFromReservation(reserved)
          : sideThreadParamsFromParent(parent!, request.params, creationId);
        const targetAdmissionKey = threadCreationTargetAdmissionKey(createParams);
        if (conflictingThreadCreationReservation(createParams, creationId)
          || (targetAdmissionKey && creationTargetAdmissions.has(targetAdmissionKey))) throw unresolvedThreadCreationTargetError();
        const conflictingReservation = [...threadCreationReservations.values()].find((candidate) => candidate.fingerprint === fingerprint && candidate.creationId !== creationId);
        if (conflictingReservation || creationFingerprintAdmissions.has(fingerprint)) {
          throw new Error("An equivalent thread creation is unresolved; retry it with its original creationId");
        }
        const promise = createThread(createParams, fingerprint);
        creationAdmissions.set(creationId, { fingerprint, promise });
        creationFingerprintAdmissions.set(fingerprint, creationId);
        if (targetAdmissionKey) creationTargetAdmissions.set(targetAdmissionKey, creationId);
        try {
          reply(socket, request.id, { thread: publicThread(await promise, remoteConnections.has(socket)) });
        } finally {
          if (creationAdmissions.get(creationId)?.promise === promise) creationAdmissions.delete(creationId);
          if (creationFingerprintAdmissions.get(fingerprint) === creationId) creationFingerprintAdmissions.delete(fingerprint);
          if (targetAdmissionKey && creationTargetAdmissions.get(targetAdmissionKey) === creationId) creationTargetAdmissions.delete(targetAdmissionKey);
        }
        return;
      }
      const parent = engine.thread(request.params.threadId);
      if (!parent) throw new Error(`Unknown thread ${request.params.threadId}`);
      const createParams = sideThreadParamsFromParent(parent, request.params);
      const targetAdmissionKey = threadCreationTargetAdmissionKey(createParams);
      if (conflictingThreadCreationReservation(createParams) || (targetAdmissionKey && creationTargetAdmissions.has(targetAdmissionKey))) {
        throw unresolvedThreadCreationTargetError();
      }
      const admissionId = `legacy:${crypto.randomUUID()}`;
      if (targetAdmissionKey) creationTargetAdmissions.set(targetAdmissionKey, admissionId);
      try {
        reply(socket, request.id, { thread: publicThread(await createThread(createParams), remoteConnections.has(socket)) });
      } finally {
        if (targetAdmissionKey && creationTargetAdmissions.get(targetAdmissionKey) === admissionId) creationTargetAdmissions.delete(targetAdmissionKey);
      }
      return;
    }
    const thread = engine.thread(request.params.threadId);
    if (!thread) throw new Error(`Unknown thread ${request.params.threadId}`);
    if (request.method === "threads.rename") {
      await engine.append(thread.threadId, { type: "ThreadRenamed", payload: { title: request.params.title } });
      reply(socket, request.id, { thread: publicThread(engine.thread(thread.threadId)!, remoteConnections.has(socket)) });
      return;
    }
    if (request.method === "threads.archive") {
      if (request.params.archived) {
        await queueInsertions.during(thread.threadId, `archive-${crypto.randomUUID()}`, async () => {
          const current = engine.thread(thread.threadId);
          if (!current) throw new Error(`Unknown thread ${thread.threadId}`);
          if (threadHasWorkspaceWork(current, true)) throw new Error("Finish or stop active work before archiving this chat");
          await engine.append(current.threadId, { type: "ThreadArchived", payload: { archived: true } });
        });
      } else {
        await engine.append(thread.threadId, { type: "ThreadArchived", payload: { archived: false } });
      }
        reply(socket, request.id, { thread: publicThread(engine.thread(thread.threadId)!, remoteConnections.has(socket)) });
      return;
    }
    if (request.method === "threads.delete") {
      await queueInsertions.during(thread.threadId, `delete-${crypto.randomUUID()}`, async () => {
        const current = engine.thread(thread.threadId);
        if (!current) throw new Error(`Unknown thread ${thread.threadId}`);
        if (threadHasWorkspaceWork(current, true)) throw new Error("Stop active work and clear queued prompts before deleting this chat");
        cancelQueueAdmission(current.threadId);
        turnQueues.delete(current.threadId);
        await persistQueues();
        publishQueue(current.threadId);
        await ingestion.flush(current.threadId);
        if (current.creationId && current.creationFingerprint) await ensureThreadCreationReceipt(current);
        await engine.append(current.threadId, { type: "ThreadDeleted", payload: {} });
      });
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "checkpoints.list") {
      reply(socket, request.id, { checkpoints: thread.checkpoints });
      return;
    }
    if (request.method === "checkpoints.revert") {
      assertKimiProvider(thread.provider);
      if (threadHasWorkspaceWork(thread)) throw new Error("Stop the active task before reverting its changes");
      if (thread.revertedParts.some((part) => part.turnId === request.params.turnId)) throw new Error("This turn was partially reverted; review its remaining hunks instead");
      const before = thread.checkpoints.find((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "before");
      const after = thread.checkpoints.findLast((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "after");
      if (!before || !after) throw new Error("Turn checkpoints are incomplete");
      gitWorkspaceLease = await acquireGitWorkspaceLease(thread.cwd);
      const reverted = await checkpointReactor.revert(thread.threadId, request.params.turnId, before, after);
      if (reverted) await engine.append(thread.threadId, { type: "CheckpointReverted", payload: { checkpoint: reverted } });
      pushAll("receipt", { type: "checkpoint.reverted", threadId: thread.threadId, turnId: request.params.turnId });
      reply(socket, request.id, { checkpoint: reverted });
      return;
    }
    if (request.method === "threads.sendTurn") {
      assertKimiProvider(thread.provider);
      const params = request.params as SendTurnParams & { threadId: string };
      if (!params.submissionId) {
        reply(socket, request.id, await enqueueUserTurn(thread.threadId, params));
        return;
      }
      const fingerprint = submissionFingerprint(params);
      const key = `${thread.threadId}:${params.submissionId}`;
      const receipt = thread.submissionReceipts.find((candidate) => candidate.submissionId === params.submissionId);
      if (receipt) {
        assertSubmissionFingerprint(receipt.fingerprint, fingerprint);
        if (receipt.state === "payload_lost") throw new Error("The original submitted prompt payload could not be recovered after restart; resend it as a new prompt");
        reply(socket, request.id, { accepted: true, queuedId: receipt.queuedId, queued: receipt.state === "queued" });
        return;
      }
      const pending = submissionAdmissions.get(key);
      if (pending) {
        assertSubmissionFingerprint(pending.fingerprint, fingerprint);
        reply(socket, request.id, await pending.promise);
        return;
      }
      const promise = enqueueUserTurn(thread.threadId, params, fingerprint);
      submissionAdmissions.set(key, { fingerprint, promise });
      try {
        reply(socket, request.id, await promise);
      } finally {
        submissionAdmissions.delete(key);
      }
      return;
    }
    if (request.method === "threads.updateQueuedTurn") {
      assertKimiProvider(thread.provider);
      queueInsertions.assertIdle(thread.threadId);
      const queue = turnQueues.get(thread.threadId) ?? [];
      const index = queue.findIndex((item) => item.queuedId === request.params.queuedId);
      if (index < 0) throw new Error("Queued prompt no longer exists");
      if (index === 0 && queueAdmissions.has(thread.threadId)) throw new Error("Queued prompt is already starting");
      const text = request.params.text;
      queue[index] = { ...queue[index]!, text, mentions: mentionsFromText(text) };
      await persistQueues();
      publishQueue(thread.threadId);
      reply(socket, request.id, { queued: queueSummary(thread.threadId) });
      return;
    }
    if (request.method === "threads.steerQueuedTurn") {
      assertKimiProvider(thread.provider);
      queueInsertions.assertIdle(thread.threadId);
      const queue = turnQueues.get(thread.threadId) ?? [];
      const index = queue.findIndex((item) => item.queuedId === request.params.queuedId);
      if (index < 0) throw new Error("Queued prompt no longer exists");
      const startingAdmission = queueAdmissions.get(thread.threadId);
      const [queued] = queue.splice(index, 1);
      queue.unshift({ ...queued!, mode: "steer" });
      turnQueues.set(thread.threadId, queue);
      await persistQueues();
      publishQueue(thread.threadId);
      if (thread.running) {
        await resolveThreadApprovals(thread.threadId);
        const acp = runtimeForLocalCancellation(thread.provider, thread.instanceId);
        await cancelThreadTurn(acp, thread);
      } else if (startingAdmission) {
        startingAdmission.cancelled = true;
        requestQueueRestart(thread.threadId, startingAdmission);
      } else {
        startNextQueued(thread.threadId);
      }
      reply(socket, request.id, { accepted: true });
      return;
    }
    if (request.method === "threads.removeQueuedTurn") {
      queueInsertions.assertIdle(thread.threadId);
      const queue = turnQueues.get(thread.threadId) ?? [];
      const admission = cancelQueueAdmission(thread.threadId, request.params.queuedId);
      const removed = queue.filter((item) => item.queuedId === request.params.queuedId);
      const remaining = queue.filter((item) => item.queuedId !== request.params.queuedId);
      if (remaining.length) turnQueues.set(thread.threadId, remaining);
      else turnQueues.delete(thread.threadId);
      await persistQueues();
      await markSubmissionsRemoved(thread.threadId, removed);
      publishQueue(thread.threadId);
      requestQueueRestart(thread.threadId, admission);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "checkpoints.review") {
      const before = thread.checkpoints.find((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "before");
      const after = thread.checkpoints.findLast((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "after");
      if (!before || !after) throw new Error("Turn checkpoints are incomplete");
      reply(socket, request.id, { turnId: request.params.turnId, files: await checkpointReactor.review(before, after) });
      return;
    }
    if (request.method === "checkpoints.revertPart") {
      assertKimiProvider(thread.provider);
      if (threadHasWorkspaceWork(thread)) throw new Error("Stop the active task before reverting reviewed changes");
      const before = thread.checkpoints.find((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "before");
      const after = thread.checkpoints.findLast((checkpoint) => checkpoint.turnId === request.params.turnId && checkpoint.phase === "after");
      if (!before || !after) throw new Error("Turn checkpoints are incomplete");
      const duplicate = thread.revertedParts.some((part) => part.turnId === request.params.turnId && part.path === request.params.path
        && (part.hunkIndex === undefined || request.params.hunkIndex === undefined || part.hunkIndex === request.params.hunkIndex));
      if (duplicate) throw new Error("This reviewed change was already reverted");
      gitWorkspaceLease = await acquireGitWorkspaceLease(thread.cwd);
      const reverted = await checkpointReactor.revertPart(thread.threadId, request.params.turnId, before, after, request.params.path, request.params.hunkIndex);
      if (reverted) await engine.append(thread.threadId, { type: "CheckpointPartReverted", payload: { checkpoint: reverted, turnId: request.params.turnId, path: request.params.path, ...(request.params.hunkIndex === undefined ? {} : { hunkIndex: request.params.hunkIndex }) } });
      pushAll("receipt", { type: "checkpoint.partReverted", threadId: thread.threadId, turnId: request.params.turnId, path: request.params.path, ...(request.params.hunkIndex === undefined ? {} : { hunkIndex: request.params.hunkIndex }) });
      reply(socket, request.id, { checkpoint: reverted });
      return;
    }
    if (request.method === "threads.setGoal") {
      await engine.append(thread.threadId, { type: "ThreadGoalSet", payload: { objective: request.params.objective } });
      reply(socket, request.id, { thread: publicThread(engine.thread(thread.threadId)!, remoteConnections.has(socket)) });
      return;
    }
    if (request.method === "threads.clearGoal") {
      await engine.append(thread.threadId, { type: "ThreadGoalCleared", payload: {} });
      reply(socket, request.id, { thread: publicThread(engine.thread(thread.threadId)!, remoteConnections.has(socket)) });
      return;
    }
    if (request.method === "subagents.inspect") {
      assertKimiProvider(thread.provider);
      if (!isLinkedSubagent(thread, request.params.agentThreadId)) throw new Error("Subagent thread is not linked to this Kimi Code chat");
      const runtime = await ensureRuntime(thread.provider, thread.instanceId);
      if (!runtime.inspectSubagent) throw new Error(`${providerName(thread.provider)} does not expose inspectable subagent transcripts`);
      reply(socket, request.id, { inspection: await runtime.inspectSubagent(request.params.agentThreadId) });
      return;
    }
    if (request.method === "subagents.stop") {
      assertKimiProvider(thread.provider);
      if (!isLinkedSubagent(thread, request.params.agentThreadId)) throw new Error("Subagent thread is not linked to this Kimi Code chat");
      const runtime = await ensureRuntime(thread.provider, thread.instanceId);
      if (!runtime.stopSubagent) throw new Error(`${providerName(thread.provider)} does not support stopping an individual subagent`);
      await runtime.stopSubagent(request.params.agentThreadId);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "threads.clearQueue") {
      queueInsertions.assertIdle(thread.threadId);
      const admission = cancelQueueAdmission(thread.threadId);
      const removed = turnQueues.get(thread.threadId) ?? [];
      turnQueues.delete(thread.threadId);
      await persistQueues();
      await markSubmissionsRemoved(thread.threadId, removed);
      publishQueue(thread.threadId);
      requestQueueRestart(thread.threadId, admission);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "threads.respondToRequest") {
      assertKimiProvider(thread.provider);
      const acp = await ensureRuntime(thread.provider, thread.instanceId);
      await engine.append(thread.threadId, { type: "ApprovalResolved", payload: request.params.optionId ? { requestId: request.params.requestId, optionId: request.params.optionId } : { requestId: request.params.requestId } });
      acp.respondToPermission(request.params.requestId, request.params.optionId);
      reply(socket, request.id, {});
      return;
    }
    if (request.method === "threads.interruptTurn") {
      queueInsertions.assertIdle(thread.threadId);
      const admission = cancelQueueAdmission(thread.threadId);
      const queued = turnQueues.get(thread.threadId) ?? [];
      let removed: QueuedTurn[] = [];
      if (request.params.clearQueue) {
        removed = queued;
        turnQueues.delete(thread.threadId);
      } else if (admission) {
        removed = queued.filter((item) => item.queuedId === admission.queued.queuedId);
        const remaining = queued.filter((item) => item.queuedId !== admission.queued.queuedId);
        if (remaining.length) turnQueues.set(thread.threadId, remaining);
        else turnQueues.delete(thread.threadId);
      }
      if (request.params.clearQueue || admission) {
        await persistQueues();
        await markSubmissionsRemoved(thread.threadId, removed);
        publishQueue(thread.threadId);
      }
      await resolveThreadApprovals(thread.threadId);
      const acp = runtimeForLocalCancellation(thread.provider, thread.instanceId);
      await cancelThreadTurn(acp, thread);
      requestQueueRestart(thread.threadId, admission);
      reply(socket, request.id, {});
      return;
    }
    assertKimiProvider(thread.provider);
    const configOptions = await serializeSessionConfig(thread.provider, thread.instanceId, thread.sessionId, async () => {
      const acp = await ensureRuntime(thread.provider, thread.instanceId);
      const current = engine.thread(thread.threadId);
      if (!current) throw new Error(`Unknown thread ${thread.threadId}`);
      const liveOptions = await ensureThreadSession(acp, current);
      const option = liveOptions.find((candidate) => candidate.id === request.params.configId);
      const applicable = sanitizeSessionConfig({ [request.params.configId]: request.params.value }, liveOptions);
      if (!applicable.length) {
        if (option && String(option.currentValue) === String(request.params.value)) return liveOptions;
        throw new Error(`${request.params.configId} is not supported by this ${providerName(current.provider)} session`);
      }
      const result = await retryUnknownSessionOnce(
        acp,
        current,
        (client) => client.setConfigOption(current.sessionId, request.params.configId, request.params.value),
      );
      const options = result.configOptions ?? engine.thread(current.threadId)?.configOptions ?? liveOptions;
      await engine.append(current.threadId, { type: "ConfigOptionsReplaced", payload: { options } });
      return engine.thread(current.threadId)?.configOptions ?? options;
    });
    reply(socket, request.id, { configOptions });
  } catch (error) {
    reply(socket, request.id, undefined, { code: -32000, message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (gitWorkspaceLease) releaseGitWorkspaceLease(gitWorkspaceLease);
    if (sendAdmitted) pendingSendAdmissions -= 1;
    if (creationAdmitted) pendingThreadCreations -= 1;
    if (scheduleMutationAdmitted) scheduleMutationAdmissions -= 1;
    if (runtimeOperationKey) endRuntimeOperation(runtimeOperationKey);
  }
}

function updateBlockers(): Record<string, number> {
  const threads = engine.threads();
  return {
    pendingSends: pendingSendAdmissions,
    threadCreations: pendingThreadCreations,
    runtimeOperations: [...runtimeOperationAdmissions.values()].reduce((total, count) => total + count, 0),
    runtimeStarts: runtimeStarts.size,
    queueInsertions: threads.filter((thread) => queueInsertions.hasAny(thread.threadId)).length,
    mcpPolicyChanges: runtimePolicyMutations.size,
    schedules: Number(checkingSchedules),
    scheduleMutations: scheduleMutationAdmissions,
    activeTurns: threads.filter((thread) => thread.running).length,
    queues: [...turnQueues.values()].reduce((total, queue) => total + queue.length, 0),
    queueStarts: queueAdmissions.size,
    turnCancellations: turnCancellations.size,
    gitActions: gitWorkspaceLeases.size,
    approvals: threads.reduce((total, thread) => total + thread.approvals.length, 0),
    terminals: terminal.activeCount,
    backgroundTasks: threads.reduce(
      (total, thread) => total + thread.backgroundTasks.filter((task) => task.status === "running").length,
      0,
    ),
    authLogin: Number(auth.status().loginRunning),
  };
}

function queueSummary(threadId: string) {
  return queueInsertions.visible(threadId, turnQueues.get(threadId) ?? []).map(({ queuedId, text, mode, createdAt, images, origin }) => ({
    queuedId,
    text,
    mode,
    createdAt,
    origin,
    images: publicImages(images),
  }));
}

function publicAttachmentName(name: string): string {
  return basename(name.replaceAll("\\", "/"));
}

function publicImages(images: ReadonlyArray<{ name: string; mimeType: string }>): Array<{ name: string; mimeType: string }> {
  return images.map(({ name, mimeType }) => ({ name: publicAttachmentName(name), mimeType }));
}

type PublicThread = Omit<ThreadProjection, "submissionReceipts" | "creationId" | "creationFingerprint" | "backgroundTasks"> & {
  backgroundTasks: Array<Omit<ThreadProjection["backgroundTasks"][number], "kimiHome" | "outputPath">>;
};

function remoteChatCwd(thread: Pick<ThreadProjection, "threadId">): string {
  return `kimi-code-chat://${thread.threadId}`;
}

function publicThread(thread: ThreadProjection, remote = false): PublicThread {
  const {
    submissionReceipts: _submissionReceipts,
    creationId: _creationId,
    creationFingerprint: _creationFingerprint,
    backgroundTasks,
    ...projection
  } = thread;
  return {
    ...projection,
    ...(remote && thread.kind === "chat" ? { cwd: remoteChatCwd(thread) } : {}),
    lifecycle: projection.lifecycle.error
      ? { ...projection.lifecycle, error: redactPrivateError(projection.lifecycle.error) }
      : projection.lifecycle,
    turns: projection.turns.map((turn) => turn.error ? { ...turn, error: redactPrivateError(turn.error) } : turn),
    messages: projection.messages.map((message) => ({
      ...message,
      ...(message.images ? { images: publicImages(message.images) } : {}),
    })),
    backgroundTasks: backgroundTasks.map(({ kimiHome: _kimiHome, outputPath: _outputPath, ...task }) => ({
      ...task,
      ...(task.reportLastError ? { reportLastError: redactPrivateError(task.reportLastError) } : {}),
    })),
  };
}

function validateThreadCreation(params: CreateThreadParams): void {
  if (!params.standalone && !params.cwd) throw new Error("Workspace path is required for a project chat");
  if (params.standalone && params.isolate) throw new Error("Standalone chats do not use Git worktrees");
}

function threadCreationFingerprint(params: CreateThreadParams): string {
  const hash = createHash("sha256");
  const add = (value: string) => {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  add(params.provider);
  add(params.instanceId ?? "");
  add(params.standalone ? "standalone" : "project");
  add(params.isolate ? "isolated" : "shared");
  add(params.standalone ? "" : comparablePath(params.cwd!));
  const config = Object.entries(params.config ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  add(String(config.length));
  for (const [key, value] of config) {
    add(key);
    add(typeof value);
    add(String(value));
  }
  return hash.digest("hex");
}

function sideThreadCreationFingerprint(params: CreateSideThreadParams): string {
  const hash = createHash("sha256");
  const add = (value: string) => {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  add("side");
  add(params.threadId);
  add(params.title === undefined ? "omitted" : "explicit");
  add(params.title ?? "");
  return hash.digest("hex");
}

function sideThreadParamsFromParent(parent: ThreadProjection, request: CreateSideThreadParams, creationId?: string): CreateThreadParams {
  assertKimiProvider(parent.provider);
  const inheritedConfig = Object.fromEntries(parent.configOptions.map((option) => [option.id, option.currentValue]));
  return {
    cwd: parent.cwd,
    standalone: parent.kind === "chat",
    isolate: false,
    provider: parent.provider,
    ...(parent.instanceId ? { instanceId: parent.instanceId } : {}),
    config: inheritedConfig,
    ...(creationId ? { creationId } : {}),
    side: {
      parentThreadId: parent.threadId,
      title: request.title ?? `Side chat · ${parent.title}`,
      kind: parent.kind,
      ...(parent.worktree ? { worktree: { ...parent.worktree } } : {}),
      inheritedConfig,
    },
  };
}

function sideThreadParamsFromReservation(reservation: ThreadCreationReservation): CreateThreadParams {
  if (!reservation.side) throw new Error("creationId belongs to a different thread creation operation");
  return {
    cwd: reservation.targetCwd,
    standalone: reservation.side.kind === "chat",
    isolate: false,
    provider: reservation.provider,
    ...(reservation.instanceId ? { instanceId: reservation.instanceId } : {}),
    config: reservation.side.inheritedConfig,
    creationId: reservation.creationId,
    side: {
      parentThreadId: reservation.side.parentThreadId,
      title: reservation.side.title,
      kind: reservation.side.kind,
      ...(reservation.side.worktree ? { worktree: { ...reservation.side.worktree } } : {}),
      inheritedConfig: { ...reservation.side.inheritedConfig },
    },
  };
}

function assertThreadCreationFingerprint(stored: string | undefined, incoming: string): void {
  if (!stored || stored !== incoming) throw new Error("creationId was already used with different thread creation parameters");
}

function sharedThreadCreationTargetKey(params: CreateThreadParams): string | undefined {
  if (params.isolate) return undefined;
  return comparablePath(params.side ? params.cwd! : params.standalone ? standaloneChatCwd : params.cwd!);
}

function threadCreationTargetAdmissionKey(params: CreateThreadParams): string | undefined {
  const target = sharedThreadCreationTargetKey(params);
  return target ? `${params.provider}\0${params.instanceId ?? ""}\0${target}` : undefined;
}

function conflictingThreadCreationReservation(params: CreateThreadParams, creationId?: string): ThreadCreationReservation | undefined {
  const targetKey = sharedThreadCreationTargetKey(params);
  if (!targetKey) return undefined;
  return [...threadCreationReservations.values()].find((candidate) => candidate.creationId !== creationId
    && candidate.provider === params.provider
    && candidate.instanceId === params.instanceId
    && candidate.sharedTargetKey === targetKey);
}

function unresolvedThreadCreationTargetError(): Error {
  return new Error("A thread creation is unresolved for this workspace; retry it with its original creationId before creating another session");
}

function assertSessionNotReservedForCreation(provider: ProviderId, instanceId: string | undefined, sessionId: string): void {
  if ([...threadCreationReservations.values()].some((reservation) => reservation.provider === provider
    && reservation.instanceId === instanceId
    && reservation.sessionId === sessionId)) {
    throw new Error("This ACP session is reserved by an unfinished thread creation");
  }
}

async function createThread(params: CreateThreadParams, creationFingerprint?: string): Promise<ThreadProjection> {
  if (!params.creationId || !creationFingerprint) return createUntrackedThread(params);
  let worktreeLease: GitWorkspaceLease | undefined;
  try {
    if (params.isolate) worktreeLease = await acquireGitWorkspaceLease(params.cwd!);
    const reservation = threadCreationReservations.get(params.creationId)
      ?? await reserveThreadCreation(params, creationFingerprint);
    return await continueReservedThreadCreation(params, reservation);
  } finally {
    if (worktreeLease) releaseGitWorkspaceLease(worktreeLease);
  }
}

async function reserveThreadCreation(params: CreateThreadParams, fingerprint: string): Promise<ThreadCreationReservation> {
  const threadId = crypto.randomUUID();
  let sourceCwd: string | undefined;
  let branch: string | undefined;
  let targetCwd: string;
  if (params.side) {
    targetCwd = await realpath(resolve(params.cwd!));
  } else if (params.isolate) {
    sourceCwd = (await git.workspaceIdentity(params.cwd!)).root;
    targetCwd = resolve(dataHome, "worktrees", threadId);
    branch = threadCreationBranch(threadId);
  } else if (params.standalone) {
    targetCwd = standaloneChatCwd;
  } else {
    targetCwd = await realpath(resolve(params.cwd!));
  }
  const reservation: ThreadCreationReservation = {
    creationId: params.creationId!,
    fingerprint,
    threadId,
    provider: params.provider,
    ...(params.instanceId ? { instanceId: params.instanceId } : {}),
    standalone: params.standalone,
    isolate: params.isolate,
    targetCwd,
    ...(!params.isolate ? { sharedTargetKey: sharedThreadCreationTargetKey(params)! } : {}),
    ...(sourceCwd ? { sourceCwd } : {}),
    ...(branch ? { branch } : {}),
    ...(params.side ? { side: {
      ...params.side,
      ...(params.side.worktree ? { worktree: { ...params.side.worktree } } : {}),
      inheritedConfig: { ...params.side.inheritedConfig },
    } } : {}),
    stage: "reserved",
    createdAt: new Date().toISOString(),
  };
  await saveThreadCreationReservation(reservation);
  return reservation;
}

async function continueReservedThreadCreation(params: CreateThreadParams, initial: ThreadCreationReservation): Promise<ThreadProjection> {
  const provider = params.provider;
  const instanceId = params.instanceId;
  let reservation = initial;
  assertThreadCreationReservationMatches(params, reservation);
  try {
    const acp = await ensureRuntime(provider, instanceId);
    if (!reservation.baselineSessionIds) {
      reservation = {
        ...reservation,
        baselineSessionIds: [...new Set((await acp.listSessions()).sessions.map((session) => session.sessionId))].sort(),
        stage: "ready",
      };
      await saveThreadCreationReservation(reservation);
    }
    if (params.isolate) {
      const worktree = await git.createWorktree(reservation.sourceCwd!, reservation.targetCwd, reservation.threadId);
      if (reservation.targetCwd !== worktree.cwd || reservation.sourceCwd !== worktree.sourceCwd || reservation.branch !== worktree.branch) {
        reservation = { ...reservation, targetCwd: worktree.cwd, sourceCwd: worktree.sourceCwd, branch: worktree.branch };
        await saveThreadCreationReservation(reservation);
      }
    }
    if (params.standalone) await mkdir(reservation.targetCwd, { recursive: true });

    let configOptions: SessionConfigOption[];
    if (reservation.sessionId) {
      configOptions = (await resumeRuntimeSession(acp, reservation.sessionId, reservation.targetCwd)).configOptions ?? [];
    } else if (reservation.stage === "requesting") {
      if ((!params.isolate && !reservation.side) || !reservation.baselineSessionIds) throw uncertainThreadCreationError();
      const baseline = new Set(reservation.baselineSessionIds);
      const owned = new Set([
        ...engine.threads()
          .filter((thread) => thread.provider === provider && thread.instanceId === instanceId)
          .map((thread) => thread.sessionId),
        ...[...threadCreationReservations.values()]
          .filter((candidate) => candidate.provider === provider && candidate.instanceId === instanceId)
          .flatMap((candidate) => candidate.sessionId ? [candidate.sessionId] : []),
      ]);
      const candidates = (await acp.listSessions()).sessions.filter((session) => session.cwd
        && comparablePath(session.cwd) === comparablePath(reservation.targetCwd)
        && !baseline.has(session.sessionId)
        && !owned.has(session.sessionId));
      if (candidates.length !== 1) throw uncertainThreadCreationError(candidates.length);
      const recoveredSessionId = candidates[0]!.sessionId;
      reservation = { ...reservation, stage: "bound", sessionId: recoveredSessionId };
      await saveThreadCreationReservation(reservation);
      configOptions = (await resumeRuntimeSession(acp, recoveredSessionId, reservation.targetCwd)).configOptions ?? [];
    } else {
      reservation = { ...reservation, stage: "requesting" };
      await saveThreadCreationReservation(reservation);
      let session: Awaited<ReturnType<AgentRuntime["newSession"]>>;
      try {
        session = await acp.newSession(reservation.targetCwd);
      } catch (error) {
        // Product contract: a correlated ACP RequestError definitively rejects session/new.
        // Missing responses, timeouts, transport loss, and protocol failures remain delivery-uncertain.
        if (error instanceof RequestError) {
          reservation = { ...reservation, stage: "ready" };
          await saveThreadCreationReservation(reservation);
        }
        throw error;
      }
      reservation = { ...reservation, stage: "bound", sessionId: session.sessionId };
      await saveThreadCreationReservation(reservation);
      configOptions = session.configOptions ?? [];
    }
    if (!hasConfiguredModel(configOptions)) throw new Error(`${providerName(provider)} has no configured model. Complete provider sign-in, then retry.`);
    const requestedConfig = reservation.side?.inheritedConfig ?? params.config;
    for (const [configId, value] of sanitizeSessionConfig(requestedConfig, configOptions)) {
      if (!sanitizeSessionConfig({ [configId]: value }, configOptions).length) continue;
      const applied = await acp.setConfigOption(reservation.sessionId!, configId, value);
      if (applied.configOptions) configOptions = applied.configOptions;
    }
    await engine.append(reservation.threadId, { type: "ThreadCreated", payload: {
      sessionId: reservation.sessionId!,
      creationId: reservation.creationId,
      creationFingerprint: reservation.fingerprint,
      provider,
      ...(instanceId ? { instanceId } : {}),
      ...(reservation.side ? { parentThreadId: reservation.side.parentThreadId } : {}),
      cwd: reservation.targetCwd,
      ...(reservation.side?.worktree
        ? { worktree: reservation.side.worktree }
        : params.isolate ? { worktree: { sourceCwd: reservation.sourceCwd!, branch: reservation.branch! } } : {}),
      kind: reservation.side?.kind ?? (params.standalone ? "chat" : "project"),
      title: reservation.side?.title ?? (params.standalone ? "New chat" : "New Kimi session"),
      configOptions,
    } });
    const created = engine.thread(reservation.threadId)!;
    await completeThreadCreationReservation(created, reservation);
    return created;
  } catch (error) {
    const latest = threadCreationReservations.get(reservation.creationId);
    if (latest && latest.stage !== "requesting" && latest.stage !== "bound") {
      let cleanupSucceeded = true;
      if (params.isolate && latest.sourceCwd && latest.branch) {
        await git.discardNewWorktree({ cwd: latest.targetCwd, sourceCwd: latest.sourceCwd, branch: latest.branch })
          .catch((cleanupError) => {
            cleanupSucceeded = false;
            emitDiagnostic("error", cleanupError, "worktree-cleanup");
          });
      }
      if (cleanupSucceeded) {
        await removeThreadCreationReservation(latest.creationId)
          .catch((cleanupError) => emitDiagnostic("error", cleanupError, "thread-create-journal"));
      }
    }
    throw error;
  }
}

async function createUntrackedThread(params: CreateThreadParams): Promise<ThreadProjection> {
  const provider = params.provider;
  const instanceId = params.instanceId;
  const acp = await ensureRuntime(provider, instanceId);
  const threadId = crypto.randomUUID();
  let createdWorktree: Awaited<ReturnType<GitService["createWorktree"]>> | undefined;
  let worktreeLease: GitWorkspaceLease | undefined;
  try {
    if (params.isolate) {
      worktreeLease = await acquireGitWorkspaceLease(params.cwd!);
      createdWorktree = await git.createWorktree(params.cwd!, join(dataHome, "worktrees", threadId), threadId);
    }
    const targetCwd = params.side ? resolve(params.cwd!) : params.standalone ? standaloneChatCwd : createdWorktree?.cwd ?? resolve(params.cwd!);
    if (params.standalone) await mkdir(targetCwd, { recursive: true });
    const session = await acp.newSession(targetCwd);
    let configOptions = session.configOptions ?? [];
    if (!hasConfiguredModel(configOptions)) throw new Error(`${providerName(provider)} has no configured model. Complete provider sign-in, then retry.`);
    for (const [configId, value] of sanitizeSessionConfig(params.config, configOptions)) {
      if (!sanitizeSessionConfig({ [configId]: value }, configOptions).length) continue;
      const applied = await acp.setConfigOption(session.sessionId, configId, value);
      if (applied.configOptions) configOptions = applied.configOptions;
    }
    await engine.append(threadId, { type: "ThreadCreated", payload: {
      sessionId: session.sessionId,
      provider,
      ...(instanceId ? { instanceId } : {}),
      ...(params.side ? { parentThreadId: params.side.parentThreadId } : {}),
      cwd: targetCwd,
      ...(params.side?.worktree
        ? { worktree: params.side.worktree }
        : createdWorktree ? { worktree: { sourceCwd: createdWorktree.sourceCwd, branch: createdWorktree.branch } } : {}),
      kind: params.side?.kind ?? (params.standalone ? "chat" : "project"),
      title: params.side?.title ?? (params.standalone ? "New chat" : "New Kimi session"),
      configOptions,
    } });
    return engine.thread(threadId)!;
  } catch (error) {
    if (createdWorktree) await git.discardNewWorktree(createdWorktree).catch((cleanupError) => emitDiagnostic("error", cleanupError, "worktree-cleanup"));
    throw error;
  } finally {
    if (worktreeLease) releaseGitWorkspaceLease(worktreeLease);
  }
}

function uncertainThreadCreationError(candidates?: number): Error {
  const detail = candidates === undefined ? "" : ` (${candidates} unowned candidates found)`;
  return new Error(`Thread creation delivery is uncertain${detail}; refusing to create another ACP session. Manual runtime-session resolution is required before this request can continue.`);
}

async function loadThreadCreationJournal(): Promise<void> {
  const loaded = await readRecoverableJson(threadCreationJournalPath, (value) => {
    const parsed = threadCreationJournalSchema.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  });
  if (loaded.corrupt && !loaded.value) throw new Error("Thread creation recovery journal is corrupt; refusing unsafe startup");
  let changed = false;
  for (const receipt of loaded.value?.receipts ?? []) {
    if (threadCreationReceipts.has(receipt.creationId)) throw new Error("Thread creation recovery journal contains duplicate receipts");
    threadCreationReceipts.set(receipt.creationId, receipt);
  }
  const fingerprints = new Set<string>();
  for (const stored of loaded.value?.reservations ?? []) {
    // A recovered backup may predate an unacknowledged session/new. Persist fail-closed
    // delivery uncertainty instead of replaying an older ready/reserved state.
    const reservation = loaded.recovered && !stored.sessionId
      ? { ...stored, stage: "requesting" as const }
      : stored;
    if (reservation !== stored) changed = true;
    assertStoredThreadCreationReservation(reservation);
    if (threadCreationReservations.has(reservation.creationId) || threadCreationReceipts.has(reservation.creationId) || fingerprints.has(reservation.fingerprint)) {
      throw new Error("Thread creation recovery journal contains duplicate reservations");
    }
    threadCreationReservations.set(reservation.creationId, reservation);
    fingerprints.add(reservation.fingerprint);
  }
  for (const thread of engine.threads()) {
    if (!thread.creationId) continue;
    const receipt = threadCreationReceipts.get(thread.creationId);
    if (receipt) assertThreadCreationReceiptMatches(thread, receipt);
    const reservation = threadCreationReservations.get(thread.creationId);
    if (reservation) {
      assertThreadCreationFingerprint(thread.creationFingerprint, reservation.fingerprint);
      assertCompletedThreadCreationReservation(thread, reservation);
      threadCreationReservations.delete(thread.creationId);
      changed = true;
    }
    if (!receipt) {
      threadCreationReceipts.set(thread.creationId, creationReceipt(thread));
      changed = true;
    }
  }
  if (changed) await writeThreadCreationJournal();
}

function threadCreationBranch(threadId: string): string {
  return `kimi/${threadId.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40)}`;
}

function assertStoredThreadCreationReservation(reservation: ThreadCreationReservation): void {
  if ((reservation.stage === "bound") !== Boolean(reservation.sessionId)) {
    throw new Error("Thread creation recovery journal contains an invalid session binding");
  }
  if (reservation.isolate) {
    const expectedTarget = join(dataHome, "worktrees", reservation.threadId);
    if (reservation.standalone
      || !reservation.sourceCwd
      || reservation.branch !== threadCreationBranch(reservation.threadId)
      || reservation.sharedTargetKey
      || comparablePath(reservation.targetCwd) !== comparablePath(expectedTarget)) {
      throw new Error("Thread creation recovery journal contains an unsafe isolated reservation");
    }
    return;
  }
  if (reservation.side && (reservation.standalone !== (reservation.side.kind === "chat")
    || reservation.side.parentThreadId === reservation.threadId)) {
    throw new Error("Thread creation recovery journal contains invalid side-chat metadata");
  }
  if (reservation.sourceCwd
    || reservation.branch
    || reservation.sharedTargetKey !== comparablePath(reservation.targetCwd)
    || (reservation.standalone && !reservation.side && comparablePath(reservation.targetCwd) !== comparablePath(standaloneChatCwd))) {
    throw new Error("Thread creation recovery journal contains an unsafe shared reservation");
  }
}

function assertThreadCreationReservationMatches(params: CreateThreadParams, reservation: ThreadCreationReservation): void {
  if (reservation.provider !== params.provider
    || reservation.instanceId !== params.instanceId
    || reservation.standalone !== params.standalone
    || reservation.isolate !== params.isolate
    || Boolean(reservation.side) !== Boolean(params.side)) {
    throw new Error("Thread creation recovery journal does not match the requested runtime");
  }
}

function assertCompletedThreadCreationReservation(thread: ThreadProjection, reservation: ThreadCreationReservation): void {
  if (reservation.side) {
    if (reservation.threadId !== thread.threadId
      || reservation.sessionId !== thread.sessionId
      || comparablePath(reservation.targetCwd) !== comparablePath(thread.cwd)
      || reservation.provider !== thread.provider
      || reservation.instanceId !== thread.instanceId
      || reservation.side.parentThreadId !== thread.parentThreadId
      || reservation.side.kind !== thread.kind
      || !sameThreadWorktree(reservation.side.worktree, thread.worktree)) {
      throw new Error("Thread creation recovery journal conflicts with the completed side chat");
    }
    return;
  }
  if (reservation.threadId !== thread.threadId
    || reservation.sessionId !== thread.sessionId
    || comparablePath(reservation.targetCwd) !== comparablePath(thread.cwd)
    || reservation.provider !== thread.provider
    || reservation.instanceId !== thread.instanceId
    || reservation.isolate !== Boolean(thread.worktree)
    || (reservation.isolate && (comparablePath(reservation.sourceCwd!) !== comparablePath(thread.worktree!.sourceCwd) || reservation.branch !== thread.worktree?.branch))) {
    throw new Error("Thread creation recovery journal conflicts with the completed thread");
  }
}

function sameThreadWorktree(left: ThreadWorktree | undefined, right: ThreadWorktree | undefined): boolean {
  return (!left && !right) || Boolean(left && right
    && comparablePath(left.sourceCwd) === comparablePath(right.sourceCwd)
    && left.branch === right.branch);
}

function creationReceipt(thread: ThreadProjection): ThreadCreationReceipt {
  if (!thread.creationId || !thread.creationFingerprint) throw new Error("Completed thread is missing creation metadata");
  return { creationId: thread.creationId, fingerprint: thread.creationFingerprint, threadId: thread.threadId };
}

function assertThreadCreationReceiptMatches(thread: ThreadProjection, receipt: ThreadCreationReceipt): void {
  if (receipt.threadId !== thread.threadId
    || receipt.creationId !== thread.creationId
    || receipt.fingerprint !== thread.creationFingerprint) {
    throw new Error("Thread creation recovery receipt conflicts with the completed thread");
  }
}

function saveThreadCreationReservation(reservation: ThreadCreationReservation): Promise<void> {
  const operation = threadCreationJournalWrite.then(async () => {
    const previous = threadCreationReservations.get(reservation.creationId);
    threadCreationReservations.set(reservation.creationId, reservation);
    try {
      await writeThreadCreationJournal();
    } catch (error) {
      if (previous) threadCreationReservations.set(reservation.creationId, previous);
      else threadCreationReservations.delete(reservation.creationId);
      throw error;
    }
  });
  threadCreationJournalWrite = operation.then(() => undefined, () => undefined);
  return operation;
}

function completeThreadCreationReservation(thread: ThreadProjection, reservation: ThreadCreationReservation): Promise<void> {
  assertCompletedThreadCreationReservation(thread, reservation);
  return persistThreadCreationReceipt(thread);
}

function ensureThreadCreationReceipt(thread: ThreadProjection): Promise<void> {
  return persistThreadCreationReceipt(thread);
}

function persistThreadCreationReceipt(thread: ThreadProjection): Promise<void> {
  const receipt = creationReceipt(thread);
  const operation = threadCreationJournalWrite.then(async () => {
    const previousReservation = threadCreationReservations.get(receipt.creationId);
    const previousReceipt = threadCreationReceipts.get(receipt.creationId);
    if (previousReservation) assertCompletedThreadCreationReservation(thread, previousReservation);
    if (previousReceipt) assertThreadCreationReceiptMatches(thread, previousReceipt);
    if (previousReceipt && !previousReservation) return;
    threadCreationReservations.delete(receipt.creationId);
    threadCreationReceipts.set(receipt.creationId, receipt);
    try {
      await writeThreadCreationJournal();
    } catch (error) {
      if (previousReservation) threadCreationReservations.set(receipt.creationId, previousReservation);
      else threadCreationReservations.delete(receipt.creationId);
      if (previousReceipt) threadCreationReceipts.set(receipt.creationId, previousReceipt);
      else threadCreationReceipts.delete(receipt.creationId);
      throw error;
    }
  });
  threadCreationJournalWrite = operation.then(() => undefined, () => undefined);
  return operation;
}

function removeThreadCreationReservation(creationId: string): Promise<void> {
  const operation = threadCreationJournalWrite.then(async () => {
    const previous = threadCreationReservations.get(creationId);
    if (!previous) return;
    threadCreationReservations.delete(creationId);
    try {
      await writeThreadCreationJournal();
    } catch (error) {
      threadCreationReservations.set(creationId, previous);
      throw error;
    }
  });
  threadCreationJournalWrite = operation.then(() => undefined, () => undefined);
  return operation;
}

function writeThreadCreationJournal(): Promise<void> {
  return writeRecoverableJson(threadCreationJournalPath, {
    version: 1,
    reservations: [...threadCreationReservations.values()].sort((left, right) => left.creationId < right.creationId ? -1 : left.creationId > right.creationId ? 1 : 0),
    receipts: [...threadCreationReceipts.values()].sort((left, right) => left.creationId < right.creationId ? -1 : left.creationId > right.creationId ? 1 : 0),
  });
}

async function enqueueUserTurn(threadId: string, params: SendTurnParams, fingerprint?: string): Promise<SendTurnResult> {
  let thread = engine.thread(threadId);
  if (!thread) throw new Error(`Unknown thread ${threadId}`);
  assertKimiProvider(thread.provider);
  if (thread.archivedAt) throw new Error("Restore this chat before sending another task");
  await waitForSessionConfig(thread.provider, thread.instanceId, thread.sessionId);
  thread = engine.thread(threadId);
  if (!thread) throw new Error(`Unknown thread ${threadId}`);
  const preflightThread = thread;
  const admissionState = params.images.length
    ? await readQueueAfterPreflight(turnQueues, threadId, () => threadTouchesWorkspaceLease(preflightThread))
    : { queue: turnQueues.get(threadId) ?? [], preflightResult: false };
  const { queue, preflightResult: workspaceLeaseConflict } = admissionState;
  if (params.submissionId && queue.some((item) => item.queuedId === params.submissionId)) {
    throw new Error("submissionId conflicts with an existing queued prompt");
  }
  if (params.images.length && (
    thread.running
    || queueAdmissions.has(threadId)
    || turnCancellations.has(threadId)
    || queue.length
    || updateLease
    || workspaceLeaseConflict
  )) {
    throw new Error("Image prompts must start immediately; wait for active work to finish");
  }
  const queued: QueuedTurn = {
    queuedId: params.submissionId ?? crypto.randomUUID(),
    text: params.text,
    mentions: params.mentions,
    images: params.images,
    mode: params.mode,
    createdAt: new Date().toISOString(),
    origin: "user",
    ...(params.submissionId ? { submissionId: params.submissionId } : {}),
  };
  let committedQueue = queue;
  let startingAdmission: QueueAdmission | undefined;
  let steering = false;
  try {
    await queueInsertions.during(threadId, queued.queuedId, () => withStableQueueWrites(queueWrites, async () => {
      const currentThread = engine.thread(threadId);
      if (!currentThread) throw new Error(`Unknown thread ${threadId}`);
      if (currentThread.archivedAt) throw new Error("Restore this chat before sending another task");
      thread = currentThread;
      committedQueue = turnQueues.get(threadId) ?? [];
      if (params.submissionId && committedQueue.some((item) => item.queuedId === params.submissionId)) {
        throw new Error("submissionId conflicts with an existing queued prompt");
      }
      startingAdmission = queueAdmissions.get(threadId);
      steering = queued.mode === "steer" && (thread.running || Boolean(startingAdmission));
      if (params.images.length && (thread.running || startingAdmission || turnCancellations.has(threadId) || committedQueue.length || updateLease || workspaceLeaseConflict)) {
        throw new Error("Image prompts must start immediately; wait for active work to finish");
      }
      if (steering) committedQueue.unshift(queued);
      else committedQueue.push(queued);
      turnQueues.set(threadId, committedQueue);
      await persistQueuedInsertion(turnQueues, threadId, queued, persistQueues);
      if (queued.submissionId) {
        await acceptQueuedInsertion(turnQueues, threadId, queued, () => engine.append(threadId, {
          type: "TurnSubmissionAccepted",
          payload: { submissionId: queued.submissionId!, fingerprint: fingerprint ?? submissionFingerprint(params), queuedId: queued.queuedId },
        }), persistQueues);
      }
    }));
  } catch (error) {
    publishQueue(threadId);
    startNextQueued(threadId);
    throw error;
  }
  publishQueue(threadId);
  if (queued.images.length) {
    const started = await runNextQueued(threadId, queued.queuedId);
    if (!started) {
      removeQueuedItem(turnQueues, threadId, queued);
      await persistQueues();
      if (queued.submissionId) await markSubmissionsPayloadLost(threadId, [queued.submissionId]);
      publishQueue(threadId);
      throw new Error("Image prompt could not start immediately; retry it as a new prompt");
    }
    return { accepted: true, queuedId: queued.queuedId, queued: false };
  }
  if (steering && thread.running) {
    await resolveThreadApprovals(threadId);
    await cancelThreadTurn(runtimeForLocalCancellation(thread.provider, thread.instanceId), thread);
  } else if (steering && startingAdmission) {
    startingAdmission.cancelled = true;
    requestQueueRestart(threadId, startingAdmission);
  } else {
    startNextQueued(threadId);
  }
  return { accepted: true, queuedId: queued.queuedId, queued: thread.running || Boolean(startingAdmission) || committedQueue.length > 1 };
}

function submissionFingerprint(params: Pick<QueuedTurn, "text" | "mentions" | "images" | "mode">): string {
  const hash = createHash("sha256");
  const add = (value: string) => {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  add(params.mode);
  add(params.text);
  add(String(params.mentions.length));
  for (const mention of params.mentions) add(mention);
  add(String(params.images.length));
  for (const image of params.images) {
    add(image.name);
    add(image.mimeType);
    add(image.data);
  }
  return hash.digest("hex");
}

function assertSubmissionFingerprint(expected: string, actual: string): void {
  if (expected !== actual) throw new Error("submissionId was already used with different prompt content");
}

async function markSubmissionsRemoved(threadId: string, queued: QueuedTurn[]): Promise<void> {
  const submissionIds = queued.flatMap((item) => item.submissionId ? [item.submissionId] : []);
  if (submissionIds.length) await engine.append(threadId, { type: "TurnSubmissionsRemoved", payload: { submissionIds } });
}

async function markSubmissionsPayloadLost(threadId: string, submissionIds: string[]): Promise<void> {
  if (submissionIds.length) await engine.append(threadId, { type: "TurnSubmissionsPayloadLost", payload: { submissionIds } });
}

function mentionsFromText(text: string): string[] {
  return [...text.matchAll(/@\{([^}]+)\}/g)].map((match) => match[1]!).slice(0, 20);
}

async function resolveThreadApprovals(threadId: string): Promise<void> {
  for (const approval of engine.thread(threadId)?.approvals ?? []) {
    await engine.append(threadId, { type: "ApprovalResolved", payload: { requestId: approval.requestId } });
  }
}

async function cancelThreadTurn(acp: AgentRuntime | undefined, thread: ThreadProjection): Promise<void> {
  const turnId = thread.activeTurnId;
  if (!turnId) return;
  await engine.append(thread.threadId, { type: "TurnPhaseChanged", payload: { phase: "stopping", turnId } });
  const cancellation: Promise<TurnCancellationOutcome> = acp
    ? (async () => {
      try {
        await acp.cancel(thread.sessionId);
        return { safeToRestart: true } as const;
      } catch (error) {
        emitDiagnostic("error", `${providerName(thread.provider)} cancel notification failed; stopping its runtime before continuing: ${error instanceof Error ? error.message : String(error)}`, "turn-cancel");
        const key = runtimeKey(thread.provider, thread.instanceId);
        if (runtimeEventSources.get(key) === acp) runtimeEventSources.delete(key);
        try {
          await acp.close();
        } catch (closeError) {
          const message = `Could not prove the ${providerName(thread.provider)} runtime stopped after cancellation failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`;
          emitDiagnostic("error", message, "turn-cancel");
          return { safeToRestart: false, error: message } as const;
        }
        if (runtimes.get(key) === acp) {
          runtimes.delete(key);
          initializeResults.delete(key);
          configDefaultsFor(thread.provider, thread.instanceId).invalidateLiveDefaults();
          sessionResumes.clear();
        }
        return { safeToRestart: true } as const;
      }
    })()
    : Promise.resolve({ safeToRestart: true } as const);
  turnCancellations.set(thread.threadId, cancellation);
  const drained = await ingestion.flushWithin(thread.threadId, 250);
  if (!drained) {
    emitDiagnostic("warning", "Stopped locally while the final agent output finishes saving.", "turn-cancel");
  }
  if (engine.thread(thread.threadId)?.activeTurnId === turnId) {
    await engine.append(thread.threadId, { type: "TurnCancelled", payload: { turnId } });
  }
  trackLifecycleOperation(() => cancellation.then(async (outcome) => {
    if (turnCancellations.get(thread.threadId) !== cancellation) return;
    if (!outcome.safeToRestart) {
      await engine.append(thread.threadId, { type: "TurnPhaseChanged", payload: { phase: "blocked", turnId, error: redactPrivateError(outcome.error) } });
      return;
    }
    turnCancellations.delete(thread.threadId);
    pushAll("receipt", { type: "turn.quiescent", threadId: thread.threadId, turnId });
    startNextQueued(thread.threadId);
  })).catch((error) => emitDiagnostic("error", error, "turn-cancel"));
}

function runtimeForLocalCancellation(provider: ProviderId, instanceId?: string): AgentRuntime | undefined {
  const runtime = runtimes.get(runtimeKey(provider, instanceId));
  return runtime?.isOpen() ? runtime : undefined;
}

function publishQueue(threadId: string): void {
  pushAll("thread.queueUpdated", { threadId, queue: queueSummary(threadId) });
}

async function runDueSchedules(): Promise<void> {
  if (shuttingDown || checkingSchedules || updateLease || runtimePolicyMutations.size > 0) return;
  checkingSchedules = true;
  try {
    const testDelay = process.env.KIMI_FAKE === "1" ? Number(process.env.KIMI_FAKE_SCHEDULE_ADMISSION_DELAY_MS ?? 0) : 0;
    if (Number.isFinite(testDelay) && testDelay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(testDelay, 30_000)));
    for (const schedule of await schedules.takeDue()) {
      try {
        await enqueueScheduledTurn(schedule);
      } catch (error) {
        const message = redactPrivateError(error instanceof Error ? error.message : String(error));
        await recordScheduleResult(schedule.id, `failed: ${message}`);
        pushAll("notifications.event", { type: "schedule.failed", scheduleId: schedule.id, threadId: schedule.threadId, title: schedule.name, message });
        emitDiagnostic("error", message, "schedules");
      }
    }
  } finally {
    checkingSchedules = false;
  }
}

async function enqueueScheduledTurn(schedule: Schedule): Promise<void> {
  if (updateLease) throw new Error("An app update is prepared; scheduled runs are temporarily paused");
  const queued: QueuedTurn = {
    queuedId: crypto.randomUUID(), text: schedule.text, mentions: mentionsFromText(schedule.text), images: [], mode: "queue",
    createdAt: new Date().toISOString(), origin: "user",
  };
  let thread!: ThreadProjection;
  await queueInsertions.during(schedule.threadId, queued.queuedId, () => withStableQueueWrites(queueWrites, async () => {
    const testDelay = process.env.KIMI_FAKE === "1" ? Number(process.env.KIMI_FAKE_QUEUE_INSERTION_DELAY_MS ?? 0) : 0;
    if (Number.isFinite(testDelay) && testDelay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(testDelay, 30_000)));
    const current = engine.thread(schedule.threadId);
    if (!current || current.archivedAt) throw new Error("The scheduled chat is unavailable or archived");
    assertKimiProvider(current.provider);
    assertRuntimePolicyAvailable(current.provider, current.instanceId);
    if (current.provider !== schedule.provider || current.instanceId !== schedule.instanceId || current.cwd !== schedule.cwd) {
      throw new Error("The scheduled chat target changed; recreate the schedule before running it");
    }
    const permission = current.configOptions.find((option) => option.id.toLowerCase() === "mode" || option.category?.toLowerCase() === "mode")?.currentValue;
    if (schedule.permission !== undefined && String(permission) !== schedule.permission) {
      throw new Error("The chat permission mode changed; recreate the schedule to confirm the new boundary");
    }
    thread = current;
    const queue = turnQueues.get(thread.threadId) ?? [];
    queue.push(queued);
    turnQueues.set(thread.threadId, queue);
    await persistQueuedInsertion(turnQueues, thread.threadId, queued, persistQueues);
  }));
  publishQueue(thread.threadId);
  startNextQueued(thread.threadId);
  void recordScheduleResult(schedule.id, "queued");
  pushAll("notifications.event", { type: "schedule.queued", scheduleId: schedule.id, threadId: thread.threadId, title: schedule.name, message: `Scheduled task queued in ${thread.title}` });
}

async function recordScheduleResult(scheduleId: string, result: string): Promise<void> {
  await trackLifecycleOperation(async () => {
    if (updateLease) {
      emitDiagnostic("error", "Schedule status persistence was blocked by a prepared app update", "schedules");
      return;
    }
    scheduleMutationAdmissions += 1;
    try {
      await delayScheduleResultForTest();
      await schedules.record(scheduleId, result);
    } catch (error) {
      emitDiagnostic("error", `Schedule status persistence failed: ${error instanceof Error ? error.message : String(error)}`, "schedules");
    } finally {
      scheduleMutationAdmissions -= 1;
    }
  });
}

async function delayScheduleMutationForTest(): Promise<void> {
  if (process.env.KIMI_FAKE !== "1") return;
  const delay = Number(process.env.KIMI_FAKE_SCHEDULE_MUTATION_DELAY_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
}

async function delayScheduleResultForTest(): Promise<void> {
  if (process.env.KIMI_FAKE !== "1") return;
  const delay = Number(process.env.KIMI_FAKE_SCHEDULE_RESULT_DELAY_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
}

function startNextQueued(threadId: string): void {
  if (shuttingDown) return;
  startLifecycleOperation(() => runNextQueued(threadId), "turn-admission");
}

async function runNextQueued(threadId: string, expectedQueuedId?: string): Promise<boolean> {
  if (shuttingDown || updateLease) return false;
  if (turnCancellations.has(threadId)) return false;
  if (queueAdmissions.has(threadId)) return false;
  const thread = engine.thread(threadId);
  const queue = turnQueues.get(threadId) ?? [];
  if (!thread || thread.provider !== "kimi" || thread.running || !queue.length) return false;
  if (runtimePolicyMutations.has(runtimeKey(thread.provider, thread.instanceId))) return false;
  const queued = queue[0]!;
  if (expectedQueuedId && queued.queuedId !== expectedQueuedId) return false;
  if (queueInsertions.has(threadId, queued.queuedId)) return false;
  const admission: QueueAdmission = { queued, cancelled: false, restartRequested: false };
  queueAdmissions.set(threadId, admission);
  try {
    if (await threadTouchesWorkspaceLease(thread)) return false;
    return await startQueuedTurn(threadId, admission);
  } catch (error) {
    const message = redactPrivateError(error instanceof Error ? error.message : String(error));
    const current = engine.thread(threadId);
    if (!current?.running && current?.lifecycle.queuedId === admission.queued.queuedId) {
      await engine.append(threadId, { type: "TurnPhaseChanged", payload: { phase: "blocked", queuedId: admission.queued.queuedId, ...(admission.turnId ? { turnId: admission.turnId } : {}), error: message } });
    }
    emitDiagnostic("error", message, "turn-admission");
    return false;
  } finally {
    if (queueAdmissions.get(threadId) === admission) queueAdmissions.delete(threadId);
    if (!shuttingDown && admission.restartRequested && !engine.thread(threadId)?.running && (turnQueues.get(threadId)?.length ?? 0) > 0) {
      startNextQueued(threadId);
    }
  }
}

async function startQueuedTurn(threadId: string, admission: QueueAdmission): Promise<boolean> {
  const { queued } = admission;
  const pendingThread = engine.thread(threadId);
  if (!pendingThread) throw new Error(`Unknown thread ${threadId}`);
  assertKimiProvider(pendingThread.provider);
  const turnId = crypto.randomUUID();
  admission.turnId = turnId;
  await engine.append(threadId, { type: "TurnPhaseChanged", payload: { phase: "preparing", turnId, queuedId: queued.queuedId } });
  const admissionDelay = process.env.KIMI_FAKE === "1" ? Number(process.env.KIMI_FAKE_QUEUE_ADMISSION_DELAY_MS ?? 0) : 0;
  if (Number.isFinite(admissionDelay) && admissionDelay > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(admissionDelay, 30_000)));
  }
  await waitForSessionConfig(pendingThread.provider, pendingThread.instanceId, pendingThread.sessionId);
  const acp = await ensureRuntime(pendingThread.provider, pendingThread.instanceId);
  const thread = engine.thread(threadId);
  if (!thread) throw new Error(`Unknown thread ${threadId}`);
  if (thread.running) throw new Error("A turn is already running");
  const configOptions = await ensureThreadSession(acp, thread);
  if (!hasConfiguredModel(configOptions)) throw new Error(`${providerName(thread.provider)} has no configured model. Complete provider sign-in, then retry.`);
  const prompt: ContentBlock[] = [{ type: "text", text: queued.text }];
  const resourcePaths: string[] = [];
  for (const mention of queued.mentions) {
    const resource = await readWorkspaceFile(thread.cwd, mention);
    resourcePaths.push(resource.path);
    prompt.push({ type: "resource", resource: { uri: pathToFileURL(resource.path).href, text: resource.content, mimeType: "text/plain" } });
  }
  for (const image of queued.images) prompt.push({ type: "image", data: image.data, mimeType: image.mimeType });
  const before = await captureCheckpoint(thread.threadId, turnId, "before", thread.cwd);
  if (!admitQueuedTurn(threadId, admission)) {
    if (!shuttingDown && engine.thread(threadId)?.lifecycle.turnId === turnId) await engine.append(threadId, { type: "TurnPhaseChanged", payload: { phase: "idle", turnId, queuedId: queued.queuedId } });
    return false;
  }
  await engine.append(thread.threadId, { type: "TurnStarted", payload: {
    turnId,
    text: queued.text,
    origin: queued.origin,
    sourceQueuedId: queued.queuedId,
    ...(thread.turns.length === 0 ? { title: titleFromPrompt(queued.text) } : {}),
    ...(resourcePaths.length ? { resources: resourcePaths } : {}),
    ...(queued.images.length ? { images: queued.images.map(({ name, mimeType }) => ({ name, mimeType })) } : {}),
  } });
  const remaining = (turnQueues.get(threadId) ?? []).filter((item) => item.queuedId !== queued.queuedId);
  if (remaining.length) turnQueues.set(threadId, remaining);
  else turnQueues.delete(threadId);
  if (!queued.images.length) await persistQueues();
  publishQueue(threadId);
  if (admission.cancelled || engine.thread(thread.threadId)?.activeTurnId !== turnId) {
    if (engine.thread(thread.threadId)?.activeTurnId === turnId) {
      await engine.append(thread.threadId, { type: "TurnCancelled", payload: { turnId } });
    }
    return true;
  }
  let promptRuntime = acp;
  const promptSourceIsCurrent = () => !shuttingDown
    && runtimeEventSources.get(runtimeKey(thread.provider, thread.instanceId)) === promptRuntime;
  trackLifecycleOperation(() => retryUnknownSessionOnce(
    acp,
    thread,
    (client) => {
      promptRuntime = client;
      return engine.thread(thread.threadId)?.activeTurnId === turnId
        ? client.prompt(thread.sessionId, prompt)
        : Promise.resolve({ stopReason: "cancelled" as const });
    },
  ).then(async (result) => {
    if (!engine.thread(thread.threadId)) return;
    await ingestion.flush(thread.threadId);
    await registerBackgroundTasks(thread.threadId, thread.sessionId, turnId, thread.provider, thread.instanceId, promptSourceIsCurrent);
    if (engine.thread(thread.threadId)?.activeTurnId === turnId) await engine.append(thread.threadId, { type: "TurnPhaseChanged", payload: { phase: "checkpointing", turnId, queuedId: queued.queuedId } });
    const after = await captureCheckpoint(thread.threadId, turnId, "after", thread.cwd, before);
    const localHome = backgroundTaskRuntime(thread)?.kimiHome;
    const localUsage = result.usage || !localHome ? undefined : await readLatestKimiUsage(localHome, thread.sessionId);
    if (engine.thread(thread.threadId)?.activeTurnId !== turnId) return;
    if (localUsage) await engine.append(thread.threadId, { type: "UsageUpdated", payload: { usage: localUsage.context } });
    await engine.append(thread.threadId, result.stopReason === "cancelled"
      ? { type: "TurnCancelled", payload: { turnId } }
      : { type: "TurnCompleted", payload: { turnId, stopReason: result.stopReason, ...(result.usage ? { usage: result.usage } : localUsage ? { usage: localUsage.tokens } : {}) } });
    pushAll("notifications.event", {
      type: result.stopReason === "end_turn" ? "turn.completed" : result.stopReason === "cancelled" ? "turn.cancelled" : "turn.finished",
      threadId: thread.threadId, title: thread.title, message: result.stopReason === "end_turn" ? "Task completed" : `Task stopped: ${result.stopReason}`,
    });
    pushAll("receipt", { type: "turn.quiescent", threadId: thread.threadId, turnId });
    requestQueueRestart(thread.threadId, admission);
  }).catch(async (error: Error) => {
    emitDiagnostic("error", error.message, "turn-runtime");
    await ingestion.flush(thread.threadId);
    await registerBackgroundTasks(thread.threadId, thread.sessionId, turnId, thread.provider, thread.instanceId, promptSourceIsCurrent);
    const current = engine.thread(thread.threadId);
    if (current?.activeTurnId === turnId) await engine.append(thread.threadId, { type: "TurnCompleted", payload: { turnId, stopReason: "error", error: redactPrivateError(error.message) } });
    pushAll("notifications.event", { type: "turn.failed", threadId: thread.threadId, title: thread.title, message: redactPrivateError(error.message) });
    requestQueueRestart(thread.threadId, admission);
  }).catch((error) => emitDiagnostic("error", error, "turn-settlement")));
  return true;
}

function admitQueuedTurn(threadId: string, admission: QueueAdmission): boolean {
  return !shuttingDown
    && queueAdmissions.get(threadId) === admission
    && !admission.cancelled
    && (turnQueues.get(threadId) ?? []).some((item) => item.queuedId === admission.queued.queuedId);
}

function cancelQueueAdmission(threadId: string, queuedId?: string): QueueAdmission | undefined {
  const admission = queueAdmissions.get(threadId);
  if (!admission || (queuedId && admission.queued.queuedId !== queuedId)) return undefined;
  admission.cancelled = true;
  return admission;
}

function requestQueueRestart(threadId: string, admission?: QueueAdmission): void {
  if (shuttingDown) return;
  if (admission && queueAdmissions.get(threadId) === admission) {
    admission.restartRequested = true;
  } else if (!engine.thread(threadId)?.running && (turnQueues.get(threadId)?.length ?? 0) > 0) {
    startNextQueued(threadId);
  }
}

async function registerBackgroundTasks(
  threadId: string,
  sessionId: string,
  turnId: string,
  provider: ProviderId,
  instanceId?: string,
  sourceIsCurrent: () => boolean = () => !shuttingDown,
): Promise<void> {
  await serializeBackgroundTaskMutation(async () => {
    if (!sourceIsCurrent()) return;
    await registerBackgroundTasksNow(threadId, sessionId, turnId, provider, instanceId, sourceIsCurrent);
  });
}

async function registerBackgroundTasksNow(
  threadId: string,
  sessionId: string,
  turnId: string,
  provider: ProviderId,
  instanceId?: string,
  sourceIsCurrent: () => boolean = () => true,
): Promise<void> {
  if (!sourceIsCurrent()) return;
  const thread = engine.thread(threadId);
  if (!thread || thread.sessionId !== sessionId || thread.provider !== provider || thread.instanceId !== instanceId) return;
  const backgroundRuntime = backgroundTaskRuntime(thread);
  if (!backgroundRuntime) return;
  await delayBackgroundTaskRegistrationForTest();
  if (!sourceIsCurrent()) return;
  const runtimeKimiHome = await realpath(backgroundRuntime.kimiHome).catch(() => undefined);
  if (!runtimeKimiHome || !sourceIsCurrent()) return;
  const known = new Set(thread.backgroundTasks.map((task) => task.taskId));
  let threadCapacity = MAX_ACTIVE_BACKGROUND_TASKS - thread.backgroundTasks.filter((task) => task.status === "running").length;
  let globalCapacity = MAX_MONITORED_BACKGROUND_TASKS - engine.threads().reduce(
    (total, candidate) => total + candidate.backgroundTasks.filter((task) => task.status === "running").length,
    0,
  );
  for (const candidate of backgroundTaskCandidates(thread.tools, turnId)) {
    if (known.has(candidate.taskId)) continue;
    const current = await readKimiBackgroundTask(runtimeKimiHome, sessionId, candidate.taskId);
    if (!current) continue;
    if (!sourceIsCurrent()) return;
    if (current.status === "running" && (threadCapacity <= 0 || globalCapacity <= 0)) continue;
    const latest = engine.thread(threadId);
    if (!latest || latest.sessionId !== sessionId || latest.provider !== provider || latest.instanceId !== instanceId) return;
    if (!sourceIsCurrent()) return;
    await engine.append(threadId, {
      type: "BackgroundTaskRegistered",
      payload: {
        taskId: candidate.taskId,
        queuedId: crypto.randomUUID(),
        turnId,
        description: current.description,
        kimiHome: runtimeKimiHome,
      },
    });
    known.add(candidate.taskId);
    if (current.status === "running") {
      threadCapacity -= 1;
      globalCapacity -= 1;
    } else {
      backgroundTasks.wake();
      const registeredAt = engine.thread(threadId)?.backgroundTasks.find((task) => task.taskId === candidate.taskId)?.registeredAt;
      if (registeredAt && sourceIsCurrent()) {
        await finishBackgroundTaskNow({ threadId, sessionId, taskId: candidate.taskId, registeredAt, kimiHome: runtimeKimiHome }, current, sourceIsCurrent);
      }
    }
  }
  backgroundTasks.wake();
}

function pendingBackgroundTasks(): PendingBackgroundTask[] {
  return engine.threads().flatMap((thread) => {
    const backgroundRuntime = backgroundTaskRuntime(thread);
    if (!backgroundRuntime) return [];
    return thread.backgroundTasks
      .filter((task) => task.status === "running" && typeof task.kimiHome === "string")
      .map((task) => ({
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        taskId: task.taskId,
        registeredAt: task.registeredAt,
        kimiHome: task.kimiHome!,
      }));
  });
}

function backgroundTaskRuntime(thread: Pick<ThreadProjection, "provider" | "instanceId">): { kimiHome: string } | undefined {
  if (thread.provider !== "kimi") return undefined;
  if (!thread.instanceId) return { kimiHome };
  const instance = providerInstances.find((candidate) => candidate.provider === "kimi" && candidate.id === thread.instanceId);
  if (!instance || instance.wsl) return undefined;
  return { kimiHome: instance.environment.KIMI_CODE_HOME ?? kimiHome };
}

async function reconcileUnsupportedBackgroundTasks(): Promise<void> {
  for (const thread of engine.threads()) {
    const supported = Boolean(backgroundTaskRuntime(thread));
    for (const task of thread.backgroundTasks.filter((candidate) => candidate.status === "running" && (!supported || !candidate.kimiHome))) {
      await engine.append(thread.threadId, { type: "BackgroundTaskFinished", payload: { taskId: task.taskId, status: "lost" } });
      await engine.append(thread.threadId, { type: "BackgroundTaskReportCancelled", payload: { taskId: task.taskId } });
    }
  }
}

async function finishBackgroundTask(pending: PendingBackgroundTask, result: BackgroundTaskResult): Promise<void> {
  await serializeBackgroundTaskMutation(() => finishBackgroundTaskNow(pending, result));
}

async function finishBackgroundTaskNow(pending: PendingBackgroundTask, result: BackgroundTaskResult, sourceIsCurrent: () => boolean = () => true): Promise<void> {
  const thread = engine.thread(pending.threadId);
  const task = thread?.backgroundTasks.find((candidate) => candidate.taskId === pending.taskId);
  if (!thread || !task || task.status !== "running") return;
  await delayBackgroundTaskFinishForTest();
  if (!sourceIsCurrent()) return;
  await engine.append(thread.threadId, {
    type: "BackgroundTaskFinished",
    payload: {
      taskId: task.taskId,
      status: result.status,
      ...(result.endedAt !== undefined ? { endedAt: result.endedAt } : {}),
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      ...(result.outputPath ? { outputPath: result.outputPath } : {}),
    },
  });
  pushAll("notifications.event", { type: "background.completed", threadId: thread.threadId, title: thread.title, message: `Background task ${result.status}` });
  if (!sourceIsCurrent()) return;
  await engine.append(thread.threadId, { type: "BackgroundTaskReportCancelled", payload: { taskId: task.taskId } });
}

function serializeBackgroundTaskMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = backgroundTaskMutation.catch(() => undefined).then(operation);
  backgroundTaskMutation = result.then(() => undefined, () => undefined);
  return result;
}

async function delayBackgroundTaskRegistrationForTest(): Promise<void> {
  if (process.env.KIMI_FAKE !== "1") return;
  const delay = Number(process.env.KIMI_FAKE_BACKGROUND_REGISTRATION_DELAY_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
}

async function delayBackgroundTaskFinishForTest(): Promise<void> {
  if (process.env.KIMI_FAKE !== "1") return;
  const delay = Number(process.env.KIMI_FAKE_BACKGROUND_FINISH_DELAY_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
}

async function delayBackgroundTaskMonitorFinishForTest(): Promise<void> {
  if (process.env.KIMI_FAKE !== "1") return;
  const delay = Number(process.env.KIMI_FAKE_BACKGROUND_MONITOR_FINISH_DELAY_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
}

async function ensureThreadSession(acp: AgentRuntime, thread: ThreadProjection): Promise<SessionConfigOption[]> {
  if (acp.hasSession(thread.sessionId)) return thread.configOptions;
  const key = runtimeSessionOperationKey(thread.provider, thread.instanceId, thread.sessionId);
  const pending = sessionResumes.get(key);
  if (pending) return pending;
  const resume = (async () => {
    const configOptions = (await resumeRuntimeSession(acp, thread.sessionId, thread.cwd)).configOptions ?? thread.configOptions;
    await engine.append(thread.threadId, { type: "ConfigOptionsReplaced", payload: { options: configOptions } });
    return configOptions;
  })().finally(() => sessionResumes.delete(key));
  sessionResumes.set(key, resume);
  return resume;
}

async function resumeRuntimeSession(acp: AgentRuntime, sessionId: string, cwd: string): ReturnType<AgentRuntime["resumeSession"]> {
  try {
    return await acp.resumeSession(sessionId, cwd);
  } catch (error) {
    if (!isTransientWindowsSpawnError(error)) throw error;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
    return acp.resumeSession(sessionId, cwd);
  }
}

async function retryUnknownSessionOnce<T>(
  acp: AgentRuntime,
  thread: ThreadProjection,
  operation: (client: AgentRuntime) => Promise<T>,
): Promise<T> {
  try {
    return await operation(acp);
  } catch (error) {
    if (!isUnknownAcpSessionError(error) && !/unknown .*?(?:session|thread)/i.test(error instanceof Error ? error.message : String(error))) throw error;
    const current = engine.thread(thread.threadId);
    if (!current) throw new Error(`Unknown thread ${thread.threadId}`);
    const client = await ensureRuntime(thread.provider, thread.instanceId);
    await ensureThreadSession(client, current);
    return operation(client);
  }
}

function serializeSessionConfig<T>(provider: ProviderId, instanceId: string | undefined, sessionId: string, operation: () => Promise<T>): Promise<T> {
  const key = runtimeSessionOperationKey(provider, instanceId, sessionId);
  const previous = sessionConfigWrites.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  sessionConfigWrites.set(key, tail);
  void tail.then(() => {
    if (sessionConfigWrites.get(key) === tail) sessionConfigWrites.delete(key);
  });
  return result;
}

async function waitForSessionConfig(provider: ProviderId, instanceId: string | undefined, sessionId: string): Promise<void> {
  const key = runtimeSessionOperationKey(provider, instanceId, sessionId);
  while (sessionConfigWrites.has(key)) {
    await sessionConfigWrites.get(key);
  }
}

async function rememberLiveConfigOptions(provider: ProviderId, instanceId: string | undefined, options: SessionConfigOption[], sourceRuntime?: AgentRuntime): Promise<boolean> {
  const key = runtimeKey(provider, instanceId);
  const runtime = sourceRuntime ?? runtimes.get(key);
  if (!runtime || runtimes.get(key) !== runtime || !runtime.isOpen()) return false;
  const store = configDefaultsFor(provider, instanceId);
  const observation = store.beginLiveObservation();
  if (!options.length) return true;
  await store.update(options);
  if (runtimes.get(key) === runtime && runtime?.isOpen()) {
    store.completeLiveObservation(observation, runtime);
    return true;
  }
  return false;
}

function persistLiveConfigOptions(provider: ProviderId, instanceId: string | undefined, options: SessionConfigOption[]): void {
  void trackLifecycleOperation(() => rememberLiveConfigOptions(provider, instanceId, options))
    .catch((error) => emitDiagnostic("error", error, "config-defaults"));
}

async function probeConfigDefaults(provider: ProviderId, instanceId?: string): Promise<SessionConfigOption[]> {
  const key = runtimeKey(provider, instanceId);
  const acp = await ensureRuntime(provider, instanceId);
  const pending = configDefaultsProbes.get(key);
  if (pending?.runtime === acp) return pending.promise;
  const probing = (async () => {
    await mkdir(configProbeCwd, { recursive: true });
    const options = (await acp.newSession(configProbeCwd)).configOptions ?? [];
    if (!await rememberLiveConfigOptions(provider, instanceId, options, acp)) throw new Error("Runtime changed during config probe");
    return options;
  })().finally(() => {
    if (configDefaultsProbes.get(key)?.promise === probing) configDefaultsProbes.delete(key);
  });
  configDefaultsProbes.set(key, { runtime: acp, promise: probing });
  return probing;
}

const pairClaimSchema = z.object({ id, method: z.literal("remote.claim"), params: z.object({ code: z.string().min(8).max(12), name: z.string().trim().min(1).max(80) }) });

function remoteStatus(): ReturnType<RemoteAccess["status"]> & { listening: boolean; addresses: string[] } {
  const status = remoteAccess.status();
  const hosts = status.config.bind === "0.0.0.0"
    ? Object.values(networkInterfaces()).flat().filter((address) => address?.family === "IPv4" && !address.internal).map((address) => address!.address)
    : ["127.0.0.1"];
  return { ...status, listening: Boolean(remoteServer), addresses: status.config.enabled ? [...new Set(hosts)].map((host) => `ws://${host}:${status.config.port}`) : [] };
}

async function replaceRemoteServer(config: RemoteConfig): Promise<void> {
  const previous = remoteAccess.status().config;
  await stopRemoteServer();
  try {
    if (config.enabled) await startRemoteServer(config);
  } catch (error) {
    if (previous.enabled) await startRemoteServer(previous).catch(() => undefined);
    throw error;
  }
}

async function stopRemoteServer(): Promise<void> {
  const current = remoteServer;
  remoteServer = undefined;
  if (!current) return;
  for (const socket of remoteConnections) socket.terminate();
  await new Promise<void>((resolveClose) => current.close(() => resolveClose()));
}

async function startRemoteServer(config: RemoteConfig): Promise<void> {
  if (shuttingDown) throw new Error("Server is shutting down");
  if (remoteServer) throw new Error("Remote access is already listening");
  const verifyRemote: VerifyClientCallbackSync = ({ req }) => {
    if (shuttingDown) return false;
    const path = new URL(req.url ?? "/", "ws://localhost").pathname;
    const address = req.socket.remoteAddress ?? "unknown";
    if (path === "/pair") return remoteAccess.allow(`pair-open:${address}`, 30);
    const protocols = req.headers["sec-websocket-protocol"];
    return path === "/remote" && remoteProtocolOffered(protocols) && Boolean(remoteAccess.authenticate(remoteProtocolToken(protocols)));
  };
  const candidate = new WebSocketServer({
    host: config.bind,
    port: config.port,
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: selectRemoteProtocol,
    verifyClient: verifyRemote,
  });
  await new Promise<void>((resolveListen, reject) => {
    const failed = (error: Error) => reject(error);
    candidate.once("error", failed);
    candidate.once("listening", () => { candidate.off("error", failed); resolveListen(); });
  }).catch(async (error) => {
    await new Promise<void>((resolveClose) => candidate.close(() => resolveClose())).catch(() => undefined);
    throw error;
  });
  if (shuttingDown) {
    await closeWebSocketServer(candidate);
    throw new Error("Server is shutting down");
  }
  remoteServer = candidate;
  candidate.on("error", (error) => emitDiagnostic("error", error, "remote-access"));
  candidate.on("connection", (socket, request) => {
    if (!trackConnectedSocket(socket)) return;
    handleRemoteConnection(socket, request.url, request.headers["sec-websocket-protocol"], request.socket.remoteAddress ?? "unknown");
  });
}

function handleRemoteConnection(socket: WebSocket, requestUrl: string | undefined, protocols: string | string[] | undefined, address: string): void {
  remoteConnections.add(socket);
  const pairing = new URL(requestUrl ?? "/", "ws://localhost").pathname === "/pair";
  let device = pairing ? undefined : remoteAccess.authenticate(remoteProtocolToken(protocols));
  if (device) attachRemoteSocket(socket, device);
  else socket.send(JSON.stringify({ channel: "remote.pairRequired", seq: 1, payload: { protocolVersion: 1 } }));

  socket.on("message", (data) => {
    let requestId: string | number | undefined;
    if (shuttingDown) return;
    void trackLifecycleOperation(async () => {
      const input = JSON.parse(data.toString()) as unknown;
      if (input && typeof input === "object" && "id" in input && (typeof input.id === "string" || typeof input.id === "number")) requestId = input.id;
      if (!device) {
        if (!remoteAccess.allow(`pair-claim:${address}`, 8)) throw new Error("Too many pairing attempts; wait one minute");
        const claim = pairClaimSchema.parse(input);
        const paired = await remoteAccess.claimPairing(claim.params.code, claim.params.name);
        device = paired.device;
        reply(socket, claim.id, { device: paired.device, token: paired.token });
        attachRemoteSocket(socket, device);
        return;
      }
      const authenticatedDevice = device;
      if (!remoteAccess.allow(`device:${authenticatedDevice.id}`, 240)) {
        void recordRemoteTelemetry(() => remoteAccess.audit("device.rate_limited", authenticatedDevice.id));
        socket.close(4008, "Rate limit exceeded");
        return;
      }
      if (!remoteMethodAllowed(input)) {
        const requestId = input && typeof input === "object" && "id" in input && (typeof input.id === "string" || typeof input.id === "number") ? input.id : "remote";
        const method = input && typeof input === "object" && "method" in input && typeof input.method === "string" ? input.method : "unknown";
        void recordRemoteTelemetry(() => remoteAccess.audit("method.denied", authenticatedDevice.id, method));
        reply(socket, requestId, undefined, { code: -32601, message: "This method is not available to remote devices" });
        return;
      }
      assertRemoteScope(input);
      await handle(socket, input);
    }).catch(async (error) => {
      void recordRemoteTelemetry(() => remoteAccess.audit("request.rejected", device?.id, error instanceof Error ? error.message : String(error)));
      if (socket.readyState !== socket.OPEN) return;
      const projected = publicRpcError({ code: -32600, message: error instanceof Error ? error.message : String(error) });
      socket.send(JSON.stringify({ ...(requestId !== undefined ? { id: requestId } : {}), error: projected }));
    });
  });
  socket.on("close", () => {
    remoteConnections.delete(socket);
    sockets.delete(socket);
    const disconnectedDevice = device;
    if (!disconnectedDevice) return;
    const connected = remoteDeviceSockets.get(disconnectedDevice.id);
    connected?.delete(socket);
    if (!connected?.size) remoteDeviceSockets.delete(disconnectedDevice.id);
    if (!shuttingDown) void recordRemoteTelemetry(() => remoteAccess.audit("device.disconnected", disconnectedDevice.id));
  });
}

function assertRemoteScope(input: unknown): void {
  const request = input as { method?: unknown; params?: Record<string, unknown> };
  const params = request.params && typeof request.params === "object" ? request.params : {};
  if (request.method === "threads.create") {
    if (params.standalone === true) return;
    if (typeof params.cwd !== "string" || !knownRemoteWorkspace(params.cwd)) throw new Error("Remote devices can create project chats only in an existing Kimi Code workspace");
  }
  if (request.method === "threads.list" && typeof params.cwd === "string" && !knownRemoteWorkspace(params.cwd)) {
    throw new Error("Remote thread filtering is limited to existing Kimi Code workspaces");
  }
  if (request.method === "threads.resume") {
    const thread = typeof params.threadId === "string" ? engine.thread(params.threadId) : undefined;
    if (!thread || params.sessionId !== thread.sessionId) throw new Error("Remote devices can resume only an existing matching Kimi Code thread");
    const cwdMatches = thread.kind === "chat"
      ? params.cwd === remoteChatCwd(thread)
        || (typeof params.cwd === "string" && comparablePath(params.cwd) === comparablePath(thread.cwd))
      : typeof params.cwd === "string" && comparablePath(params.cwd) === comparablePath(thread.cwd);
    if (!cwdMatches) throw new Error("Remote devices can resume only an existing matching Kimi Code thread");
  }
}

function knownRemoteWorkspace(cwd: string): boolean {
  const candidate = comparablePath(cwd);
  return engine.threads().some((thread) => comparablePath(thread.cwd) === candidate || (thread.worktree && comparablePath(thread.worktree.sourceCwd) === candidate));
}

function attachRemoteSocket(socket: WebSocket, device: RemoteDevice): void {
  const connected = remoteDeviceSockets.get(device.id) ?? new Set<WebSocket>();
  connected.add(socket);
  remoteDeviceSockets.set(device.id, connected);
  sockets.add(socket);
  socketSeq.set(socket, 0);
  sendPush(socket, "server.welcome", { protocolVersion: 1, remote: true, device: { id: device.id, name: device.name } });
  void recordRemoteTelemetry(() => remoteAccess.seen(device.id));
}

function trackConnectedSocket(socket: WebSocket): boolean {
  connectedSockets.add(socket);
  socket.once("close", () => connectedSockets.delete(socket));
  if (!shuttingDown) return true;
  socket.terminate();
  return false;
}

const verifyClient: VerifyClientCallbackSync = ({ origin, req }) => !shuttingDown
  && (isAuthorizedSocketRequest(origin, req.url, serverToken) || isPreviewBridgeRequest(req.url, previewBridgeToken));
const server = new WebSocketServer({ host: "127.0.0.1", port, verifyClient });
server.on("connection", (socket, request) => {
  if (!trackConnectedSocket(socket)) return;
  const previewBridge = isPreviewBridgeRequest(request.url, previewBridgeToken);
  if (previewBridge) {
    previewBridgeSockets.add(socket);
  } else {
    sockets.add(socket);
    socketSeq.set(socket, 0);
    sendPush(socket, "server.welcome", { defaultCwd, protocolVersion: 1 });
  }
  socket.on("message", (data) => {
    if (shuttingDown) return;
    void trackLifecycleOperation(async () => handle(socket, JSON.parse(data.toString())))
      .catch((error) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ error: { code: -32700, message: error instanceof Error ? error.message : String(error) } }));
      });
  });
  socket.on("close", () => {
    sockets.delete(socket);
    releaseUpdateLease(socket);
    startLifecycleOperation(async () => { await Promise.allSettled([...socketTerminals.get(socket) ?? []].map((sessionId) => terminal.stop(sessionId))); }, "terminal-close");
  });
});
server.on("listening", () => console.log(`Kimi Code orchestration server listening on ws://127.0.0.1:${port}`));
if (remoteAccess.status().config.enabled) {
  await startRemoteServer(remoteAccess.status().config).catch((error) => emitDiagnostic("error", `Remote access could not start: ${error instanceof Error ? error.message : String(error)}`, "remote-access"));
}

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

function quotaCachePathFor(key: string, runtimeHome: string): string {
  const homeIdentity = createHash("sha256").update(comparablePath(runtimeHome)).digest("hex").slice(0, 16);
  return join(dataHome, `quota-cache-${key.replaceAll(":", "-")}-${homeIdentity}.json`);
}

function canonicalExistingPath(value: string): string {
  const requested = resolve(value);
  try {
    return realpathSync(requested);
  } catch {
    return requested;
  }
}

function isInternalProbeSession(session: unknown): boolean {
  if (!session || typeof session !== "object") return false;
  const cwd = (session as { cwd?: unknown }).cwd;
  if (typeof cwd !== "string") return false;
  if (isKimiQuotaProbePath(cwd, quotaProbeCwd)) return true;
  if (basename(cwd).toLowerCase() !== "config-probe") return false;
  return comparablePath(cwd) === comparablePath(configProbeCwd);
}

function isStandaloneChatPath(path: string): boolean {
  return basename(path).toLowerCase() === "chats"
    && comparablePath(path) === comparablePath(standaloneChatCwd);
}

function comparablePath(value: string): string {
  const requested = resolve(value);
  let current = requested;
  const suffix: string[] = [];
  while (true) {
    try {
      current = realpathSync(current);
      break;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        current = requested;
        suffix.length = 0;
        break;
      }
      suffix.unshift(basename(current));
      current = parent;
    }
  }
  return resolve(current, ...suffix).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

function threadWorkspacePaths(threads: ThreadProjection[]): string[] {
  return threads.flatMap((thread) => [thread.cwd, ...(thread.worktree ? [thread.worktree.sourceCwd] : [])]);
}

function storedTaskKimiHomes(threads: ThreadProjection[]): string[] {
  return [...new Set(threads.flatMap((thread) => thread.backgroundTasks.flatMap((task) => typeof task.kimiHome === "string"
    ? [task.kimiHome, canonicalExistingPath(task.kimiHome)]
    : [])))];
}

async function acquireGitWorkspaceLease(cwd: string): Promise<GitWorkspaceLease> {
  const lease = acquireWorkspaceLease(comparablePath(cwd), true);
  try {
    const identity = await git.workspaceIdentity(cwd);
    lease.root = comparablePath(identity.root);
    lease.commonDir = comparablePath(identity.commonDir);
    assertLeaseAvailable(lease);
    for (const thread of engine.threads().filter((candidate) => candidate.provider === "kimi" && threadHasWorkspaceWork(candidate))) {
      if (threadTouchesPath(thread, lease.root)) throw new Error("Finish or stop active Kimi work before changing this Git workspace");
      if (await gitCommonDir(thread.cwd) === lease.commonDir) {
        throw new Error("Finish or stop active Kimi work before changing this Git workspace");
      }
    }
    lease.pending = false;
    return lease;
  } catch (error) {
    releaseGitWorkspaceLease(lease);
    throw error;
  }
}

function acquireWorkspaceLease(root: string, pending = false): GitWorkspaceLease {
  if (updateLease) throw new Error("An app update is prepared; Git actions are temporarily paused");
  const lease = { root, pending };
  assertLeaseAvailable(lease);
  if (engine.threads().some((thread) => thread.provider === "kimi" && threadHasWorkspaceWork(thread) && threadTouchesPath(thread, root))) {
    throw new Error("Finish or stop active Kimi work before changing this Git workspace");
  }
  gitWorkspaceLeases.add(lease);
  return lease;
}

function assertLeaseAvailable(candidate: GitWorkspaceLease): void {
  if ([...gitWorkspaceLeases].some((lease) => lease !== candidate && (
    pathsOverlap(lease.root, candidate.root)
    || Boolean(lease.commonDir && candidate.commonDir && lease.commonDir === candidate.commonDir)
  ))) throw new Error("Another Git action is already changing this workspace");
}

function releaseGitWorkspaceLease(lease: GitWorkspaceLease): void {
  if (!gitWorkspaceLeases.delete(lease)) return;
  for (const threadId of turnQueues.keys()) startNextQueued(threadId);
}

async function threadTouchesWorkspaceLease(thread: ThreadProjection): Promise<boolean> {
  if ([...gitWorkspaceLeases].some((lease) => lease.pending || threadTouchesPath(thread, lease.root))) return true;
  if (![...gitWorkspaceLeases].some((lease) => lease.commonDir)) return false;
  let commonDir: string | undefined;
  try {
    commonDir = await gitCommonDir(thread.cwd);
  } catch {
    return gitWorkspaceLeases.size > 0;
  }
  if (!commonDir) return false;
  return [...gitWorkspaceLeases].some((lease) => lease.pending || lease.commonDir === commonDir);
}

async function gitCommonDir(cwd: string): Promise<string | undefined> {
  try {
    return comparablePath((await git.workspaceIdentity(cwd)).commonDir);
  } catch (error) {
    if (/not a git repository/i.test(error instanceof Error ? error.message : String(error))) return undefined;
    throw error;
  }
}

function threadTouchesPath(thread: ThreadProjection, root: string): boolean {
  return threadWorkspacePaths([thread]).some((path) => pathsOverlap(comparablePath(path), root));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function threadHasWorkspaceWork(thread: ThreadProjection, ignoreQueueInsertions = false): boolean {
  return thread.running
    || Boolean(thread.activeTurnId)
    || ["preparing", "running", "stopping", "checkpointing"].includes(thread.lifecycle.phase)
    || queueAdmissions.has(thread.threadId)
    || (!ignoreQueueInsertions && queueInsertions.hasAny(thread.threadId))
    || turnCancellations.has(thread.threadId)
    || (turnQueues.get(thread.threadId)?.length ?? 0) > 0
    || thread.approvals.length > 0
    || thread.backgroundTasks.some((task) => task.status === "running");
}

function classifyRuntimeSession(
  session: unknown,
  target: { provider: ProviderId; instanceId?: string },
  remote = false,
): unknown {
  if (!session || typeof session !== "object") return remote ? undefined : session;
  const record = session as Record<string, unknown>;
  if (remote) {
    const sessionId = record.sessionId;
    const linked = typeof sessionId === "string"
      ? engine.threads().find((thread) => thread.provider === target.provider
        && thread.instanceId === target.instanceId
        && thread.sessionId === sessionId)
      : undefined;
    if (!linked) return undefined;
    const safe: Record<string, unknown> = { ...record };
    delete safe.cwd;
    return { ...safe, cwd: linked.kind === "chat" ? remoteChatCwd(linked) : linked.cwd, kind: linked.kind };
  }
  const cwd = record.cwd;
  if (typeof cwd !== "string") return session;
  return { ...record, kind: isStandaloneChatPath(cwd) ? "chat" : "project" };
}

function isLinkedSubagent(thread: ThreadProjection, agentThreadId: string): boolean {
  return thread.tools.some((tool) => {
    const input = tool.rawInput && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput) ? tool.rawInput as Record<string, unknown> : {};
    return Array.isArray(input.receiverThreadIds) && input.receiverThreadIds.includes(agentThreadId);
  });
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
    emitDiagnostic("error", `Checkpoint failed: ${error instanceof Error ? error.message : String(error)}`, "checkpoint");
    return undefined;
  }
}

async function closeWebSocketServer(target: WebSocketServer | undefined): Promise<void> {
  if (!target) return;
  for (const socket of target.clients) socket.terminate();
  await new Promise<void>((resolveClose, rejectClose) => {
    try {
      target.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") rejectClose(error);
        else resolveClose();
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_SERVER_NOT_RUNNING") resolveClose();
      else rejectClose(error);
    }
  });
}

function terminateConnectedSockets(): void {
  for (const socket of new Set([
    ...connectedSockets,
    ...sockets,
    ...remoteConnections,
    ...server.clients,
    ...(remoteServer?.clients ?? []),
  ])) socket.terminate();
}

function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    clearInterval(scheduleTimer);
    const remoteListener = remoteServer;
    remoteServer = undefined;
    const listenersClosed = Promise.allSettled([
      closeWebSocketServer(remoteListener),
      closeWebSocketServer(server),
    ]);
    terminateConnectedSockets();
    await auth.close();
    await backgroundTasks.close();
    for (const admission of queueAdmissions.values()) admission.cancelled = true;

    const ownedRuntimes = new Set([...runtimeEventSources.values(), ...runtimes.values()]);
    runtimeEventSources.clear();
    const closeResults = await Promise.allSettled([...ownedRuntimes].map((runtime) => runtime.close()));
    await terminal.close();
    await drainLifecycleOperations();
    await backgroundTaskMutation;
    await drainLifecycleOperations();
    await persistQueues();
    await ingestion.flushAll();
    await drainLifecycleOperations();
    const lateRemoteListener = remoteServer;
    remoteServer = undefined;
    terminateConnectedSockets();
    const listenerResults = [
      ...await listenersClosed,
      ...await Promise.allSettled([closeWebSocketServer(lateRemoteListener)]),
    ];

    const closeFailure = closeResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const listenerFailure = listenerResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (closeFailure) throw closeFailure.reason;
    if (listenerFailure) throw listenerFailure.reason;
  })();
  return shutdownPromise;
}

async function resetRuntime(provider: ProviderId = "kimi"): Promise<void> {
  const targets = allKnownKimiRuntimeTargets().filter((target) => target.provider === provider);
  const policyKeys = acquireRuntimePolicyMutations(targets, true, "logging out or replacing authentication");
  try {
    await resetRuntimeTargets(targets);
  } finally {
    releaseRuntimePolicyMutations(policyKeys, false);
  }
}

async function resetRuntimeTargets(targets: ReadonlyArray<{ provider: ProviderId; instanceId?: string }>): Promise<void> {
  for (const target of [...targets].sort((left, right) => runtimeKey(left.provider, left.instanceId).localeCompare(runtimeKey(right.provider, right.instanceId)))) {
    await resetRuntimeInstance(target.provider, target.instanceId);
  }
}

function clearRuntimeSessionResumes(provider: ProviderId, instanceId?: string): void {
  for (const thread of engine.threads()) {
    if (thread.provider === provider && thread.instanceId === instanceId) {
      sessionResumes.delete(runtimeSessionOperationKey(provider, instanceId, thread.sessionId));
    }
  }
}

async function resetRuntimeInstance(provider: ProviderId, instanceId?: string): Promise<void> {
  const key = runtimeKey(provider, instanceId);
  const starting = runtimeStarts.get(key);
  if (starting) await starting.catch(() => undefined);
  const runtime = runtimes.get(key);
  if (runtime) await runtime.close();
  if (runtime && runtimeEventSources.get(key) === runtime) runtimeEventSources.delete(key);
  if (runtimeStarts.get(key) === starting) runtimeStarts.delete(key);
  if (!runtime || runtimes.get(key) === runtime) runtimes.delete(key);
  initializeResults.delete(key);
  configDefaultsFor(provider, instanceId).invalidateLiveDefaults();
  clearRuntimeSessionResumes(provider, instanceId);
}

async function handleAuthEvent(event: AuthEvent): Promise<void> {
  pushLocal("auth.status", { ...auth.status(), event });
  if (event.type === "complete" && event.operation === "login" && authPolicyKeys) {
    const policyKeys = authPolicyKeys;
    authPolicyKeys = undefined;
    releaseRuntimePolicyMutations(policyKeys);
  } else if (event.type === "complete") {
    wakeRuntimePolicyWork();
  }
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
if (process.env.KIMI_FAKE === "1") {
  const delay = Number(process.env.KIMI_FAKE_SHUTDOWN_AFTER_MS ?? 0);
  if (Number.isFinite(delay) && delay > 0) {
    const timer = setTimeout(() => void shutdown(), Math.min(delay, 30_000));
    timer.unref();
  }
  if (process.env.KIMI_FAKE_SHUTDOWN_STDIN === "1") {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (chunk) => {
      if (String(chunk).trim() === "shutdown") void shutdown();
    });
    process.stdin.resume();
  }
}

async function loadQueues(): Promise<void> {
  try {
    const loaded = await readRecoverableJson(queuePath, (value) => {
      const parsed = persistedQueueSchema.safeParse(value);
      return parsed.success ? parsed.data : undefined;
    });
    if (loaded.corrupt) console.error("[queue] Recovered from an invalid pending queue cache");
    let discardedQueueItem = false;
    for (const [threadId, queued] of Object.entries(loaded.value ?? {})) {
      const thread = engine.thread(threadId);
      if (!thread || thread.provider !== "kimi" || !queued.length) continue;
      const hydrated = queued
        .map(({ submissionId, ...item }) => ({ ...item, origin: item.origin ?? "user", images: [], ...(submissionId ? { submissionId } : {}) }))
        .filter((item) => item.origin !== "background_task");
      const receiptById = new Map(thread.submissionReceipts.map((receipt) => [receipt.submissionId, receipt]));
      discardedQueueItem ||= queued.some((item) => item.origin === "background_task"
        || Boolean(item.submissionId && receiptById.get(item.submissionId)?.state !== "queued"));
      const recoverable = hydrated
        .filter((item) => !item.submissionId || receiptById.get(item.submissionId)?.state === "queued");
      if (recoverable.length) turnQueues.set(threadId, recoverable);
    }
    await reconcileMissingSubmissionPayloads(engine.threads(), turnQueues, markSubmissionsPayloadLost);
    if (discardedQueueItem) await persistQueues();
  } catch (error) {
    console.error(`[queue] Pending queue recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

function persistQueues(): Promise<void> {
  const snapshot = structuredClone(persistableQueues());
  return persistQueueSnapshot(
    queueWrites,
    snapshot,
    () => structuredClone(persistableQueues()),
    (value) => writeRecoverableJson(queuePath, value),
  );
}

function persistableQueues(): Record<string, Array<Omit<QueuedTurn, "images">>> {
  return Object.fromEntries([...turnQueues].flatMap(([threadId, queued]) => {
    const textOnly = queued.filter((item) => item.images.length === 0).map(({ images: _images, ...item }) => item);
    return textOnly.length ? [[threadId, textOnly]] : [];
  }));
}
