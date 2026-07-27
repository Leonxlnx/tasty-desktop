import type { PlanEntry, SessionConfigOption, SessionUpdate, Usage, UsageUpdate } from "@agentclientprotocol/sdk";
import { EventStore, type StoredEvent } from "./event-store.js";
import type { Checkpoint } from "./checkpoint-reactor.js";

export type Message = { turnId: string; role: "user" | "assistant" | "thought"; text: string; seq?: number; updatedSeq?: number; origin?: "user" | "background_task"; sourceQueuedId?: string; resources?: string[]; images?: Array<{ name: string; mimeType: string }> };
export type ToolCall = { toolCallId: string; turnId?: string; title?: string; kind?: string; status?: string; content?: unknown[]; locations?: unknown[]; rawInput?: unknown; rawOutput?: unknown };
export type Approval = { requestId: string; turnId?: string; title: string; kind: "permission" | "question" | "plan_review"; options: Array<{ optionId: string; name: string; kind: string }> };
export type TurnCheckpoint = Checkpoint & { diff?: string };
export type ThreadUsage = { context?: UsageUpdate; tokens?: Usage };
export type ProviderId = "kimi" | "codex" | "claude" | "cursor" | "opencode";
export type ThreadGoal = {
  objective: string;
  status: "active" | "complete";
  createdAt: string;
  updatedAt: string;
};
export type TurnRecord = { turnId: string; startedAt: string; completedAt?: string; stopReason?: string; error?: string; usage?: Usage };
export type TurnPhase = "idle" | "preparing" | "running" | "stopping" | "checkpointing" | "blocked" | "failed";
export type TurnLifecycle = { phase: TurnPhase; updatedAt: string; turnId?: string; queuedId?: string; error?: string };
export type ThreadWorktree = { sourceCwd: string; branch: string };
export type BackgroundTask = {
  taskId: string;
  queuedId: string;
  turnId: string;
  description: string;
  status: "running" | "completed" | "failed" | "killed" | "lost" | "timed_out" | "expired";
  registeredAt: string;
  updatedAt: string;
  endedAt?: number;
  exitCode?: number | null;
  /** Historical scheduling marker. Delivery is guaranteed only by reportDeliveredAt. */
  reportQueued: boolean;
  reportAttemptCount?: number;
  reportNextAttemptAt?: string;
  reportLastError?: string;
  reportFailedAt?: string;
  reportDeliveredAt?: string;
  reportCancelledAt?: string;
};
export type ActivityEntry = {
  id: string;
  turnId: string;
  kind: "thought" | "tool";
  status: "pending" | "in_progress" | "completed" | "failed";
  text: string;
  toolCallId?: string;
  seq: number;
  updatedSeq?: number;
  createdAt: string;
  updatedAt: string;
};

export type ThreadProjection = {
  threadId: string;
  sessionId: string;
  provider: ProviderId;
  instanceId?: string;
  parentThreadId?: string;
  cwd: string;
  worktree?: ThreadWorktree;
  kind: "project" | "chat";
  title: string;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  activeTurnId: string | undefined;
  stopReason: string | undefined;
  lifecycle: TurnLifecycle;
  turns: TurnRecord[];
  messages: Message[];
  activity: ActivityEntry[];
  plan: PlanEntry[];
  tools: ToolCall[];
  approvals: Approval[];
  configOptions: SessionConfigOption[];
  commands: unknown[];
  modeId: string | undefined;
  checkpoints: TurnCheckpoint[];
  backgroundTasks: BackgroundTask[];
  usage: ThreadUsage;
  goal?: ThreadGoal;
  archivedAt?: string;
};

