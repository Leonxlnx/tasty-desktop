import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findGitBinary } from "../src/checkpoint-reactor.js";
import { GitService } from "../src/git-service.js";

const exec = promisify(execFile);

describe("GitService", () => {
  it("reports, diffs, stages, unstages, and commits workspace changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-manager-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);
    await writeFile(join(root, "tracked.txt"), "base\nchanged\n", "utf8");
    await writeFile(join(root, "new file.txt"), "new\n", "utf8");

    const service = new GitService(git);
    let status = await service.status(root);
    expect(status.files.map((file) => file.path).sort()).toEqual(["new file.txt", "tracked.txt"]);
    expect((await service.diff(root, "tracked.txt")).diff).toContain("+changed");
    expect((await service.diff(root, "new file.txt")).diff).toContain("+new");

    status = await service.stage(root, ["tracked.txt", "new file.txt"]);
    expect(status.files.every((file) => file.staged)).toBe(true);
    status = await service.unstage(root, ["new file.txt"]);
    expect(status.files.find((file) => file.path === "new file.txt")?.untracked).toBe(true);
    await service.stage(root, ["new file.txt"]);
    const result = await service.commit(root, "manager commit");
    expect(result.commit).toMatch(/^[0-9a-f]+$/);
    expect(result.status.files).toEqual([]);
  });

  it("rejects paths outside the current change set", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-manager-safe-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    const service = new GitService(git);
    await expect(service.stage(root, ["../outside.txt"])).rejects.toThrow("not part of the current change set");
  });

  it("creates an isolated branch worktree and can clean up an unused creation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasty-worktree-source-"));
    const storage = await mkdtemp(join(tmpdir(), "tasty-worktree-store-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);

    const service = new GitService(git);
    const worktree = await service.createWorktree(root, join(storage, "chat-1"), "chat-1");
    expect(worktree).toMatchObject({ sourceCwd: root, branch: "tasty/chat-1" });
    expect((await readFile(join(worktree.cwd, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("base\n");
    expect((await exec(git, ["-C", worktree.cwd, "branch", "--show-current"])).stdout.trim()).toBe(worktree.branch);

    await service.discardNewWorktree(worktree);
    await expect(access(worktree.cwd)).rejects.toThrow();
    expect((await exec(git, ["-C", root, "branch", "--list", worktree.branch])).stdout.trim()).toBe("");
  });
});
