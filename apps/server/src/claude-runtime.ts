import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ContentBlock, SessionConfigOption, Usage } from "@agentclientprotocol/sdk";
import type { AgentRuntime, RuntimePromptResult, RuntimeSession } from "./agent-runtime.js";
import type { RuntimeEvent } from "./acp-client.js";

type JsonObject = Record<string, unknown>;
type ClaudeSession = {
  sessionId: string;
  cwd: string;
  model: string;
  effort: string;
  mode: string;
  configOptions: SessionConfigOption[];
  resume: boolean;
  child: ChildProcessWithoutNullStreams | undefined;
  active: { resolve: (result: RuntimePromptResult) => void; reject: (error: Error) => void; streamedText: boolean } | undefined;
};

export type ClaudeRuntimeOptions = {
  binary: string;
  argsPrefix?: string[];
  onEvent: (event: RuntimeEvent) => unknown | Promise<unknown>;
  onClose?: () => void;
};

export class ClaudeRuntime implements AgentRuntime {
  readonly #options: ClaudeRuntimeOptions;
  readonly #sessions = new Map<string, ClaudeSession>();
  #open = false;
  #closing = false;

  constructor(options: ClaudeRuntimeOptions) {
    if (!isAbsolute(options.binary)) throw new Error("Claude binary path must be absolute");
    this.#options = options;
  }

