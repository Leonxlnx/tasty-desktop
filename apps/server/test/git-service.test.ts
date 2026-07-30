import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findGitBinary } from "../src/checkpoint-reactor.js";
import { GitService, parseStatus, requireRemoteUrl } from "../src/git-service.js";

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

  it("reports porcelain-v2 unmerged records", () => {
    const status = parseStatus("C:\\repo", "# branch.head main\0u UU N... 100644 100644 100644 100644 a b c conflicted file.txt\0");

    expect(status.files).toEqual([expect.objectContaining({
      path: "conflicted file.txt",
      staged: true,
      unstaged: true,
      indexStatus: "U",
      worktreeStatus: "U",
    })]);
  });

  it("manages local and tracking branches without ignoring the selected remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-branches-"));
    const remote = await mkdtemp(join(tmpdir(), "kimi-git-remote-"));
    const backup = await mkdtemp(join(tmpdir(), "kimi-git-backup-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);
    await exec(git, ["-C", remote, "init", "--bare"]);
    await exec(git, ["-C", backup, "init", "--bare"]);
    await exec(git, ["-C", root, "remote", "add", "origin", remote]);
    await exec(git, ["-C", root, "remote", "add", "backup", backup]);

    const service = new GitService(git);
    const initial = await service.status(root);
    expect((await service.push(root, "origin")).upstream).toBe(`origin/${initial.branch}`);
    await exec(git, ["-C", root, "branch", "remote-only"]);
    await exec(git, ["-C", root, "push", "origin", "remote-only"]);
    await exec(git, ["-C", root, "branch", "-D", "remote-only"]);
    await exec(git, ["-C", root, "branch", "stale"]);
    await exec(git, ["-C", root, "push", "origin", "stale"]);
    await exec(git, ["-C", root, "branch", "-D", "stale"]);
    await exec(git, ["--git-dir", remote, "update-ref", "-d", "refs/heads/stale"]);

    const repository = await service.fetch(root, "origin");
    expect(repository).toMatchObject({ current: initial.branch, detached: false, unborn: false, upstream: `origin/${initial.branch}` });
    expect(repository.localBranches).toContainEqual(expect.objectContaining({ name: initial.branch, current: true, upstream: `origin/${initial.branch}`, ahead: 0, behind: 0 }));
    expect(repository.remoteBranches).toContainEqual({ name: "remote-only", fullName: "origin/remote-only", remote: "origin" });
    expect(repository.remoteBranches.some((branch) => branch.name === "stale")).toBe(false);

    await exec(git, ["-C", root, "branch", "origin/remote-only"]);
    expect((await service.checkoutRemoteBranch(root, "origin", "remote-only", "feature/tracked")).upstream).toMatch(/origin\/remote-only$/);
    expect((await service.renameBranch(root, "feature/tracked", "feature/renamed")).current).toBe("feature/renamed");
    expect((await service.switchBranch(root, initial.branch)).branch).toBe(initial.branch);
    expect((await service.deleteBranch(root, "feature/renamed")).branches).not.toContain("feature/renamed");

    await service.push(root, "backup");
    expect((await exec(git, ["--git-dir", backup, "show-ref", "--verify", `refs/heads/${initial.branch}`])).stdout).toContain(initial.branch);
    await exec(git, ["-C", root, "fetch", "backup"]);
    await exec(git, ["-C", root, "branch", "--set-upstream-to", `backup/${initial.branch}`]);
    await expect(service.checkoutRemoteBranch(root, "origin", "missing")).rejects.toThrow("existing remote branch");
    await exec(git, ["-C", root, "remote", "remove", "origin"]);
    await service.push(root);
    await expect(service.switchBranch(root, "missing")).rejects.toThrow("existing local branch");
    await expect(service.fetch(root, "missing")).rejects.toThrow("existing Git remote");
    await expect(service.fetch(root, "--all")).rejects.toThrow("Invalid Git remote name");

    expect((await service.createBranch(root, "feature/unmerged")).branch).toBe("feature/unmerged");
    await writeFile(join(root, "unmerged.txt"), "not merged\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "unmerged"]);
    await service.switchBranch(root, initial.branch);
    await expect(service.deleteBranch(root, "feature/unmerged")).rejects.toThrow("not fully merged");
    expect((await service.repository(root)).branches).toContain("feature/unmerged");
  });

  it("represents and safely renames an unborn branch", async () => {
    expect(parseStatus("C:\\repo", "# branch.oid (initial)\0# branch.head main\0")).toMatchObject({ branch: "main", unborn: true });
    const root = await mkdtemp(join(tmpdir(), "kimi-git-unborn-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init", "-b", "main"]);
    const service = new GitService(git);
    expect(await service.repository(root)).toMatchObject({ current: "main", unborn: true, branches: ["main"] });
    expect(await service.renameBranch(root, "main", "next")).toMatchObject({ current: "next", unborn: true, branches: ["next"] });
    await expect(service.push(root)).rejects.toThrow("first commit");
  });

  it("accepts only explicit HTTPS or SSH clone URLs", () => {
    expect(() => requireRemoteUrl("https://github.com/example/repo.git")).not.toThrow();
    expect(() => requireRemoteUrl("git@github.com:example/repo.git")).not.toThrow();
    expect(() => requireRemoteUrl("C:\\private\\repo")).toThrow("HTTPS or SSH");
    expect(() => requireRemoteUrl("--upload-pack=evil")).toThrow("HTTPS or SSH");
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
    expect(worktree).toMatchObject({ sourceCwd: await realpath(root), branch: "kimi/chat-1" });
    expect((await readFile(join(worktree.cwd, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("base\n");
    expect((await exec(git, ["-C", worktree.cwd, "branch", "--show-current"])).stdout.trim()).toBe(worktree.branch);

    await service.discardNewWorktree(worktree);
    await expect(access(worktree.cwd)).rejects.toThrow();
    expect((await exec(git, ["-C", root, "branch", "--list", worktree.branch])).stdout.trim()).toBe("");
  });
});
