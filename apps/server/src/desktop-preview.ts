import { createRequire as nodeCreateRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { McpServer } from "@agentclientprotocol/sdk";

export const desktopPreviewMcpName = "kimi-desktop-preview";

export type DesktopPreviewCommand = {
  action: "open" | "resize";
  url?: string;
  panelWidth?: number;
  viewportWidth?: number;
  viewportHeight?: number;
};

export function normalizeDesktopPreviewUrl(value: string): string | undefined {
  let candidate = value.trim();
  if (/^\d{2,5}$/.test(candidate)) candidate = `http://localhost:${candidate}`;
  else if (/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/|$)/i.test(candidate)) candidate = `http://${candidate}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase())) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function clampPreviewPanelWidth(value: unknown): number {
  return Math.round(Math.min(1_200, Math.max(320, numeric(value, 960))));
}

export function clampPreviewViewportWidth(value: unknown): number {
  return Math.round(Math.min(1_920, Math.max(320, numeric(value, 1_440))));
}

export function clampPreviewViewportHeight(value: unknown): number {
  return Math.round(Math.min(1_200, Math.max(240, numeric(value, 900))));
}

export function createDesktopPreviewMcpServer(currentModuleUrl: string, bridgeUrl: string): McpServer {
  const currentFile = fileURLToPath(currentModuleUrl);
  const sourceRuntime = currentFile.endsWith(".ts");
  const script = join(dirname(currentFile), sourceRuntime ? "preview-mcp.ts" : "preview-mcp.mjs");
  const args = sourceRuntime
    ? ["--import", pathToFileURL(nodeCreateRequire(import.meta.url).resolve("tsx")).href, script]
    : [script];
  return {
    name: desktopPreviewMcpName,
    command: process.execPath,
    args,
    env: [{ name: "KIMI_DESKTOP_PREVIEW_BRIDGE", value: bridgeUrl }],
  };
}

export function isPreviewBridgeRequest(requestUrl: string | undefined, expectedToken: string): boolean {
  try {
    return new URL(requestUrl ?? "", "ws://127.0.0.1").searchParams.get("preview-token") === expectedToken;
  } catch {
    return false;
  }
}

function numeric(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