export type DomainEvent =
  | { type: "ThreadSnapshot"; payload: { thread: ThreadProjection } }
  | { type: "ThreadCreated"; payload: { sessionId: string; provider?: ProviderId; instanceId?: string; parentThreadId?: string; cwd: string; worktree?: ThreadWorktree; kind?: "project" | "chat"; title: string; configOptions?: SessionConfigOption[] } }
  | { type: "ThreadRenamed"; payload: { title: string } }
  | { type: "ThreadGoalSet"; payload: { objective: string; status?: ThreadGoal["status"] } }
  | { type: "ThreadGoalCleared"; payload: Record<string, never> }
  | { type: "ThreadArchived"; payload: { archived: boolean } }
  | { type: "ThreadDeleted"; payload: Record<string, never> }
  | { type: "TurnPhaseChanged"; payload: { phase: TurnPhase; turnId?: string; queuedId?: string; error?: string } }
  | { type: "TurnStarted"; payload: { turnId: string; text: string; origin?: "user" | "background_task"; sourceQueuedId?: string; title?: string; resources?: string[]; images?: Array<{ name: string; mimeType: string }> } }
  | { type: "MessageAppended"; payload: Message }
  | { type: "MessageDelta"; payload: Message }
  | { type: "PlanReplaced"; payload: { entries: PlanEntry[] } }
  | { type: "ToolCallCreated"; payload: { tool: ToolCall } }
  | { type: "ToolCallPatched"; payload: { tool: ToolCall } }
  | { type: "ConfigOptionsReplaced"; payload: { options: SessionConfigOption[] } }
  | { type: "CommandsReplaced"; payload: { commands: unknown[] } }
  | { type: "ModeChanged"; payload: { modeId: string } }
  | { type: "UsageUpdated"; payload: { usage: UsageUpdate } }
  | { type: "ApprovalRequested"; payload: Approval }
  | { type: "ApprovalResolved"; payload: { requestId: string; optionId?: string } }
  | { type: "TurnCompleted"; payload: { turnId: string; stopReason: string; error?: string; usage?: Usage } }
  | { type: "TurnCancelled"; payload: { turnId: string } }
  | { type: "BackgroundTaskRegistered"; payload: { taskId: string; queuedId: string; turnId: string; description: string } }
  | { type: "BackgroundTaskFinished"; payload: { taskId: string; status: Exclude<BackgroundTask["status"], "running">; endedAt?: number; exitCode?: number | null } }
  | { type: "BackgroundTaskReportQueued"; payload: { taskId: string } }
  | { type: "BackgroundTaskReportAttempted"; payload: { taskId: string; attempt: number; nextAttemptAt: string } }
  | { type: "BackgroundTaskReportDelivered"; payload: { taskId: string } }
  | { type: "BackgroundTaskReportCancelled"; payload: { taskId: string; failure?: string } }
  | { type: "CheckpointCaptured"; payload: { checkpoint: Checkpoint; diff?: string } }
  | { type: "CheckpointReverted"; payload: { checkpoint: Checkpoint } };

