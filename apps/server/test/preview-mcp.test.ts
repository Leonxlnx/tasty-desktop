import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
    const source = join(dirname(fileURLToPath(import.meta.url)), "../src/preview-mcp.ts");
    const child = spawn(process.execPath, ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href, source], {
      env: { ...process.env, KIMI_DESKTOP_PREVIEW_BRIDGE: `ws://127.0.0.1:${address.port}` },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const messages: Array<Record<string, unknown>> = [];
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => messages.push(JSON.parse(line) as Record<string, unknown>));
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
      const listed = await waitFor(messages, (message) => message.id === 2);
      const names = ((listed.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
      expect(names).toEqual(["preview_open", "preview_resize", "preview_screenshot"]);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "preview_open", arguments: { url: "localhost:4173", panelWidth: 1200 } } })}\n`);
      const opened = await waitFor(messages, (message) => message.id === 3);
      expect((opened.result as { isError?: boolean }).isError).not.toBe(true);
      expect(commands).toContainEqual(expect.objectContaining({ action: "open", url: "http://localhost:4173/", panelWidth: 1200 }));
    } finally {
      lines.close();
      child.kill();
      await new Promise<void>((resolve) => bridge.close(() => resolve()));
    }
  });
});

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
