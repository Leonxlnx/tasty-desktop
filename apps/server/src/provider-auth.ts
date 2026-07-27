import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { ProviderId } from "./orchestration.js";
import { parseLoginLine, type AuthEvent } from "./auth-service.js";
import { providerName, resolveProviderBinary } from "./provider-runtime.js";

export type ProviderAuthStatus = {
  provider: Exclude<ProviderId, "kimi">;
  installed: boolean;
  authenticated: boolean | null;
  loginRunning: boolean;
  account?: string;
  message?: string;
};

type ExternalProvider = ProviderAuthStatus["provider"];
export type ProviderAuthEvent = AuthEvent & { provider: ExternalProvider };
type ProbeResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

export class ProviderAuthService {
  readonly #children = new Map<ExternalProvider, ChildProcessWithoutNullStreams>();

  constructor(private readonly onEvent: (event: ProviderAuthEvent) => void) {}

  async status(provider: ExternalProvider): Promise<ProviderAuthStatus> {
    const binary = resolveProviderBinary(provider);
    if (!binary) return { provider, installed: false, authenticated: false, loginRunning: false, message: `${providerName(provider)} CLI is not installed` };
    const result = await probe(binary, statusArgs(provider), 4_000);
    return parseProviderAuthStatus(provider, result, this.#children.has(provider));
  }

  beginLogin(provider: ExternalProvider): ProviderAuthStatus {
    const binary = resolveProviderBinary(provider);
    if (!binary) throw new Error(`Install ${providerName(provider)} CLI before signing in`);
    if (this.#children.has(provider)) throw new Error(`${providerName(provider)} sign-in is already running`);
    const child = spawnCli(binary, loginArgs(provider));
    this.#children.set(provider, child);
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => this.onLoginLine(provider, line));
    }
    child.once("error", (error) => this.finish(provider, false, error.message));
    child.once("exit", (code, signal) => this.finish(provider, code === 0, signal ? `Sign-in stopped by ${signal}` : `Sign-in exited with code ${code ?? "unknown"}`));
    return { provider, installed: true, authenticated: null, loginRunning: true };
  }

  cancel(provider: ExternalProvider): void {
    this.#children.get(provider)?.kill();
  }

  async logout(provider: ExternalProvider): Promise<ProviderAuthStatus> {
    if (this.#children.has(provider)) throw new Error(`Cancel ${providerName(provider)} sign-in before logging out`);
    const binary = resolveProviderBinary(provider);
    if (!binary) return { provider, installed: false, authenticated: false, loginRunning: false };
    const result = await probe(binary, logoutArgs(provider), 15_000);
    if (result.timedOut || result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `${providerName(provider)} logout failed`);
    const status = await this.status(provider);
    this.onEvent({ provider, type: "complete", operation: "logout", success: status.authenticated === false, authenticated: status.authenticated === true, message: "Logged out. Local Tasty threads were preserved." });
    return status;
  }

  close(): void {
    for (const child of this.#children.values()) child.kill();
    this.#children.clear();
  }

  private onLoginLine(provider: ExternalProvider, line: string): void {
    const parsed = parseLoginLine(line);
    this.onEvent({ provider, type: "progress", operation: "login", ...parsed });
  }

  private finish(provider: ExternalProvider, success: boolean, message: string): void {
    if (!this.#children.has(provider)) return;
    this.#children.delete(provider);
    void this.status(provider).then((status) => {
      const authenticated = status.authenticated === true;
      this.onEvent({ provider, type: "complete", operation: "login", success: success && authenticated, authenticated, message });
    }).catch((error) => {
      this.onEvent({ provider, type: "complete", operation: "login", success: false, authenticated: false, message: error instanceof Error ? error.message : String(error) });
    });
  }
}

export function parseProviderAuthStatus(provider: ExternalProvider, result: ProbeResult, loginRunning = false): ProviderAuthStatus {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (result.timedOut) return { provider, installed: true, authenticated: null, loginRunning, message: "Authentication check timed out" };
  if (provider === "codex") {
    const authenticated = /logged in|authenticated/i.test(combined) && !/not logged in|unauthenticated/i.test(combined);
    return { provider, installed: true, authenticated, loginRunning, ...(combined ? { message: combined } : {}) };
  }
  if (provider === "claude") {
    try {
      const value = JSON.parse(result.stdout) as Record<string, unknown>;
      const authenticated = value.loggedIn === true || value.authenticated === true;
      const account = typeof value.email === "string" ? value.email : undefined;
      return { provider, installed: true, authenticated, loginRunning, ...(account ? { account } : {}) };
    } catch {
      const authenticated = /logged in|authenticated/i.test(combined) && !/not logged in|unauthenticated/i.test(combined);
      return { provider, installed: true, authenticated: result.code === 0 ? authenticated || null : false, loginRunning, ...(combined ? { message: combined } : {}) };
    }
  }
  if (provider === "opencode") {
    const count = /\b(\d+)\s+credentials?\b/i.exec(combined)?.[1];
    return { provider, installed: true, authenticated: count && Number(count) > 0 ? true : result.code === 0 ? null : false, loginRunning, ...(combined ? { message: combined } : {}) };
  }
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    const account = typeof value.userEmail === "string" ? value.userEmail : undefined;
    const authenticated = Boolean(account && !/not logged in|login required/i.test(account));
    return { provider, installed: true, authenticated, loginRunning, ...(authenticated && account ? { account } : {}) };
  } catch {
    const email = /User Email\s+([^\r\n]+)/i.exec(combined)?.[1]?.trim();
    const authenticated = Boolean(email && !/not logged in|login required/i.test(email));
    return { provider, installed: true, authenticated: email ? authenticated : null, loginRunning, ...(authenticated && email ? { account: email } : {}), ...(combined ? { message: combined } : {}) };
  }
}

function statusArgs(provider: ExternalProvider): string[] {
  if (provider === "codex") return ["login", "status"];
  if (provider === "claude") return ["auth", "status", "--json"];
  if (provider === "opencode") return ["providers", "list"];
  return ["about", "--json"];
}

function loginArgs(provider: ExternalProvider): string[] {
  if (provider === "codex") return ["login", "--device-auth"];
  if (provider === "claude") return ["auth", "login"];
  if (provider === "opencode") return ["providers", "login"];
  return ["login"];
}

function logoutArgs(provider: ExternalProvider): string[] {
  if (provider === "codex") return ["logout"];
  if (provider === "claude") return ["auth", "logout"];
  if (provider === "opencode") return ["providers", "logout"];
  return ["logout"];
}

function spawnCli(binary: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(binary, args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: process.platform === "win32" && /\.cmd$/i.test(binary),
  });
}

function probe(binary: string, args: string[], timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawnCli(binary, args);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null, timedOut: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.slice(0, 20_000), stderr: stderr.slice(0, 20_000), timedOut });
    };
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => { stderr += error.message; finish(null, false); });
    child.once("exit", (code) => finish(code, false));
    const timer = setTimeout(() => { child.kill(); finish(null, true); }, timeoutMs);
    timer.unref();
  });
}
