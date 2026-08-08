import { existsSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export type AuthStatus = {
  installed: boolean;
  authenticated: boolean;
  loginRunning: boolean;
  installRunning: boolean;
  installMode: "manual";
  installUrl: string;
  home: string;
};

export type AuthEvent =
  | { type: "progress"; operation: "login"; message: string; url?: string; code?: string }
  | { type: "complete"; operation: "login" | "logout"; success: boolean; authenticated: boolean; message: string };

export const KIMI_INSTALL_URL = "https://moonshotai.github.io/kimi-code/";

const credentialPath = (home: string) => join(home, "credentials", "kimi-code.json");
const AUTH_PROCESS_CLOSE_TIMEOUT_MS = 2_000;

type ClosableAuthProcess = Pick<
  ChildProcessWithoutNullStreams,
  "exitCode" | "signalCode" | "kill"
> & Pick<NodeJS.EventEmitter, "once" | "removeListener">;

function hasAuthProcessExited(child: ClosableAuthProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

export function terminateAuthProcess(
  child: ClosableAuthProcess,
  timeoutMs = AUTH_PROCESS_CLOSE_TIMEOUT_MS,
): Promise<void> {
  if (hasAuthProcessExited(child)) return Promise.resolve();

  return new Promise<void>((resolveClose, rejectClose) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.removeListener("close", onClosed);
      child.removeListener("exit", onExited);
      child.removeListener("error", onError);
    };
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveClose();
    };
    const rejectOnce = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectClose(new Error(message));
    };
    const onClosed = () => resolveOnce();
    const onExited = () => resolveOnce();
    const onError = () => rejectOnce("Kimi login process failed while stopping");

    child.once("close", onClosed);
    child.once("exit", onExited);
    child.once("error", onError);
    timer = setTimeout(
      () => rejectOnce(`Kimi login process did not stop within ${timeoutMs}ms`),
      timeoutMs,
    );

    try {
      const signalled = child.kill();
      if (!signalled) {
        if (hasAuthProcessExited(child)) resolveOnce();
        else rejectOnce("Kimi login process could not be signalled to stop");
      }
    } catch {
      rejectOnce("Kimi login process could not be signalled to stop");
    }
  });
}

export function hasKimiCredentials(home: string): boolean {
  const path = credentialPath(home);
  return existsSync(path) && statSync(path).isFile() && statSync(path).size > 0;
}

export function clearKimiCredentials(home: string): void {
  const path = credentialPath(home);
  if (existsSync(path)) unlinkSync(path);
}

export function parseLoginLine(line: string): { message: string; url?: string; code?: string } {
  const url = line.match(/https?:\/\/[^\s<>]+/i)?.[0]?.replace(/[),.;]+$/, "");
  const labelledCode = line.match(/(?:code|token)\s*[:=]\s*([A-Z0-9][A-Z0-9-]{3,})/i)?.[1];
  const dashedCode = line.match(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+\b/i)?.[0];
  const code = labelledCode ?? dashedCode;
  return { message: line, ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

export class AuthService {
  readonly home: string;
  #child: ChildProcessWithoutNullStreams | undefined;
  #operation: "login" | undefined;

  constructor(
    private readonly binary: string,
    kimiCodeHome: string | undefined,
    private readonly onEvent: (event: AuthEvent) => void,
  ) {
    this.home = resolve(kimiCodeHome ?? join(homedir(), ".kimi-code"));
  }

  status(): AuthStatus {
    return {
      installed: existsSync(this.binary),
      authenticated: hasKimiCredentials(this.home),
      loginRunning: this.#operation === "login",
      installRunning: false,
      installMode: "manual",
      installUrl: KIMI_INSTALL_URL,
      home: this.home,
    };
  }

  beginInstall(): AuthStatus {
    return this.status();
  }

  beginLogin(): AuthStatus {
    if (!existsSync(this.binary)) throw new Error("Install Kimi Code CLI before signing in");
    return this.start(this.binary, ["login"]);
  }

  logout(): AuthStatus {
    if (this.#child) throw new Error("Cancel the current setup operation before logging out");
    clearKimiCredentials(this.home);
    const status = this.status();
    this.onEvent({ type: "complete", operation: "logout", success: !status.authenticated, authenticated: status.authenticated, message: "Logged out. Sessions and settings were preserved." });
    return status;
  }

  cancel(): void {
    this.#child?.kill();
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    await terminateAuthProcess(child);
  }

  private start(command: string, args: string[]): AuthStatus {
    if (this.#child) throw new Error("A Kimi setup operation is already running");
    const operation = "login";
    const child = spawn(command, args, {
      env: { ...process.env, KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CODE_HOME: this.home },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#operation = operation;
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => this.onEvent({ type: "progress", operation, ...parseLoginLine(line) }));
    }
    child.once("error", (error) => this.finish(operation, false, error.message));
    child.once("exit", (code, signal) => this.finish(operation, code === 0, signal ? `${operation} stopped by ${signal}` : `${operation} exited with code ${code ?? "unknown"}`));
    return this.status();
  }

  private finish(operation: "login", success: boolean, message: string): void {
    if (!this.#child || this.#operation !== operation) return;
    this.#child = undefined;
    this.#operation = undefined;
    const authenticated = hasKimiCredentials(this.home);
    const completed = success && authenticated;
    this.onEvent({ type: "complete", operation, success: completed, authenticated, message });
  }
}
