import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat, mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, dirname, join, relative, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ApprovalBroker } from "./approval-broker.js";
import { MAX_BACKGROUND_OUTPUT_BYTES } from "./background-tasks.js";

const ACP_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
const CHILD_EXIT_GRACE_MS = 1_000;
const MAX_BACKGROUND_OUTPUT_LINES = 2_000;

export type RuntimeEvent =
  | { type: "session_update"; params: acp.SessionNotification }
  | { type: "permission_request"; requestId: string; params: acp.RequestPermissionRequest }
  | { type: "diagnostic"; level: "info" | "error"; message: string };

export type AcpClientOptions = {
  binary: string;
  args?: string[];
  kimiCodeHome?: string;
  mcpServers?: (canonicalCwd: string) => Promise<acp.McpServer[]>;
  onEvent: (event: RuntimeEvent) => unknown | Promise<unknown>;
  onClose?: () => void;
  controlRequestTimeoutMs?: number;
};

export function isUnknownAcpSessionError(error: unknown): boolean {
  return error instanceof acp.RequestError
    && error.code === -32602
    && /^Invalid params:\s*Unknown sessionId(?:\s*:|\b)/i.test(error.message);
}

export class AcpClient {
  readonly #options: AcpClientOptions;
  readonly #sessionRoots = new Map<string, string>();
  readonly #approvalBroker: ApprovalBroker;
  #child: ChildProcessWithoutNullStreams | undefined;
  #connection: acp.ClientSideConnection | undefined;
  #closing = false;

