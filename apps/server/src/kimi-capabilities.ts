import { constants, copyFile, lstat, mkdir, mkdtemp, open, opendir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
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
  projectScoped?: true;
};

export type KimiSkill = {
  name: string;
  description: string;
  scope: "user" | "project";
  source: "kimi" | "agents";
  path: string;
  modelInvocable: boolean;
  hasSubSkills: boolean;
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
  skills: KimiSkill[];
  agents: KimiAgent[];
  roots: { plugins: string; mcp: string; skills: string };
  warnings: string[];
  updatedAt: string;
};

const skillReadLimit = 64 * 1024;
const skillInstallFileLimit = 256 * 1024;
const skillInstallBundleLimit = 20 * 1024 * 1024;
const skillInstallFileCountLimit = 500;
const skillInstallDirectoryCountLimit = 500;
const skillInstallDepthLimit = 16;
const skillDiscoveryEntryLimit = 1_000;
const skillInstallLockStaleMs = 10 * 60 * 1_000;
const skillNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

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

export async function readKimiCapabilities(kimiHome: string, cwd?: string, userHome = homedir()): Promise<KimiCapabilities> {
  const pluginsRoot = join(kimiHome, "plugins");
  const mcpPath = join(kimiHome, "mcp.json");
  const skillsRoot = join(kimiHome, "skills");
  const pluginWarnings: string[] = [];
  const mcpWarnings: string[] = [];
  const skillWarnings: string[] = [];
  const [plugins, mcp, skills] = await Promise.all([
    readPlugins(pluginsRoot, pluginWarnings),
    readMcpConfig(await mcpConfigPaths(kimiHome, cwd), mcpWarnings),
    readKimiSkills(kimiHome, cwd, userHome, skillWarnings),
  ]);
  return {
    plugins,
    mcpServers: mcp.display,
    skills,
    agents: builtInAgents.map((agent) => ({ ...agent })),
    roots: { plugins: pluginsRoot, mcp: mcpPath, skills: skillsRoot },
    warnings: [...pluginWarnings, ...mcpWarnings, ...skillWarnings],
    updatedAt: new Date().toISOString(),
  };
}

export async function readKimiMcpServers(kimiHome: string): Promise<McpServer[]> {
  return (await readMcpConfig([join(kimiHome, "mcp.json")], [])).connectable;
}

