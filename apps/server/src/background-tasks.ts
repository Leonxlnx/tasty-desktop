import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MAX_ACTIVE_BACKGROUND_TASKS = 20;
export const MAX_MONITORED_BACKGROUND_TASKS = 100;
export const MAX_BACKGROUND_OUTPUT_BYTES = 4 * 1_024 * 1_024;
export const BACKGROUND_TASK_EXPIRY_MS = 24 * 60 * 60 * 1_000;

const TASK_ID = /^(?:bash|agent)-[a-z0-9]+$/;
const TERMINAL_STATUSES = new Set(["completed", "failed", "killed", "lost", "timed_out"]);

export type BackgroundTaskCandidate = { taskId: string; description: string };
export type PendingBackgroundTask = {
  threadId: string;
  sessionId: string;
  taskId: string;
  registeredAt: string;
};
export type BackgroundTaskResult = {
  status: "completed" | "failed" | "killed" | "lost" | "timed_out" | "expired";
  description: string;
  endedAt?: number;
  exitCode?: number | null;
  outputPath?: string;
};

type CandidateTool = {
  turnId?: string;
  title?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
};

type KimiTaskRecord = {
  taskId?: unknown;
  description?: unknown;
  status?: unknown;
  detached?: unknown;
  endedAt?: unknown;
  exitCode?: unknown;
};

export function backgroundTaskCandidates(tools: CandidateTool[], turnId: string): BackgroundTaskCandidate[] {
  const completedInTurn = new Set<string>();
  for (const tool of tools) {
    if (tool.turnId !== turnId || typeof tool.rawOutput !== "string") continue;
    const taskId = tool.rawOutput.match(/^task_id:\s*((?:bash|agent)-[a-z0-9]+)\s*$/im)?.[1];
    const status = tool.rawOutput.match(/^status:\s*(completed|failed|killed|lost|timed_out)\s*$/im)?.[1];
    if (taskId && status) completedInTurn.add(taskId);
  }
  const found = new Map<string, BackgroundTaskCandidate>();
  for (const tool of tools) {
    if (tool.turnId !== turnId || !isRecord(tool.rawInput) || tool.rawInput.disable_timeout === true) continue;
    const output = typeof tool.rawOutput === "string" ? tool.rawOutput : "";
    if (!/^status:\s*(?:running|completed|failed|killed|lost|timed_out)\s*$/im.test(output)
      || !/^automatic_notification:\s*true\s*$/im.test(output)) continue;
    const taskId = output.match(/^task_id:\s*((?:bash|agent)-[a-z0-9]+)\s*$/im)?.[1];
    if (!taskId || !TASK_ID.test(taskId) || completedInTurn.has(taskId)) continue;
    const description = output.match(/^description:\s*(.+?)\s*$/im)?.[1] ?? tool.title ?? "Background task";
    found.set(taskId, { taskId, description: cleanDescription(description) });
  }
  return [...found.values()];
}

export async function readKimiBackgroundTask(kimiHome: string, sessionId: string, taskId: string): Promise<BackgroundTaskResult | { status: "running"; description: string } | undefined> {
  if (!safeSegment(sessionId) || !TASK_ID.test(taskId)) return undefined;
  let sessionsRoot: string;
  try {
    sessionsRoot = await realpath(join(resolve(kimiHome), "sessions"));
  } catch {
    return undefined;
  }
  const sessionDirectories = sessionId.startsWith("session_") ? [sessionId] : [sessionId, `session_${sessionId}`];
  const workspaces = await readdir(sessionsRoot, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ record: KimiTaskRecord; taskPath: string }> = [];
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    for (const sessionDirectory of sessionDirectories) {
      const sessionRoot = await realpath(join(sessionsRoot, workspace.name, sessionDirectory)).catch(() => undefined);
      if (!sessionRoot || !inside(sessionsRoot, sessionRoot) || basename(sessionRoot).toLowerCase() !== sessionDirectory.toLowerCase()) continue;
      const agentsRoot = join(sessionRoot, "agents");
      const agents = await readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
      for (const agent of agents) {
        if (!agent.isDirectory()) continue;
        const taskPath = await realpath(join(agentsRoot, agent.name, "tasks", `${taskId}.json`)).catch(() => undefined);
        if (!taskPath || !validTaskPath(sessionsRoot, taskPath, sessionDirectory, taskId)) continue;
        const info = await stat(taskPath).catch(() => undefined);
        if (!info?.isFile() || info.size > 64 * 1_024) continue;
        const record = await readTaskRecord(taskPath);
        if (!record || record.taskId !== taskId || record.detached !== true || typeof record.status !== "string") continue;
        matches.push({ record, taskPath });
      }
    }
  }
  if (matches.length !== 1) return undefined;
  const { record, taskPath } = matches[0]!;
  const description = cleanDescription(typeof record.description === "string" ? record.description : "Background task");
  if (!TERMINAL_STATUSES.has(String(record.status))) return record.status === "running" || record.status === "pending"
    ? { status: "running", description }
    : undefined;
  const outputPath = await safeOutputPath(sessionsRoot, taskPath, taskId);
  const result: BackgroundTaskResult = {
    status: record.status as BackgroundTaskResult["status"],
    description,
  };
  const endedAt = naturalTimestamp(record.endedAt);
  if (endedAt !== undefined) result.endedAt = endedAt;
  if (validExitCode(record.exitCode)) result.exitCode = record.exitCode;
  if (outputPath) result.outputPath = outputPath;
  return result;
}

