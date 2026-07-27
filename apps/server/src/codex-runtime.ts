import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ContentBlock, SessionConfigOption, Usage } from "@agentclientprotocol/sdk";
import type { AgentRuntime, RuntimePromptResult, RuntimeSession, SubagentInspection } from "./agent-runtime.js";
import type { RuntimeEvent } from "./acp-client.js";

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;
type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
};
type CodexSession = {
  sessionId: string;
  cwd: string;
  model: string;
  effort: string;
  mode: string;
  configOptions: SessionConfigOption[];
  activeTurnId?: string;
  usage?: Usage;
};
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type PendingTurn = { resolve: (value: RuntimePromptResult) => void; reject: (error: Error) => void };
type PendingApproval = { rpcId: JsonRpcId; method: string };

export type CodexRuntimeOptions = {
  binary: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  onEvent: (event: RuntimeEvent) => unknown | Promise<unknown>;
  onClose?: () => void;
  requestTimeoutMs?: number;
};

const REQUEST_TIMEOUT_MS = 30_000;

export class CodexRuntime implements AgentRuntime {
  readonly #options: CodexRuntimeOptions;
  readonly #sessions = new Map<string, CodexSession>();
  readonly #models = new Map<string, CodexModel>();
  readonly #requests = new Map<JsonRpcId, PendingRequest>();
  readonly #turns = new Map<string, PendingTurn>();
  readonly #approvals = new Map<string, PendingApproval>();
  #child: ChildProcessWithoutNullStreams | undefined;
  #requestId = 0;
  #closing = false;

  constructor(options: CodexRuntimeOptions) {
    if (!isAbsolute(options.binary)) throw new Error("Codex binary path must be absolute");
    this.#options = options;
  }

  async start(): Promise<unknown> {
    if (this.#child) throw new Error("Codex runtime already started");
    this.#closing = false;
    const child = spawn(this.#options.binary, this.#options.args ?? ["app-server", "--stdio"], {
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    createInterface({ input: child.stdout }).on("line", (line) => void this.#receive(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      const message = line.trim();
      if (message) void this.#emit({ type: "diagnostic", level: "info", message: `[codex] ${message}` });
    });
    child.once("error", (error) => this.#disconnect(error));
    child.once("exit", (code, signal) => this.#disconnect(new Error(`Codex App Server exited (${signal ?? code ?? "unknown"})`)));
    const initialize = await this.#request("initialize", {
      clientInfo: { name: "tasty", title: "Tasty", version: "0.11.1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.#notify("initialized");
    await this.#loadModels();
    return initialize;
  }

  async newSession(cwd: string): Promise<RuntimeSession> {
    const root = await canonicalWorkspace(cwd);
    const model = this.#defaultModel();
    const response = asObject(await this.#request("thread/start", {
      cwd: root,
      model: model.model,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
    }));
    const thread = asObject(response.thread);
    const sessionId = asString(thread.id, "Codex thread id");
    const session = this.#rememberSession({
      sessionId,
      cwd: root,
      model: stringOr(response.model, model.model),
      effort: stringOr(response.reasoningEffort, model.defaultReasoningEffort),
      mode: "default",
    });
    return sessionResponse(session);
  }

