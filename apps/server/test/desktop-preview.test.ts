import { describe, expect, it } from "vitest";
import {
  clampPreviewPanelWidth,
  clampPreviewViewportHeight,
  clampPreviewViewportWidth,
  createDesktopPreviewMcpServer,
  isPreviewBridgeRequest,
  normalizeDesktopPreviewUrl,
} from "../src/desktop-preview.js";

describe("desktop preview bridge", () => {
  it("accepts only local preview URLs", () => {
    expect(normalizeDesktopPreviewUrl("5173")).toBe("http://localhost:5173/");
    expect(normalizeDesktopPreviewUrl("127.0.0.1:3000/app")).toBe("http://127.0.0.1:3000/app");
    expect(normalizeDesktopPreviewUrl("https://example.com")).toBeUndefined();
    expect(normalizeDesktopPreviewUrl("file:///C:/secret.txt")).toBeUndefined();
  });

  it("bounds panel and capture dimensions", () => {
    expect(clampPreviewPanelWidth(100)).toBe(320);
    expect(clampPreviewPanelWidth(2_000)).toBe(1_200);
    expect(clampPreviewViewportWidth(4_000)).toBe(1_920);
    expect(clampPreviewViewportHeight(10)).toBe(240);
  });

  it("attaches the bundled MCP and authenticates its private bridge token", () => {
    const bridge = "ws://127.0.0.1:4317?preview-token=test-token";
    const server = createDesktopPreviewMcpServer("file:///C:/runtime/orchestration-server.mjs", bridge);
    expect(server).toMatchObject({ name: "kimi-desktop-preview", args: [expect.stringMatching(/preview-mcp\.mjs$/)] });
    expect((server as { env?: Array<{ name: string; value: string }> }).env).toEqual([{ name: "KIMI_DESKTOP_PREVIEW_BRIDGE", value: bridge }]);
    expect(isPreviewBridgeRequest("/?preview-token=test-token", "test-token")).toBe(true);
    expect(isPreviewBridgeRequest("/?preview-token=wrong", "test-token")).toBe(false);
  });
});
