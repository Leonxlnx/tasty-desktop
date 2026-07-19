import type { PlanEntry, SessionConfigOption, SessionUpdate, Usage, UsageUpdate } from "@agentclientprotocol/sdk";
import { EventStore, type StoredEvent } from "./event-store.js";
import type { Checkpoint } from "./checkpoint-reactor.js";

export type Message = { turnId: string; role: "user" | "assistant" | "thought"; text: string; resources?: string[]; images?: Array<{ name: string; mimeType: string }> };
export type ToolCall = { toolCallId: string; turnId?: string; title?: string; kind?: string; status?: string; content?: unknown[]; locations?: unknown[]; rawInput?: unknown; rawOutput?: unknown };
export type Approval = { requestId: string; turnId?: string; title: string; kind: "permission" | "question" | "plan_review"; options: Array<{ optionId: string; name: string; kind: string }> };
export type TurnCheckpoint = Checkpoint & { diff?: string };
export type ThreadUsage = { context?: UsageUpdate; tokens?: Usage };
export type TurnRecord = { turnId: string; startedAt: string; completedAt?: string; stopReason?: string; usage?: Usage };
export type ActivityEntry = {
  id: string;
  turnId: string;
  kind: "thought" | "tool";
  status: "pending" | "in_progress" | "completed" | "failed";
  text: string;
  toolCallId?: string;
  seq: number;
  createdAt: string;
  updatedAt: string;
};

export type ThreadProjection = {
  threadId: string;
  sessionId: string;
  cwd: string;
  kind: "project" | "chat";
  title: string;
  createdAt: string;
  updatedAt: string;
  running: boolean;
  activeTurnId: string | undefined;
  stopReason: string | undefined;
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
  usage: ThreadUsage;
};

