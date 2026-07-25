import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  clampPreviewPanelWidth,
  clampPreviewViewportHeight,
  clampPreviewViewportWidth,
  normalizeDesktopPreviewUrl,
  type PreviewBridgeCommand,
} from "./desktop-preview.js";

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" }>; isError?: boolean };

const tools = [
  {
    name: "preview_open",
    description: "Open a localhost app inside Kimi Code Desktop's Preview panel and choose its panel and screenshot viewport sizes.",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "A localhost or 127.0.0.1 HTTP(S) URL." },
      panelWidth: { type: "number", minimum: 320, maximum: 1200, description: "Preview panel width in pixels." },
      viewportWidth: { type: "number", minimum: 320, maximum: 1920 },
      viewportHeight: { type: "number", minimum: 240, maximum: 1200 },
    }, required: ["url"], additionalProperties: false },
  },
  {
    name: "preview_resize",
    description: "Resize Kimi Code Desktop's Preview panel and the viewport used by the next screenshot.",
    inputSchema: { type: "object", properties: {
      panelWidth: { type: "number", minimum: 320, maximum: 1200 },
      viewportWidth: { type: "number", minimum: 320, maximum: 1920 },
      viewportHeight: { type: "number", minimum: 240, maximum: 1200 },
    }, additionalProperties: false },
  },
  {
    name: "preview_screenshot",
    description: "Capture the current localhost app in an isolated Edge session and return the PNG so you can visually evaluate the result.",
    inputSchema: { type: "object", properties: {
      url: { type: "string", description: "Optional localhost URL. Uses the last preview_open URL when omitted." },
      panelWidth: { type: "number", minimum: 320, maximum: 1200 },
      viewportWidth: { type: "number", minimum: 320, maximum: 1920 },
      viewportHeight: { type: "number", minimum: 240, maximum: 1200 },
    }, additionalProperties: false },
  },
  {
    name: "skill_install_local",
    description: "Request installation of one local skill from the active workspace. The desktop app always asks the user to confirm before anything is installed.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", minLength: 1, description: "Absolute path to a local skill directory or Markdown skill file inside the active workspace." },
      },
      required: ["source"],
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

export function startPreviewMcp(): void {
  const state: { url?: string; panelWidth: number; viewportWidth: number; viewportHeight: number } = {
    panelWidth: 960,
    viewportWidth: 1440,
    viewportHeight: 900,
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    void handleLine(line, state);
  });
}

async function handleLine(line: string, state: { url?: string; panelWidth: number; viewportWidth: number; viewportHeight: number }): Promise<void> {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } });
    return;
  }
  if (request.method === "notifications/initialized" || request.method === "notifications/cancelled") return;
  if (request.id === undefined) return;
  try {
    if (request.method === "initialize") {
      const requested = request.params?.protocolVersion;
      write({ jsonrpc: "2.0", id: request.id, result: {
        protocolVersion: typeof requested === "string" ? requested : "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "Kimi Code Desktop Preview", version: "0.9.0" },
      } });
      return;
    }
    if (request.method === "ping") {
      write({ jsonrpc: "2.0", id: request.id, result: {} });
      return;
    }
    if (request.method === "tools/list") {
      write({ jsonrpc: "2.0", id: request.id, result: { tools } });
      return;
    }
    if (request.method === "tools/call") {
      const name = typeof request.params?.name === "string" ? request.params.name : "";
      const args = isRecord(request.params?.arguments) ? request.params.arguments : {};
      write({ jsonrpc: "2.0", id: request.id, result: await callTool(name, args, state) });
      return;
    }
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } });
  } catch (error) {
    write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
  }
}

async function callTool(name: string, args: Record<string, unknown>, state: { url?: string; panelWidth: number; viewportWidth: number; viewportHeight: number }): Promise<ToolResult> {
  try {
    if (name === "skill_install_local") return await installLocalSkill(args);
    state.panelWidth = clampPreviewPanelWidth(args.panelWidth ?? state.panelWidth);
    state.viewportWidth = clampPreviewViewportWidth(args.viewportWidth ?? state.viewportWidth);
    state.viewportHeight = clampPreviewViewportHeight(args.viewportHeight ?? state.viewportHeight);
    if (name === "preview_open") {
      const url = normalizeDesktopPreviewUrl(String(args.url ?? ""));
      if (!url) throw new Error("Preview accepts only localhost or 127.0.0.1 HTTP(S) URLs.");
      state.url = url;
      await sendBridge({ action: "open", url, panelWidth: state.panelWidth, viewportWidth: state.viewportWidth, viewportHeight: state.viewportHeight });
      return textResult(`Opened ${url} in the desktop Preview panel at ${state.panelWidth}px. Screenshot viewport: ${state.viewportWidth}×${state.viewportHeight}.`);
    }
    if (name === "preview_resize") {
      await sendBridge({ action: "resize", ...(state.url ? { url: state.url } : {}), panelWidth: state.panelWidth, viewportWidth: state.viewportWidth, viewportHeight: state.viewportHeight });
      return textResult(`Preview resized to ${state.panelWidth}px. Screenshot viewport: ${state.viewportWidth}×${state.viewportHeight}.`);
    }
    if (name === "preview_screenshot") {
      const explicit = typeof args.url === "string" ? normalizeDesktopPreviewUrl(args.url) : undefined;
      if (typeof args.url === "string" && !explicit) throw new Error("Preview accepts only localhost or 127.0.0.1 HTTP(S) URLs.");
      const url = explicit ?? state.url;
      if (!url) throw new Error("Open a localhost preview or pass a URL before taking a screenshot.");
      state.url = url;
      await sendBridge({ action: "open", url, panelWidth: state.panelWidth, viewportWidth: state.viewportWidth, viewportHeight: state.viewportHeight });
      const image = await captureScreenshot(url, state.viewportWidth, state.viewportHeight);
      return { content: [
        { type: "text", text: `Captured ${url} at ${state.viewportWidth}×${state.viewportHeight}. Inspect the image and report concrete visual issues before editing.` },
        { type: "image", data: image, mimeType: "image/png" },
      ] };
    }
    throw new Error(`Unknown preview tool: ${name || "(missing)"}`);
  } catch (error) {
    return { ...textResult(error instanceof Error ? error.message : String(error)), isError: true };
  }
}

