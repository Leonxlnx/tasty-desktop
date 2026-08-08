import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
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
    await expect(readFile(join(dataHome, "checkpoints", "thread", "turn", "revert.patch"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const beforeFailure = await reactor.capture("thread", "failed-turn", "before", root);
    await writeFile(file, "base\nuser dirt\nfailed agent change\n", "utf8");
    const afterFailure = await reactor.capture("thread", "failed-turn", "after", root);
    const capture = reactor.capture.bind(reactor);
    const captureSpy = vi.spyOn(reactor, "capture").mockImplementation(async (...args) => {
      if (args[2] === "reverted") throw new Error("reverted capture failed");
      return capture(...args);
    });
    await expect(reactor.revert("thread", "failed-turn", beforeFailure!, afterFailure!)).rejects.toThrow("reverted capture failed");
    captureSpy.mockRestore();
    await expect(readFile(join(dataHome, "checkpoints", "thread", "failed-turn", "revert.patch"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const beforeCleanupFailure = await reactor.capture("thread", "failed-cleanup-turn", "before", root);
    await writeFile(file, "base\nuser dirt\ncleanup failure change\n", "utf8");
    const afterCleanupFailure = await reactor.capture("thread", "failed-cleanup-turn", "after", root);
    const cleanupPatch = join(dataHome, "checkpoints", "thread", "failed-cleanup-turn", "revert.patch");
    const cleanupSpy = vi.spyOn(reactor, "capture").mockImplementation(async (...args) => {
      if (args[2] !== "reverted") return capture(...args);
      await rm(cleanupPatch, { force: true });
      await mkdir(cleanupPatch);
      await writeFile(join(cleanupPatch, "blocked"), "blocked", "utf8");
      throw new Error("original revert error");
    });
    await expect(reactor.revert("thread", "failed-cleanup-turn", beforeCleanupFailure!, afterCleanupFailure!)).rejects.toThrow("original revert error");
    cleanupSpy.mockRestore();
    await rm(cleanupPatch, { recursive: true, force: true });

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

  it("refuses full and partial reverts after the Git branch changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-checkpoint-branch-"));
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-checkpoint-branch-data-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init", "-b", "main"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    const file = join(root, "branch.txt");
    await writeFile(file, "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);

    const reactor = new CheckpointReactor(git, dataHome);
    const before = await reactor.capture("thread", "branch-turn", "before", root);
    await writeFile(file, "agent change\n", "utf8");
    const after = await reactor.capture("thread", "branch-turn", "after", root);
    expect(after).toMatchObject({ branch: "refs/heads/main", head: expect.stringMatching(/^[0-9a-f]+$/), tree: expect.stringMatching(/^[0-9a-f]+$/) });
    await exec(git, ["-C", root, "switch", "-c", "other"]);

    await expect(reactor.revert("thread", "branch-turn", before!, after!)).rejects.toThrow("Git branch or HEAD changed");
    await expect(reactor.revertPart("thread", "branch-turn", before!, after!, "branch.txt")).rejects.toThrow("Git branch or HEAD changed");
    expect(await readFile(file, "utf8")).toBe("agent change\n");
  });

  it("refuses to worktree-revert a turn that moved Git HEAD", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-checkpoint-head-"));
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-checkpoint-head-data-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    const file = join(root, "head.txt");
    await writeFile(file, "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);

    const reactor = new CheckpointReactor(git, dataHome);
    const before = await reactor.capture("thread", "head-turn", "before", root);
    await writeFile(file, "agent commit\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "agent"]);
    const after = await reactor.capture("thread", "head-turn", "after", root);

    await expect(reactor.revert("thread", "head-turn", before!, after!)).rejects.toThrow("task changed Git HEAD");
    await expect(reactor.revertPart("thread", "head-turn", before!, after!, "head.txt")).rejects.toThrow("task changed Git HEAD");
    expect((await exec(git, ["-C", root, "rev-parse", "HEAD"])).stdout.trim()).toBe(after!.head);
    expect(await readFile(file, "utf8")).toBe("agent commit\n");
  });

  it("refuses index changes during or after a captured turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-checkpoint-index-"));
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-checkpoint-index-data-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    const file = join(root, "index.txt");
    await writeFile(file, "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);

    const reactor = new CheckpointReactor(git, dataHome);
    const stagedBefore = await reactor.capture("thread", "staged-turn", "before", root);
    await writeFile(file, "staged by task\n", "utf8");
    await exec(git, ["-C", root, "add", file]);
    const stagedAfter = await reactor.capture("thread", "staged-turn", "after", root);
    await expect(reactor.revert("thread", "staged-turn", stagedBefore!, stagedAfter!)).rejects.toThrow("task changed the Git index");
    await expect(reactor.revertPart("thread", "staged-turn", stagedBefore!, stagedAfter!, "index.txt")).rejects.toThrow("task changed the Git index");

    await exec(git, ["-C", root, "reset", "--quiet"]);
    const driftBefore = await reactor.capture("thread", "index-drift-turn", "before", root);
    await writeFile(file, "unstaged task change\n", "utf8");
    const driftAfter = await reactor.capture("thread", "index-drift-turn", "after", root);
    await exec(git, ["-C", root, "add", file]);
    await expect(reactor.revert("thread", "index-drift-turn", driftBefore!, driftAfter!)).rejects.toThrow("Git staging changed after this task");
    await expect(reactor.revertPart("thread", "index-drift-turn", driftBefore!, driftAfter!, "index.txt")).rejects.toThrow("Git staging changed after this task");
    expect((await exec(git, ["-C", root, "diff", "--cached", "--name-only"])).stdout.trim()).toBe("index.txt");
    expect(await readFile(file, "utf8")).toBe("unstaged task change\n");
  });

  it("preserves workspace changes made after a checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-checkpoint-drift-"));
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-checkpoint-drift-data-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    const file = join(root, "drift.txt");
    await writeFile(file, "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);

    const reactor = new CheckpointReactor(git, dataHome);
    const before = await reactor.capture("thread", "drift-turn", "before", root);
    await writeFile(file, "agent change\n", "utf8");
    const after = await reactor.capture("thread", "drift-turn", "after", root);
    await writeFile(file, "agent change\nmanual follow-up\n", "utf8");

    await expect(reactor.revert("thread", "drift-turn", before!, after!)).rejects.toThrow("Workspace changed after this task");
    await expect(reactor.revertPart("thread", "drift-turn", before!, after!, "drift.txt")).rejects.toThrow("Workspace changed after this task");
    expect(await readFile(file, "utf8")).toBe("agent change\nmanual follow-up\n");
  });

  it("does not guess when legacy checkpoints lack captured Git state", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-checkpoint-legacy-"));
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-checkpoint-legacy-data-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    const file = join(root, "legacy.txt");
    await writeFile(file, "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);

    const reactor = new CheckpointReactor(git, dataHome);
    const before = (await reactor.capture("thread", "legacy-turn", "before", root))!;
    await writeFile(file, "changed\n", "utf8");
    const after = (await reactor.capture("thread", "legacy-turn", "after", root))!;
    const { branch: _beforeBranch, head: _beforeHead, tree: _beforeTree, index: _beforeIndex, ...legacyBefore } = before;
    const { branch: _afterBranch, head: _afterHead, tree: _afterTree, index: _afterIndex, ...legacyAfter } = after;

    await expect(reactor.revert("thread", "legacy-turn", legacyBefore, legacyAfter)).rejects.toThrow("legacy checkpoint");
    await expect(reactor.revertPart("thread", "legacy-turn", legacyBefore, legacyAfter, "legacy.txt")).rejects.toThrow("legacy checkpoint");
    expect(await readFile(file, "utf8")).toBe("changed\n");
  });

  it("keeps rename diffs reviewable but limits them to whole-file revert", () => {
    const [file] = parseCheckpointPatch("diff --git a/old.txt b/new.txt\nsimilarity index 80%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n");
    expect(file).toMatchObject({ path: "new.txt", canRevertHunks: false, hunks: [{ index: 0 }] });
  });
});
