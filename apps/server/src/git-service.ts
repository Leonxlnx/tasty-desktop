import { execFile } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type GitFile = {
  path: string;
  originalPath?: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  indexStatus: string;
  worktreeStatus: string;
};

export type GitStatus = {
  root: string;
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
};

export type GitRepository = { current: string; branches: string[]; remotes: Array<{ name: string; url: string }> };

export class GitService {
  readonly #git: string;

  constructor(gitBinary: string) {
    this.#git = resolve(gitBinary);
  }

  async status(cwd: string): Promise<GitStatus> {
    const root = await this.#root(cwd);
    const output = await this.#run(root, ["status", "--porcelain=v2", "--branch", "-z"]);
    return parseStatus(root, output);
  }

  async diff(cwd: string, path: string): Promise<{ path: string; diff: string }> {
    const status = await this.status(cwd);
    const file = requireChangedPath(status, path);
    const sections: string[] = [];
    if (file.staged) sections.push(await this.#run(status.root, ["diff", "--cached", "--", file.path], false));
    if (file.unstaged && !file.untracked) sections.push(await this.#run(status.root, ["diff", "--", file.path], false));
    if (file.untracked) sections.push(await this.#runAllowOne(status.root, ["diff", "--no-index", "--", "NUL", file.path]));
    return { path: file.path, diff: sections.filter(Boolean).join("\n") };
  }

  async stage(cwd: string, paths: string[]): Promise<GitStatus> {
    const status = await this.status(cwd);
    const safe = uniqueChangedPaths(status, paths);
    await this.#run(status.root, ["add", "--", ...safe]);
    return this.status(status.root);
  }

  async unstage(cwd: string, paths: string[]): Promise<GitStatus> {
    const status = await this.status(cwd);
    const safe = uniqueChangedPaths(status, paths);
    await this.#run(status.root, ["reset", "--quiet", "--", ...safe]);
    return this.status(status.root);
  }

  async commit(cwd: string, message: string): Promise<{ commit: string; status: GitStatus }> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error("Commit message is required");
    const status = await this.status(cwd);
    if (!status.files.some((file) => file.staged)) throw new Error("Stage at least one file before committing");
    await this.#run(status.root, ["commit", "-m", trimmed]);
    const commit = await this.#run(status.root, ["rev-parse", "--short", "HEAD"]);
    return { commit, status: await this.status(status.root) };
  }

  async repository(cwd: string): Promise<GitRepository> {
    const status = await this.status(cwd);
    const branches = (await this.#run(status.root, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split(/\r?\n/).filter(Boolean);
    const remoteLines = (await this.#run(status.root, ["remote", "-v"])).split(/\r?\n/).filter((line) => line.endsWith(" (fetch)"));
    return {
      current: status.branch,
      branches,
      remotes: remoteLines.flatMap((line) => {
        const match = /^(\S+)\s+(.+)\s+\(fetch\)$/.exec(line);
        return match ? [{ name: match[1]!, url: match[2]! }] : [];
      }),
    };
  }

  async createBranch(cwd: string, branch: string): Promise<GitStatus> {
    const status = await this.status(cwd);
    await this.#validateBranch(status.root, branch);
    await this.#run(status.root, ["switch", "-c", branch]);
    return this.status(status.root);
  }

  async switchBranch(cwd: string, branch: string): Promise<GitStatus> {
    const status = await this.status(cwd);
    await this.#validateBranch(status.root, branch);
    const branches = (await this.repository(status.root)).branches;
    if (!branches.includes(branch)) throw new Error("Choose an existing local branch");
    await this.#run(status.root, ["switch", branch]);
    return this.status(status.root);
  }

  async push(cwd: string, remote = "origin"): Promise<GitStatus> {
    const status = await this.status(cwd);
    requireRemoteName(remote);
    if (status.branch === "HEAD" || status.branch === "(detached)") throw new Error("Create or switch to a branch before pushing");
    if (status.upstream) await this.#run(status.root, ["push"]);
    else {
      await this.#run(status.root, ["remote", "get-url", remote]);
      await this.#run(status.root, ["push", "--set-upstream", remote, status.branch]);
    }
    return this.status(status.root);
  }

  async pull(cwd: string): Promise<GitStatus> {
    const status = await this.status(cwd);
    if (!status.upstream) throw new Error("Push this branch once before pulling");
    await this.#run(status.root, ["pull", "--ff-only"]);
    return this.status(status.root);
  }

  async clone(url: string, destination: string): Promise<GitStatus> {
    requireRemoteUrl(url);
    const target = resolve(destination);
    await mkdir(dirname(target), { recursive: true });
    await this.#run(dirname(target), ["clone", "--", url, target]);
    return this.status(target);
  }

  async publish(cwd: string, name: string, visibility: "private" | "public"): Promise<GitStatus> {
    const status = await this.status(cwd);
    if (!/^(?:[a-zA-Z0-9_.-]+\/)?[a-zA-Z0-9_.-]+$/.test(name)) throw new Error("Repository name must be owner/name or name");
    if ((await this.repository(status.root)).remotes.some((remote) => remote.name === "origin")) throw new Error("This repository already has an origin remote");
    await this.#runGh(status.root, ["repo", "create", name, `--${visibility}`, "--source", status.root, "--remote", "origin", "--push"]);
    return this.status(status.root);
  }

  async createPullRequest(cwd: string, title: string, body: string, draft: boolean): Promise<{ url: string }> {
    const status = await this.status(cwd);
    const args = ["pr", "create", "--title", title.trim(), "--body", body.trim() || "Created with Kimi Code Desktop"];
    if (draft) args.push("--draft");
    const url = await this.#runGh(status.root, args);
    if (!/^https:\/\//.test(url)) throw new Error("GitHub CLI did not return a pull request URL");
    return { url };
  }

  async createWorktree(cwd: string, destination: string, id: string): Promise<{ cwd: string; sourceCwd: string; branch: string }> {
    const sourceCwd = await this.#root(cwd);
    const target = resolve(destination);
    const branch = `kimi/${id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40)}`;
    await mkdir(dirname(target), { recursive: true });
    await this.#run(sourceCwd, ["worktree", "add", "-b", branch, target, "HEAD"]);
    return { cwd: await realpath(target), sourceCwd, branch };
  }

  async discardNewWorktree(worktree: { cwd: string; sourceCwd: string; branch: string }): Promise<void> {
    await this.#run(worktree.sourceCwd, ["worktree", "remove", "--force", resolve(worktree.cwd)]);
    await this.#run(worktree.sourceCwd, ["branch", "-D", worktree.branch]);
  }

  async #root(cwd: string): Promise<string> {
    return resolve(await this.#run(resolve(cwd), ["rev-parse", "--show-toplevel"]));
  }

  async #validateBranch(cwd: string, branch: string): Promise<void> {
    if (!branch.trim() || branch.startsWith("-") || branch.length > 200) throw new Error("Enter a valid branch name");
    await this.#run(cwd, ["check-ref-format", "--branch", branch]);
  }

  async #run(cwd: string, args: string[], trim = true): Promise<string> {
    const result = await exec(this.#git, ["-C", resolve(cwd), ...args], { windowsHide: true, maxBuffer: 100 * 1024 * 1024 });
    return trim ? result.stdout.trim() : result.stdout;
  }

  async #runAllowOne(cwd: string, args: string[]): Promise<string> {
    try {
      return await this.#run(cwd, args, false);
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      if (failure.code === 1) return failure.stdout ?? "";
      throw error;
    }
  }

  async #runGh(cwd: string, args: string[]): Promise<string> {
    try {
      const result = await exec(process.env.GH_BINARY ?? "gh", args, { cwd: resolve(cwd), windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      return result.stdout.trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Install and sign in to GitHub CLI to use publishing and pull requests");
      throw error;
    }
  }
}

export function requireRemoteUrl(url: string): void {
  if (!/^(?:https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[\w.-]+:[^\s]+)$/.test(url)) throw new Error("Clone URL must use HTTPS or SSH");
}

function requireRemoteName(remote: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(remote)) throw new Error("Invalid Git remote name");
}

export function parseStatus(root: string, output: string): GitStatus {
  const records = output.split("\0").filter(Boolean);
  const files: GitFile[] = [];
  let branch = "HEAD";
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record.startsWith("# branch.head ")) branch = record.slice(14);
    else if (record.startsWith("# branch.upstream ")) upstream = record.slice(18);
    else if (record.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(record);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    } else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const renamed = record.startsWith("2 ");
      const parts = record.split(" ");
      const xy = parts[1] ?? "..";
      const path = parts.slice(renamed ? 9 : 8).join(" ");
      const originalPath = renamed ? records[++index] : undefined;
      files.push(fileStatus(path, xy, false, originalPath));
    } else if (record.startsWith("u ")) {
      const parts = record.split(" ");
      files.push(fileStatus(parts.slice(10).join(" "), parts[1] ?? "UU", false));
    } else if (record.startsWith("? ")) {
      files.push(fileStatus(record.slice(2), "??", true));
    }
  }
  return { root: resolve(root), branch, ...(upstream ? { upstream } : {}), ahead, behind, files };
}

function fileStatus(path: string, xy: string, untracked: boolean, originalPath?: string): GitFile {
  const indexStatus = xy[0] ?? ".";
  const worktreeStatus = xy[1] ?? ".";
  return {
    path,
    ...(originalPath ? { originalPath } : {}),
    staged: !untracked && indexStatus !== ".",
    unstaged: untracked || worktreeStatus !== ".",
    untracked,
    indexStatus,
    worktreeStatus,
  };
}

function requireChangedPath(status: GitStatus, path: string): GitFile {
  const file = status.files.find((candidate) => candidate.path === path);
  if (!file) throw new Error("Git path is not part of the current change set");
  return file;
}

function uniqueChangedPaths(status: GitStatus, paths: string[]): string[] {
  const safe = [...new Set(paths.map((path) => requireChangedPath(status, path).path))];
  if (!safe.length) throw new Error("Select at least one changed file");
  return safe;
}
