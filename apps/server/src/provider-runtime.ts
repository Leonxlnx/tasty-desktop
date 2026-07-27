import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
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

const providerNames: Record<ProviderId, string> = {
  kimi: "Kimi",
  codex: "OpenAI Codex",
  claude: "Anthropic Claude",
  cursor: "Cursor",
};

const installUrls: Record<ProviderId, string> = {
  kimi: "https://moonshotai.github.io/kimi-code/",
  codex: "https://developers.openai.com/codex/cli/",
  claude: "https://docs.anthropic.com/en/docs/claude-code/overview",
  cursor: "https://cursor.com/cli",
};

const capabilities: Record<ProviderId, ProviderCapabilities> = {
  kimi: { models: true, reasoning: true, permissions: true, commands: true, images: true, quota: true, skills: "native", mcp: "native", plugins: "native", subagents: { activity: true, inspect: false, stop: false, steer: false } },
  codex: { models: true, reasoning: true, permissions: true, commands: false, images: true, quota: false, skills: "none", mcp: "runtime", plugins: "none", subagents: { activity: true, inspect: true, stop: true, steer: false } },
  claude: { models: true, reasoning: true, permissions: true, commands: false, images: false, quota: false, skills: "none", mcp: "runtime", plugins: "none", subagents: { activity: true, inspect: false, stop: false, steer: false } },
  cursor: { models: true, reasoning: true, permissions: true, commands: false, images: true, quota: false, skills: "none", mcp: "runtime", plugins: "none", subagents: { activity: true, inspect: false, stop: false, steer: false } },
};

export function providerDescriptors(): ProviderDescriptor[] {
  return (["kimi", "codex", "claude", "cursor"] as const).map((id) => {
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

export function resolveProviderBinary(id: ProviderId): string | undefined {
  const env = process.env[`${id.toUpperCase()}_BINARY`];
  if (env) {
    const binary = resolve(env);
    return existsSync(binary) ? binary : undefined;
  }
  if (id === "kimi") {
    const candidate = process.platform === "win32" ? join(homedir(), ".kimi-code", "bin", "kimi.exe") : join(homedir(), ".kimi-code", "bin", "kimi");
    return existsSync(candidate) ? resolve(candidate) : undefined;
  }
  return findExecutable(id === "codex" ? "codex" : id === "claude" ? "claude" : "cursor-agent");
}

export function requireProviderBinary(id: ProviderId): string {
  const binary = resolveProviderBinary(id);
  if (!binary) throw new Error(`${providerName(id)} CLI is not installed`);
  return binary;
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
