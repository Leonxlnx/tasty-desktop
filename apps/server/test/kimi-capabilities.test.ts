import { createHash, type Hash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { installKimiSkill, readKimiCapabilities, readKimiMcpServers, readProjectMcpBundle } from "../src/kimi-capabilities.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Kimi capability discovery", () => {
  it("reads installed plugins and redacts MCP secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    roots.push(root);
    await mkdir(join(root, "plugins", "hello"), { recursive: true });
    await writeFile(join(root, "plugins", "hello", "plugin.json"), JSON.stringify({
      name: "hello",
      version: "1.2.3",
      description: "Says hello",
      tools: [{ name: "greet" }],
    }));
    await writeFile(join(root, "mcp.json"), JSON.stringify({
      mcpServers: {
        linear: { url: "https://mcp.example.test/tools?token=secret", auth: "oauth", headers: { Authorization: "secret" } },
        local: { command: "C:\\tools\\server.exe", args: ["--token", "secret"] },
      },
    }));

    const result = await readKimiCapabilities(root);

    expect(result.plugins).toEqual([{ name: "hello", version: "1.2.3", description: "Says hello", toolCount: 1 }]);
    expect(result.mcpServers).toEqual([
      { name: "linear", transport: "http", target: "https://mcp.example.test", needsAuthorization: true, connectable: false },
      { name: "local", transport: "stdio", target: "server.exe", needsAuthorization: false, connectable: true },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.agents.map((agent) => agent.name)).toEqual(["coder", "explore", "plan"]);
    expect(result.warnings).toEqual(["MCP server 'linear' uses OAuth, which this ACP transport cannot attach without Kimi-native authorization support."]);
    expect(await readKimiMcpServers(root)).toEqual([{
      name: "local",
      command: "C:\\tools\\server.exe",
      args: ["--token", "secret"],
      env: [],
    }]);
  });

  it("translates HTTP headers for ACP without exposing them in capability metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    roots.push(root);
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: {
      context: { url: "https://mcp.example.test/tools?key=hidden", headers: { Authorization: "Bearer hidden" } },
    } }));

    expect(await readKimiMcpServers(root)).toEqual([{
      type: "http",
      name: "context",
      url: "https://mcp.example.test/tools?key=hidden",
      headers: [{ name: "Authorization", value: "Bearer hidden" }],
    }]);
    expect(JSON.stringify(await readKimiCapabilities(root))).not.toContain("hidden");
  });

  it("returns a useful empty snapshot when Kimi has no share directory yet", async () => {
    const root = join(tmpdir(), `missing-kimi-${crypto.randomUUID()}`);
    const result = await readKimiCapabilities(root);
    expect(result.plugins).toEqual([]);
    expect(result.mcpServers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("keeps bad manifests out of the product surface", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    roots.push(root);
    await mkdir(join(root, "plugins", "broken"), { recursive: true });
    await writeFile(join(root, "plugins", "broken", "plugin.json"), "not json");
    const result = await readKimiCapabilities(root);
    expect(result.plugins).toEqual([]);
    expect(result.warnings).toEqual(["Plugin 'broken' has an unreadable manifest."]);
  });

  it("discovers scoped skills using Kimi's precedence", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const user = await mkdtemp(join(tmpdir(), "kimi-user-"));
    const project = await mkdtemp(join(tmpdir(), "kimi-project-"));
    roots.push(root, user, project);
    await mkdir(join(project, ".git"));
    await writeSkill(join(user, ".agents", "skills", "shared"), "shared", "User generic");
    await writeSkill(join(root, "skills", "shared"), "shared", "User Kimi");
    await writeSkill(join(project, ".agents", "skills", "shared"), "shared", "Project generic");
    await writeSkill(join(project, ".kimi-code", "skills", "shared"), "shared", "Project Kimi", true);
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(join(root, "skills", "flat.md"), "---\nname: flat\ndescription: Flat skill\n---\n# Flat\n");

    const result = await readKimiCapabilities(root, project, user);

    expect(result.skills).toEqual([
      expect.objectContaining({ name: "flat", description: "Flat skill", scope: "user", source: "kimi" }),
      expect.objectContaining({ name: "shared", description: "Project Kimi", scope: "project", source: "kimi", modelInvocable: false }),
    ]);
    expect(result.roots.skills).toBe(join(root, "skills"));
  });

  it("discovers project MCP definitions without attaching their commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const project = await mkdtemp(join(tmpdir(), "kimi-project-"));
    roots.push(root, project);
    await mkdir(join(project, ".git"));
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: {
      shared: { command: "user-tool", env: { TOKEN: "user-secret" } },
      user: { command: "user-only" },
    } }));
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {
      shared: { command: "project-tool", env: { TOKEN: "project-secret" } },
    } }));
    await mkdir(join(project, ".kimi-code"));
    await writeFile(join(project, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: {
      local: { url: "https://example.test/mcp?token=hidden" },
    } }));

    const capabilities = await readKimiCapabilities(root, project);
    const attached = await readKimiMcpServers(root);

    expect(capabilities.mcpServers).toEqual([
      { name: "local", transport: "http", target: "https://example.test", needsAuthorization: false, connectable: false, projectScoped: true },
      { name: "shared", transport: "stdio", target: "user-tool", needsAuthorization: false, connectable: true },
      { name: "shared", transport: "stdio", target: "project-tool", needsAuthorization: false, connectable: false, projectScoped: true },
      { name: "user", transport: "stdio", target: "user-only", needsAuthorization: false, connectable: true },
    ]);
    expect(capabilities.projectMcp).toMatchObject({ root: await realpath(project), status: "required", approvable: true });
    expect(JSON.stringify(capabilities)).not.toMatch(/hidden|secret/);
    expect(capabilities.warnings).toContain("Project MCP definitions are shown for review but are not attached automatically.");
    expect(attached).toEqual([
      { name: "shared", command: "user-tool", args: [], env: [{ name: "TOKEN", value: "user-secret" }] },
      { name: "user", command: "user-only", args: [], env: [] },
    ]);
    expect(attached).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "project-tool" }),
      expect.objectContaining({ name: "local" }),
    ]));
  });

  it("binds project MCP approval to the canonical root and exact bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const project = await mkdtemp(join(tmpdir(), "kimi-project-"));
    const copy = await mkdtemp(join(tmpdir(), "kimi-project-copy-"));
    const nested = join(project, "packages", "app");
    roots.push(root, project, copy);
    await mkdir(join(project, ".git"));
    await mkdir(nested, { recursive: true });
    await mkdir(join(project, ".kimi-code"));
    await writeFile(join(root, "mcp.json"), `{"mcpServers":{"__proto__":{"command":"user-proto"},"shared":{"command":"user-tool","env":{"TOKEN":"user-secret"}},"user":{"command":"user-only"},"kimi-desktop-preview":{"command":"untrusted-preview"}}}`);
    const rootBytes = Buffer.from(`{"mcpServers":{"shared":{"command":"project-tool","env":{"TOKEN":"project-secret"}},"constructor":{"command":"project-constructor"},"kimi-desktop-preview":{"command":"project-preview"}}}`);
    const kimiBytes = Buffer.from(`{"mcpServers":{"shared":{"command":"project-tool-final"},"local":{"url":"https://example.test/mcp?token=hidden"}}}`);
    await writeFile(join(project, ".mcp.json"), rootBytes);
    await writeFile(join(project, ".kimi-code", "mcp.json"), kimiBytes);

    const bundle = await readProjectMcpBundle(nested);
    const canonicalRoot = await realpath(project);

    expect(bundle).toMatchObject({ root: canonicalRoot, status: "required", approvable: true });
    expect(bundle?.fingerprint).toBe(expectedProjectMcpFingerprint(canonicalRoot, { ".mcp.json": rootBytes, ".kimi-code/mcp.json": kimiBytes }));
    expect([...bundle!.servers.keys()]).toEqual(["shared", "constructor", "local"]);
    expect(JSON.stringify(bundle)).not.toMatch(/hidden|secret|project-tool/);

    for (const fingerprint of [undefined, "0".repeat(64)]) {
      const pending = await readKimiMcpServers(root, nested, fingerprint);
      expect(pending).toEqual(expect.arrayContaining([
        { name: "__proto__", command: "user-proto", args: [], env: [] },
        { name: "shared", command: "user-tool", args: [], env: [{ name: "TOKEN", value: "user-secret" }] },
        { name: "user", command: "user-only", args: [], env: [] },
      ]));
      expect(pending).toHaveLength(3);
    }

    const approved = await readKimiMcpServers(root, nested, bundle!.fingerprint!);
    expect(approved).toEqual(expect.arrayContaining([
      { name: "__proto__", command: "user-proto", args: [], env: [] },
      { name: "constructor", command: "project-constructor", args: [], env: [] },
      { name: "local", type: "http", url: "https://example.test/mcp?token=hidden", headers: [] },
      { name: "shared", command: "project-tool-final", args: [], env: [] },
      { name: "user", command: "user-only", args: [], env: [] },
    ]));
    expect(approved).toHaveLength(5);
    expect(approved).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "kimi-desktop-preview" })]));

    await mkdir(join(copy, ".git"));
    await mkdir(join(copy, ".kimi-code"));
    await writeFile(join(copy, ".mcp.json"), rootBytes);
    await writeFile(join(copy, ".kimi-code", "mcp.json"), kimiBytes);
    expect((await readProjectMcpBundle(copy))?.fingerprint).not.toBe(bundle?.fingerprint);

    await writeFile(join(project, ".kimi-code", "mcp.json"), Buffer.concat([kimiBytes, Buffer.from("\n")]));
    const changed = await readProjectMcpBundle(nested);
    expect(changed?.fingerprint).not.toBe(bundle?.fingerprint);
    expect(await readKimiMcpServers(root, nested, bundle!.fingerprint!)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "shared", command: "user-tool" }),
    ]));
  });

  it("never lets unsupported or reserved project entries suppress trusted MCP servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const project = await mkdtemp(join(tmpdir(), "kimi-project-"));
    roots.push(root, project);
    await mkdir(join(project, ".git"));
    await writeFile(join(root, "mcp.json"), JSON.stringify({ mcpServers: {
      shared: { command: "user-tool" },
      fallback: { command: "user-fallback" },
      invalidUrl: { command: "user-url-fallback" },
      emptyCommand: { command: "user-command-fallback" },
    } }));
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: {
      shared: { url: "https://example.test/oauth?secret=hidden", auth: "oauth" },
      fallback: { unsupported: true },
      invalidUrl: { url: "not a URL" },
      emptyCommand: { command: "" },
      "kimi-desktop-preview": { command: "project-preview" },
    } }));

    const bundle = await readProjectMcpBundle(project);
    const attached = await readKimiMcpServers(root, project, bundle?.fingerprint ?? undefined);
    const capabilities = await readKimiCapabilities(root, project);

    expect(attached).toEqual([
      { name: "emptyCommand", command: "user-command-fallback", args: [], env: [] },
      { name: "fallback", command: "user-fallback", args: [], env: [] },
      { name: "invalidUrl", command: "user-url-fallback", args: [], env: [] },
      { name: "shared", command: "user-tool", args: [], env: [] },
    ]);
    expect(capabilities.mcpServers.filter((server) => server.name === "shared")).toHaveLength(2);
    expect(capabilities.mcpServers.filter((server) => server.name === "fallback")).toHaveLength(2);
    expect(JSON.stringify(capabilities)).not.toContain("hidden");
    expect(capabilities.mcpServers).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "kimi-desktop-preview", projectScoped: true }),
    ]));
  });

  it("fails unsafe project MCP bundles closed and ignores valid empty bundles", async () => {
    const outside = await mkdtemp(join(tmpdir(), "kimi-mcp-outside-"));
    const escaped = await mkdtemp(join(tmpdir(), "kimi-mcp-escaped-"));
    const nonfile = await mkdtemp(join(tmpdir(), "kimi-mcp-nonfile-"));
    const oversized = await mkdtemp(join(tmpdir(), "kimi-mcp-oversized-"));
    const invalidUtf8 = await mkdtemp(join(tmpdir(), "kimi-mcp-utf8-"));
    const empty = await mkdtemp(join(tmpdir(), "kimi-mcp-empty-"));
    roots.push(outside, escaped, nonfile, oversized, invalidUtf8, empty);
    await writeFile(join(outside, "mcp.json"), JSON.stringify({ mcpServers: { escaped: { command: "outside" } } }));

    await mkdir(join(escaped, ".git"));
    await writeFile(join(escaped, ".mcp.json"), JSON.stringify({ mcpServers: { safe: { command: "safe" } } }));
    await symlink(outside, join(escaped, ".kimi-code"), "junction");
    expect(await readProjectMcpBundle(escaped)).toMatchObject({ root: await realpath(escaped), fingerprint: null, status: "invalid", approvable: false });

    await mkdir(join(nonfile, ".git"));
    await mkdir(join(nonfile, ".mcp.json"));
    expect(await readProjectMcpBundle(nonfile)).toMatchObject({ fingerprint: null, status: "invalid", approvable: false });

    await mkdir(join(oversized, ".git"));
    await writeFile(join(oversized, ".mcp.json"), Buffer.alloc(256 * 1024 + 1, 0x20));
    expect(await readProjectMcpBundle(oversized)).toMatchObject({ fingerprint: null, status: "invalid", approvable: false });

    await mkdir(join(invalidUtf8, ".git"));
    await writeFile(join(invalidUtf8, ".mcp.json"), Buffer.from([0xff]));
    expect(await readProjectMcpBundle(invalidUtf8)).toMatchObject({ fingerprint: null, status: "invalid", approvable: false });

    await mkdir(join(empty, ".git"));
    await writeFile(join(empty, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
    await expect(readProjectMcpBundle(empty)).resolves.toBeUndefined();
  });

  it("installs a validated workspace skill without overwriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "kimi-outside-"));
    roots.push(root, workspace, outside);
    const source = join(workspace, "source-skill");
    await writeSkill(source, "installed-skill", "Installed safely");
    await mkdir(join(source, "references"));
    await writeFile(join(source, "references", "notes.md"), "supporting file");

    const installed = await installKimiSkill(root, workspace, source);

    expect(installed).toMatchObject({
      skill: { name: "installed-skill", description: "Installed safely", scope: "user", source: "kimi" },
      destination: join(await realpath(root), "skills", "installed-skill"),
      restartRequired: true,
    });
    await expect(readFile(join(installed.destination, "references", "notes.md"), "utf8")).resolves.toBe("supporting file");
    await expect(readdir(join(root, "skills"))).resolves.toEqual(["installed-skill"]);
    await expect(installKimiSkill(root, workspace, source)).rejects.toThrow(/already installed/i);

    const externalSource = join(outside, "external");
    await writeSkill(externalSource, "external", "Outside");
    await expect(installKimiSkill(root, workspace, externalSource)).rejects.toThrow(/inside the active workspace/i);
  });

  it("allows only one concurrent install for the same skill name", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-"));
    roots.push(root, workspace);
    const first = join(workspace, "first");
    const second = join(workspace, "second");
    await writeSkill(first, "shared-name", "First");
    await writeSkill(second, "shared-name", "Second");

    const results = await Promise.allSettled([
      installKimiSkill(root, workspace, first),
      installKimiSkill(root, workspace, second),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(readFile(join(root, "skills", "shared-name", "SKILL.md"), "utf8")).resolves.toMatch(/description: (First|Second)/);
  });

  it("does not remove a lock owned by another install request", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-"));
    roots.push(root, workspace);
    const source = join(workspace, "locked");
    const lock = join(root, "skills", ".install-locked.lock");
    await writeSkill(source, "locked", "Locked");
    await mkdir(join(root, "skills"), { recursive: true });
    await writeFile(lock, "other request");

    await expect(installKimiSkill(root, workspace, source)).rejects.toThrow(/already being installed/i);
    await expect(readFile(lock, "utf8")).resolves.toBe("other request");
  });

  it("rejects oversized source bundles before creating staging files", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-"));
    roots.push(root, workspace);
    const source = join(workspace, "too-many-files");
    await writeSkill(source, "too-many-files", "Too many files");
    await Promise.all(Array.from({ length: 500 }, (_, index) => writeFile(join(source, `${index}.txt`), "")));

    await expect(installKimiSkill(root, workspace, source)).rejects.toThrow(/too large/i);
    await expect(lstat(join(root, "skills"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a skill manifest that is not valid UTF-8", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-"));
    roots.push(root, workspace);
    const source = join(workspace, "invalid-utf8");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), Buffer.concat([
      Buffer.from("---\nname: invalid-utf8\ndescription: "),
      Buffer.from([0xff]),
      Buffer.from("\n---\n"),
    ]));

    await expect(installKimiSkill(root, workspace, source)).rejects.toThrow(/valid UTF-8/i);
    await expect(lstat(join(root, "skills"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a directory skill without required frontmatter metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-capabilities-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-"));
    roots.push(root, workspace);
    const source = join(workspace, "missing-description");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: incomplete\n---\n# Incomplete\n");

    await expect(installKimiSkill(root, workspace, source)).rejects.toThrow(/name and description/i);
    await expect(lstat(join(root, "skills", "incomplete"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function writeSkill(path: string, name: string, description: string, disableModelInvocation = false): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\ndisable-model-invocation: ${disableModelInvocation}\n---\n# ${name}\n`);
}

function expectedProjectMcpFingerprint(root: string, files: Partial<Record<".mcp.json" | ".kimi-code/mcp.json", Buffer>>): string {
  const hash = createHash("sha256");
  frame(hash, Buffer.from("kimi-project-mcp-v1"));
  frame(hash, Buffer.from(root));
  for (const name of [".mcp.json", ".kimi-code/mcp.json"] as const) {
    const bytes = files[name];
    frame(hash, Buffer.from(name));
    frame(hash, Buffer.from(bytes ? [1] : [0]));
    if (bytes) frame(hash, bytes);
  }
  return hash.digest("hex");
}

function frame(hash: Hash, value: Uint8Array): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  hash.update(length).update(value);
}
