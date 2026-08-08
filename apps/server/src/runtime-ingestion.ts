import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "./acp-client.js";
import { compactToolCall, OrchestrationEngine, textFromUpdate, type DomainEvent, type RuntimeIdentity, type ToolCall } from "./orchestration.js";

type RuntimeEventFence = { generation: unknown; isCurrent: () => boolean };
type PendingDomainEvent = { event: DomainEvent; fence: RuntimeEventFence };
type PendingStream = { events: PendingDomainEvent[]; characters: number };
export type RuntimeEventSource = RuntimeIdentity;

const defaultRuntimeGeneration = Symbol("default-runtime-generation");
const defaultRuntimeFence: RuntimeEventFence = { generation: defaultRuntimeGeneration, isCurrent: () => true };

export class RuntimeIngestion {
  readonly #engine: OrchestrationEngine;
  readonly #onError: (error: unknown) => void;
  readonly #pending = new Map<string, PendingStream>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #tails = new Map<string, Promise<void>>();
  readonly #ingressTails = new Map<string, Promise<void>>();

  constructor(engine: OrchestrationEngine, onError: (error: unknown) => void = () => undefined) {
    this.#engine = engine;
    this.#onError = onError;
  }

  async ingest(event: RuntimeEvent, source: RuntimeEventSource, fence: RuntimeEventFence = defaultRuntimeFence): Promise<string | undefined> {
    if (event.type === "diagnostic") return;
    if (!fence.isCurrent()) return;
    const sessionId = event.params.sessionId;
    const thread = this.#engine.runtimeThreadForSession(sessionId, source);
    if (!thread || thread.provider !== source.provider || thread.instanceId !== source.instanceId) return;
    const threadId = thread.threadId;
    const previous = this.#ingressTails.get(threadId) ?? Promise.resolve();
    let accepted = false;
    const operation = previous.catch(() => undefined).then(async () => {
      if (!fence.isCurrent()) return;
      const current = this.#engine.runtimeThreadForSession(sessionId, source);
      if (!current || current.threadId !== threadId || !fence.isCurrent()) return;
      accepted = await this.#ingestResolved(event, threadId, current.activeTurnId, fence);
    });
    const tail = operation.catch(() => undefined);
    this.#ingressTails.set(threadId, tail);
    try {
      await operation;
    } finally {
      if (this.#ingressTails.get(threadId) === tail) this.#ingressTails.delete(threadId);
    }
    return accepted ? threadId : undefined;
  }

  async #ingestResolved(event: Exclude<RuntimeEvent, { type: "diagnostic" }>, threadId: string, activeTurnId: string | undefined, fence: RuntimeEventFence): Promise<boolean> {
    if (event.type === "permission_request") {
      await this.#flushNow(threadId);
      await this.#enqueue(threadId, async () => {
        if (!fence.isCurrent()) return;
        await this.#engine.append(threadId, {
          type: "ApprovalRequested",
          payload: { requestId: event.requestId, title: event.params.toolCall.title ?? "Permission required", kind: classifyApproval(event.params.options), options: event.params.options },
        });
      });
      return true;
    }
    const domain = toDomainEvent(event.params.update, activeTurnId ?? `replay-${Date.now()}`);
    if (!domain) return false;
    if (domain.type === "MessageDelta" || domain.type === "ToolCallPatched") {
      this.#queue(threadId, domain, fence);
      if ((this.#pending.get(threadId)?.characters ?? 0) >= 16_000) await this.#flushNow(threadId);
      return true;
    }
    await this.#flushNow(threadId);
    await this.#enqueue(threadId, async () => {
      if (!fence.isCurrent()) return;
      await this.#engine.append(threadId, domain);
    });
    return true;
  }

  async flush(threadId: string): Promise<void> {
    while (true) {
      await this.#ingressTails.get(threadId);
      await this.#flushNow(threadId);
      const tail = this.#tails.get(threadId);
      await tail;
      if (this.#ingressTails.has(threadId) || this.#pending.has(threadId)) continue;
      const currentTail = this.#tails.get(threadId);
      if (currentTail && currentTail !== tail) continue;
      return;
    }
  }

  #flushNow(threadId: string): Promise<void> {
    const timer = this.#timers.get(threadId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(threadId);
    const pending = this.#pending.get(threadId);
    this.#pending.delete(threadId);
    if (!pending?.events.length) return this.#tails.get(threadId) ?? Promise.resolve();
    return this.#enqueue(threadId, async () => {
      for (const pendingEvent of pending.events) {
        if (!pendingEvent.fence.isCurrent()) continue;
        await this.#engine.append(threadId, pendingEvent.event);
      }
    });
  }

  async flushWithin(threadId: string, timeoutMs: number): Promise<boolean> {
    const flush = this.flush(threadId);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        flush.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async flushAll(): Promise<void> {
    while (true) {
      const threads = new Set([...this.#ingressTails.keys(), ...this.#pending.keys(), ...this.#tails.keys()]);
      if (!threads.size) return;
      await Promise.all([...threads].map((threadId) => this.flush(threadId)));
    }
  }

  #queue(threadId: string, event: Extract<DomainEvent, { type: "MessageDelta" | "ToolCallPatched" }>, fence: RuntimeEventFence): void {
    const pending = this.#pending.get(threadId) ?? { events: [], characters: 0 };
    const previous = pending.events.at(-1);
    if (previous && previous.fence.generation === fence.generation && previous.event.type === "MessageDelta" && event.type === "MessageDelta"
      && previous.event.payload.turnId === event.payload.turnId && previous.event.payload.role === event.payload.role) {
      previous.event.payload.text += event.payload.text;
    } else if (previous && previous.fence.generation === fence.generation && previous.event.type === "ToolCallPatched" && event.type === "ToolCallPatched"
      && previous.event.payload.tool.toolCallId === event.payload.tool.toolCallId) {
      previous.event.payload.tool = compactToolCall({ ...previous.event.payload.tool, ...event.payload.tool });
    } else {
      pending.events.push({ event, fence });
    }
    pending.characters += event.type === "MessageDelta" ? event.payload.text.length : 1_000;
    this.#pending.set(threadId, pending);
    if (!this.#timers.has(threadId)) {
      this.#timers.set(threadId, setTimeout(() => {
        void this.flush(threadId).catch(this.#onError);
      }, 32));
    }
  }

  #enqueue(threadId: string, operation: () => Promise<void>): Promise<void> {
    const queued = (this.#tails.get(threadId) ?? Promise.resolve()).then(operation);
    const tail = queued.catch(() => undefined);
    this.#tails.set(threadId, tail);
    void tail.then(() => {
      if (this.#tails.get(threadId) === tail) this.#tails.delete(threadId);
    });
    return queued;
  }
}

