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
  home: string;
};

export type AuthEvent =
  | { type: "progress"; operation: "install" | "login"; message: string; url?: string; code?: string }
  | { type: "complete"; operation: "install" | "login" | "logout"; success: boolean; authenticated: boolean; message: string };

const credentialPath = (home: string) => join(home, "credentials", "kimi-code.json");

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
  #operation: "install" | "login" | undefined;

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
      installRunning: this.#operation === "install",
      home: this.home,
    };
  }

  beginInstall(): AuthStatus {
    if (process.platform !== "win32") throw new Error("Automatic Kimi CLI installation is currently available on Windows only");
    if (existsSync(this.binary)) throw new Error("Kimi Code CLI is already installed");
    return this.start("install", "powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", "Invoke-RestMethod https://code.kimi.com/install.ps1 | Invoke-Expression",
    ]);
  }

  beginLogin(): AuthStatus {
    if (!existsSync(this.binary)) throw new Error("Install Kimi Code CLI before signing in");
    return this.start("login", this.binary, ["login"]);
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

  close(): void {
    this.cancel();
  }

  private start(operation: "install" | "login", command: string, args: string[]): AuthStatus {
    if (this.#child) throw new Error("A Kimi setup operation is already running");
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

  private finish(operation: "install" | "login", success: boolean, message: string): void {
    if (!this.#child || this.#operation !== operation) return;
    this.#child = undefined;
    this.#operation = undefined;
    const authenticated = hasKimiCredentials(this.home);
    const completed = operation === "install" ? success && existsSync(this.binary) : success && authenticated;
    this.onEvent({ type: "complete", operation, success: completed, authenticated, message });
  }
}
