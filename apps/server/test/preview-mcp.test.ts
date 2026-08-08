import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";

describe("desktop preview MCP", () => {
  it("advertises open, resize, and screenshot tools over stdio", async () => {
    const bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => { bridge.once("listening", resolve); bridge.once("error", reject); });
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("Preview bridge did not bind a TCP port");
    const commands: Array<Record<string, unknown>> = [];
    bridge.on("connection", (socket) => socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; params: Record<string, unknown> };
      commands.push(request.params);
      socket.send(JSON.stringify({ id: request.id, result: { accepted: true } }));
    }));
    const mcp = startMcp({
      KIMI_DESKTOP_PREVIEW_BRIDGE: `ws://127.0.0.1:${address.port}`,
      KIMI_DESKTOP_SKILL_WORKSPACE: undefined,
      KIMI_CODE_HOME: undefined,
    });
    try {
      await mcp.request("initialize", { protocolVersion: "2025-03-26" });
      const listed = await mcp.request("tools/list", {});
      const names = ((listed.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
      expect(names).toEqual(["preview_open", "preview_resize", "preview_screenshot", "skill_install_local"]);
      const skillTool = (listed.result as { tools: Array<{ name: string; inputSchema: unknown; annotations?: unknown }> }).tools.at(-1);
      expect(skillTool).toMatchObject({
        inputSchema: { required: ["source"], additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      });
      const opened = await mcp.request("tools/call", { name: "preview_open", arguments: { url: "localhost:4173", panelWidth: 1200 } });
      expect((opened.result as { isError?: boolean }).isError).not.toBe(true);
      expect(commands).toContainEqual(expect.objectContaining({ action: "open", url: "http://localhost:4173/", panelWidth: 1200 }));
      const unavailable = await mcp.request("tools/call", { name: "skill_install_local", arguments: { source: resolve("missing-skill") } });
      expect(unavailable.result).toMatchObject({ isError: true });
      expect(JSON.stringify(unavailable.result)).toContain("unavailable for this session");
    } finally {
      mcp.close();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });

  it("requests confirmation only for a source in its bound workspace and never installs directly", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-preview-skill-"));
    const kimiHome = join(root, "home");
    const firstWorkspace = join(root, "first");
    const secondWorkspace = join(root, "second");
    const source = join(firstWorkspace, "example");
    await mkdir(source, { recursive: true });
    await mkdir(secondWorkspace);
    await writeFile(join(source, "SKILL.md"), "---\nname: example-skill\ndescription: Example\n---\n# Example\n");
    const bridge = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve, reject) => { bridge.once("listening", resolve); bridge.once("error", reject); });
    const address = bridge.address();
    if (!address || typeof address === "string") throw new Error("Preview bridge did not bind a TCP port");
    const commands: Array<Record<string, unknown>> = [];
    bridge.on("connection", (socket) => socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as { id: string; params: Record<string, unknown> };
      commands.push(request.params);
      socket.send(JSON.stringify({ id: request.id, result: { accepted: true } }));
    }));
    const bridgeUrl = `ws://127.0.0.1:${address.port}`;
    const first = startMcp({ KIMI_DESKTOP_PREVIEW_BRIDGE: bridgeUrl, KIMI_DESKTOP_SKILL_WORKSPACE: firstWorkspace, KIMI_CODE_HOME: kimiHome });
    const second = startMcp({ KIMI_DESKTOP_PREVIEW_BRIDGE: bridgeUrl, KIMI_DESKTOP_SKILL_WORKSPACE: secondWorkspace, KIMI_CODE_HOME: kimiHome });
    try {
      const requested = await first.request("tools/call", { name: "skill_install_local", arguments: { source } });
      const requestedText = JSON.stringify(requested.result);
      expect(requestedText).toContain("Confirmation requested");
      expect(requestedText).toContain("has not been installed");
      expect(requestedText).not.toMatch(new RegExp(escapeRegex(root), "i"));
      expect(commands).toContainEqual({
        action: "request_skill_install",
        cwd: await realpath(firstWorkspace),
        source: await realpath(source),
        name: "example",
      });
      await expect(access(join(kimiHome, "skills", "example-skill", "SKILL.md"))).rejects.toThrow();

      const crossed = await second.request("tools/call", { name: "skill_install_local", arguments: { source } });
      expect(crossed.result).toMatchObject({ isError: true });
      expect(JSON.stringify(crossed.result)).not.toMatch(new RegExp(escapeRegex(root), "i"));

      for (const argumentsValue of [{ source: "relative/skill" }, { source: "https://example.test/skill" }, { source, extra: true }]) {
        const rejected = await second.request("tools/call", { name: "skill_install_local", arguments: argumentsValue });
        expect(rejected.result).toMatchObject({ isError: true });
      }
    } finally {
      first.close();
      second.close();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});

function startMcp(extraEnv: Record<string, string | undefined>) {
  const source = join(dirname(fileURLToPath(import.meta.url)), "../src/preview-mcp.ts");
  const child = spawn(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, source], {
    env: { ...process.env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages: Array<Record<string, unknown>> = [];
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => messages.push(JSON.parse(line) as Record<string, unknown>));
  let id = 0;
  return {
    request(method: string, params: Record<string, unknown>) {
      id += 1;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return waitFor(messages, (message) => message.id === id);
    },
    close() {
      lines.close();
      child.kill();
    },
  };
}

function waitFor(messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let poll: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      clearInterval(poll);
      reject(new Error("Timed out waiting for preview MCP response"));
    }, 10_000);
    poll = setInterval(() => {
      const match = messages.find(predicate);
      if (!match) return;
      clearTimeout(timeout);
      clearInterval(poll);
      resolve(match);
    }, 10);
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
