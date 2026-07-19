#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

class FakeAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions = new Map<string, { cwd: string; controller: AbortController; configOptions: acp.SessionConfigOption[] }>();

  constructor(connection: acp.AgentSideConnection) {
    this.#connection = connection;
  }

  async initialize(): Promise<acp.InitializeResponse> {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "Kimi Code Fake", version: "0.26.0-fixture" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {} },
      },
      authMethods: [],
    };
  }

  async authenticate(): Promise<Record<string, never>> {
    return {};
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    const sessionId = `fake-${crypto.randomUUID()}`;
    const configOptions = fakeConfigOptions();
    this.#sessions.set(sessionId, { cwd: params.cwd, controller: new AbortController(), configOptions });
    return { sessionId, configOptions };
  }

  async listSessions(params: acp.ListSessionsRequest): Promise<acp.ListSessionsResponse> {
    return { sessions: [...this.#sessions].filter(([, session]) => !params.cwd || params.cwd === session.cwd).map(([sessionId, session]) => ({ sessionId, cwd: session.cwd, title: "Fake Kimi session" })) };
  }

  async resumeSession(params: acp.ResumeSessionRequest): Promise<acp.ResumeSessionResponse> {
    const existing = this.#sessions.get(params.sessionId);
    if (!existing) this.#sessions.set(params.sessionId, { cwd: params.cwd, controller: new AbortController(), configOptions: fakeConfigOptions() });
    return { configOptions: this.#sessions.get(params.sessionId)!.configOptions };
  }

  loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    return this.resumeSession(params);
  }

  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) throw new Error("Unknown fake session");
    const values = new Map(session.configOptions.map((option) => [option.id, option.currentValue]));
    values.set(String(params.configId), params.value);
    session.configOptions = fakeConfigOptions(values, values.get("model") === "kimi-k3-fast");
    await this.#connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: session.configOptions } });
    if (params.configId === "mode") await this.#connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: String(params.value) } });
    return { configOptions: session.configOptions };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const session = this.#sessions.get(params.sessionId);
    if (!session) throw new Error("Unknown fake session");
    const controller = session.controller = new AbortController();
    for (const block of params.prompt) {
      if (block.type === "resource" && !("text" in block.resource)) throw new Error("Fake ACP rejects blob resources");
      if (block.type === "audio") throw new Error("Fake ACP rejects audio prompts");
    }

    await this.#update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting the workspace." } });
    await this.#update(params.sessionId, { sessionUpdate: "plan", entries: [
      { content: "Inspect workspace", priority: "high", status: "completed" },
      { content: "Apply the requested change", priority: "high", status: "in_progress" },
    ] });
    await this.#update(params.sessionId, {
      sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Update README", kind: "edit", status: "in_progress",
      locations: [{ path: join(process.cwd(), "package.json") }], rawInput: { path: "package.json" },
    });
    await this.#update(params.sessionId, {
      sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed", content: [{
        type: "diff", path: "README.md", oldText: "# Before\n", newText: "# After\n",
      }],
    });
    const permission = await this.#connection.requestPermission({
      sessionId: params.sessionId,
      toolCall: { toolCallId: "tool-2", title: "Run project checks", kind: "execute", status: "pending" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        { optionId: "reject-always", name: "Never allow", kind: "reject_always" },
      ],
    });
    if (controller.signal.aborted || permission.outcome.outcome === "cancelled") return { stopReason: "cancelled" };
    if (permission.outcome.outcome === "selected" && permission.outcome.optionId.startsWith("reject")) {
      await this.#update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Permission rejected." } });
      return { stopReason: "end_turn" };
    }
    await this.#update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The requested change is ready." } });
    return { stopReason: "end_turn" };
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    this.#sessions.get(params.sessionId)?.controller.abort();
  }

  async #update(sessionId: string, update: acp.SessionUpdate): Promise<void> {
    await this.#connection.sessionUpdate({ sessionId, update });
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);

function fakeConfigOptions(values: ReadonlyMap<string, string | boolean> = new Map(), withoutThinking = false): acp.SessionConfigOption[] {
  const current = (id: string, fallback: string) => values.get(id) ?? fallback;
  return [
    { id: "model", name: "Model", type: "select", category: "model", currentValue: String(current("model", "kimi-k3")), options: [{ value: "kimi-k3", name: "Kimi K3" }, { value: "kimi-k3-fast", name: "Kimi K3 Fast" }] },
    ...withoutThinking ? [] : [{ id: "thinking", name: "Thinking", type: "select", category: "thought_level", currentValue: String(current("thinking", "on")), options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] } satisfies acp.SessionConfigOption],
    { id: "mode", name: "Mode", type: "select", category: "mode", currentValue: String(current("mode", "default")), options: [
      { value: "default", name: "Default" }, { value: "plan", name: "Plan" }, { value: "auto", name: "Auto" }, { value: "yolo", name: "YOLO" },
    ] },
  ];
}
