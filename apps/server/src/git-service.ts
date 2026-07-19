import { execFile } from "node:child_process";
import { resolve } from "node:path";
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

  async #root(cwd: string): Promise<string> {
    return resolve(await this.#run(resolve(cwd), ["rev-parse", "--show-toplevel"]));
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