export function classifyApproval(options: Array<{ optionId: string }>): "permission" | "question" | "plan_review" {
  if (options.some((option) => /^q\d+_(?:opt_\d+|skip)$/.test(option.optionId))) return "question";
  if (options.some((option) => option.optionId.startsWith("plan_"))) return "plan_review";
  return "permission";
}

export function hasConfiguredModel(options: SessionConfigOption[]): boolean {
  const model = options.find((option) => option.id === "model" || option.category === "model");
  return Boolean(model && typeof model.currentValue === "string" && model.currentValue && "options" in model && model.options.some((option) => "value" in option && option.value === model.currentValue));
}

export function toDomainEvent(update: SessionUpdate, turnId: string): DomainEvent | undefined {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      return { type: "MessageAppended", payload: { turnId, role: "user", text: textFromUpdate(update) } };
    case "agent_message_chunk":
      return { type: "MessageDelta", payload: { turnId, role: "assistant", text: textFromUpdate(update) } };
    case "agent_thought_chunk":
      return { type: "MessageDelta", payload: { turnId, role: "thought", text: textFromUpdate(update) } };
    case "plan":
      return { type: "PlanReplaced", payload: { entries: update.entries } };
    case "tool_call":
      return { type: "ToolCallCreated", payload: { tool: compactToolCall({ ...(update as ToolCall), rawInput: toolCallInput(update) }) } };
    case "tool_call_update":
      return { type: "ToolCallPatched", payload: { tool: compactToolCall(update as ToolCall) } };
    case "config_option_update":
      return { type: "ConfigOptionsReplaced", payload: { options: update.configOptions as SessionConfigOption[] } };
    case "available_commands_update":
      return { type: "CommandsReplaced", payload: { commands: update.availableCommands } };
    case "current_mode_update":
      return { type: "ModeChanged", payload: { modeId: update.currentModeId } };
    case "usage_update":
      return { type: "UsageUpdated", payload: { usage: { used: update.used, size: update.size, ...(update.cost ? { cost: update.cost } : {}) } } };
    default:
      return undefined;
  }
}

export function toolCallInput(update: SessionUpdate): unknown {
  if (update.sessionUpdate !== "tool_call") return undefined;
  if ("rawInput" in update && update.rawInput !== undefined) return update.rawInput;
  if (!("content" in update) || !Array.isArray(update.content)) return undefined;
  const text = update.content
    .map((item) => item && typeof item === "object" && "content" in item ? item.content : undefined)
    .find((content) => content && typeof content === "object" && "text" in content && typeof content.text === "string") as { text: string } | undefined;
  if (!text) return undefined;
  try {
    return JSON.parse(text.text);
  } catch {
    return text.text;
  }
}
