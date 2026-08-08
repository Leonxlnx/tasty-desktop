import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { findGitBinary } from "../src/checkpoint-reactor.js";
import { gitDiffLimits, GitService, parseStatus, requireRemoteUrl } from "../src/git-service.js";

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
    expect((await service.diff(root, "tracked.txt")).truncation).toMatchObject({
      truncated: false,
      omittedBytes: 0,
      omittedLines: 0,
    });

    status = await service.stage(root, ["tracked.txt", "new file.txt"]);
    expect(status.files.every((file) => file.staged)).toBe(true);
    status = await service.unstage(root, ["new file.txt"]);
    expect(status.files.find((file) => file.path === "new file.txt")?.untracked).toBe(true);
    await service.stage(root, ["new file.txt"]);
    const result = await service.commit(root, "manager commit");
    expect(result.commit).toMatch(/^[0-9a-f]+$/);
    expect(result.status.files).toEqual([]);
  });

  it("bounds diff output by bytes and lines before returning it", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-bounded-diff-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "large.txt"), "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);
    const changed = Array.from(
      { length: gitDiffLimits.maxLines + 800 },
      (_, index) => `changed-${index.toString().padStart(4, "0")} ${"x".repeat(180)}`,
    ).join("\n");
    await writeFile(join(root, "large.txt"), `${changed}\n`, "utf8");

    const result = await new GitService(git).diff(root, "large.txt");
    expect(Buffer.byteLength(result.diff, "utf8")).toBeLessThanOrEqual(gitDiffLimits.maxBytes);
    expect(result.diff.split("\n").filter((line, index, lines) => index < lines.length - 1 || line).length)
      .toBeLessThanOrEqual(gitDiffLimits.maxLines);
    expect(result.truncation).toMatchObject({
      truncated: true,
      maxBytes: gitDiffLimits.maxBytes,
      maxLines: gitDiffLimits.maxLines,
      returnedBytes: Buffer.byteLength(result.diff, "utf8"),
    });
    expect(result.truncation.omittedBytes).toBeGreaterThan(0);
    expect(result.truncation.omittedLines).toBeGreaterThan(0);
  });

  it("enforces the byte bound even when a diff contains one very long line", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-byte-bounded-diff-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "wide.txt"), "base\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);
    await writeFile(join(root, "wide.txt"), `${"é".repeat(gitDiffLimits.maxBytes)}\n`, "utf8");

    const result = await new GitService(git).diff(root, "wide.txt");
    expect(Buffer.byteLength(result.diff, "utf8")).toBeLessThanOrEqual(gitDiffLimits.maxBytes);
    expect(result.diff).not.toContain("�");
    expect(result.truncation.truncated).toBe(true);
    expect(result.truncation.omittedBytes).toBeGreaterThan(0);
  });

  it("rejects paths outside the current change set", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-manager-safe-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    const service = new GitService(git);
    await expect(service.stage(root, ["../outside.txt"])).rejects.toThrow("not part of the current change set");
  });

  it("fully unstages both sides of a rename", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-rename-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "old.txt"), "renamed\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    await exec(git, ["-C", root, "commit", "-m", "base"]);
    await rename(join(root, "old.txt"), join(root, "new.txt"));
    await exec(git, ["-C", root, "add", "-A"]);

    const service = new GitService(git);
    const staged = await service.status(root);
    expect(staged.files).toContainEqual(expect.objectContaining({ path: "new.txt", originalPath: "old.txt", staged: true }));
    const unstaged = await service.unstage(root, ["new.txt"]);

    expect(unstaged.files.some((file) => file.staged)).toBe(false);
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("renamed\n");
    await expect(access(join(root, "old.txt"))).rejects.toThrow();
  });

  it("bounds a stalled Git network request", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-timeout-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    const stalled = createServer(() => undefined);
    await new Promise<void>((resolve) => stalled.listen(0, "127.0.0.1", resolve));
    const address = stalled.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP test address");
    await exec(git, ["-C", root, "remote", "add", "origin", `http://127.0.0.1:${address.port}/repo.git`]);

    try {
      await expect(new GitService(git, 100).fetch(root, "origin")).rejects.toThrow("Git request timed out");
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve, reject) => stalled.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("bounds GitHub CLI requests and disables interactive prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-gh-timeout-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await writeFile(join(root, "pr"), [
      "if (process.env.GIT_TERMINAL_PROMPT !== '0' || process.env.GH_PROMPT_DISABLED !== '1') process.exit(2);",
      "setInterval(() => undefined, 1_000);",
    ].join("\n"), "utf8");
    const previous = process.env.GH_BINARY;
    process.env.GH_BINARY = process.execPath;

    try {
      await expect(new GitService(git, 100).createPullRequest(root, "Title", "Body", false))
        .rejects.toThrow("GitHub CLI request timed out");
    } finally {
      if (previous === undefined) delete process.env.GH_BINARY;
      else process.env.GH_BINARY = previous;
    }
  });

  it("disables interactive prompts in Git subprocesses", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-git-noninteractive-"));
    const git = findGitBinary();
    await exec(git, ["-C", root, "init"]);
    await exec(git, ["-C", root, "config", "user.name", "Test"]);
    await exec(git, ["-C", root, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "content\n", "utf8");
    await exec(git, ["-C", root, "add", "."]);
    const hook = join(root, ".git", "hooks", "pre-commit");
    await writeFile(hook, [
      "#!/bin/sh",
      "test \"$GIT_TERMINAL_PROMPT\" = 0 || exit 10",
      "test \"$GCM_INTERACTIVE\" = Never || exit 11",
      "test \"$GCM_GUI_PROMPT\" = 0 || exit 12",
      "test \"$SSH_ASKPASS_REQUIRE\" = never || exit 13",
      "test -n \"$GIT_ASKPASS\" || exit 14",
      "case \"$GIT_SSH_COMMAND\" in *BatchMode=yes*NumberOfPasswordPrompts=0*ConnectTimeout=10*ConnectionAttempts=1*StrictHostKeyChecking=yes*) ;; *) exit 15 ;; esac",
      "",
    ].join("\n"), "utf8");
    await chmod(hook, 0o755);

    await expect(new GitService(git).commit(root, "noninteractive")).resolves.toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]+$/) });
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
    await expect(service.createWorktree(root, join(storage, "chat-1"), "chat-1")).resolves.toEqual(worktree);
    await writeFile(join(worktree.cwd, "tracked.txt"), "partial checkout\n", "utf8");
    await expect(service.createWorktree(root, join(storage, "chat-1"), "chat-1")).rejects.toThrow("worktree target already exists");
    expect(await readFile(join(worktree.cwd, "tracked.txt"), "utf8")).toBe("partial checkout\n");
    await writeFile(join(worktree.cwd, "tracked.txt"), "base\n", "utf8");
    expect(await service.workspaceIdentity(worktree.cwd)).toMatchObject({
      root: await realpath(worktree.cwd),
      commonDir: (await service.workspaceIdentity(root)).commonDir,
    });
    expect((await readFile(join(worktree.cwd, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("base\n");
    expect((await exec(git, ["-C", worktree.cwd, "branch", "--show-current"])).stdout.trim()).toBe(worktree.branch);

    await service.discardNewWorktree(worktree);
    await expect(service.discardNewWorktree(worktree)).resolves.toBeUndefined();
    await expect(access(worktree.cwd)).rejects.toThrow();
    expect((await exec(git, ["-C", root, "branch", "--list", worktree.branch])).stdout.trim()).toBe("");
  });
});