export class OrchestrationEngine {
  readonly #store: EventStore;
  readonly #threads = new Map<string, ThreadProjection>();
  readonly #threadBySession = new Map<string, string>();
  #publish: (event: StoredEvent) => void = () => undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(store: EventStore) {
    this.#store = store;
  }

  async open(): Promise<void> {
    await this.#store.open((event) => this.#apply(event));
    this.#reconcileSessionOwners();
    for (const thread of [...this.#threads.values()].filter((candidate) => candidate.running && candidate.activeTurnId)) {
      for (const approval of thread.approvals) await this.append(thread.threadId, { type: "ApprovalResolved", payload: { requestId: approval.requestId } });
      await this.append(thread.threadId, { type: "TurnCancelled", payload: { turnId: thread.activeTurnId! } });
    }
    for (const thread of [...this.#threads.values()].filter((candidate) => !candidate.running && ["preparing", "stopping", "checkpointing", "running"].includes(candidate.lifecycle.phase))) {
      await this.append(thread.threadId, { type: "TurnPhaseChanged", payload: { phase: "idle", ...(thread.lifecycle.turnId ? { turnId: thread.lifecycle.turnId } : {}), ...(thread.lifecycle.queuedId ? { queuedId: thread.lifecycle.queuedId } : {}) } });
    }
    await this.compact();
  }

  setPublisher(publish: (event: StoredEvent) => void): void {
    this.#publish = publish;
  }

  append(threadId: string, event: DomainEvent): Promise<StoredEvent> {
    const operation = this.#tail.then(async () => {
      if (event.type === "ThreadCreated" || event.type === "ThreadSnapshot") {
        if (this.#threads.has(threadId)) throw new Error(`Thread ${threadId} already exists`);
        const sessionId = event.type === "ThreadCreated" ? event.payload.sessionId : event.payload.thread.sessionId;
        this.assertSessionAvailable(sessionId, threadId);
      }
      const stored = await this.#store.append(threadId, event);
      this.#apply(stored);
      try {
        this.#publish(stored);
      } catch (error) {
        console.error(`[orchestration:publish] ${error instanceof Error ? error.message : String(error)}`);
      }
      if (event.type === "TurnCompleted" || event.type === "TurnCancelled" || event.type === "ThreadDeleted") await this.#compactNow();
      return stored;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  compact(): Promise<void> {
    const operation = this.#tail.then(() => this.#compactNow());
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #compactNow(): Promise<void> {
    const compacted = [...this.#threads.values()].map(compactThread);
    await this.#store.replace(compacted.map((thread) => ({ threadId: thread.threadId, event: { type: "ThreadSnapshot", payload: { thread } } })));
    this.#threads.clear();
    this.#threadBySession.clear();
    for (const thread of compacted) {
      this.#threads.set(thread.threadId, thread);
      if (!this.#threadBySession.has(thread.sessionId)) this.#threadBySession.set(thread.sessionId, thread.threadId);
    }
  }

  async drain(): Promise<void> {
    await this.#tail;
    await this.#store.drain();
  }

  threads(): ThreadProjection[] {
    return [...this.#threads.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(cloneThread);
  }

  thread(threadId: string): ThreadProjection | undefined {
    const thread = this.#threads.get(threadId);
    return thread ? cloneThread(thread) : undefined;
  }

  assertSessionAvailable(sessionId: string, threadId: string): void {
    const thread = this.#threads.get(threadId);
    if (thread && thread.sessionId !== sessionId) {
      throw new Error(`Thread ${threadId} belongs to a different ACP session`);
    }
    const owner = this.#threadBySession.get(sessionId);
    if (owner && owner !== threadId) {
      throw new Error(`ACP session ${sessionId} is already owned by thread ${owner}`);
    }
  }

  runtimeThreadForSession(sessionId: string): Pick<ThreadProjection, "threadId" | "activeTurnId"> | undefined {
    const threadId = this.#threadBySession.get(sessionId);
    const thread = threadId ? this.#threads.get(threadId) : undefined;
    return thread ? { threadId: thread.threadId, activeTurnId: thread.activeTurnId } : undefined;
  }

  #apply(event: StoredEvent): void {
    if (event.type === "ThreadSnapshot") {
      const thread = compactThread((event.payload as Extract<DomainEvent, { type: "ThreadSnapshot" }>["payload"]).thread);
      this.#threads.set(event.threadId, thread);
      if (!this.#threadBySession.has(thread.sessionId)) this.#threadBySession.set(thread.sessionId, event.threadId);
      return;
    }
    if (event.type === "ThreadCreated") {
      const payload = event.payload as Extract<DomainEvent, { type: "ThreadCreated" }>["payload"];
      const thread = {
        threadId: event.threadId,
        sessionId: payload.sessionId,
        provider: payload.provider ?? "kimi",
        ...(payload.instanceId ? { instanceId: payload.instanceId } : {}),
        ...(payload.parentThreadId ? { parentThreadId: payload.parentThreadId } : {}),
        cwd: payload.cwd,
        ...(payload.worktree ? { worktree: payload.worktree } : {}),
        kind: payload.kind === "chat" ? "chat" : "project",
        title: payload.title,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        running: false,
        activeTurnId: undefined,
        stopReason: undefined,
        lifecycle: { phase: "idle", updatedAt: event.createdAt },
        turns: [],
        messages: [],
        activity: [],
        plan: [],
        tools: [],
        approvals: [],
        configOptions: payload.configOptions ?? [],
        commands: [],
        modeId: undefined,
        checkpoints: [],
        backgroundTasks: [],
        usage: {},
      } satisfies ThreadProjection;
      this.#threads.set(event.threadId, thread);
      if (!this.#threadBySession.has(thread.sessionId)) this.#threadBySession.set(thread.sessionId, event.threadId);
      return;
    }
    const thread = this.#threads.get(event.threadId);
    if (!thread) return;
    if (event.type === "ThreadDeleted") {
      this.#threads.delete(event.threadId);
      if (this.#threadBySession.get(thread.sessionId) === event.threadId) {
        this.#threadBySession.delete(thread.sessionId);
        const replacement = [...this.#threads.entries()].find(([, candidate]) => candidate.sessionId === thread.sessionId);
        if (replacement) this.#threadBySession.set(thread.sessionId, replacement[0]);
      }
      return;
    }
    thread.updatedAt = event.createdAt;
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "ThreadRenamed":
        thread.title = String(payload.title);
        break;
      case "ThreadGoalSet": {
        const objective = String(payload.objective).trim();
        const createdAt = thread.goal?.createdAt ?? event.createdAt;
        thread.goal = {
          objective,
          status: payload.status === "complete" ? "complete" : "active",
          createdAt,
          updatedAt: event.createdAt,
        };
        break;
      }
      case "ThreadGoalCleared":
        delete thread.goal;
        break;
      case "ThreadArchived":
        if (payload.archived) thread.archivedAt = event.createdAt;
        else delete thread.archivedAt;
        break;
      case "TurnPhaseChanged": {
        const turnId = typeof payload.turnId === "string" ? payload.turnId : undefined;
        const queuedId = typeof payload.queuedId === "string" ? payload.queuedId : undefined;
        const current = thread.lifecycle;
        const terminal = payload.phase === "idle" || payload.phase === "blocked" || payload.phase === "failed";
        if (payload.phase !== "preparing" && !terminal && turnId && thread.activeTurnId !== turnId) break;
        if (terminal && current.turnId && turnId && current.turnId !== turnId) break;
        thread.lifecycle = {
          phase: payload.phase as TurnPhase,
          updatedAt: event.createdAt,
          ...(turnId ? { turnId } : {}),
          ...(queuedId ? { queuedId } : {}),
          ...(typeof payload.error === "string" && payload.error ? { error: boundedText(payload.error, 2_000) } : {}),
        };
        break;
      }
      case "TurnStarted": {
        const queuedId = typeof payload.sourceQueuedId === "string"
          ? payload.sourceQueuedId
          : thread.lifecycle.turnId === payload.turnId ? thread.lifecycle.queuedId : undefined;
        thread.running = true;
        thread.activeTurnId = String(payload.turnId);
        thread.stopReason = undefined;
        thread.lifecycle = {
          phase: "running",
          updatedAt: event.createdAt,
          turnId: String(payload.turnId),
          ...(queuedId ? { queuedId } : {}),
        };
        if (typeof payload.title === "string" && payload.title) thread.title = payload.title;
        thread.turns.push({ turnId: String(payload.turnId), startedAt: event.createdAt });
        thread.messages.push({
          turnId: String(payload.turnId), role: "user", text: String(payload.text),
          seq: event.seq, updatedSeq: event.seq,
          ...(payload.origin === "background_task" ? { origin: "background_task" as const } : {}),
          ...(typeof payload.sourceQueuedId === "string" ? { sourceQueuedId: payload.sourceQueuedId } : {}),
          ...(Array.isArray(payload.resources) && payload.resources.length ? { resources: payload.resources as string[] } : {}),
          ...(Array.isArray(payload.images) && payload.images.length ? { images: payload.images as Array<{ name: string; mimeType: string }> } : {}),
        });
        thread.plan = [];
        break;
      }
      case "MessageAppended":
        if ((payload as Message).role === "thought") appendThoughtActivity(thread, payload as Message, event);
        else appendMessage(thread, payload as Message, event);
        break;
      case "MessageDelta": {
        const delta = payload as Message;
        if (delta.role === "thought") appendThoughtActivity(thread, delta, event);
        else appendMessage(thread, delta, event);
        break;
      }
      case "PlanReplaced":
        thread.plan = payload.entries as PlanEntry[];
        break;
      case "ToolCallCreated": {
        const tool = compactToolCall(payload.tool as ToolCall);
        const turnId = tool.turnId ?? thread.activeTurnId;
        thread.tools.push({ ...tool, ...(turnId ? { turnId } : {}) });
        if (turnId) upsertToolActivity(thread, { ...tool, turnId }, event);
        break;
      }
      case "ToolCallPatched": {
        const patch = compactToolCall(payload.tool as ToolCall);
        const index = thread.tools.findIndex((tool) => tool.toolCallId === patch.toolCallId);
        const turnId = patch.turnId ?? thread.tools[index]?.turnId ?? thread.activeTurnId;
        if (index >= 0) thread.tools[index] = { ...thread.tools[index], ...patch, ...(turnId ? { turnId } : {}) };
        else thread.tools.push({ ...patch, ...(turnId ? { turnId } : {}) });
        const tool = thread.tools.find((candidate) => candidate.toolCallId === patch.toolCallId);
        if (turnId && tool) upsertToolActivity(thread, { ...tool, turnId }, event);
        break;
      }
      case "ConfigOptionsReplaced":
        thread.configOptions = payload.options as SessionConfigOption[];
        break;
      case "CommandsReplaced":
        thread.commands = payload.commands as unknown[];
        break;
      case "ModeChanged":
        thread.modeId = String(payload.modeId);
        break;
      case "UsageUpdated":
        thread.usage.context = payload.usage as UsageUpdate;
        break;
      case "ApprovalRequested": {
        const approval = payload as Approval;
        const turnId = approval.turnId ?? thread.activeTurnId;
        thread.approvals.push({ ...approval, ...(turnId ? { turnId } : {}) });
        break;
      }
      case "ApprovalResolved":
        thread.approvals = thread.approvals.filter((approval) => approval.requestId !== payload.requestId);
        break;
      case "TurnCompleted":
        if (thread.activeTurnId === payload.turnId) {
          thread.running = false;
          thread.stopReason = String(payload.stopReason);
          thread.activeTurnId = undefined;
          thread.lifecycle = {
            phase: String(payload.stopReason) === "error" ? "failed" : "idle",
            updatedAt: event.createdAt,
            ...(String(payload.stopReason) === "error" && typeof payload.error === "string" ? { error: boundedText(payload.error, 2_000) } : {}),
          };
        }
        if (payload.usage) thread.usage.tokens = payload.usage as Usage;
        Object.assign(thread.turns.findLast((turn) => turn.turnId === payload.turnId) ?? {}, {
          completedAt: event.createdAt,
          stopReason: String(payload.stopReason),
          ...(typeof payload.error === "string" && payload.error ? { error: payload.error } : {}),
          ...(payload.usage ? { usage: payload.usage as Usage } : {}),
        });
        finishActivity(thread, String(payload.turnId), event.createdAt, String(payload.stopReason) === "error");
        break;
      case "TurnCancelled":
        if (thread.activeTurnId === payload.turnId) {
          thread.running = false;
          thread.stopReason = "cancelled";
          thread.activeTurnId = undefined;
          thread.lifecycle = { phase: "idle", updatedAt: event.createdAt };
        }
        Object.assign(thread.turns.findLast((turn) => turn.turnId === payload.turnId) ?? {}, { completedAt: event.createdAt, stopReason: "cancelled" });
        finishActivity(thread, String(payload.turnId), event.createdAt, true);
        break;
      case "BackgroundTaskRegistered":
        if (!thread.backgroundTasks.some((task) => task.taskId === payload.taskId)) {
          thread.backgroundTasks.push({
            taskId: String(payload.taskId),
            queuedId: String(payload.queuedId),
            turnId: String(payload.turnId),
            description: String(payload.description),
            status: "running",
            registeredAt: event.createdAt,
            updatedAt: event.createdAt,
            reportQueued: false,
          });
        }
        break;
      case "BackgroundTaskFinished": {
        const task = thread.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
        if (task && task.status === "running") {
          task.status = payload.status as Exclude<BackgroundTask["status"], "running">;
          task.updatedAt = event.createdAt;
          if (typeof payload.endedAt === "number") task.endedAt = payload.endedAt;
          if (typeof payload.exitCode === "number" || payload.exitCode === null) task.exitCode = payload.exitCode as number | null;
        }
        break;
      }
      case "BackgroundTaskReportQueued": {
        const task = thread.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
        if (task) {
          task.reportQueued = true;
          task.updatedAt = event.createdAt;
        }
        break;
      }
      case "BackgroundTaskReportAttempted": {
        const task = thread.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
        if (task && !task.reportDeliveredAt && !task.reportCancelledAt) {
          task.reportAttemptCount = Number(payload.attempt);
          task.reportNextAttemptAt = String(payload.nextAttemptAt);
          task.updatedAt = event.createdAt;
        }
        break;
      }
      case "BackgroundTaskReportDelivered": {
        const task = thread.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
        if (task && !task.reportCancelledAt) {
          task.reportDeliveredAt = event.createdAt;
          delete task.reportNextAttemptAt;
          delete task.reportLastError;
          task.updatedAt = event.createdAt;
        }
        break;
      }
      case "BackgroundTaskReportCancelled": {
        const task = thread.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
        if (task && !task.reportDeliveredAt) {
          task.reportCancelledAt = event.createdAt;
          delete task.reportNextAttemptAt;
          if (typeof payload.failure === "string" && payload.failure) {
            task.reportFailedAt = event.createdAt;
            task.reportLastError = payload.failure;
          }
          task.updatedAt = event.createdAt;
        }
        break;
      }
      case "CheckpointCaptured": {
        const checkpoint = payload.checkpoint as Checkpoint;
        const stored: TurnCheckpoint = { ...checkpoint };
        if (typeof payload.diff === "string") stored.diff = payload.diff;
        thread.checkpoints.push(stored);
        break;
      }
      case "CheckpointReverted":
        thread.checkpoints.push(payload.checkpoint as Checkpoint);
        break;
    }
  }

  #reconcileSessionOwners(): void {
    this.#threadBySession.clear();
    for (const [threadId, thread] of this.#threads) {
      const owner = this.#threadBySession.get(thread.sessionId);
      if (!owner) {
        this.#threadBySession.set(thread.sessionId, threadId);
        continue;
      }
      this.#threads.delete(threadId);
      console.warn(`[orchestration:replay] Ignored duplicate thread ${threadId}; ACP session ${thread.sessionId} is owned by ${owner}`);
    }
  }
}

function appendThoughtActivity(thread: ThreadProjection, message: Message, event: StoredEvent): void {
  const active = thread.activeTurnId === message.turnId;
  const current = thread.activity.at(-1);
  if (current?.kind === "thought" && current.turnId === message.turnId && current.status === "in_progress") {
    current.text = boundedText(current.text + message.text, 4_000);
    current.updatedSeq = event.seq;
    current.updatedAt = event.createdAt;
    return;
  }
  finishCurrentThought(thread, message.turnId, event.createdAt);
  thread.activity.push({
    id: `thought-${event.seq}`,
    turnId: message.turnId,
    kind: "thought",
    status: active ? "in_progress" : "completed",
    text: boundedText(message.text, 4_000),
    seq: event.seq,
    updatedSeq: event.seq,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  });
}

function appendMessage(thread: ThreadProjection, message: Message, event: StoredEvent): void {
  const last = thread.messages.at(-1);
  const latestActivitySeq = thread.activity.reduce((latest, entry) => entry.turnId === message.turnId
    ? Math.max(latest, entry.updatedSeq ?? entry.seq)
    : latest, -1);
  if (last?.turnId === message.turnId && last.role === message.role
    && (last.updatedSeq ?? last.seq ?? -1) > latestActivitySeq) {
    last.text += message.text;
    last.updatedSeq = event.seq;
    return;
  }
  thread.messages.push({ ...message, seq: event.seq, updatedSeq: event.seq });
}

function upsertToolActivity(thread: ThreadProjection, tool: ToolCall & { turnId: string }, event: StoredEvent): void {
  const existing = thread.activity.find((entry) => entry.kind === "tool" && entry.turnId === tool.turnId && entry.toolCallId === tool.toolCallId);
  const rawStatus = activityStatus(tool.status);
  const status = thread.activeTurnId === tool.turnId || rawStatus === "failed" ? rawStatus : "completed";
  if (existing) {
    existing.text = tool.title ?? existing.text;
    existing.status = status;
    existing.updatedSeq = event.seq;
    existing.updatedAt = event.createdAt;
    return;
  }
  finishCurrentThought(thread, tool.turnId, event.createdAt);
  thread.activity.push({
    id: `tool-${tool.toolCallId}`,
    turnId: tool.turnId,
    kind: "tool",
    status,
    text: tool.title ?? "Tool call",
    toolCallId: tool.toolCallId,
    seq: event.seq,
    updatedSeq: event.seq,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  });
}

function finishCurrentThought(thread: ThreadProjection, turnId: string, updatedAt: string): void {
  const current = thread.activity.findLast((entry) => entry.turnId === turnId && entry.kind === "thought" && entry.status === "in_progress");
  if (current) {
    current.status = "completed";
    current.updatedAt = updatedAt;
  }
}

function finishActivity(thread: ThreadProjection, turnId: string, updatedAt: string, failed: boolean): void {
  for (const entry of thread.activity) {
    if (entry.turnId !== turnId || (entry.status !== "pending" && entry.status !== "in_progress")) continue;
    entry.status = failed ? "failed" : "completed";
    entry.updatedAt = updatedAt;
  }
}

function activityStatus(status?: string): ActivityEntry["status"] {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "error" || status === "cancelled") return "failed";
  if (status === "pending") return "pending";
  return "in_progress";
}

export function titleFromPrompt(text: string): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " code ")
    .replace(/[`*_#>\[\]()]/g, " ")
    .replace(/@\{?[^}\s]+}?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "New Kimi session";
  const phrase = (cleaned.split(/(?<=[.!?])\s/)[0] ?? cleaned).replace(/[.!?]+$/, "").trim();
  const words = phrase.split(" ");
  const selected: string[] = [];
  for (const word of words.slice(0, 9)) {
    if ([...selected, word].join(" ").length > 56) break;
    selected.push(word);
  }
  const concise = selected.join(" ") || phrase.slice(0, 56).trimEnd();
  return selected.length < words.length ? `${concise}…` : concise;
}

export function textFromUpdate(update: SessionUpdate): string {
  if (!("content" in update) || !update.content || Array.isArray(update.content) || update.content.type !== "text") return "";
  return update.content.text;
}

function cloneThread(thread: ThreadProjection): ThreadProjection {
  return structuredClone(thread);
}

export function compactToolCall(tool: ToolCall): ToolCall {
  let serialized = "";
  try { serialized = JSON.stringify(tool); } catch {
    return {
      toolCallId: tool.toolCallId,
      ...(tool.turnId ? { turnId: tool.turnId } : {}),
      ...(tool.title ? { title: tool.title } : {}),
      ...(tool.kind ? { kind: tool.kind } : {}),
      ...(tool.status ? { status: tool.status } : {}),
    };
  }
  if (serialized.length <= 16_000) return tool;
  return {
    toolCallId: tool.toolCallId,
    ...(tool.turnId ? { turnId: tool.turnId } : {}),
    ...(tool.title ? { title: tool.title } : {}),
    ...(tool.kind ? { kind: tool.kind } : {}),
    ...(tool.status ? { status: tool.status } : {}),
    ...(Array.isArray(tool.locations) ? { locations: tool.locations.slice(0, 12) } : {}),
    ...(Array.isArray(tool.content) ? { content: tool.content.slice(-4).map((value) => compactValue(value, 2_400)) } : {}),
    ...(tool.rawInput !== undefined ? { rawInput: compactValue(tool.rawInput, 2_400) } : {}),
    ...(tool.rawOutput !== undefined ? { rawOutput: compactValue(tool.rawOutput, 4_800) } : {}),
  };
}

function compactThread(thread: ThreadProjection): ThreadProjection {
  const compacted = cloneThread(thread);
  compacted.provider ??= "kimi";
  compacted.lifecycle ??= {
    phase: compacted.running ? "running" : compacted.stopReason === "error" ? "failed" : "idle",
    updatedAt: compacted.updatedAt,
    ...(compacted.activeTurnId ? { turnId: compacted.activeTurnId } : {}),
  };
  compacted.backgroundTasks ??= [];
  compacted.messages = compacted.messages.filter((message) => message.role !== "thought");
  compacted.activity = compacted.activity.map((entry) => ({ ...entry, text: boundedText(entry.text, 4_000) }));
  compacted.tools = compacted.tools.map(compactToolCall);
  const pending = compacted.backgroundTasks
    .filter((task) => !task.reportDeliveredAt && !task.reportCancelledAt)
    .slice(-20);
  const reported = compacted.backgroundTasks
    .filter((task) => task.reportDeliveredAt || task.reportCancelledAt)
    .slice(-50);
  compacted.backgroundTasks = [...pending, ...reported].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt));
  return compacted;
}

function compactValue(value: unknown, maxCharacters: number): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= maxCharacters) return value;
    return { truncated: true, preview: boundedText(serialized, maxCharacters) };
  } catch {
    return { truncated: true, preview: boundedText(String(value), maxCharacters) };
  }
}

function boundedText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 1).trimEnd()}…`;
}