export async function readKimiSkills(kimiHome: string, cwd?: string, userHome = homedir(), warnings: string[] = []): Promise<KimiSkill[]> {
  const roots: Array<{ path: string; scope: KimiSkill["scope"]; source: KimiSkill["source"] }> = [
    { path: join(userHome, ".agents", "skills"), scope: "user", source: "agents" },
    { path: join(kimiHome, "skills"), scope: "user", source: "kimi" },
  ];
  if (cwd) {
    const projectRoot = await findProjectRoot(cwd);
    roots.push(
      { path: join(projectRoot, ".agents", "skills"), scope: "project", source: "agents" },
      { path: join(projectRoot, ".kimi-code", "skills"), scope: "project", source: "kimi" },
    );
  }

  const skills = new Map<string, KimiSkill>();
  for (const root of roots) {
    for (const skill of await readSkillRoot(root.path, root.scope, root.source, warnings)) {
      skills.set(skill.name.toLowerCase(), skill);
    }
  }
  return [...skills.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function installKimiSkill(kimiHome: string, cwd: string, source: string): Promise<{ skill: KimiSkill; destination: string; restartRequired: true }> {
  if (!isAbsolute(cwd) || !isAbsolute(source)) throw new Error("Skill workspace and source paths must be absolute");
  const workspace = await realpath(cwd);
  const sourceEntry = await lstat(source);
  if (sourceEntry.isSymbolicLink()) throw new Error("Skill source cannot be a symbolic link");
  const canonicalSource = await realpath(source);
  assertContained(workspace, canonicalSource, "Skill source must be inside the active workspace");

  const directory = sourceEntry.isDirectory();
  if (!directory && (!sourceEntry.isFile() || extname(canonicalSource).toLowerCase() !== ".md")) {
    throw new Error("Skill source must be a directory containing SKILL.md or a Markdown skill file");
  }
  const manifestEntry = await lstat(directory ? join(canonicalSource, "SKILL.md") : canonicalSource).catch(() => undefined);
  if (!manifestEntry?.isFile() || manifestEntry.isSymbolicLink()) throw new Error("Skill source does not contain a regular SKILL.md");
  if (manifestEntry.size > skillInstallFileLimit) throw new Error("SKILL.md is too large to install");
  await validateInstallSource(canonicalSource);
  await readInstallMetadata(directory ? join(canonicalSource, "SKILL.md") : canonicalSource, directory);

  const destinationRoot = join(kimiHome, "skills");
  await mkdir(destinationRoot, { recursive: true });
  const canonicalDestinationRoot = await realpath(destinationRoot);
  const stagingRoot = await mkdtemp(join(canonicalDestinationRoot, ".install-"));
  const staged = join(stagingRoot, directory ? "skill" : "skill.md");
  let destination = "";
  let metadata = { name: "", description: "", disableModelInvocation: false, hasSubSkills: false };
  let name = "";
  let lock: Awaited<ReturnType<typeof open>> | undefined;
  let lockPath = "";
  try {
    await copyInstallSource(canonicalSource, staged);
    await validateInstallSource(staged);
    const stagedManifest = directory ? join(staged, "SKILL.md") : staged;
    metadata = await readInstallMetadata(stagedManifest, directory);
    const fallbackName = directory ? basename(canonicalSource) : basename(canonicalSource, extname(canonicalSource));
    name = metadata.name || fallbackName;
    if (!skillNamePattern.test(name)) throw new Error("Skill name must use letters, numbers, dots, underscores, or hyphens");

    destination = join(canonicalDestinationRoot, directory ? name : `${name}.md`);
    assertContained(canonicalDestinationRoot, destination, "Invalid skill destination");
    lockPath = join(canonicalDestinationRoot, `.install-${name}.lock`);
    lock = await acquireInstallLock(lockPath, name);
    const collisions = [join(canonicalDestinationRoot, name), join(canonicalDestinationRoot, `${name}.md`)];
    if ((await Promise.all(collisions.map((path) => lstat(path).then(() => true, () => false)))).some(Boolean)) {
      throw new Error(`Skill '${name}' is already installed`);
    }
    if (directory) {
      await rename(staged, destination);
    } else {
      await copyFile(staged, destination, constants.COPYFILE_EXCL);
    }
  } finally {
    try {
      if (lock) {
        try {
          await lock.close();
        } finally {
          await rm(lockPath, { force: true });
        }
      }
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
  return {
    skill: {
      name,
      description: metadata.description,
      scope: "user",
      source: "kimi",
      path: destination,
      modelInvocable: !metadata.disableModelInvocation,
      hasSubSkills: metadata.hasSubSkills,
    },
    destination,
    restartRequired: true,
  };
}

async function readPlugins(root: string, warnings: string[]): Promise<KimiPlugin[]> {
  const roots = [root, join(root, "managed")];
  const plugins = new Map<string, KimiPlugin>();
  for (const candidateRoot of roots) {
    let entries;
    try {
      entries = await readdir(candidateRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      warnings.push("Kimi's plugin directory could not be read.");
      continue;
    }
    if (entries.length > skillDiscoveryEntryLimit) warnings.push(`Kimi's plugin directory contains too many entries; only the first ${skillDiscoveryEntryLimit} were inspected.`);
    for (const entry of entries.slice(0, skillDiscoveryEntryLimit).filter((item) => item.isDirectory() && item.name !== "managed" && !item.name.startsWith("."))) {
      const pluginRoot = join(candidateRoot, entry.name);
      const manifestPaths = [
        join(pluginRoot, "kimi.plugin.json"),
        join(pluginRoot, ".kimi-plugin", "plugin.json"),
        join(pluginRoot, "plugin.json"),
      ];
      let parsed: Record<string, unknown> | undefined;
      for (const manifestPath of manifestPaths) {
        try {
          const value = JSON.parse(await readBoundedText(manifestPath, skillReadLimit)) as unknown;
          if (isRecord(value)) {
            parsed = value;
            break;
          }
        } catch (error) {
          if (!isMissing(error)) {
            warnings.push(`Plugin '${entry.name}' has an unreadable manifest.`);
            break;
          }
        }
      }
      if (!parsed) continue;
      const name = typeof parsed.name === "string" && parsed.name ? parsed.name : entry.name;
      const toolCount = Array.isArray(parsed.tools) ? parsed.tools.length : isRecord(parsed.tools) ? Object.keys(parsed.tools).length : 0;
      plugins.set(name.toLowerCase(), {
        name,
        version: typeof parsed.version === "string" ? parsed.version : "",
        description: typeof parsed.description === "string" ? parsed.description : "",
        toolCount,
      });
    }
  }
  return [...plugins.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function readSkillRoot(root: string, scope: KimiSkill["scope"], source: KimiSkill["source"], warnings: string[]): Promise<KimiSkill[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    warnings.push(`Kimi's ${scope} skill directory could not be read.`);
    return [];
  }

  const skills: KimiSkill[] = [];
  if (entries.length > skillDiscoveryEntryLimit) warnings.push(`Kimi's ${scope} skill directory contains too many entries; only the first ${skillDiscoveryEntryLimit} were inspected.`);
  for (const entry of entries.slice(0, skillDiscoveryEntryLimit)) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const path = entry.isDirectory()
      ? join(root, entry.name, "SKILL.md")
      : entry.isFile() && extname(entry.name).toLowerCase() === ".md"
        ? join(root, entry.name)
        : undefined;
    if (!path) continue;
    try {
      const metadata = parseSkillFrontmatter(await readBoundedText(path, skillReadLimit));
      const fallbackName = entry.isDirectory() ? entry.name : basename(entry.name, extname(entry.name));
      const name = metadata.name || fallbackName;
      if (!skillNamePattern.test(name)) {
        warnings.push(`Skill '${fallbackName}' has an invalid name.`);
        continue;
      }
      skills.push({
        name,
        description: metadata.description,
        scope,
        source,
        path,
        modelInvocable: !metadata.disableModelInvocation,
        hasSubSkills: metadata.hasSubSkills,
      });
    } catch (error) {
      if (!isMissing(error)) warnings.push(`Skill '${entry.name}' could not be read.`);
    }
  }
  return skills;
}

async function mcpConfigPaths(kimiHome: string, cwd?: string): Promise<string[]> {
  const paths = [join(kimiHome, "mcp.json")];
  if (!cwd) return paths;
  const projectRoot = await findProjectRoot(cwd);
  paths.push(join(projectRoot, ".mcp.json"), join(resolve(cwd), ".kimi-code", "mcp.json"));
  return paths;
}

async function readMcpConfig(paths: string[], warnings: string[]): Promise<{ display: KimiMcpServer[]; connectable: McpServer[] }> {
  const servers: Record<string, { value: unknown; projectScoped: boolean }> = {};
  let hasProjectDefinitions = false;
  for (const [index, path] of paths.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBoundedText(path, skillInstallFileLimit));
    } catch (error) {
      if (isMissing(error)) continue;
      warnings.push("Kimi's MCP configuration could not be read.");
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
      warnings.push("Kimi's MCP configuration has an unsupported shape.");
      continue;
    }
    const projectScoped = index > 0;
    for (const [name, value] of Object.entries(parsed.mcpServers)) {
      servers[name] = { value, projectScoped };
      hasProjectDefinitions ||= projectScoped;
    }
  }
  if (hasProjectDefinitions) warnings.push("Project MCP definitions are shown for review but are not attached automatically.");

  const display: KimiMcpServer[] = [];
  const connectable: McpServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const { value, projectScoped } = entry;
    const scope = projectScoped ? { projectScoped: true as const } : {};
    if (!isRecord(value)) {
      display.push({ name, transport: "unknown", target: "Invalid configuration", needsAuthorization: false, connectable: false, ...scope });
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
        connectable: !needsAuthorization && !projectScoped,
        ...scope,
      });
      if (needsAuthorization) {
        warnings.push(`MCP server '${name}' uses OAuth, which this ACP transport cannot attach without Kimi-native authorization support.`);
        continue;
      }
      if (projectScoped) continue;
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
        connectable: !projectScoped,
        ...scope,
      });
      if (projectScoped) continue;
      connectable.push({
        name,
        command: value.command,
        args: Array.isArray(value.args) ? value.args.filter((item): item is string => typeof item === "string") : [],
        env: stringEntries(value.env).map(([envName, envValue]) => ({ name: envName, value: envValue })),
      });
      continue;
    }
    display.push({ name, transport: "unknown", target: "Unknown transport", needsAuthorization: false, connectable: false, ...scope });
    warnings.push(`MCP server '${name}' uses an unsupported transport.`);
  }
  display.sort((left, right) => left.name.localeCompare(right.name));
  connectable.sort((left, right) => left.name.localeCompare(right.name));
  return { display, connectable };
}

