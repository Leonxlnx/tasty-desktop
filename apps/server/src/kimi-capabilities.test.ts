import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { readKimiCapabilities, readKimiMcpServers } from "./kimi-capabilities.js";

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
      { name: "linear", transport: "http", target: "https://mcp.example.test/tools", needsAuthorization: true, connectable: false },
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
});
