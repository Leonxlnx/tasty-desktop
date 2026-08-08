import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { copyReviewedLicenses, recreateBundleAssets } from "./prepare-bundle.mjs";

test("recreates bundle assets without stale files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kimi-bundle-assets-"));
  const stale = join(directory, "stale-sentinel.txt");
  try {
    await writeFile(stale, "must not ship");
    await recreateBundleAssets(directory);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses to bundle unexpected license-root files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kimi-bundle-licenses-"));
  const source = join(directory, "source");
  const destination = join(directory, "destination");
  try {
    await mkdir(source);
    await Promise.all([
      mkdir(join(source, "texts")),
      mkdir(join(source, "upstream")),
      writeFile(join(source, "inventory.json"), "{}\n"),
      writeFile(join(source, "notes.txt"), "must not ship"),
    ]);
    await assert.rejects(copyReviewedLicenses(source, destination), /unreferenced notes\.txt/);
    await assert.rejects(readdir(destination), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