async function findProjectRoot(cwd: string): Promise<string> {
  let current = await realpath(resolve(cwd));
  while (true) {
    if (await stat(join(current, ".git")).then(() => true, () => false)) return current;
    const parent = dirname(current);
    if (parent === current) return await realpath(resolve(cwd));
    current = parent;
  }
}

async function readBoundedText(path: string, limit: number, strictUtf8 = false): Promise<string> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await file.read(buffer, 0, limit, 0);
    const content = buffer.subarray(0, bytesRead);
    if (!strictUtf8) return content.toString("utf8");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw new Error("Skill manifest must be valid UTF-8");
    }
  } finally {
    await file.close();
  }
}

function parseSkillFrontmatter(content: string): { name: string; description: string; disableModelInvocation: boolean; hasSubSkills: boolean } {
  const result = { name: "", description: "", disableModelInvocation: false, hasSubSkills: false };
  if (!content.startsWith("---")) return result;
  const end = content.indexOf("\n---", 3);
  if (end < 0) return result;
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const value = unquote(match[2] ?? "");
    if (match[1] === "name") result.name = value;
    else if (match[1] === "description") result.description = value;
    else if (match[1] === "disable-model-invocation") result.disableModelInvocation = value.toLowerCase() === "true";
    else if (match[1] === "has-sub-skill") result.hasSubSkills = value.toLowerCase() === "true";
  }
  return result;
}

