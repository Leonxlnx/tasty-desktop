import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { ProviderId } from "./orchestration.js";

export type ProviderDescriptor = {
  id: "kimi";
  name: string;
  protocol: "acp";
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

export type ProviderInstance = { id: string; name: string; provider: "kimi"; binary?: string; environment: Record<string, string>; wsl?: { distribution: string; binary: string } };

const instanceEnvironmentKeys = new Set(["KIMI_CODE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]);

export const historicalProviderChatMessage = "This is a historical provider chat. Start a Kimi chat to continue.";

const providerNames: Record<ProviderId, string> = {
  kimi: "Kimi",
  codex: "OpenAI Codex",
  claude: "Anthropic Claude",
  cursor: "Cursor",
  opencode: "OpenCode",
};

const kimiCapabilities: ProviderCapabilities = {
  models: true, reasoning: true, permissions: true, commands: true, images: true, quota: true,
  skills: "native", mcp: "native", plugins: "native",
  subagents: { activity: true, inspect: false, stop: false, steer: false },
};

export function providerDescriptors(): ProviderDescriptor[] {
  const binary = resolveProviderBinary("kimi");
  return [{
    id: "kimi",
    name: "Kimi",
    protocol: "acp",
    installed: Boolean(binary),
    ...(binary ? { binary } : {}),
    installUrl: "https://moonshotai.github.io/kimi-code/",
    capabilities: kimiCapabilities,
  }];
}

export function providerName(id: ProviderId): string {
  return providerNames[id];
}

export function resolveProviderBinary(id: ProviderId, configured?: string): string | undefined {
  if (id !== "kimi") return undefined;
  if (configured) return isAbsolute(configured) && existsSync(configured) ? resolve(configured) : undefined;
  const env = process.env.KIMI_BINARY;
  if (env) {
    const binary = resolve(env);
    return existsSync(binary) ? binary : undefined;
  }
  const candidate = process.platform === "win32" ? join(homedir(), ".kimi-code", "bin", "kimi.exe") : join(homedir(), ".kimi-code", "bin", "kimi");
  return existsSync(candidate) ? resolve(candidate) : undefined;
}

export function requireProviderBinary(id: ProviderId, configured?: string): string {
  assertKimiProvider(id);
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
  return parsed.flatMap((value, index): ProviderInstance[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Provider instance ${index + 1} must be an object`);
    const item = value as Record<string, unknown>;
    if (typeof item.provider === "string" && item.provider !== "kimi") return [];
    const id = typeof item.id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(item.id) ? item.id : undefined;
    const name = typeof item.name === "string" ? item.name.trim().slice(0, 80) : "";
    if (!id || item.provider !== "kimi" || !name || seen.has(id)) throw new Error(`Provider instance ${index + 1} has an invalid or duplicate id, name, or provider`);
    seen.add(id);
    const binary = typeof item.binary === "string" ? item.binary : undefined;
    if (binary && (!isAbsolute(binary) || !existsSync(binary))) throw new Error(`Provider instance ${id} binary must be an existing absolute path`);
    const wslValue = item.wsl && typeof item.wsl === "object" && !Array.isArray(item.wsl) ? item.wsl as Record<string, unknown> : undefined;
    const wsl = wslValue && typeof wslValue.distribution === "string" && /^[\w.-]{1,80}$/.test(wslValue.distribution) && typeof wslValue.binary === "string" && wslValue.binary.startsWith("/")
      ? { distribution: wslValue.distribution, binary: wslValue.binary }
      : undefined;
    if (item.wsl && !wsl) throw new Error(`Provider instance ${id} has an invalid WSL runtime`);
    if (binary && wsl) throw new Error(`Provider instance ${id} cannot combine Windows and WSL binaries`);
    const environment = item.environment && typeof item.environment === "object" && !Array.isArray(item.environment) ? Object.fromEntries(Object.entries(item.environment).map(([key, value]) => {
      if (!instanceEnvironmentKeys.has(key) || typeof value !== "string" || !isAbsolute(value)) throw new Error(`Provider instance ${id} environment values must be allowed absolute provider-owned paths`);
      return [key, resolve(value)];
    })) : {};
    return [{ id, name, provider: "kimi", ...(binary ? { binary: resolve(binary) } : {}), environment, ...(wsl ? { wsl } : {}) }];
  });
}

export function assertKimiProvider(provider: ProviderId): asserts provider is "kimi" {
  if (provider !== "kimi") throw new Error(historicalProviderChatMessage);
}
