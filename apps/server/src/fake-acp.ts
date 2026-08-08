#!/usr/bin/env node
import { Readable, Writable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";

class FakeAgent implements acp.Agent {
  readonly #connection: acp.AgentSideConnection;
  readonly #sessions = new Map<string, { cwd: string; controller: AbortController; configOptions: acp.SessionConfigOption[] }>();
  #forgotConfigOnce = false;
  #forgotPromptOnce = false;

  constructor(connection: acp.AgentSideConnection) {
    this.#connection = connection;
  }

  async initialize(): Promise<acp.InitializeResponse> {
    const delay = Number(process.env.KIMI_FAKE_INITIALIZE_DELAY_MS ?? 0);
    if (Number.isFinite(delay) && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
    }
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
    if (process.env.KIMI_FAKE_NEW_SESSION_LOG) {
      await writeFile(process.env.KIMI_FAKE_NEW_SESSION_LOG, `${params.cwd}\n`, { encoding: "utf8", flag: "a" });
    }
    if (process.env.KIMI_FAKE_NEW_SESSION_MCP_LOG) {
      await writeFile(process.env.KIMI_FAKE_NEW_SESSION_MCP_LOG, `${JSON.stringify({
        cwd: params.cwd,
        kimiCodeHome: process.env.KIMI_CODE_HOME,
        mcpServers: params.mcpServers.map((server) => server.name),
      })}\n`, { encoding: "utf8", flag: "a" });
    }
    const delay = Number(process.env.KIMI_FAKE_NEW_SESSION_DELAY_MS ?? 0);
    if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
    if (process.env.KIMI_FAKE_NEW_SESSION_REJECT === "1") {
      throw acp.RequestError.invalidParams(undefined, "Fake new session rejected");
    }
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
    if (process.env.KIMI_FAKE_UNKNOWN_CONFIG_ONCE === "1" && !this.#forgotConfigOnce) {
      this.#forgotConfigOnce = true;
      this.#sessions.delete(params.sessionId);
      throw acp.RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    }
    const session = this.#sessions.get(params.sessionId);
    if (!session) throw acp.RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    const delay = Number(process.env.KIMI_FAKE_CONFIG_DELAY_MS ?? 0);
    if (params.configId === "model" && Number.isFinite(delay) && delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
    }
    const values = new Map(session.configOptions.map((option) => [option.id, option.currentValue]));
    values.set(String(params.configId), params.value);
    session.configOptions = fakeConfigOptions(values, values.get("model") === "kimi-k3-fast");
    await this.#connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions: session.configOptions } });
    if (params.configId === "mode") await this.#connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: String(params.value) } });
    return { configOptions: session.configOptions };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    if (process.env.KIMI_FAKE_UNKNOWN_PROMPT_ONCE === "1" && !this.#forgotPromptOnce) {
      this.#forgotPromptOnce = true;
      this.#sessions.delete(params.sessionId);
      throw acp.RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    }
    const session = this.#sessions.get(params.sessionId);
    if (!session) throw acp.RequestError.invalidParams(undefined, `Unknown sessionId: ${params.sessionId}`);
    if (params.prompt.some((block) => block.type === "text" && block.text === "__CLOSE_ACP__")) process.exit(0);
    const readPath = params.prompt.find((block) => block.type === "text" && block.text.startsWith("__READ_TEXT_FILE__:"));
    if (readPath?.type === "text") {
      const result = await this.#connection.readTextFile({ sessionId: params.sessionId, path: readPath.text.slice("__READ_TEXT_FILE__:".length) });
      await this.#update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.content } });
      return { stopReason: "end_turn" };
    }
    const rangedRead = params.prompt.find((block) => block.type === "text" && block.text.startsWith("__READ_TEXT_FILE_RANGE__:"));
    const rangedMatch = rangedRead?.type === "text" && /^__READ_TEXT_FILE_RANGE__:(\d+):(\d+):(.*)$/s.exec(rangedRead.text);
    if (rangedMatch) {
      const result = await this.#connection.readTextFile({
        sessionId: params.sessionId,
        path: rangedMatch[3]!,
        line: Number(rangedMatch[1]),
        limit: Number(rangedMatch[2]),
      });
      await this.#update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.content } });
      return { stopReason: "end_turn" };
    }
    const writePath = params.prompt.find((block) => block.type === "text" && block.text.startsWith("__WRITE_TEXT_FILE__:"));
    if (writePath?.type === "text") {
      await this.#connection.writeTextFile({ sessionId: params.sessionId, path: writePath.text.slice("__WRITE_TEXT_FILE__:".length), content: "changed" });
      return { stopReason: "end_turn" };
    }
    const text = params.prompt.map((block) => block.type === "text" ? block.text : "").join("\n");
    if (text.includes("__PRIVATE_RUNTIME_ERROR__")) {
      const detail = [process.env.KIMI_BINARY, process.env.KIMI_CODE_HOME, process.env.XDG_CONFIG_HOME, process.env.KIMI_FAKE_RETIRED_PRIVATE_PATH].filter(Boolean).join(" | ");
      process.stderr.write(`Fake private runtime diagnostic: ${detail}\n`);
      throw acp.RequestError.invalidParams(undefined, `Fake private runtime failure: ${detail}`);
    }
    if (text.includes("__STALE_RUNTIME_DIAGNOSTIC__")) {
      process.stderr.write("__STALE_RUNTIME_DIAGNOSTIC__\n");
      await this.#update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Diagnostic scheduled." } });
      return { stopReason: "end_turn" };
    }
    if (text.includes("__BACKGROUND_TASK__")) {
      const taskId = "bash-build1";
      const path = fakeTaskPath(params.sessionId, taskId);
      const completedBeforeTurn = text.includes("__BACKGROUND_TASK_COMPLETED__");
      const task = {
        taskId,
        description: "Build APK",
        status: completedBeforeTurn ? "completed" : "running",
        detached: true,
        startedAt: Date.now(),
        timeoutMs: 60_000,
        kind: "process",
        pid: process.pid,
        ...(completedBeforeTurn ? { endedAt: Date.now(), exitCode: 0 } : {}),
      };
      await mkdir(dirname(path), { recursive: true });
      if (completedBeforeTurn) {
        const output = join(dirname(path), taskId, "output.log");
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, "BUILD SUCCESSFUL", "utf8");
      }
      await writeFile(path, JSON.stringify(task), "utf8");
      await this.#update(params.sessionId, {
        sessionUpdate: "tool_call", toolCallId: "tool-background", title: "Starting background: build APK", kind: "execute", status: "in_progress",
        rawInput: { command: "build-apk", description: "Build APK", run_in_background: true, timeout: 60 },
      });
      await this.#update(params.sessionId, {
        sessionUpdate: "tool_call_update", toolCallId: "tool-background", status: "completed",
        rawOutput: `task_id: ${taskId}\npid: ${process.pid}\ndescription: Build APK\nstatus: ${task.status}\nautomatic_notification: true`,
      });
      if (!text.includes("__BACKGROUND_TASK_PENDING__") && !completedBeforeTurn) {
        setTimeout(() => {
          const output = join(dirname(path), taskId, "output.log");
          void mkdir(dirname(output), { recursive: true })
            .then(() => writeFile(output, "BUILD SUCCESSFUL", "utf8"))
            .then(() => writeFile(path, JSON.stringify({ ...task, status: "completed", endedAt: Date.now(), exitCode: 0 }), "utf8"));
        }, 250);
      }
      await this.#update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The build is still running; I will report when it finishes." } });
      if (text.includes("__BACKGROUND_TASK_STALL__")) {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      }
      if (text.includes("__BACKGROUND_TASK_REJECT__")) throw new Error("Fake prompt rejected after starting a background task");
      return { stopReason: "end_turn" };
    }
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
    if (controller.signal.aborted || permission.outcome.outcome === "cancelled") {
      const delay = Number(process.env.KIMI_FAKE_CANCEL_RESPONSE_DELAY_MS ?? 0);
      if (Number.isFinite(delay) && delay > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(delay, 30_000)));
      return { stopReason: "cancelled" };
    }
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

function fakeTaskPath(sessionId: string, taskId: string): string {
  const home = process.env.KIMI_CODE_HOME ?? join(process.cwd(), ".kimi-code");
  const sessionDirectory = sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`;
  return join(home, "sessions", "wd-test", sessionDirectory, "agents", "main", "tasks", `${taskId}.json`);
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