export type DomainEvent =
  | { type: "ThreadSnapshot"; payload: { thread: ThreadProjection } }
  | { type: "ThreadCreated"; payload: { sessionId: string; cwd: string; kind?: "project" | "chat"; title: string; configOptions?: SessionConfigOption[] } }
  | { type: "ThreadRenamed"; payload: { title: string } }
  | { type: "ThreadDeleted"; payload: Record<string, never> }
  | { type: "TurnStarted"; payload: { turnId: string; text: string; title?: string; resources?: string[]; images?: Array<{ name: string; mimeType: string }> } }
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
  | { type: "TurnCompleted"; payload: { turnId: string; stopReason: string; usage?: Usage } }
  | { type: "TurnCancelled"; payload: { turnId: string } }
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
    for (const thread of [...this.#threads.values()].filter((candidate) => candidate.running && candidate.activeTurnId)) {
      for (const approval of thread.approvals) await this.append(thread.threadId, { type: "ApprovalResolved", payload: { requestId: approval.requestId } });
      await this.append(thread.threadId, { type: "TurnCancelled", payload: { turnId: thread.activeTurnId! } });
    }
    await this.compact();
  }

  setPublisher(publish: (event: StoredEvent) => void): void {
    this.#publish = publish;
  }

  append(threadId: string, event: DomainEvent): Promise<StoredEvent> {
    const operation = this.#tail.then(async () => {
      const stored = await this.#store.append(threadId, event);
      this.#apply(stored);
      this.#publish(stored);
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
      this.#threadBySession.set(thread.sessionId, thread.threadId);
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

  runtimeThreadForSession(sessionId: string): Pick<ThreadProjection, "threadId" | "activeTurnId"> | undefined {
    const threadId = this.#threadBySession.get(sessionId);
    const thread = threadId ? this.#threads.get(threadId) : undefined;
    return thread ? { threadId: thread.threadId, activeTurnId: thread.activeTurnId } : undefined;
  }

  #apply(event: StoredEvent): void {
    if (event.type === "ThreadSnapshot") {
      const thread = compactThread((event.payload as Extract<DomainEvent, { type: "ThreadSnapshot" }>["payload"]).thread);
      this.#threads.set(event.threadId, thread);
      this.#threadBySession.set(thread.sessionId, event.threadId);
      return;
    }
    if (event.type === "ThreadCreated") {
      const payload = event.payload as Extract<DomainEvent, { type: "ThreadCreated" }>["payload"];
      const thread = {
        threadId: event.threadId,
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        kind: payload.kind === "chat" ? "chat" : "project",
        title: payload.title,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
        running: false,
        activeTurnId: undefined,
        stopReason: undefined,
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
        usage: {},
      } satisfies ThreadProjection;
      this.#threads.set(event.threadId, thread);
      this.#threadBySession.set(thread.sessionId, event.threadId);
      return;
    }
    const thread = this.#threads.get(event.threadId);
    if (!thread) return;
    if (event.type === "ThreadDeleted") {
      this.#threads.delete(event.threadId);
      this.#threadBySession.delete(thread.sessionId);
      return;
    }
    thread.updatedAt = event.createdAt;
    const payload = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "ThreadRenamed":
        thread.title = String(payload.title);
        break;
      case "TurnStarted":
        thread.running = true;
        thread.activeTurnId = String(payload.turnId);
        thread.stopReason = undefined;
        if (typeof payload.title === "string" && payload.title) thread.title = payload.title;
        thread.turns.push({ turnId: String(payload.turnId), startedAt: event.createdAt });
        thread.messages.push({
          turnId: String(payload.turnId), role: "user", text: String(payload.text),
          ...(Array.isArray(payload.resources) && payload.resources.length ? { resources: payload.resources as string[] } : {}),
          ...(Array.isArray(payload.images) && payload.images.length ? { images: payload.images as Array<{ name: string; mimeType: string }> } : {}),
        });
        thread.plan = [];
        break;
      case "MessageAppended":
        if ((payload as Message).role === "thought") appendThoughtActivity(thread, payload as Message, event);
        else thread.messages.push(payload as Message);
        break;
      case "MessageDelta": {
        const delta = payload as Message;
        if (delta.role === "thought") appendThoughtActivity(thread, delta, event);
        else {
          const last = thread.messages.at(-1);
          if (last?.turnId === delta.turnId && last.role === delta.role) last.text += delta.text;
          else thread.messages.push({ ...delta });
        }
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
        thread.running = false;
        thread.stopReason = String(payload.stopReason);
        thread.activeTurnId = undefined;
        if (payload.usage) thread.usage.tokens = payload.usage as Usage;
        Object.assign(thread.turns.findLast((turn) => turn.turnId === payload.turnId) ?? {}, {
          completedAt: event.createdAt,
          stopReason: String(payload.stopReason),
          ...(payload.usage ? { usage: payload.usage as Usage } : {}),
        });
        finishActivity(thread, String(payload.turnId), event.createdAt, String(payload.stopReason) === "error");
        break;
      case "TurnCancelled":
        thread.running = false;
        thread.stopReason = "cancelled";
        thread.activeTurnId = undefined;
        Object.assign(thread.turns.findLast((turn) => turn.turnId === payload.turnId) ?? {}, { completedAt: event.createdAt, stopReason: "cancelled" });
        finishActivity(thread, String(payload.turnId), event.createdAt, true);
        break;
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
}

function appendThoughtActivity(thread: ThreadProjection, message: Message, event: StoredEvent): void {
  const current = thread.activity.at(-1);
  if (current?.kind === "thought" && current.turnId === message.turnId && current.status === "in_progress") {
    current.text = boundedText(current.text + message.text, 4_000);
    current.updatedAt = event.createdAt;
    return;
  }
  finishCurrentThought(thread, message.turnId, event.createdAt);
  thread.activity.push({
    id: `thought-${event.seq}`,
    turnId: message.turnId,
    kind: "thought",
    status: "in_progress",
    text: boundedText(message.text, 4_000),
    seq: event.seq,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  });
}

function upsertToolActivity(thread: ThreadProjection, tool: ToolCall & { turnId: string }, event: StoredEvent): void {
  const existing = thread.activity.find((entry) => entry.kind === "tool" && entry.turnId === tool.turnId && entry.toolCallId === tool.toolCallId);
  const status = activityStatus(tool.status);
  if (existing) {
    existing.text = tool.title ?? existing.text;
    existing.status = status;
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
  compacted.messages = compacted.messages.filter((message) => message.role !== "thought");
  compacted.activity = compacted.activity.map((entry) => ({ ...entry, text: boundedText(entry.text, 4_000) }));
  compacted.tools = compacted.tools.map(compactToolCall);
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
