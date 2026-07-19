import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ApprovalBroker } from "./approval-broker.js";

export type RuntimeEvent =
  | { type: "session_update"; params: acp.SessionNotification }
  | { type: "permission_request"; requestId: string; params: acp.RequestPermissionRequest }
  | { type: "diagnostic"; level: "info" | "error"; message: string };

export type AcpClientOptions = {
  binary: string;
  args?: string[];
  kimiCodeHome?: string;
  mcpServers?: () => Promise<acp.McpServer[]>;
  onEvent: (event: RuntimeEvent) => void;
};

export class AcpClient {
  readonly #options: AcpClientOptions;
  readonly #sessionRoots = new Map<string, string>();
  readonly #approvalBroker: ApprovalBroker;
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: acp.ClientSideConnection | undefined;

  constructor(options: AcpClientOptions) {
    if (!isAbsolute(options.binary)) throw new Error("ACP binary path must be absolute");
    this.#options = options;
    this.#approvalBroker = new ApprovalBroker((requestId, params) => this.#options.onEvent({ type: "permission_request", requestId, params }));
  }

  async start(): Promise<acp.InitializeResponse> {
    if (this.#connection) throw new Error("ACP client already started");

    const child = spawn(this.#options.binary, this.#options.args ?? ["acp"], {
      env: {
        ...process.env,
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        KIMI_LOG_LEVEL: "info",
        ...(this.#options.kimiCodeHome ? { KIMI_CODE_HOME: this.#options.kimiCodeHome } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.#options.onEvent({ type: "diagnostic", level: "info", message: chunk.trimEnd() });
    });
    child.on("error", (error) => {
      this.#options.onEvent({ type: "diagnostic", level: "error", message: error.message });
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const client: acp.Client = {
      sessionUpdate: async (params) => {
        this.#options.onEvent({ type: "session_update", params });
      },
      requestPermission: (params) => this.#approvalBroker.request(params),
      readTextFile: (params) => this.#readTextFile(params),
      writeTextFile: (params) => this.#writeTextFile(params),
    };
    this.#connection = new acp.ClientSideConnection(() => client, stream);

    return this.#connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: "kimi-code-desktop", title: "Kimi Code Desktop", version: "0.1.0" },
    });
  }

  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    const result = await this.#agent().newSession({ cwd: resolve(cwd), mcpServers: await this.#mcpServers() });
    this.#sessionRoots.set(result.sessionId, resolve(cwd));
    return result;
  }

  listSessions(cwd?: string): Promise<acp.ListSessionsResponse> {
    if (cwd && !isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    return this.#agent().listSessions(cwd ? { cwd: resolve(cwd) } : {});
  }

  async resumeSession(sessionId: string, cwd: string): Promise<acp.ResumeSessionResponse> {
    if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    const root = resolve(cwd);
    const result = await this.#agent().resumeSession({ sessionId, cwd: root, mcpServers: await this.#mcpServers() });
    this.#sessionRoots.set(sessionId, root);
    return result;
  }

  async loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse> {
    if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    const root = resolve(cwd);
    this.#sessionRoots.set(sessionId, root);
    return this.#agent().loadSession({ sessionId, cwd: root, mcpServers: await this.#mcpServers() });
  }

  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<acp.SetSessionConfigOptionResponse> {
    return this.#agent().setSessionConfigOption(typeof value === "boolean"
      ? { sessionId, configId, type: "boolean", value }
      : { sessionId, configId, value });
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.#agent().prompt({ sessionId, prompt });
  }

  hasSession(sessionId: string): boolean {
    return this.#sessionRoots.has(sessionId);
  }

  respondToPermission(requestId: string, optionId?: string): void {
    this.#approvalBroker.respond(requestId, optionId);
  }

  async cancel(sessionId: string): Promise<void> {
    this.#approvalBroker.cancelSession(sessionId);
    await this.#agent().cancel({ sessionId });
  }

  async close(): Promise<void> {
    this.#approvalBroker.cancelAll();
    this.#child?.kill();
    await this.#connection?.closed.catch(() => undefined);
    this.#connection = undefined;
    this.#child = undefined;
  }

  #agent(): acp.ClientSideConnection {
    if (!this.#connection) throw new Error("ACP client is not started");
    return this.#connection;
  }

  #mcpServers(): Promise<acp.McpServer[]> {
    return this.#options.mcpServers?.() ?? Promise.resolve([]);
  }

  async #readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const path = this.#workspacePath(params.sessionId, params.path);
    const content = await readFile(path, "utf8");
    if (params.line == null && params.limit == null) return { content };
    const start = Math.max(0, (params.line ?? 1) - 1);
    return { content: content.split(/\r?\n/).slice(start, params.limit == null ? undefined : start + params.limit).join("\n") };
  }

  async #writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const path = this.#workspacePath(params.sessionId, params.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
    return {};
  }

  #workspacePath(sessionId: string, path: string): string {
    if (!isAbsolute(path)) throw new Error("ACP file paths must be absolute");
    const root = this.#sessionRoots.get(sessionId);
    if (!root) throw new Error(`Unknown ACP session ${sessionId}`);
    const resolved = resolve(path);
    const rel = relative(root, resolved);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside workspace: ${resolved}`);
    return resolved;
  }
}