  async start(): Promise<unknown> {
    if (this.#open) throw new Error("Claude runtime already started");
    this.#open = true;
    return { provider: "claude", protocol: "stream-json" };
  }

  async newSession(cwd: string): Promise<RuntimeSession> {
    return sessionResponse(this.#remember({
      sessionId: randomUUID(),
      cwd: await canonicalWorkspace(cwd),
      model: "sonnet",
      effort: "high",
      mode: "default",
      resume: false,
    }));
  }

  async listSessions(cwd?: string): Promise<{ sessions: RuntimeSession[] }> {
    const root = cwd ? await canonicalWorkspace(cwd) : undefined;
    return { sessions: [...this.#sessions.values()].filter((session) => !root || session.cwd === root).map(sessionResponse) };
  }

  async resumeSession(sessionId: string, cwd: string): Promise<RuntimeSession> {
    return sessionResponse(this.#remember({
      sessionId,
      cwd: await canonicalWorkspace(cwd),
      model: "sonnet",
      effort: "high",
      mode: "default",
      resume: true,
    }));
  }

  loadSession(sessionId: string, cwd: string): Promise<RuntimeSession> {
    return this.resumeSession(sessionId, cwd);
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<{ configOptions?: SessionConfigOption[] }> {
    const session = this.#session(sessionId);
    const next = String(value);
    if (configId === "model" && ["sonnet", "opus", "haiku"].includes(next)) session.model = next;
    else if (configId === "thinking" && ["low", "medium", "high", "max"].includes(next)) session.effort = next;
    else if (configId === "mode" && ["default", "plan", "yolo"].includes(next)) session.mode = next;
    else throw new Error(`Claude does not support ${configId}=${next}`);
    if (session.child) await this.#stopSession(session, new Error("Claude configuration changed"), false);
    session.resume = true;
    session.configOptions = claudeConfigOptions(session.model, session.effort, session.mode);
    await this.#emit({ type: "session_update", params: { sessionId, update: { sessionUpdate: "config_option_update", configOptions: session.configOptions } } } as RuntimeEvent);
    return { configOptions: session.configOptions };
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<RuntimePromptResult> {
    const session = this.#session(sessionId);
    if (session.active) throw new Error("A Claude turn is already running");
    await this.#ensureChild(session);
    const text = prompt.map(claudePromptPart).filter(Boolean).join("\n\n");
    const result = new Promise<RuntimePromptResult>((resolve, reject) => { session.active = { resolve, reject, streamedText: false }; });
    session.child!.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null, session_id: session.sessionId })}\n`);
    return result;
  }

  hasSession(sessionId: string): boolean {
    return this.#open && this.#sessions.has(sessionId);
  }

  isOpen(): boolean {
    return this.#open;
  }

  respondToPermission(): void {
    // Claude print mode applies the selected CLI permission policy up front.
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    if (!session.active) return;
    const active = session.active;
    session.active = undefined;
    active.resolve({ stopReason: "cancelled" });
    await this.#stopSession(session, new Error("Claude turn cancelled"), false);
    session.resume = true;
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#open = false;
    await Promise.all([...this.#sessions.values()].map((session) => this.#stopSession(session, new Error("Claude runtime closed"), true)));
    this.#sessions.clear();
    this.#closing = false;
  }

  #remember(input: Omit<ClaudeSession, "configOptions" | "child" | "active">): ClaudeSession {
    const session: ClaudeSession = { ...input, child: undefined, active: undefined, configOptions: claudeConfigOptions(input.model, input.effort, input.mode) };
    this.#sessions.set(session.sessionId, session);
    return session;
  }

  #session(sessionId: string): ClaudeSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Claude session ${sessionId}`);
    return session;
  }

  async #ensureChild(session: ClaudeSession): Promise<void> {
    if (session.child) return;
    const args = [
      "--print",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--replay-user-messages",
      "--verbose",
      "--model", session.model,
      "--effort", session.effort,
      "--permission-mode", permissionMode(session.mode),
      ...(session.mode === "yolo" ? ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"] : []),
      ...(session.resume ? ["--resume", session.sessionId] : ["--session-id", session.sessionId]),
    ];
    const child = spawn(this.#options.binary, [...this.#options.argsPrefix ?? [], ...args], {
      cwd: session.cwd,
      env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(this.#options.binary),
    });
    session.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => void this.#receive(session, line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      const message = line.trim();
      if (message) void this.#emit({ type: "diagnostic", level: "info", message: `[claude] ${message}` });
    });
    child.once("error", (error) => this.#childClosed(session, error));
    child.once("exit", (code, signal) => this.#childClosed(session, new Error(`Claude exited (${signal ?? code ?? "unknown"})`)));
  }

  async #receive(session: ClaudeSession, line: string): Promise<void> {
    let message: JsonObject;
    try {
      message = asObject(JSON.parse(line));
    } catch {
      await this.#emit({ type: "diagnostic", level: "error", message: `[claude] Invalid JSON: ${line.slice(0, 500)}` });
      return;
    }
    const type = stringOr(message.type, "");
    if (type === "system" && message.subtype === "init" && typeof message.session_id === "string" && message.session_id !== session.sessionId) {
      this.#sessions.delete(session.sessionId);
      session.sessionId = message.session_id;
      this.#sessions.set(session.sessionId, session);
      return;
    }
    if (type === "stream_event") {
      const event = asObject(message.event);
      if (event.type === "content_block_delta") {
        const delta = asObject(event.delta);
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (session.active) session.active.streamedText = true;
          await this.#update(session.sessionId, "agent_message_chunk", { content: { type: "text", text: delta.text } });
        } else if ((delta.type === "thinking_delta" || delta.type === "signature_delta") && typeof delta.thinking === "string") {
          await this.#update(session.sessionId, "agent_thought_chunk", { content: { type: "text", text: delta.thinking } });
        }
      }
      return;
    }
    if (type === "assistant") {
      const content = Array.isArray(asObject(message.message).content) ? asObject(message.message).content as unknown[] : [];
      for (const blockValue of content) {
        const block = asObject(blockValue);
        if (block.type === "text" && typeof block.text === "string" && !session.active?.streamedText) {
          await this.#update(session.sessionId, "agent_message_chunk", { content: { type: "text", text: block.text } });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          await this.#update(session.sessionId, "agent_thought_chunk", { content: { type: "text", text: block.thinking } });
        } else if (block.type === "tool_use") {
          await this.#emit({ type: "session_update", params: { sessionId: session.sessionId, update: claudeTool(block, false) } } as RuntimeEvent);
        }
      }
      return;
    }
    if (type === "user") {
      const content = Array.isArray(asObject(message.message).content) ? asObject(message.message).content as unknown[] : [];
      for (const blockValue of content) {
        const block = asObject(blockValue);
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          await this.#emit({ type: "session_update", params: { sessionId: session.sessionId, update: {
            sessionUpdate: "tool_call_update", toolCallId: block.tool_use_id, status: block.is_error ? "failed" : "completed",
            content: typeof block.content === "string" ? [{ type: "content", content: { type: "text", text: bounded(block.content) } }] : undefined,
          } } } as RuntimeEvent);
        }
      }
      return;
    }
    if (type === "result") {
      const active = session.active;
      if (!active) return;
      session.active = undefined;
      session.resume = true;
      const usageValue = asObject(message.usage);
      const usage = {
        inputTokens: numberOr(usageValue.input_tokens, 0) + numberOr(usageValue.cache_read_input_tokens, 0),
        outputTokens: numberOr(usageValue.output_tokens, 0),
        totalTokens: numberOr(usageValue.input_tokens, 0) + numberOr(usageValue.cache_read_input_tokens, 0) + numberOr(usageValue.output_tokens, 0),
      } as Usage;
      if (message.is_error === true) active.reject(new Error(stringOr(message.result, "Claude turn failed")));
      else active.resolve({ stopReason: "end_turn", usage });
    }
  }

  #update(sessionId: string, sessionUpdate: string, payload: JsonObject): Promise<void> {
    return this.#emit({ type: "session_update", params: { sessionId, update: { sessionUpdate, ...payload } } } as RuntimeEvent);
  }

  async #stopSession(session: ClaudeSession, error: Error, rejectActive: boolean): Promise<void> {
    const child = session.child;
    session.child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (rejectActive && session.active) {
      session.active.reject(error);
      session.active = undefined;
    }
  }

  #childClosed(session: ClaudeSession, error: Error): void {
    if (!session.child) return;
    session.child = undefined;
    if (session.active) {
      session.active.reject(error);
      session.active = undefined;
    }
    if (!this.#closing) void this.#emit({ type: "diagnostic", level: "error", message: error.message });
  }

  async #emit(event: RuntimeEvent): Promise<void> {
    await this.#options.onEvent(event);
  }
}

