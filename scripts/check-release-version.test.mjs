import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { checkReleaseVersion } from "./check-release-version.mjs";

test("checks every release version anchor and its release note", async () => {
  const root = await mkdtemp(join(tmpdir(), "kimi-release-version-"));
  const files = {
    "apps/desktop/package.json": '{"version":"1.2.3"}',
    "apps/desktop/src-tauri/Cargo.toml": '[package]\nname = "kimi-code-desktop"\nversion = "1.2.3"\n\n[dependencies]\n',
    "apps/desktop/src-tauri/Cargo.lock": 'version = 4\n\n[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "kimi-code-desktop"\nversion = "1.2.3"\n',
    "apps/desktop/src-tauri/tauri.conf.json": '{"version":"1.2.3"}',
    "apps/server/src/acp-client.ts": 'clientInfo: { name: "kimi-code-desktop", version: "1.2.3" },',
    "apps/server/src/preview-mcp.ts": 'serverInfo: { name: "Kimi Code Preview", version: "1.2.3" },',
    "docs/releases/v1.2.3.md": "# Kimi Code 1.2.3\n",
  };
  try {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), contents);
    }
    assert.deepEqual(await checkReleaseVersion(root, "v1.2.3"), {
      version: "1.2.3",
      releaseNotes: "docs/releases/v1.2.3.md",
      anchors: 6,
    });
    await writeFile(join(root, "apps/server/src/preview-mcp.ts"), 'serverInfo: { version: "1.2.4" },');
    await assert.rejects(checkReleaseVersion(root, "1.2.3"), /Preview MCP: 1\.2\.4/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