async function installLocalSkill(args: Record<string, unknown>): Promise<ToolResult> {
  const keys = Object.keys(args);
  const source = args.source;
  if (keys.length !== 1 || keys[0] !== "source" || typeof source !== "string" || !source.trim()) {
    throw new Error("skill_install_local accepts exactly one source path.");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) || !isAbsolute(source)) {
    throw new Error("Skill source must be an absolute local path.");
  }
  const workspace = process.env.KIMI_DESKTOP_SKILL_WORKSPACE;
  if (!workspace || !isAbsolute(workspace)) {
    throw new Error("Skill installation is unavailable for this session.");
  }
  try {
    const sourceEntry = await lstat(source);
    if (sourceEntry.isSymbolicLink() || (!sourceEntry.isDirectory() && !sourceEntry.isFile())) {
      throw new Error("Skill source must be a regular file or directory.");
    }
    if (sourceEntry.isFile() && extname(source).toLowerCase() !== ".md") {
      throw new Error("Skill source must be a directory or Markdown file.");
    }
    const canonicalWorkspace = await realpath(workspace);
    const canonicalSource = await realpath(source);
    const rel = relative(canonicalWorkspace, canonicalSource);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Skill source must be inside the active workspace.");
    const sourceName = basename(canonicalSource);
    const name = sourceEntry.isFile() ? sourceName.slice(0, -extname(sourceName).length) : sourceName;
    await sendBridge({ action: "request_skill_install", cwd: canonicalWorkspace, source: canonicalSource, name });
    return textResult(`Confirmation requested for local skill '${name}'. It has not been installed; the user must confirm in Kimi Code Desktop.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/^(?:Skill|SKILL\.md)\b/.test(message)) throw new Error(message);
    throw new Error("Skill installation could not be requested. Check that the source is a valid local skill inside this workspace.");
  }
}

async function sendBridge(command: PreviewBridgeCommand): Promise<void> {
  const url = process.env.KIMI_DESKTOP_PREVIEW_BRIDGE;
  if (!url) throw new Error("Kimi Code Desktop preview bridge is unavailable.");
  await new Promise<void>((resolvePromise, reject) => {
    const requestId = randomUUID();
    const socket = new WebSocket(url, { origin: "http://tauri.localhost" });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolvePromise();
    };
    timer = setTimeout(() => finish(new Error("Kimi Code Desktop preview bridge timed out.")), 5_000);
    socket.on("open", () => socket.send(JSON.stringify({ id: requestId, method: "preview.agentCommand", params: command })));
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as { id?: string; error?: { message?: string } };
      if (message.id !== requestId) return;
      finish(message.error ? new Error(message.error.message ?? "Preview command failed.") : undefined);
    });
    socket.on("error", () => finish(new Error("Kimi Code Desktop preview bridge is unavailable.")));
  });
}

async function captureScreenshot(url: string, width: number, height: number): Promise<string> {
  const edge = await findEdge();
  if (!edge) throw new Error("Microsoft Edge is required for agent screenshots on Windows.");
  const root = await mkdtemp(join(tmpdir(), "kimi-preview-"));
  const screenshot = join(root, "preview.png");
  const profile = join(root, "profile");
  try {
    await new Promise<void>((resolvePromise, reject) => execFile(edge, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      "--force-device-scale-factor=1",
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      `--screenshot=${screenshot}`,
      url,
    ], { timeout: 30_000, windowsHide: true }, (error) => error ? reject(error) : resolvePromise()));
    return (await readFile(screenshot)).toString("base64");
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function findEdge(): Promise<string | undefined> {
  const candidates = [
    process.env["PROGRAMFILES(X86)"] && join(process.env["PROGRAMFILES(X86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next standard Windows install location.
    }
  }
  return undefined;
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === resolve(fileURLToPath(import.meta.url))) startPreviewMcp();
