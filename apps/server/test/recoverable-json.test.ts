import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRecoverableJson, writeRecoverableJson } from "../src/recoverable-json.js";

describe("recoverable JSON persistence", () => {
  const parseRecord = (value: unknown) => value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

  it("atomically rotates a valid backup and recovers a corrupt primary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-recoverable-json-"));
    const path = join(dir, "pending.json");
    await writeRecoverableJson(path, { generation: 1 });
    await writeRecoverableJson(path, { generation: 2 });
    await writeFile(path, "{truncated", "utf8");

    const loaded = await readRecoverableJson(path, parseRecord);
    expect(loaded).toEqual({ value: { generation: 1 }, recovered: true, corrupt: true });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ generation: 1 });
  });

  it("recovers the backup left between primary and replacement renames", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-recoverable-json-backup-"));
    const path = join(dir, "pending.json");
    await writeRecoverableJson(path, { queued: true });
    await rename(path, `${path}.bak`);

    const loaded = await readRecoverableJson(path, parseRecord);
    expect(loaded).toEqual({ value: { queued: true }, recovered: true, corrupt: false });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ queued: true });
  });
});