async function validateInstallSource(source: string): Promise<void> {
  await traverseInstallSource(source);
}

async function copyInstallSource(source: string, destination: string): Promise<void> {
  await traverseInstallSource(
    source,
    async (path, mode) => {
      const target = path === source ? destination : join(destination, relative(source, path));
      await mkdir(target, { mode });
    },
    async (path, size, mode) => {
      const target = path === source ? destination : join(destination, relative(source, path));
      await copyRegularFile(path, target, size, mode);
    },
  );
}

async function traverseInstallSource(
  source: string,
  onDirectory?: (path: string, mode: number) => Promise<void>,
  onFile?: (path: string, size: number, mode: number) => Promise<void>,
): Promise<void> {
  let files = 0;
  let directories = 0;
  let bytes = 0;
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > skillInstallDepthLimit) throw new Error("Skill bundle is nested too deeply to install");
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error("Skill bundles cannot contain symbolic links");
    if (entry.isFile()) {
      files += 1;
      bytes += entry.size;
      if (files > skillInstallFileCountLimit || bytes > skillInstallBundleLimit) throw new Error("Skill bundle is too large to install");
      await onFile?.(path, entry.size, entry.mode);
    } else if (entry.isDirectory()) {
      directories += 1;
      if (directories > skillInstallDirectoryCountLimit) throw new Error("Skill bundle contains too many directories");
      await onDirectory?.(path, entry.mode);
      const directory = await opendir(path);
      for await (const child of directory) await visit(join(path, child.name), depth + 1);
    } else {
      throw new Error("Skill bundles may contain only regular files and directories");
    }
  };
  await visit(source, 0);
}

async function copyRegularFile(source: string, destination: string, expectedSize: number, mode: number): Promise<void> {
  const input = await open(source, "r");
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!(await input.stat()).isFile()) throw new Error("Skill bundles may contain only regular files and directories");
    output = await open(destination, "wx", mode);
    const buffer = Buffer.alloc(64 * 1024);
    let copied = 0;
    while (true) {
      const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      copied += bytesRead;
      if (copied > expectedSize) throw new Error("Skill source changed while it was being installed");
      let written = 0;
      while (written < bytesRead) {
        written += (await output.write(buffer, written, bytesRead - written, null)).bytesWritten;
      }
    }
  } finally {
    await output?.close();
    await input.close();
  }
}

async function readInstallMetadata(path: string, required: boolean): Promise<ReturnType<typeof parseSkillFrontmatter>> {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry?.isFile() || entry.isSymbolicLink()) throw new Error("Skill source does not contain a regular SKILL.md");
  if (entry.size > skillInstallFileLimit) throw new Error("SKILL.md is too large to install");
  const metadata = parseSkillFrontmatter(await readBoundedText(path, skillInstallFileLimit, true));
  if (required && (!metadata.name.trim() || !metadata.description.trim())) {
    throw new Error("SKILL.md must declare a non-empty name and description");
  }
  return metadata;
}

function assertContained(root: string, path: string, message: string): void {
  const rel = relative(root, path);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(message);
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function safeHttpTarget(value: string): string {
  try {
    const url = new URL(value);
    return url.origin;
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

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

async function acquireInstallLock(path: string, name: string): Promise<Awaited<ReturnType<typeof open>>> {
  try {
    return await open(path, "wx");
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    const existing = await stat(path).catch(() => undefined);
    if (existing && Date.now() - existing.mtimeMs > skillInstallLockStaleMs) {
      await rm(path, { force: true });
      try {
        return await open(path, "wx");
      } catch (retryError) {
        if (!isAlreadyExists(retryError)) throw retryError;
      }
    }
    throw new Error(`Skill '${name}' is already being installed`);
  }
}
