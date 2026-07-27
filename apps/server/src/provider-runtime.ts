import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ProviderId } from "./orchestration.js";

export type ProviderDescriptor = {
  id: ProviderId;
  name: string;
  protocol: "acp" | "app-server" | "stream-json";
  installed: boolean;
  binary?: string;
  installUrl: string;
  capabilities: ProviderCapabilities;
};

export type ProviderCapabilities = {
  models: boolean; reasoning: boolean; permissions: boolean; commands: boolean; images: boolean; quota: boolean;
  skills: "native" | "none"; mcp: "native" | "runtime" | "none"; plugins: "native" | "none";
  subagents: { activity: boolean; inspect: boolean; stop: boolean; steer: boolean };
};

export type ProviderInstance = { id: string; name: string; provider: ProviderId; binary?: string; environment: Record<string, string>; wsl?: { distribution: string; binary: string } };

const instanceEnvironmentKeys = new Set(["KIMI_CODE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]);

const providerNames: Record<ProviderId, string> = {
  kimi: "Kimi",
  codex: "OpenAI Codex",
  claude: "Anthropic Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const installUrls: Record<ProviderId, string> = {
  kimi: "https://moonshotai.github.io/kimi-code/",
  codex: "https://developers.openai.com/codex/cli/",
  claude: "https://docs.anthropic.com/en/docs/claude-code/overview",
  cursor: "https://cursor.com/cli",
  opencode: "https://opencode.ai/docs/",
};

const capabilities: Record<ProviderId, ProviderCapabilities> = {
  kimi: { models: true, reasoning: true, permissions: true, commands: true, images: true, quota: true, skills: "native", mcp: "native", plugins: "native", subagents: { activity: true, inspect: false, stop: false, steer: false } },
  codex: { models: true, reasoning: true, permissions: true, commands: false, images: true, quota: false, skills: "none", mcp: "runtime", plugins: "none", subagents: { activity: true, inspect: true, stop: true, steer: false } },
  claude: { models: true, reasoning: true, permissions: true, commands: false, images: false, quota: false, skills: "none", mcp: "runtime", plugins: "none", subagents: { activity: true, inspect: false, stop: false, steer: false } },
  cursor: { models: true, reasoning: true, permissions: true, commands: false, images: true, quota: false, skills: "none", mcp: "runtime", plugins: "none", subagents: { activity: true, inspect: false, stop: false, steer: false } },
  opencode: { models: true, reasoning: true, permissions: true, commands: true, images: true, quota: false, skills: "none", mcp: "native", plugins: "native", subagents: { activity: true, inspect: false, stop: false, steer: false } },
};

export function providerDescriptors(): ProviderDescriptor[] {
  return (["kimi", "codex", "claude", "cursor", "opencode"] as const).map((id) => {
    const binary = resolveProviderBinary(id);
    return {
      id,
      name: providerNames[id],
      protocol: id === "codex" ? "app-server" : id === "claude" ? "stream-json" : "acp",
      installed: Boolean(binary),
      ...(binary ? { binary } : {}),
      installUrl: installUrls[id],
      capabilities: capabilities[id],
    };
  });
}

export function providerName(id: ProviderId): string {
  return providerNames[id];
}

export function resolveProviderBinary(id: ProviderId, configured?: string): string | undefined {
  if (configured) return isAbsolute(configured) && existsSync(configured) ? resolve(configured) : undefined;
  const env = process.env[`${id.toUpperCase()}_BINARY`];
  if (env) {
    const binary = resolve(env);
    return existsSync(binary) ? binary : undefined;
  }
  if (id === "kimi") {
    const candidate = process.platform === "win32" ? join(homedir(), ".kimi-code", "bin", "kimi.exe") : join(homedir(), ".kimi-code", "bin", "kimi");
    return existsSync(candidate) ? resolve(candidate) : undefined;
  }
  return findExecutable(id === "codex" ? "codex" : id === "claude" ? "claude" : id === "cursor" ? "cursor-agent" : "opencode");
}

export function requireProviderBinary(id: ProviderId, configured?: string): string {
  const binary = resolveProviderBinary(id, configured);
  if (!binary) throw new Error(`${providerName(id)} CLI is not installed`);
  return binary;
}

export async function readProviderInstances(path: string): Promise<ProviderInstance[]> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Provider instances are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("Provider instances must be a JSON array");
  const seen = new Set<string>();
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Provider instance ${index + 1} must be an object`);
    const item = value as Record<string, unknown>;
    const id = typeof item.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(item.id) ? item.id : undefined;
    const provider = typeof item.provider === "string" && Object.hasOwn(providerNames, item.provider) ? item.provider as ProviderId : undefined;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 80) : "";
    if (!id || !provider || !name || seen.has(id)) throw new Error(`Provider instance ${index + 1} has an invalid or duplicate id, name, or provider`);
    seen.add(id);
    const binary = typeof item.binary === "string" ? item.binary : undefined;
    if (binary && (!isAbsolute(binary) || !existsSync(binary))) throw new Error(`Provider instance ${id} binary must be an existing absolute path`);
    const wslValue = item.wsl && typeof item.wsl === "object" && !Array.isArray(item.wsl) ? item.wsl as Record<string, unknown> : undefined;
    const wsl = wslValue && typeof wslValue.distribution === "string" && /^[\w.-]{1,80}$/.test(wslValue.distribution) && typeof wslValue.binary === "string" && wslValue.binary.startsWith("/")
      ? { distribution: wslValue.distribution, binary: wslValue.binary }
      : undefined;
    if (item.wsl && (!wsl || provider === "codex" || provider === "claude")) throw new Error(`Provider instance ${id} has an invalid or unsupported WSL runtime`);
    if (binary && wsl) throw new Error(`Provider instance ${id} cannot combine Windows and WSL binaries`);
    const environment = item.environment && typeof item.environment === "object" && !Array.isArray(item.environment) ? Object.fromEntries(Object.entries(item.environment).map(([key, value]) => {
      if (!instanceEnvironmentKeys.has(key) || typeof value !== "string" || !isAbsolute(value)) throw new Error(`Provider instance ${id} environment values must be allowed absolute provider-owned paths`);
      return [key, resolve(value)];
    })) : {};
    return { id, name, provider, ...(binary ? { binary: resolve(binary) } : {}), environment, ...(wsl ? { wsl } : {}) };
  });
}

export function findExecutable(name: string): string | undefined {
  if (isAbsolute(name)) return existsSync(name) ? resolve(name) : undefined;
  const command = process.platform === "win32" ? "where.exe" : "which";
  const names = process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const candidate of names) {
    try {
      const output = execFileSync(command, [candidate], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      const path = output.split(/\r?\n/).find((line) => line && isAbsolute(line));
      if (path && existsSync(path)) return resolve(path);
    } catch {
      // Try the next platform-specific executable suffix.
    }
  }
  return undefined;
}