  async listSessions(cwd?: string): Promise<{ sessions: RuntimeSession[] }> {
    const root = cwd ? await canonicalWorkspace(cwd) : undefined;
    const response = asObject(await this.#request("thread/list", {
      limit: 100,
      archived: false,
      ...(root ? { cwd: root } : {}),
    }));
    const sessions = arrayOfObjects(response.data).map((thread) => ({
      sessionId: asString(thread.id, "Codex thread id"),
      cwd: stringOr(thread.cwd, ""),
      title: stringOr(thread.name, stringOr(thread.preview, "Codex session")),
    }));
    return { sessions };
  }

  async inspectSubagent(threadId: string): Promise<SubagentInspection> {
    const response = asObject(await this.#request("thread/read", { threadId, includeTurns: true }));
    const thread = asObject(response.thread);
    return {
      threadId: asString(thread.id, "Codex subagent thread id"),
      title: stringOr(thread.name, stringOr(thread.agentNickname, stringOr(thread.preview, "Codex subagent"))),
      ...(typeof thread.agentRole === "string" && thread.agentRole ? { role: thread.agentRole } : {}),
      status: typeof thread.status === "string" ? thread.status : safeText(thread.status, "unknown"),
      turns: arrayOfObjects(thread.turns).map((turn) => ({
        turnId: stringOr(turn.id, "turn"),
        status: typeof turn.status === "string" ? turn.status : safeText(turn.status, "unknown"),
        ...(typeof turn.durationMs === "number" ? { durationMs: turn.durationMs } : {}),
        items: arrayOfObjects(turn.items).map(inspectCodexItem),
      })),
    };
  }

  async stopSubagent(threadId: string): Promise<void> {
    const inspection = await this.inspectSubagent(threadId);
    const active = [...inspection.turns].reverse().find((turn) => /in.?progress|running|active/i.test(turn.status));
    if (!active) throw new Error("This subagent has no active turn to stop");
    await this.#request("turn/interrupt", { threadId, turnId: active.turnId });
  }

  async resumeSession(sessionId: string, cwd: string): Promise<RuntimeSession> {
    const root = await canonicalWorkspace(cwd);
    const response = asObject(await this.#request("thread/resume", { threadId: sessionId, cwd: root, excludeTurns: true }));
    const model = this.#defaultModel();
    const session = this.#rememberSession({
      sessionId,
      cwd: root,
      model: stringOr(response.model, model.model),
      effort: stringOr(response.reasoningEffort, model.defaultReasoningEffort),
      mode: "default",
    });
    return sessionResponse(session);
  }

  loadSession(sessionId: string, cwd: string): Promise<RuntimeSession> {
    return this.resumeSession(sessionId, cwd);
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<{ configOptions?: SessionConfigOption[] }> {
    const session = this.#session(sessionId);
    const stringValue = String(value);
    if (configId === "model") {
      const model = this.#models.get(stringValue);
      if (!model) throw new Error(`Unknown Codex model ${stringValue}`);
      session.model = model.model;
      if (!model.supportedReasoningEfforts.some((option) => option.reasoningEffort === session.effort)) {
        session.effort = model.defaultReasoningEffort;
      }
    } else if (configId === "thinking") {
      const model = this.#models.get(session.model);
      if (!model?.supportedReasoningEfforts.some((option) => option.reasoningEffort === stringValue)) {
        throw new Error(`Reasoning effort ${stringValue} is not available for ${session.model}`);
      }
      session.effort = stringValue;
    } else if (configId === "mode") {
      if (!new Set(["default", "plan", "yolo"]).has(stringValue)) throw new Error(`Unknown Codex permission mode ${stringValue}`);
      session.mode = stringValue;
    } else {
      throw new Error(`Codex does not support config option ${configId}`);
    }
    session.configOptions = codexConfigOptions([...this.#models.values()], session.model, session.effort, session.mode);
    await this.#emitConfig(session);
    return { configOptions: session.configOptions };
  }

  async prompt(sessionId: string, prompt: ContentBlock[]): Promise<RuntimePromptResult> {
    const session = this.#session(sessionId);
    const input = prompt.flatMap(codexInput);
    const response = asObject(await this.#request("turn/start", {
      threadId: sessionId,
      input,
      model: session.model,
      effort: session.effort,
      ...modeOverrides(session.mode),
    }));
    const turn = asObject(response.turn);
    const turnId = asString(turn.id, "Codex turn id");
    session.activeTurnId = turnId;
    return new Promise((resolve, reject) => this.#turns.set(turnId, { resolve, reject }));
  }

  hasSession(sessionId: string): boolean {
    return this.isOpen() && this.#sessions.has(sessionId);
  }

  isOpen(): boolean {
    return Boolean(this.#child);
  }

  respondToPermission(requestId: string, optionId?: string): void {
    const pending = this.#approvals.get(requestId);
    if (!pending) return;
    this.#approvals.delete(requestId);
    const accepted = optionId === "accept" || optionId === "accept-session";
    const decision = accepted ? (optionId === "accept-session" ? "acceptForSession" : "accept") : "decline";
    this.#write({ id: pending.rpcId, result: { decision } });
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.#session(sessionId);
    if (!session.activeTurnId) return;
    await this.#request("turn/interrupt", { threadId: sessionId, turnId: session.activeTurnId });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    const child = this.#child;
    this.#child = undefined;
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    this.#rejectPending(new Error("Codex runtime closed"));
    this.#sessions.clear();
    this.#closing = false;
  }

  async #loadModels(): Promise<void> {
    const response = asObject(await this.#request("model/list", { limit: 100, includeHidden: false }));
    for (const item of arrayOfObjects(response.data)) {
      const model = parseModel(item);
      if (!model.hidden) this.#models.set(model.model, model);
    }
    if (!this.#models.size) throw new Error("Codex App Server returned no models");
  }

  #defaultModel(): CodexModel {
    return [...this.#models.values()].find((model) => model.isDefault) ?? [...this.#models.values()][0]!;
  }

  #rememberSession(session: Omit<CodexSession, "configOptions">): CodexSession {
    const remembered: CodexSession = {
      ...session,
      configOptions: codexConfigOptions([...this.#models.values()], session.model, session.effort, session.mode),
    };
    this.#sessions.set(session.sessionId, remembered);
    return remembered;
  }

  #session(sessionId: string): CodexSession {
    const session = this.#sessions.get(sessionId);
    if (!session) throw new Error(`Unknown Codex session ${sessionId}`);
    return session;
  }

  #request(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        reject(new Error(`Codex ${method} timed out`));
      }, this.#options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
      this.#requests.set(id, { resolve, reject, timer });
      this.#write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  #notify(method: string, params?: unknown): void {
    this.#write({ method, ...(params === undefined ? {} : { params }) });
  }

  #write(message: unknown): void {
    const child = this.#child;
    if (!child?.stdin.writable) throw new Error("Codex runtime is not open");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async #receive(line: string): Promise<void> {
    let message: JsonObject;
    try {
      message = asObject(JSON.parse(line));
    } catch {
      await this.#emit({ type: "diagnostic", level: "error", message: `[codex] Invalid JSON: ${line.slice(0, 500)}` });
      return;
    }
    if (message.id !== undefined && ("result" in message || "error" in message) && typeof message.method !== "string") {
      const pending = this.#requests.get(message.id as JsonRpcId);
      if (!pending) return;
      this.#requests.delete(message.id as JsonRpcId);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(jsonRpcError(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (message.id !== undefined) await this.#serverRequest(message.id as JsonRpcId, message.method, asObject(message.params));
    else await this.#notification(message.method, asObject(message.params));
  }

  async #serverRequest(rpcId: JsonRpcId, method: string, params: JsonObject): Promise<void> {
    if (method !== "item/commandExecution/requestApproval" && method !== "item/fileChange/requestApproval") {
      this.#write({ id: rpcId, error: { code: -32601, message: `Unsupported Codex request ${method}` } });
      return;
    }
    const sessionId = asString(params.threadId, "Codex approval thread id");
    const requestId = `codex-${String(rpcId)}`;
    this.#approvals.set(requestId, { rpcId, method });
    const title = method.includes("commandExecution")
      ? stringOr(params.command, stringOr(params.reason, "Run command"))
      : stringOr(params.reason, "Apply file changes");
    await this.#emit({
      type: "permission_request",
      requestId,
      params: {
        sessionId,
        toolCall: { toolCallId: stringOr(params.itemId, requestId), title, kind: method.includes("commandExecution") ? "execute" : "edit", status: "pending" },
        options: [
          { optionId: "accept", name: "Allow once", kind: "allow_once" },
          { optionId: "accept-session", name: "Allow for session", kind: "allow_always" },
          { optionId: "decline", name: "Decline", kind: "reject_once" },
        ],
      },
    } as RuntimeEvent);
  }

  async #notification(method: string, params: JsonObject): Promise<void> {
    const sessionId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (method === "item/agentMessage/delta" && sessionId) {
      await this.#sessionUpdate(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: stringOr(params.delta, "") } });
      return;
    }
    if ((method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") && sessionId) {
      await this.#sessionUpdate(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: stringOr(params.delta, "") } });
      return;
    }
    if (method === "turn/plan/updated" && sessionId) {
      await this.#sessionUpdate(sessionId, {
        sessionUpdate: "plan",
        entries: arrayOfObjects(params.plan).map((step) => ({ content: stringOr(step.step, "Plan step"), priority: "medium", status: normalizePlanStatus(step.status) })),
      });
      return;
    }
    if ((method === "item/started" || method === "item/completed") && sessionId) {
      const item = asObject(params.item);
      const tool = codexTool(item, method === "item/completed");
      if (tool) await this.#sessionUpdate(sessionId, tool);
      return;
    }
    if (method === "thread/tokenUsage/updated" && sessionId) {
      const tokenUsage = asObject(params.tokenUsage);
      const last = asObject(tokenUsage.last);
      const total = asObject(tokenUsage.total);
      const used = numberOr(last.totalTokens, 0);
      const size = numberOr(tokenUsage.modelContextWindow, 0);
      const session = this.#sessions.get(sessionId);
      if (session) session.usage = {
        inputTokens: numberOr(total.inputTokens, 0),
        outputTokens: numberOr(total.outputTokens, 0),
        totalTokens: numberOr(total.totalTokens, used),
      } as Usage;
      if (used > 0 && size > 0) await this.#sessionUpdate(sessionId, { sessionUpdate: "usage_update", used, size });
      return;
    }
    if (method === "turn/completed" && sessionId) {
      const turn = asObject(params.turn);
      const turnId = stringOr(turn.id, "");
      const pending = this.#turns.get(turnId);
      if (!pending) return;
      this.#turns.delete(turnId);
      const session = this.#sessions.get(sessionId);
      if (session) delete session.activeTurnId;
      const status = stringOr(turn.status, "completed");
      if (status === "failed") pending.reject(new Error(stringOr(asObject(turn.error).message, "Codex turn failed")));
      else pending.resolve({ stopReason: status === "cancelled" || status === "interrupted" ? "cancelled" : "end_turn", ...(session?.usage ? { usage: session.usage } : {}) });
      return;
    }
    if (method === "error") {
      await this.#emit({ type: "diagnostic", level: "error", message: `[codex] ${stringOr(asObject(params.error).message, "Runtime error")}` });
    }
  }

  #sessionUpdate(sessionId: string, update: JsonObject): Promise<void> {
    return this.#emit({ type: "session_update", params: { sessionId, update } } as RuntimeEvent);
  }

  #emitConfig(session: CodexSession): Promise<void> {
    return this.#sessionUpdate(session.sessionId, { sessionUpdate: "config_option_update", configOptions: session.configOptions });
  }

  async #emit(event: RuntimeEvent): Promise<void> {
    await this.#options.onEvent(event);
  }

  #disconnect(error: Error): void {
    const wasOpen = Boolean(this.#child);
    this.#child = undefined;
    this.#rejectPending(error);
    if (wasOpen && !this.#closing) this.#options.onClose?.();
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#requests.clear();
    for (const pending of this.#turns.values()) pending.reject(error);
    this.#turns.clear();
    this.#approvals.clear();
  }
}

export function codexConfigOptions(models: CodexModel[], currentModel: string, effort: string, mode: string): SessionConfigOption[] {
  const selected = models.find((model) => model.model === currentModel) ?? models[0];
  if (!selected) return [];
  return [
    {
      id: "model", name: "Model", description: "OpenAI Codex model", category: "model", type: "select", currentValue: selected.model,
      options: models.map((model) => ({ value: model.model, name: model.displayName, description: model.description })),
    },
    {
      id: "thinking", name: "Reasoning", description: "Reasoning effort", category: "model", type: "select", currentValue: effort,
      options: selected.supportedReasoningEfforts.map((option) => ({ value: option.reasoningEffort, name: titleCase(option.reasoningEffort), description: option.description })),
    },
    {
      id: "mode", name: "Permissions", description: "Workspace permission policy", category: "mode", type: "select", currentValue: mode,
      options: [
        { value: "default", name: "Default", description: "Workspace access with approvals when needed" },
        { value: "plan", name: "Plan", description: "Read-only planning" },
        { value: "yolo", name: "Full access", description: "No approval prompts or sandbox" },
      ],
    },
  ] as SessionConfigOption[];
}

function codexInput(block: ContentBlock): JsonObject[] {
  if (block.type === "text") return [{ type: "text", text: block.text, text_elements: [] }];
  if (block.type === "image") return [{ type: "image", url: `data:${block.mimeType};base64,${block.data}` }];
  if (block.type === "resource" && "text" in block.resource) {
    return [{ type: "text", text: `\n\n<resource uri=${JSON.stringify(block.resource.uri)}>\n${block.resource.text}\n</resource>`, text_elements: [] }];
  }
  return [];
}

function modeOverrides(mode: string): JsonObject {
  if (mode === "yolo") return { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } };
  if (mode === "plan") return { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } };
  return { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
}

