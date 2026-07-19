import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";

export type KimiPlugin = {
  name: string;
  version: string;
  description: string;
  toolCount: number;
};

export type KimiMcpServer = {
  name: string;
  transport: "http" | "stdio" | "unknown";
  target: string;
  needsAuthorization: boolean;
  connectable: boolean;
};

export type KimiAgent = {
  name: "coder" | "explore" | "plan";
  description: string;
  access: string;
  supportsBackground: boolean;
};

export type KimiCapabilities = {
  plugins: KimiPlugin[];
  mcpServers: KimiMcpServer[];
  agents: KimiAgent[];
  roots: { plugins: string; mcp: string };
  warnings: string[];
  updatedAt: string;
};

const builtInAgents: KimiAgent[] = [
  {
    name: "coder",
    description: "General software engineering with workspace read, write, search, and shell tools.",
    access: "Read, write, shell",
    supportsBackground: true,
  },
  {
    name: "explore",
    description: "Fast read-only codebase exploration, search, and technical summaries.",
    access: "Read and search",
    supportsBackground: true,
  },
  {
    name: "plan",
    description: "Architecture analysis and implementation planning without changing files.",
    access: "Read and plan",
    supportsBackground: true,
  },
];

export async function readKimiCapabilities(shareDir: string): Promise<KimiCapabilities> {
  const pluginsRoot = join(shareDir, "plugins");
  const mcpPath = join(shareDir, "mcp.json");
  const warnings: string[] = [];
  const [plugins, mcp] = await Promise.all([
    readPlugins(pluginsRoot, warnings),
    readMcpConfig(mcpPath, warnings),
  ]);
  return {
    plugins,
    mcpServers: mcp.display,
    agents: builtInAgents.map((agent) => ({ ...agent })),
    roots: { plugins: pluginsRoot, mcp: mcpPath },
    warnings,
    updatedAt: new Date().toISOString(),
  };
}

export async function readKimiMcpServers(shareDir: string): Promise<McpServer[]> {
  return (await readMcpConfig(join(shareDir, "mcp.json"), [])).connectable;
}

async function readPlugins(root: string, warnings: string[]): Promise<KimiPlugin[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    warnings.push("Kimi's plugin directory could not be read.");
    return [];
  }

  const plugins = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map(async (entry) => {
      try {
        const parsed = JSON.parse(await readFile(join(root, entry.name, "plugin.json"), "utf8")) as Record<string, unknown>;
        if (typeof parsed.name !== "string" || typeof parsed.version !== "string") throw new Error("Invalid plugin manifest");
        return {
          name: parsed.name,
          version: parsed.version,
          description: typeof parsed.description === "string" ? parsed.description : "",
          toolCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
        } satisfies KimiPlugin;
      } catch {
        warnings.push(`Plugin '${entry.name}' has an unreadable manifest.`);
        return undefined;
      }
    }));
  return plugins.filter((plugin): plugin is KimiPlugin => Boolean(plugin)).sort((left, right) => left.name.localeCompare(right.name));
}

async function readMcpConfig(path: string, warnings: string[]): Promise<{ display: KimiMcpServer[]; connectable: McpServer[] }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissing(error)) return { display: [], connectable: [] };
    warnings.push("Kimi's MCP configuration could not be read.");
    return { display: [], connectable: [] };
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    warnings.push("Kimi's MCP configuration has an unsupported shape.");
    return { display: [], connectable: [] };
  }
  const display: KimiMcpServer[] = [];
  const connectable: McpServer[] = [];
  for (const [name, value] of Object.entries(parsed.mcpServers)) {
    if (!isRecord(value)) {
      display.push({ name, transport: "unknown", target: "Invalid configuration", needsAuthorization: false, connectable: false });
      warnings.push(`MCP server '${name}' has an invalid configuration.`);
      continue;
    }
    if (typeof value.url === "string") {
      const needsAuthorization = value.auth === "oauth";
      display.push({
        name,
        transport: "http",
        target: safeHttpTarget(value.url),
        needsAuthorization,
        connectable: !needsAuthorization,
      });
      if (needsAuthorization) {
        warnings.push(`MCP server '${name}' uses OAuth, which this ACP transport cannot attach without Kimi-native authorization support.`);
        continue;
      }
      const type = value.transport === "sse" ? "sse" : "http";
      connectable.push({ type, name, url: value.url, headers: stringEntries(value.headers).map(([headerName, headerValue]) => ({ name: headerName, value: headerValue })) });
      continue;
    }
    if (typeof value.command === "string") {
      display.push({
        name,
        transport: "stdio",
        target: basename(value.command),
        needsAuthorization: false,
        connectable: true,
      });
      connectable.push({
        name,
        command: value.command,
        args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [],
        env: stringEntries(value.env).map(([envName, envValue]) => ({ name: envName, value: envValue })),
      });
      continue;
    }
    display.push({ name, transport: "unknown", target: "Unknown transport", needsAuthorization: false, connectable: false });
    warnings.push(`MCP server '${name}' uses an unsupported transport.`);
  }
  display.sort((left, right) => left.name.localeCompare(right.name));
  connectable.sort((left, right) => left.name.localeCompare(right.name));
  return { display, connectable };
}

function safeHttpTarget(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "Configured HTTP server";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringEntries(value: unknown): Array<[string, string]> {
  return isRecord(value) ? Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string") : [];
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