export function claudeConfigOptions(model: string, effort: string, mode: string): SessionConfigOption[] {
  return [
    {
      id: "model", name: "Model", description: "Anthropic Claude model", category: "model", type: "select", currentValue: model,
      options: [
        { value: "sonnet", name: "Sonnet", description: "Balanced coding model" },
        { value: "opus", name: "Opus", description: "Most capable model" },
        { value: "haiku", name: "Haiku", description: "Fast, efficient model" },
      ],
    },
    {
      id: "thinking", name: "Reasoning", description: "Claude effort level", category: "model", type: "select", currentValue: effort,
      options: ["low", "medium", "high", "max"].map((value) => ({ value, name: `${value[0]!.toUpperCase()}${value.slice(1)}` })),
    },
    {
      id: "mode", name: "Permissions", description: "Claude Code permission mode", category: "mode", type: "select", currentValue: mode,
      options: [
        { value: "default", name: "Default", description: "Accept edits and retain safety checks" },
        { value: "plan", name: "Plan", description: "Plan without editing" },
        { value: "yolo", name: "Full access", description: "Bypass permission checks" },
      ],
    },
  ] as SessionConfigOption[];
}

function permissionMode(mode: string): string {
  return mode === "yolo" ? "bypassPermissions" : mode === "plan" ? "plan" : "acceptEdits";
}

function claudePromptPart(block: ContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "resource" && "text" in block.resource) return `<resource uri=${JSON.stringify(block.resource.uri)}>\n${block.resource.text}\n</resource>`;
  if (block.type === "image") return `[Attached image: ${block.mimeType}; image transport is not available in Claude stream-json mode yet]`;
  return "";
}

function claudeTool(block: JsonObject, completed: boolean): JsonObject {
  const name = stringOr(block.name, "Tool");
  const input = asObject(block.input);
  const subagent = /^(?:Agent|Task)$/i.test(name);
  return {
    sessionUpdate: completed ? "tool_call_update" : "tool_call",
    toolCallId: stringOr(block.id, randomUUID()),
    title: subagent ? `Agent: ${stringOr(input.description, stringOr(input.subagent_type, "delegate"))}` : name,
    kind: /edit|write|notebook/i.test(name) ? "edit" : /bash|shell/i.test(name) ? "execute" : "other",
    status: completed ? "completed" : "in_progress",
    rawInput: subagent ? { ...input, subagent_type: stringOr(input.subagent_type, stringOr(input.agent, "coder")) } : input,
  };
}

function sessionResponse(session: ClaudeSession): RuntimeSession {
  return { sessionId: session.sessionId, cwd: session.cwd, configOptions: session.configOptions };
}

async function canonicalWorkspace(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
  return realpath(resolve(cwd));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bounded(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n[output truncated]`;
}