function codexTool(item: JsonObject, completed: boolean): JsonObject | undefined {
  const id = stringOr(item.id, "");
  if (!id) return undefined;
  const type = stringOr(item.type, "");
  const status = completed ? (stringOr(item.status, "completed") === "failed" ? "failed" : "completed") : "in_progress";
  if (type === "commandExecution") return {
    sessionUpdate: completed ? "tool_call_update" : "tool_call", toolCallId: id, title: stringOr(item.command, "Run command"), kind: "execute", status,
    rawInput: { command: item.command, cwd: item.cwd }, content: completed && item.aggregatedOutput ? [{ type: "content", content: { type: "text", text: bounded(String(item.aggregatedOutput)) } }] : undefined,
  };
  if (type === "fileChange") return {
    sessionUpdate: completed ? "tool_call_update" : "tool_call", toolCallId: id, title: "Apply file changes", kind: "edit", status, rawInput: { changes: item.changes },
  };
  if (type === "mcpToolCall" || type === "dynamicToolCall") return {
    sessionUpdate: completed ? "tool_call_update" : "tool_call", toolCallId: id,
    title: type === "mcpToolCall" ? `${stringOr(item.server, "MCP")} · ${stringOr(item.tool, "tool")}` : stringOr(item.tool, "Tool call"),
    kind: "other", status, rawInput: item.arguments,
  };
  if (type === "collabAgentToolCall") return {
    sessionUpdate: completed ? "tool_call_update" : "tool_call", toolCallId: id, title: `Agent: ${stringOr(item.tool, "delegate")}`, kind: "other", status,
    rawInput: { subagent_type: item.tool, description: item.prompt, receiverThreadIds: item.receiverThreadIds, agentsStates: item.agentsStates },
  };
  return undefined;
}