export class BackgroundTaskMonitor {
  readonly #kimiHome: string;
  readonly #pending: () => PendingBackgroundTask[];
  readonly #finished: (task: PendingBackgroundTask, result: BackgroundTaskResult) => Promise<void>;
  readonly #onError: (error: unknown) => void;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #checking = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #wakeRequested = false;
  #closed = false;

  constructor(options: {
    kimiHome: string;
    pending: () => PendingBackgroundTask[];
    finished: (task: PendingBackgroundTask, result: BackgroundTaskResult) => Promise<void>;
    onError?: (error: unknown) => void;
    pollMs?: number;
    now?: () => number;
  }) {
    this.#kimiHome = options.kimiHome;
    this.#pending = options.pending;
    this.#finished = options.finished;
    this.#onError = options.onError ?? (() => undefined);
    this.#pollMs = options.pollMs ?? 2_000;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    this.#schedule(0);
  }

  wake(): void {
    if (this.#closed) return;
    if (this.#running) {
      this.#wakeRequested = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#schedule(0);
  }

  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#wakeRequested = false;
  }

  async checkNow(): Promise<void> {
    const pending = [...this.#pending()]
      .sort((left, right) => left.registeredAt.localeCompare(right.registeredAt)
        || left.threadId.localeCompare(right.threadId)
        || left.taskId.localeCompare(right.taskId))
      .slice(0, MAX_MONITORED_BACKGROUND_TASKS);
    for (const task of pending) {
      const key = `${task.sessionId}:${task.taskId}`;
      if (this.#checking.has(key)) continue;
      this.#checking.add(key);
      try {
        if (this.#now() - Date.parse(task.registeredAt) >= BACKGROUND_TASK_EXPIRY_MS) {
          await this.#finished(task, { status: "expired", description: "Background task" });
          continue;
        }
        const result = await readKimiBackgroundTask(this.#kimiHome, task.sessionId, task.taskId);
        if (result && result.status !== "running") await this.#finished(task, result);
      } catch (error) {
        this.#onError(error);
      } finally {
        this.#checking.delete(key);
      }
    }
  }

  #schedule(delay: number): void {
    if (this.#closed || this.#timer || this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = true;
      void this.checkNow()
        .catch(this.#onError)
        .finally(() => {
          this.#running = false;
          if (this.#closed) return;
          const nextDelay = this.#wakeRequested ? 0 : this.#pollMs;
          this.#wakeRequested = false;
          this.#schedule(nextDelay);
        });
    }, delay);
  }
}

async function readTaskRecord(path: string): Promise<KimiTaskRecord | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function safeOutputPath(sessionsRoot: string, taskPath: string, taskId: string): Promise<string | undefined> {
  const output = await realpath(join(dirname(taskPath), taskId, "output.log")).catch(() => undefined);
  if (!output || !inside(sessionsRoot, output)) return undefined;
  const info = await stat(output).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_BACKGROUND_OUTPUT_BYTES) return undefined;
  const taskParts = relative(sessionsRoot, taskPath).split(/[\\/]/);
  const parts = relative(sessionsRoot, output).split(/[\\/]/);
  return parts.length === 7
    && taskParts.length === 6
    && parts.slice(0, 5).every((part, index) => part.toLowerCase() === taskParts[index]?.toLowerCase())
    && parts[4]?.toLowerCase() === "tasks"
    && parts[5]?.toLowerCase() === taskId.toLowerCase()
    && parts[6]?.toLowerCase() === "output.log"
    ? output
    : undefined;
}

function validTaskPath(sessionsRoot: string, taskPath: string, sessionId: string, taskId: string): boolean {
  if (!inside(sessionsRoot, taskPath)) return false;
  const parts = relative(sessionsRoot, taskPath).split(/[\\/]/);
  return parts.length === 6
    && parts[1]?.toLowerCase() === sessionId.toLowerCase()
    && parts[2]?.toLowerCase() === "agents"
    && parts[4]?.toLowerCase() === "tasks"
    && parts[5]?.toLowerCase() === `${taskId}.json`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel));
}

function safeSegment(value: string): boolean {
  return value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/.test(value);
}

function cleanDescription(value: string): string {
  return sanitizeBackgroundTaskDescription(value);
}

export function sanitizeBackgroundTaskDescription(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\bBearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\b((?:api[_ -]?key|token|password|secret|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[redacted]")
    .replace(/\b(?:sk|pk)-[a-z0-9_-]{12,}\b/gi, "[redacted]")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240) || "Background task";
}

function naturalTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function validExitCode(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
