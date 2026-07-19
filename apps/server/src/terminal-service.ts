import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

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
};

export class TerminalService {
  readonly #sessions = new Map<string, TerminalSession>();

  start(cwd: string, emit: (event: TerminalEvent) => void): TerminalSessionInfo {
    // ponytail: Upgrade to a PTY dependency only when full-screen interactive terminal apps are a real requirement.
    const sessionId = randomUUID();
    const resolvedCwd = resolve(cwd);
    const windows = process.platform === "win32";
    const shell = windows ? "PowerShell" : process.env.SHELL ?? "/bin/sh";
    const child = windows
      ? spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"], terminalOptions(resolvedCwd))
      : spawn(shell, [], terminalOptions(resolvedCwd));
    const session = { sessionId, cwd: resolvedCwd, shell, child, emit };
    this.#sessions.set(sessionId, session);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => emit({ sessionId, type: "stdout", text }));
    child.stderr.on("data", (text: string) => emit({ sessionId, type: "stderr", text }));
    child.on("error", (error) => emit({ sessionId, type: "stderr", text: `${error.message}\n` }));
    child.on("exit", (code) => {
      this.#sessions.delete(sessionId);
      emit({ sessionId, type: "exit", code });
    });

    return { sessionId, cwd: resolvedCwd, shell };
  }

  write(sessionId: string, command: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session || session.child.killed || !session.child.stdin.writable) throw new Error("Terminal session is no longer running");
    session.child.stdin.write(`${command}\n`);
  }

  stop(sessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) return;
    this.#sessions.delete(sessionId);
    session.child.stdin.end();
    if (!session.child.killed) session.child.kill();
  }

  close(): void {
    for (const sessionId of [...this.#sessions.keys()]) this.stop(sessionId);
  }
}

function terminalOptions(cwd: string) {
  return {
    cwd,
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1" },
    windowsHide: true,
    stdio: "pipe" as const,
  };
}