function inspectCodexItem(item: JsonObject): SubagentInspection["turns"][number]["items"][number] {
  const id = stringOr(item.id, crypto.randomUUID());
  const type = stringOr(item.type, "activity");
  if (type === "agentMessage") return { id, kind: "message", title: "Agent", text: bounded(stringOr(item.text, "")) };
  if (type === "reasoning") return { id, kind: "reasoning", title: "Reasoning", text: bounded([...stringArray(item.summary), ...stringArray(item.content)].join("\n")) };
  if (type === "commandExecution") return { id, kind: "action", title: stringOr(item.command, "Run command"), ...(item.aggregatedOutput ? { text: bounded(String(item.aggregatedOutput)) } : {}), status: stringOr(item.status, "unknown") };
  if (type === "fileChange") return { id, kind: "action", title: `${Array.isArray(item.changes) ? item.changes.length : 0} file changes`, status: stringOr(item.status, "unknown") };
  if (type === "collabAgentToolCall") return { id, kind: "action", title: `Agent · ${stringOr(item.tool, "delegate")}`, ...(item.prompt ? { text: bounded(String(item.prompt)) } : {}), status: stringOr(item.status, "unknown") };
  return { id, kind: "action", title: type.replace(/([a-z])([A-Z])/g, "$1 $2"), status: stringOr(item.status, "completed") };
}

