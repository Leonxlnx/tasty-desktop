import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CheckpointReactor, findGitBinary, parseCheckpointPatch } from "../src/checkpoint-reactor.js";

const exec = promisify(execFile);

describe("CheckpointReactor", () => {
  it("reverts one turn while preserving pre-existing dirt", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-checkpoint-repo-"));
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-checkpoint-data-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    const file = join(root, "notes.txt");
    await writeFile(file, "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);
    await writeFile(file, "base\nuser dirt\n", "utf8");

    const reactor = new CheckpointReactor(git, dataHome);
    const before = await reactor.capture("thread", "turn", "before", root);
    await writeFile(file, "base\nuser dirt\nagent change\n", "utf8");
    await writeFile(join(root, "agent-created.txt"), "created\n", "utf8");
    const after = await reactor.capture("thread", "turn", "after", root);
    expect(before && after).toBeTruthy();
    await reactor.revert("thread", "turn", before!, after!);

    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("base\nuser dirt\n");
    await expect(readFile(join(root, "agent-created.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await writeFile(file, "base\nuser dirt\nagent change\n", "utf8");
    await expect(reactor.revert("thread", "turn", before!, after!)).rejects.toThrow("already reverted");
    expect((await readFile(file, "utf8")).replace(/\r\n/g, "\n")).toBe("base\nuser dirt\nagent change\n");
  });

  it("reviews and reverts one hunk without removing another turn change", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasty-checkpoint-review-"));
    const dataHome = await mkdtemp(join(tmpdir(), "tasty-checkpoint-review-data-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    const file = join(root, "review.txt");
    const base = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
    await writeFile(file, `${base.join("\n")}\n`, "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);

    const reactor = new CheckpointReactor(git, dataHome);
    const before = await reactor.capture("thread", "review-turn", "before", root);
    const changed = [...base];
    changed[1] = "agent changed line 2";
    changed[27] = "agent changed line 28";
    await writeFile(file, `${changed.join("\n")}\n`, "utf8");
    const after = await reactor.capture("thread", "review-turn", "after", root);
    const review = await reactor.review(before!, after!);

    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ path: "review.txt", binary: false, canRevertHunks: true });
    expect(review[0]!.hunks).toHaveLength(2);
    await reactor.revertPart("thread", "review-turn", before!, after!, "review.txt", 0);
    const result = (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
    expect(result).toContain("line 2\n");
    expect(result).toContain("agent changed line 28\n");
  });

  it("keeps rename diffs reviewable but limits them to whole-file revert", () => {
    const [file] = parseCheckpointPatch("diff --git a/old.txt b/new.txt\nsimilarity index 80%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n");
    expect(file).toMatchObject({ path: "new.txt", canRevertHunks: false, hunks: [{ index: 0 }] });
  });
});
