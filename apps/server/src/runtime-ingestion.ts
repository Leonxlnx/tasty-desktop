import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import type { RuntimeEvent } from "./acp-client.js";
import { compactToolCall, OrchestrationEngine, textFromUpdate, type DomainEvent, type ToolCall } from "./orchestration.js";

type PendingStream = { threadId: string; events: DomainEvent[]; characters: number };

export class RuntimeIngestion {
  readonly #engine: OrchestrationEngine;
  readonly #onError: (error: unknown) => void;
  readonly #pending = new Map<string, PendingStream>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #tails = new Map<string, Promise<void>>();

  constructor(engine: OrchestrationEngine, onError: (error: unknown) => void = () => undefined) {
    this.#engine = engine;
    this.#onError = onError;
  }

  async ingest(event: RuntimeEvent): Promise<void> {
    if (event.type === "diagnostic") return;
    const sessionId = event.params.sessionId;
    const thread = this.#engine.runtimeThreadForSession(sessionId);
    if (!thread) return;
    if (event.type === "permission_request") {
      await this.flush(sessionId);
      await this.#enqueue(sessionId, () => this.#engine.append(thread.threadId, {
        type: "ApprovalRequested",
        payload: { requestId: event.requestId, title: event.params.toolCall.title ?? "Permission required", kind: classifyApproval(event.params.options), options: event.params.options },
      }).then(() => undefined));
      return;
    }
    const domain = toDomainEvent(event.params.update, thread.activeTurnId ?? `replay-${Date.now()}`);
    if (!domain) return;
    if (domain.type === "MessageDelta" || domain.type === "ToolCallPatched") {
      this.#queue(sessionId, thread.threadId, domain);
      if ((this.#pending.get(sessionId)?.characters ?? 0) >= 16_000) await this.flush(sessionId);
      return;
    }
    await this.flush(sessionId);
    await this.#enqueue(sessionId, () => this.#engine.append(thread.threadId, domain).then(() => undefined));
  }

  flush(sessionId: string): Promise<void> {
    const timer = this.#timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.#timers.delete(sessionId);
    const pending = this.#pending.get(sessionId);
    this.#pending.delete(sessionId);
    if (!pending?.events.length) return this.#tails.get(sessionId) ?? Promise.resolve();
    return this.#enqueue(sessionId, async () => {
      for (const event of pending.events) await this.#engine.append(pending.threadId, event);
    });
  }

  async flushAll(): Promise<void> {
    const sessions = new Set([...this.#pending.keys(), ...this.#tails.keys()]);
    await Promise.all([...sessions].map((sessionId) => this.flush(sessionId)));
  }

  #queue(sessionId: string, threadId: string, event: Extract<DomainEvent, { type: "MessageDelta" | "ToolCallPatched" }>): void {
    const pending = this.#pending.get(sessionId) ?? { threadId, events: [], characters: 0 };
    const previous = pending.events.at(-1);
    if (previous?.type === "MessageDelta" && event.type === "MessageDelta"
      && previous.payload.turnId === event.payload.turnId && previous.payload.role === event.payload.role) {
      previous.payload.text += event.payload.text;
    } else if (previous?.type === "ToolCallPatched" && event.type === "ToolCallPatched"
      && previous.payload.tool.toolCallId === event.payload.tool.toolCallId) {
      previous.payload.tool = compactToolCall({ ...previous.payload.tool, ...event.payload.tool });
    } else {
      pending.events.push(event);
    }
    pending.characters += event.type === "MessageDelta" ? event.payload.text.length : 1_000;
    this.#pending.set(sessionId, pending);
    if (!this.#timers.has(sessionId)) {
      this.#timers.set(sessionId, setTimeout(() => {
        void this.flush(sessionId).catch(this.#onError);
      }, 32));
    }
  }

  #enqueue(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const queued = (this.#tails.get(sessionId) ?? Promise.resolve()).then(operation);
    this.#tails.set(sessionId, queued.catch(() => undefined));
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
  if (update.sessionUpdate !== "tool_call" || !("content" in update) || !Array.isArray(update.content)) return undefined;
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