function parseModel(value: JsonObject): CodexModel {
  const model = asString(value.model, "Codex model");
  return {
    id: stringOr(value.id, model),
    model,
    displayName: stringOr(value.displayName, model),
    description: stringOr(value.description, "OpenAI Codex model"),
    hidden: value.hidden === true,
    isDefault: value.isDefault === true,
    defaultReasoningEffort: stringOr(value.defaultReasoningEffort, "medium"),
    supportedReasoningEfforts: arrayOfObjects(value.supportedReasoningEfforts).map((option) => ({
      reasoningEffort: stringOr(option.reasoningEffort, "medium"),
      description: stringOr(option.description, ""),
    })),
  };
}

function sessionResponse(session: CodexSession): RuntimeSession {
  return { sessionId: session.sessionId, cwd: session.cwd, configOptions: session.configOptions };
}

async function canonicalWorkspace(cwd: string): Promise<string> {
  if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
  return realpath(resolve(cwd));
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function arrayOfObjects(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map(asObject) : [];
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function safeText(value: unknown, fallback: string): string {
  try { return value === undefined ? fallback : bounded(JSON.stringify(value)); } catch { return fallback; }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function titleCase(value: string): string {
  return value ? `${value[0]!.toUpperCase()}${value.slice(1)}` : value;
}

function normalizePlanStatus(value: unknown): "pending" | "in_progress" | "completed" {
  return value === "completed" ? "completed" : value === "inProgress" || value === "in_progress" ? "in_progress" : "pending";
}

function jsonRpcError(value: unknown): string {
  const error = asObject(value);
  return stringOr(error.message, JSON.stringify(value));
}

function bounded(value: string): string {
  return value.length <= 4_000 ? value : `${value.slice(0, 4_000)}\n[output truncated]`;
}
