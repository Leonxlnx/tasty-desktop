import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

const TERMINATION_GRACE_MS = 5_000;
const WINDOWS_TREE_KILL_ATTEMPTS = 2;

export type TerminalEvent = {
  sessionId: string;
  type: "stdout" | "stderr" | "exit";
  text?: string;
  code?: number | null;
};

export type TerminalSessionInfo = { sessionId: string; cwd: string; shell: string };

type TerminalSession = TerminalSessionInfo & {
  child: ChildProcessWithoutNullStreams;
  emit: (event: TerminalEvent) => void;
  closed: boolean;
  stopping?: Promise<void>;
  terminationFailed?: boolean;
};

export class TerminalService {
  readonly #sessions = new Map<string, TerminalSession>();

  get activeCount(): number {
    return this.#sessions.size;
  }

  start(cwd: string, emit: (event: TerminalEvent) => void): TerminalSessionInfo {
    // ponytail: Upgrade to a PTY dependency only when full-screen interactive terminal apps are a real requirement.
    const sessionId = randomUUID();
    const resolvedCwd = resolve(cwd);
    const windows = process.platform === "win32";
    const shell = windows ? "PowerShell" : process.env.SHELL ?? "/bin/sh";
    const child = windows
      ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], terminalOptions(resolvedCwd, false))
      : spawn(shell, [], terminalOptions(resolvedCwd, true));
    const session: TerminalSession = { sessionId, cwd: resolvedCwd, shell, child, emit, closed: false };
    this.#sessions.set(sessionId, session);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => emit({ sessionId, type: "stdout", text }));
    child.stderr.on("data", (text: string) => emit({ sessionId, type: "stderr", text }));
    child.on("error", (error) => emit({ sessionId, type: "stderr", text: `${error.message}\n` }));
    child.on("exit", (code) => {
      emit({ sessionId, type: "exit", code });
    });
    child.on("close", () => {
      session.closed = true;
      if (!session.stopping && !session.terminationFailed) this.#sessions.delete(sessionId);
    });

    return { sessionId, cwd: resolvedCwd, shell };
  }

  write(sessionId: string, command: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.child.killed || !session.child.stdin.writable) throw new Error("Terminal session is no longer running");
    session.child.stdin.write(`${command}\n`);
  }

  stop(sessionId: string): Promise<void> {
    const session = this.#sessions.get(sessionId);
    if (!session) return Promise.resolve();
    if (session.stopping) return session.stopping;
    if (session.terminationFailed) return Promise.resolve();
    const stopping = terminateTree(session).catch((error: unknown) => {
      session.emit({ sessionId, type: "stderr", text: `Could not terminate terminal process tree: ${error instanceof Error ? error.message : String(error)}\n` });
      return false;
    }).then((secured) => {
      if (secured) this.#sessions.delete(sessionId);
      else session.terminationFailed = true;
    }).finally(() => {
      delete session.stopping;
    });
    session.stopping = stopping;
    return stopping;
  }

  async close(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((sessionId) => this.stop(sessionId)));
  }
}

function terminalOptions(cwd: string, detached: boolean) {
  return {
    cwd,
    detached,
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
    windowsHide: true,
    stdio: "pipe" as const,
  };
}

async function terminateTree(session: TerminalSession): Promise<boolean> {
  const { child } = session;
  if (hasExited(child)) return waitForClose(session, TERMINATION_GRACE_MS);
  const treeStopped = process.platform === "win32"
    ? await terminateWindowsTree(child)
    : await terminatePosixTree(child);
  child.stdin.destroy();
  const exited = await waitForExit(child, TERMINATION_GRACE_MS);
  const closed = await waitForClose(session, TERMINATION_GRACE_MS);
  return treeStopped && exited && closed;
}

export async function terminateWindowsTree(child: ChildProcess): Promise<boolean> {
  if (hasExited(child)) return true;
  if (!child.pid) return false;
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  for (let attempt = 0; attempt < WINDOWS_TREE_KILL_ATTEMPTS; attempt += 1) {
    if (hasExited(child)) return true;
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!await waitForExit(killer, TERMINATION_GRACE_MS)) {
      if (!hasExited(killer)) killer.kill("SIGKILL");
      await waitForExit(killer, TERMINATION_GRACE_MS);
    } else if (killer.exitCode === 0) {
      return true;
    }
    if (hasExited(child)) return true;
  }
  return waitForExit(child, TERMINATION_GRACE_MS);
}

async function terminatePosixTree(child: ChildProcess): Promise<boolean> {
  const pid = child.pid;
  if (!pid || hasExited(child)) return false;
  signalGroup(pid, "SIGTERM");
  if (await waitForGroupExit(pid, TERMINATION_GRACE_MS)) return true;
  signalGroup(pid, "SIGKILL");
  return waitForGroupExit(pid, TERMINATION_GRACE_MS);
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (groupExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !groupExists(pid);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      child.off("exit", finish);
      child.off("error", finish);
      resolve(hasExited(child));
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("exit", finish);
    child.once("error", finish);
  });
}

async function waitForClose(session: TerminalSession, timeoutMs: number): Promise<boolean> {
  if (session.closed) return true;
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      session.child.off("close", close);
      resolve(session.closed);
    };
    const close = () => finish();
    const timer = setTimeout(finish, timeoutMs);
    session.child.once("close", close);
  });
}