  constructor(options: AcpClientOptions) {
    if (!isAbsolute(options.binary)) throw new Error("ACP binary path must be absolute");
    if (options.controlRequestTimeoutMs !== undefined
      && (!Number.isFinite(options.controlRequestTimeoutMs) || options.controlRequestTimeoutMs <= 0)) {
      throw new Error("ACP control request timeout must be a positive number");
    }
    this.#options = options;
    this.#approvalBroker = new ApprovalBroker((requestId, params) => {
      void Promise.resolve(this.#options.onEvent({ type: "permission_request", requestId, params })).catch(() => undefined);
    });
  }

  async start(): Promise<acp.InitializeResponse> {
    if (this.#connection) throw new Error("ACP client already started");
    this.#closing = false;

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
      void Promise.resolve(this.#options.onEvent({ type: "diagnostic", level: "info", message: chunk.trimEnd() })).catch(() => undefined);
    });
    child.on("error", (error) => {
      void Promise.resolve(this.#options.onEvent({ type: "diagnostic", level: "error", message: error.message })).catch(() => undefined);
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    );
    const client: acp.Client = {
      sessionUpdate: async (params) => {
        await this.#options.onEvent({ type: "session_update", params });
      },
      requestPermission: (params) => this.#approvalBroker.request(params),
      readTextFile: (params) => this.#readTextFile(params),
      writeTextFile: (params) => this.#writeTextFile(params),
    };
    const connection = new acp.ClientSideConnection(() => client, stream);
    this.#connection = connection;
    void connection.closed.then(
      () => this.#handleConnectionClosed(connection, child),
      () => this.#handleConnectionClosed(connection, child),
    ).catch(() => undefined);

    return this.#controlRequest("initialize", () => connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      },
      clientInfo: { name: "kimi-code-desktop", title: "Kimi Code Desktop", version: "0.9.0" },
    }));
  }

  async newSession(cwd: string): Promise<acp.NewSessionResponse> {
    if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    const root = await realpath(resolve(cwd));
    const mcpServers = await this.#mcpServers(root);
    const result = await this.#controlRequest(
      "session/new",
      () => this.#agent().newSession({ cwd: root, mcpServers }),
    );
    this.#sessionRoots.set(result.sessionId, root);
    return result;
  }

  async listSessions(cwd?: string): Promise<acp.ListSessionsResponse> {
    if (cwd && !isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    const root = cwd ? await realpath(resolve(cwd)) : undefined;
    return this.#controlRequest(
      "session/list",
      () => this.#agent().listSessions(root ? { cwd: root } : {}),
    );
  }

  async resumeSession(sessionId: string, cwd: string): Promise<acp.ResumeSessionResponse> {
    if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    const root = await realpath(resolve(cwd));
    const mcpServers = await this.#mcpServers(root);
    const result = await this.#controlSessionRequest(
      "session/resume",
      sessionId,
      () => this.#agent().resumeSession({ sessionId, cwd: root, mcpServers }),
    );
    this.#sessionRoots.set(sessionId, root);
    return result;
  }

  async loadSession(sessionId: string, cwd: string): Promise<acp.LoadSessionResponse> {
    if (!isAbsolute(cwd)) throw new Error("Workspace path must be absolute");
    const root = await realpath(resolve(cwd));
    const mcpServers = await this.#mcpServers(root);
    const result = await this.#controlSessionRequest(
      "session/load",
      sessionId,
      () => this.#agent().loadSession({ sessionId, cwd: root, mcpServers }),
    );
    this.#sessionRoots.set(sessionId, root);
    return result;
  }

  setConfigOption(sessionId: string, configId: string, value: string | boolean): Promise<acp.SetSessionConfigOptionResponse> {
    return this.#controlSessionRequest(
      "session/set_config_option",
      sessionId,
      () => this.#agent().setSessionConfigOption(typeof value === "boolean"
        ? { sessionId, configId, type: "boolean", value }
        : { sessionId, configId, value }),
    );
  }

  prompt(sessionId: string, prompt: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    return this.#sessionRequest(sessionId, () => this.#agent().prompt({ sessionId, prompt }));
  }

  hasSession(sessionId: string): boolean {
    return this.isOpen() && this.#sessionRoots.has(sessionId);
  }

  isOpen(): boolean {
    return Boolean(this.#connection);
  }

  respondToPermission(requestId: string, optionId?: string): void {
    this.#approvalBroker.respond(requestId, optionId);
  }

  async cancel(sessionId: string): Promise<void> {
    this.#approvalBroker.cancelSession(sessionId);
    await this.#controlSessionRequest(
      "session/cancel",
      sessionId,
      () => this.#agent().cancel({ sessionId }),
    );
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#approvalBroker.cancelAll();
    const child = this.#child;
    this.#connection = undefined;
    this.#child = undefined;
    this.#sessionRoots.clear();
    await terminateChild(child);
    this.#closing = false;
  }

  #agent(): acp.ClientSideConnection {
    if (!this.#connection) throw new Error("ACP client is not started");
    return this.#connection;
  }

  async #sessionRequest<T>(sessionId: string, request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (isUnknownAcpSessionError(error)) this.#sessionRoots.delete(sessionId);
      throw error;
    }
  }

  #controlSessionRequest<T>(operation: string, sessionId: string, request: () => Promise<T>): Promise<T> {
    return this.#sessionRequest(sessionId, () => this.#controlRequest(operation, request));
  }

  async #controlRequest<T>(operation: string, request: () => Promise<T>): Promise<T> {
    const timeoutMs = this.#options.controlRequestTimeoutMs ?? ACP_CONTROL_REQUEST_TIMEOUT_MS;
    const timeoutError = new Error(`ACP ${operation} timed out after ${timeoutMs}ms`);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(request),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(timeoutError), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (error === timeoutError) await this.#invalidateConnection();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async #invalidateConnection(): Promise<void> {
    const child = this.#child;
    const hadConnection = Boolean(this.#connection || child);
    this.#approvalBroker.cancelAll();
    this.#connection = undefined;
    this.#child = undefined;
    this.#sessionRoots.clear();
    await terminateChild(child);
    if (hadConnection && !this.#closing) this.#options.onClose?.();
  }

  async #handleConnectionClosed(connection: acp.ClientSideConnection, child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.#connection !== connection) return;
    this.#connection = undefined;
    if (this.#child === child) this.#child = undefined;
    this.#sessionRoots.clear();
    await terminateChild(child);
    if (!this.#closing) this.#options.onClose?.();
  }

  #mcpServers(canonicalCwd: string): Promise<acp.McpServer[]> {
    return this.#options.mcpServers?.(canonicalCwd) ?? Promise.resolve([]);
  }

  async #readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const readable = await this.#readablePath(params.sessionId, params.path);
    if (!readable.backgroundTaskOutput && params.line == null && params.limit == null) {
      const info = await stat(readable.path);
      if (!info.isFile() || info.size > MAX_BACKGROUND_OUTPUT_BYTES) {
        throw new Error(`ACP text file exceeds ${MAX_BACKGROUND_OUTPUT_BYTES} bytes`);
      }
      const result = await readBoundedUtf8(readable.path, MAX_BACKGROUND_OUTPUT_BYTES);
      if (result.truncated) throw new Error(`ACP text file exceeds ${MAX_BACKGROUND_OUTPUT_BYTES} bytes`);
      return { content: result.content };
    }
    const start = Math.max(0, (params.line ?? 1) - 1);
    if (!readable.backgroundTaskOutput) {
      return {
        content: await readUtf8LinesBounded(
          readable.path,
          start,
          params.limit == null ? undefined : Math.max(0, Math.trunc(params.limit)),
          MAX_BACKGROUND_OUTPUT_BYTES,
        ),
      };
    }
    const content = (await readBoundedUtf8(readable.path, MAX_BACKGROUND_OUTPUT_BYTES)).content;
    const limit = readable.backgroundTaskOutput
      ? Math.min(MAX_BACKGROUND_OUTPUT_LINES, Math.max(0, params.limit ?? MAX_BACKGROUND_OUTPUT_LINES))
      : params.limit;
    const lines = content.split(/\r?\n/);
    const selected = lines.slice(start, limit == null ? undefined : start + limit);
    const truncated = readable.backgroundTaskOutput && start + selected.length < lines.length;
    return { content: `${selected.join("\n")}${truncated ? "\n[output truncated]" : ""}` };
  }

  async #writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    const path = await this.#writableWorkspacePath(params.sessionId, params.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, params.content, "utf8");
    return {};
  }

  #workspaceRequest(sessionId: string, path: string): { root: string; resolved: string } {
    if (!isAbsolute(path)) throw new Error("ACP file paths must be absolute");
    const root = this.#sessionRoots.get(sessionId);
    if (!root) throw new Error(`Unknown ACP session ${sessionId}`);
    const resolved = resolve(path);
    return { root, resolved };
  }

  async #readableWorkspacePath(sessionId: string, path: string): Promise<string> {
    const { root, resolved } = this.#workspaceRequest(sessionId, path);
    const canonical = await realpath(resolved);
    this.#assertWorkspacePath(root, canonical);
    return canonical;
  }

  async #writableWorkspacePath(sessionId: string, path: string): Promise<string> {
    const { root, resolved } = this.#workspaceRequest(sessionId, path);
    let ancestor = resolved;
    while (true) {
      try {
        const canonical = await realpath(ancestor);
        this.#assertWorkspacePath(root, canonical);
        return resolve(canonical, relative(ancestor, resolved));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        let missing = false;
        try {
          await lstat(ancestor);
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError;
          missing = true;
        }
        if (!missing) throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  #assertWorkspacePath(root: string, path: string): void {
    const rel = relative(root, path);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path is outside workspace: ${path}`);
  }

  async #readablePath(sessionId: string, path: string): Promise<{ path: string; backgroundTaskOutput: boolean }> {
    try {
      return { path: await this.#readableWorkspacePath(sessionId, path), backgroundTaskOutput: false };
    } catch (workspaceError) {
      if (!this.#options.kimiCodeHome || !this.#sessionRoots.has(sessionId)) throw workspaceError;
      try {
        const sessions = await realpath(join(resolve(this.#options.kimiCodeHome), "sessions"));
        const resolved = await realpath(path);
        const rel = relative(sessions, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) throw workspaceError;
        const parts = rel.split(/[\\/]+/);
        if (parts.length !== 7
          || parts[1]?.toLowerCase() !== sessionId.toLowerCase()
          || parts[2]?.toLowerCase() !== "agents"
          || !parts[3]
          || parts[4]?.toLowerCase() !== "tasks"
          || !parts[5]
          || parts[6]?.toLowerCase() !== "output.log") throw workspaceError;
        const info = await stat(resolved);
        if (!info.isFile() || info.size > MAX_BACKGROUND_OUTPUT_BYTES) throw workspaceError;
        return { path: resolved, backgroundTaskOutput: true };
      } catch {
        throw workspaceError;
      }
    }
  }
}

async function readBoundedUtf8(path: string, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > maxBytes;
    const content = buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString("utf8");
    return { content: `${content}${truncated ? "\n[output truncated]" : ""}`, truncated };
  } finally {
    await file.close();
  }
}

async function readUtf8LinesBounded(
  path: string,
  startLine: number,
  limit: number | undefined,
  maxBytes: number,
): Promise<string> {
  if (limit === 0) return "";
  const file = await open(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1_024);
  const output: Buffer[] = [];
  let outputBytes = 0;
  let selectedLines = 0;
  let line = 0;
  let current: Buffer[] = [];
  let currentBytes = 0;
  const endLine = limit == null ? Number.POSITIVE_INFINITY : startLine + limit;
  const selecting = () => line >= startLine && line < endLine;
  const append = (value: Buffer) => {
    if (!value.length) return;
    if (outputBytes + currentBytes + value.length > maxBytes) {
      throw new Error(`ACP text file selection exceeds ${maxBytes} bytes`);
    }
    current.push(Buffer.from(value));
    currentBytes += value.length;
  };
  const finishLine = () => {
    if (selecting()) {
      let value = currentBytes ? Buffer.concat(current, currentBytes) : Buffer.alloc(0);
      if (value.at(-1) === 13) value = value.subarray(0, -1);
      const separatorBytes = selectedLines > 0 ? 1 : 0;
      if (outputBytes + separatorBytes + value.length > maxBytes) {
        throw new Error(`ACP text file selection exceeds ${maxBytes} bytes`);
      }
      if (separatorBytes) output.push(Buffer.from("\n"));
      if (value.length) output.push(value);
      outputBytes += separatorBytes + value.length;
      selectedLines += 1;
    }
    current = [];
    currentBytes = 0;
    line += 1;
  };

  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("ACP text path is not a file");
    let position = 0;
    while (line < endLine) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) {
        finishLine();
        break;
      }
      position += bytesRead;
      let cursor = 0;
      while (cursor < bytesRead && line < endLine) {
        const newline = buffer.indexOf(10, cursor);
        if (newline < 0 || newline >= bytesRead) {
          if (selecting()) append(buffer.subarray(cursor, bytesRead));
          break;
        }
        if (selecting()) append(buffer.subarray(cursor, newline));
        finishLine();
        cursor = newline + 1;
      }
    }
    return Buffer.concat(output, outputBytes).toString("utf8");
  } finally {
    await file.close();
  }
}

async function terminateChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (process.platform === "win32" && child.pid) {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!await waitForExit(killer, CHILD_EXIT_GRACE_MS)) killer.kill();
  } else {
    child.kill("SIGTERM");
    if (!await waitForExit(child, CHILD_EXIT_GRACE_MS)) child.kill("SIGKILL");
  }
  await waitForExit(child, CHILD_EXIT_GRACE_MS);
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("error", finish);
      resolve(child.exitCode !== null || child.signalCode !== null);
    };
    timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
    child.once("error", finish);
  });
}
