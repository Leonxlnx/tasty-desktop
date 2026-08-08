import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const defaultGitTimeoutMs = 5 * 60_000;
export const gitDiffLimits = Object.freeze({ maxBytes: 160_000, maxLines: 1_200 });
const maxGitErrorBytes = 64 * 1024;
const nonInteractiveSshCommand = [
  "ssh",
  "-oBatchMode=yes",
  "-oNumberOfPasswordPrompts=0",
  "-oConnectTimeout=10",
  "-oConnectionAttempts=1",
  "-oServerAliveInterval=10",
  "-oServerAliveCountMax=1",
  "-oStrictHostKeyChecking=yes",
].join(" ");

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
  unborn: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFile[];
};

export type GitWorkspaceIdentity = { root: string; commonDir: string };

export type GitDiffResult = {
  path: string;
  diff: string;
  truncation: {
    truncated: boolean;
    maxBytes: number;
    maxLines: number;
    returnedBytes: number;
    returnedLines: number;
    omittedBytes: number;
    omittedLines: number;
  };
};

export type GitLocalBranch = {
  name: string;
  current: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  upstreamGone: boolean;
};

export type GitRemoteBranch = { name: string; fullName: string; remote: string };

export type GitRepository = {
  current: string;
  detached: boolean;
  unborn: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  branches: string[];
  localBranches: GitLocalBranch[];
  remoteBranches: GitRemoteBranch[];
  remotes: Array<{ name: string; url: string }>;
};

export class GitService {
  readonly #git: string;
  readonly #timeoutMs: number;

  constructor(gitBinary: string, timeoutMs = defaultGitTimeoutMs) {
    this.#git = resolve(gitBinary);
    this.#timeoutMs = timeoutMs;
  }

  async status(cwd: string): Promise<GitStatus> {
    const root = await this.#root(cwd);
    const output = await this.#run(root, ["status", "--porcelain=v2", "--branch", "-z"]);
    return parseStatus(root, output);
  }

  async workspaceIdentity(cwd: string): Promise<GitWorkspaceIdentity> {
    const [root, commonDir] = (await this.#run(resolve(cwd), [
      "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir",
    ])).split(/\r?\n/);
    if (!root || !commonDir) throw new Error("Git did not return a workspace identity");
    return { root: await realpath(root), commonDir: await realpath(commonDir) };
  }

  async diff(cwd: string, path: string): Promise<GitDiffResult> {
    const status = await this.status(cwd);
    const file = requireChangedPath(status, path);
    const output = new BoundedGitDiff(gitDiffLimits.maxBytes, gitDiffLimits.maxLines);
    if (file.staged) await this.#appendDiff(status.root, ["diff", "--cached", "--", file.path], output);
    if (file.unstaged && !file.untracked) await this.#appendDiff(status.root, ["diff", "--", file.path], output);
    if (file.untracked) await this.#appendDiff(status.root, ["diff", "--no-index", "--", "NUL", file.path], output, true);
    return { path: file.path, ...output.result() };
  }

  async stage(cwd: string, paths: string[]): Promise<GitStatus> {
    const status = await this.status(cwd);
    const safe = uniqueChangedPaths(status, paths);
    await this.#run(status.root, ["add", "--", ...safe]);
    return this.status(status.root);
  }

  async unstage(cwd: string, paths: string[]): Promise<GitStatus> {
    const status = await this.status(cwd);
    const safe = uniqueChangedPaths(status, paths, true);
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
    const remoteLines = (await this.#run(status.root, ["remote", "-v"])).split(/\r?\n/).filter((line) => line.endsWith(" (fetch)"));
    const remotes = remoteLines.flatMap((line) => {
      const match = /^(\S+)\s+(.+)\s+\(fetch\)$/.exec(line);
      return match ? [{ name: match[1]!, url: match[2]! }] : [];
    });
    const localBranches = parseLocalBranches(await this.#run(status.root, [
      "for-each-ref",
      "--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)",
      "refs/heads",
    ]), status.branch);
    if (status.unborn && !localBranches.some((branch) => branch.name === status.branch)) {
      localBranches.unshift({ name: status.branch, current: true, ahead: 0, behind: 0, upstreamGone: false });
    }
    const remoteBranches = parseRemoteBranches(await this.#run(status.root, [
      "for-each-ref",
      "--format=%(refname:short)%09%(symref)",
      "refs/remotes",
    ]), remotes.map((remote) => remote.name));
    return {
      current: status.branch,
      detached: status.branch === "HEAD" || status.branch === "(detached)",
      unborn: status.unborn,
      ...(status.upstream ? { upstream: status.upstream } : {}),
      ahead: status.ahead,
      behind: status.behind,
      branches: localBranches.map((branch) => branch.name),
      localBranches,
      remoteBranches,
      remotes,
    };
  }

  async fetch(cwd: string, remote: string): Promise<GitRepository> {
    const status = await this.status(cwd);
    await this.#requireRemote(status.root, remote);
    await this.#run(status.root, ["fetch", "--prune", remote]);
    return this.repository(status.root);
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
    if (!await this.#hasRef(status.root, `refs/heads/${branch}`)) throw new Error("Choose an existing local branch");
    await this.#run(status.root, ["switch", branch]);
    return this.status(status.root);
  }

  async checkoutRemoteBranch(cwd: string, remote: string, branch: string, localBranch = branch): Promise<GitStatus> {
    const status = await this.status(cwd);
    await this.#requireRemote(status.root, remote);
    await this.#validateBranch(status.root, branch);
    await this.#validateBranch(status.root, localBranch);
    if (await this.#hasRef(status.root, `refs/heads/${localBranch}`)) throw new Error("Choose a new local branch name");
    if (!await this.#hasRef(status.root, `refs/remotes/${remote}/${branch}`)) throw new Error(`Fetch ${remote} or choose an existing remote branch`);
    await this.#run(status.root, ["switch", "--track", "-c", localBranch, `refs/remotes/${remote}/${branch}`]);
    await this.#run(status.root, ["config", `branch.${localBranch}.remote`, remote]);
    await this.#run(status.root, ["config", `branch.${localBranch}.merge`, `refs/heads/${branch}`]);
    return this.status(status.root);
  }

  async renameBranch(cwd: string, branch: string, newBranch: string): Promise<GitRepository> {
    const status = await this.status(cwd);
    await this.#validateBranch(status.root, branch);
    await this.#validateBranch(status.root, newBranch);
    if (status.unborn && status.branch === branch) {
      await this.#run(status.root, ["branch", "-m", newBranch]);
      return this.repository(status.root);
    }
    if (!await this.#hasRef(status.root, `refs/heads/${branch}`)) throw new Error("Choose an existing local branch");
    if (await this.#hasRef(status.root, `refs/heads/${newBranch}`)) throw new Error("A local branch already uses that name");
    await this.#run(status.root, ["branch", "-m", branch, newBranch]);
    return this.repository(status.root);
  }

  async deleteBranch(cwd: string, branch: string): Promise<GitRepository> {
    const status = await this.status(cwd);
    await this.#validateBranch(status.root, branch);
    if (status.branch === branch) throw new Error("Switch branches before deleting the current branch");
    if (!await this.#hasRef(status.root, `refs/heads/${branch}`)) throw new Error("Choose an existing local branch");
    try {
      await this.#run(status.root, ["branch", "-d", branch]);
    } catch (error) {
      if ((error as Error).message.includes("not fully merged")) throw new Error("Git refused to delete this branch because it is not fully merged");
      throw error;
    }
    return this.repository(status.root);
  }

  async push(cwd: string, remote?: string): Promise<GitStatus> {
    const status = await this.status(cwd);
    if (status.unborn) throw new Error("Create the first commit before pushing");
    if (status.branch === "HEAD" || status.branch === "(detached)") throw new Error("Create or switch to a branch before pushing");
    if (!remote && status.upstream) {
      await this.#run(status.root, ["push"]);
    } else {
      const target = remote ?? "origin";
      await this.#requireRemote(status.root, target);
      await this.#run(status.root, status.upstream
        ? ["push", target, status.branch]
        : ["push", "--set-upstream", target, status.branch]);
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
    const source = await this.workspaceIdentity(cwd);
    const sourceCwd = source.root;
    const target = resolve(destination);
    const branch = `kimi/${id.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 40)}`;
    await mkdir(dirname(target), { recursive: true });
    if (await pathExists(target)) {
      const existing = await this.#managedWorktree(target, source.commonDir, branch, true);
      if (!existing) throw new Error(`Managed worktree target already exists: ${target}`);
      return { cwd: existing, sourceCwd, branch };
    }
    await this.#run(sourceCwd, ["worktree", "prune"]);
    if (await this.#hasRef(sourceCwd, `refs/heads/${branch}`)) {
      await this.#run(sourceCwd, ["branch", "-D", branch]);
    }
    await this.#run(sourceCwd, ["worktree", "add", "-b", branch, target, "HEAD"]);
    return { cwd: await realpath(target), sourceCwd, branch };
  }

  async discardNewWorktree(worktree: { cwd: string; sourceCwd: string; branch: string }): Promise<void> {
    const source = await this.workspaceIdentity(worktree.sourceCwd);
    const target = resolve(worktree.cwd);
    if (await pathExists(target)) {
      const existing = await this.#managedWorktree(target, source.commonDir, worktree.branch, false);
      if (!existing) throw new Error(`Refusing to remove an unowned worktree target: ${target}`);
      await this.#run(source.root, ["worktree", "remove", "--force", existing]);
    }
    await this.#run(source.root, ["worktree", "prune"]);
    if (await this.#hasRef(source.root, `refs/heads/${worktree.branch}`)) {
      await this.#run(source.root, ["branch", "-D", worktree.branch]);
    }
  }

  async #managedWorktree(target: string, sourceCommonDir: string, branch: string, requireClean: boolean): Promise<string | undefined> {
    try {
      const identity = await this.workspaceIdentity(target);
      const canonicalTarget = await realpath(target);
      if (identity.root !== canonicalTarget || identity.commonDir !== sourceCommonDir) return undefined;
      const status = await this.status(canonicalTarget);
      if (status.branch !== branch || status.unborn || (requireClean && status.files.length)) return undefined;
      return canonicalTarget;
    } catch {
      return undefined;
    }
  }

  async #root(cwd: string): Promise<string> {
    return resolve(await this.#run(resolve(cwd), ["rev-parse", "--show-toplevel"]));
  }

  async #validateBranch(cwd: string, branch: string): Promise<void> {
    if (!branch.trim() || branch !== branch.trim() || branch.startsWith("-") || branch.includes("@{") || branch === "HEAD" || branch.length > 200) throw new Error("Enter a valid branch name");
    await this.#run(cwd, ["check-ref-format", "--branch", branch]);
  }

  async #requireRemote(cwd: string, remote: string): Promise<void> {
    requireRemoteName(remote);
    try {
      await this.#run(cwd, ["remote", "get-url", remote]);
    } catch (error) {
      if ((error as Error).message.includes("Git is not available")) throw error;
      throw new Error("Choose an existing Git remote");
    }
  }

  async #hasRef(cwd: string, ref: string): Promise<boolean> {
    return (await this.#run(cwd, ["for-each-ref", "--format=%(refname)", ref])) === ref;
  }

  async #run(cwd: string, args: string[], trim = true): Promise<string> {
    try {
      const result = await exec(this.#git, ["-C", resolve(cwd), ...args], {
        env: this.#environment(),
        windowsHide: true,
        maxBuffer: 100 * 1024 * 1024,
        timeout: this.#timeoutMs,
      });
      return trim ? result.stdout.trim() : result.stdout;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string; stdout?: string | Buffer };
      if (failure.code === "ENOENT") throw new Error("Git is not available on this computer");
      if (failure.killed || failure.code === "ETIMEDOUT") throw new Error("Git request timed out");
      const lines = String(failure.stderr ?? "").trim().split(/\r?\n/).filter(Boolean);
      const detail = (lines.find((line) => /^(?:fatal|error):/i.test(line)) ?? lines.find((line) => !/^hint:/i.test(line)) ?? lines.at(-1))?.replace(/^(?:fatal|error):\s*/i, "");
      if (!detail) throw error;
      const normalized = Object.assign(new Error(detail), { code: failure.code, stdout: failure.stdout });
      throw normalized;
    }
  }

  async #appendDiff(cwd: string, args: string[], output: BoundedGitDiff, allowOne = false): Promise<void> {
    const separate = output.hasOutput;
    let started = false;
    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child = spawn(this.#git, ["-C", resolve(cwd), ...args], {
        env: this.#environment(),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const errors: Buffer[] = [];
      let errorBytes = 0;
      let timedOut = false;
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectPromise(error);
        else resolvePromise();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, this.#timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        if (!started) {
          started = true;
          if (separate) output.append(Buffer.from("\n"));
        }
        output.append(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errorBytes >= maxGitErrorBytes) return;
        const retained = chunk.subarray(0, maxGitErrorBytes - errorBytes);
        errors.push(Buffer.from(retained));
        errorBytes += retained.length;
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        finish(error.code === "ENOENT" ? new Error("Git is not available on this computer") : error);
      });
      child.on("close", (code) => {
        if (timedOut) return finish(new Error("Git request timed out"));
        if (code === 0 || (allowOne && code === 1)) return finish();
        const lines = Buffer.concat(errors).toString("utf8").trim().split(/\r?\n/).filter(Boolean);
        const detail = (lines.find((line) => /^(?:fatal|error):/i.test(line)) ?? lines.find((line) => !/^hint:/i.test(line)) ?? lines.at(-1))
          ?.replace(/^(?:fatal|error):\s*/i, "");
        finish(Object.assign(new Error(detail || `Git exited with code ${code ?? "unknown"}`), { code }));
      });
    });
  }

  #environment(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: this.#git,
      GCM_INTERACTIVE: "Never",
      GCM_GUI_PROMPT: "0",
      GIT_SSH_COMMAND: nonInteractiveSshCommand,
      SSH_ASKPASS: this.#git,
      SSH_ASKPASS_REQUIRE: "never",
    };
  }

  async #runGh(cwd: string, args: string[]): Promise<string> {
    try {
      const result = await exec(process.env.GH_BINARY ?? "gh", args, {
        cwd: resolve(cwd),
        env: { ...this.#environment(), GH_PROMPT_DISABLED: "1" },
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
        timeout: this.#timeoutMs,
      });
      return result.stdout.trim();
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ENOENT") throw new Error("Install and sign in to GitHub CLI to use publishing and pull requests");
      if (failure.killed || failure.code === "ETIMEDOUT") throw new Error("GitHub CLI request timed out");
      throw error;
    }
  }
}

class BoundedGitDiff {
  readonly #maxBytes: number;
  readonly #maxLines: number;
  readonly #chunks: Buffer[] = [];
  #returnedBytes = 0;
  #returnedNewlines = 0;
  #returnedLastByte: number | undefined;
  #totalBytes = 0;
  #totalNewlines = 0;
  #totalLastByte: number | undefined;

  constructor(maxBytes: number, maxLines: number) {
    this.#maxBytes = maxBytes;
    this.#maxLines = maxLines;
  }

  get hasOutput(): boolean {
    return this.#totalBytes > 0;
  }

  append(chunk: Buffer): void {
    if (!chunk.length) return;
    this.#totalBytes += chunk.length;
    this.#totalNewlines += countByte(chunk, 0x0a);
    this.#totalLastByte = chunk.at(-1);

    const byteBudget = this.#maxBytes - this.#returnedBytes;
    if (byteBudget <= 0) return;
    const candidateLength = Math.min(chunk.length, byteBudget);
    let acceptedLength = 0;
    let lines = this.#returnedLines();
    let previous = this.#returnedLastByte;
    for (let index = 0; index < candidateLength; index += 1) {
      const byte = chunk[index]!;
      const nextLines = this.#returnedBytes + acceptedLength === 0
        ? 1
        : previous === 0x0a ? lines + 1 : lines;
      if (nextLines > this.#maxLines) break;
      lines = nextLines;
      previous = byte;
      acceptedLength += 1;
    }
    if (!acceptedLength) return;
    const accepted = Buffer.from(chunk.subarray(0, acceptedLength));
    this.#chunks.push(accepted);
    this.#returnedBytes += accepted.length;
    this.#returnedNewlines += countByte(accepted, 0x0a);
    this.#returnedLastByte = accepted.at(-1);
  }

  result(): Omit<GitDiffResult, "path"> {
    let retained = Buffer.concat(this.#chunks, this.#returnedBytes);
    const safeLength = completeUtf8PrefixLength(retained);
    if (safeLength < retained.length) {
      retained = retained.subarray(0, safeLength);
      this.#returnedBytes = safeLength;
      this.#returnedNewlines = countByte(retained, 0x0a);
      this.#returnedLastByte = retained.at(-1);
    }
    const returnedLines = this.#returnedLines();
    const totalLines = this.#totalBytes === 0
      ? 0
      : this.#totalNewlines + (this.#totalLastByte === 0x0a ? 0 : 1);
    const omittedBytes = Math.max(0, this.#totalBytes - this.#returnedBytes);
    const omittedLines = Math.max(0, totalLines - returnedLines);
    return {
      diff: retained.toString("utf8"),
      truncation: {
        truncated: omittedBytes > 0,
        maxBytes: this.#maxBytes,
        maxLines: this.#maxLines,
        returnedBytes: this.#returnedBytes,
        returnedLines,
        omittedBytes,
        omittedLines,
      },
    };
  }

  #returnedLines(): number {
    if (this.#returnedBytes === 0) return 0;
    return this.#returnedNewlines + (this.#returnedLastByte === 0x0a ? 0 : 1);
  }
}

function countByte(buffer: Buffer, target: number): number {
  let count = 0;
  for (const byte of buffer) if (byte === target) count += 1;
  return count;
}

function completeUtf8PrefixLength(buffer: Buffer): number {
  if (!buffer.length) return 0;
  let lead = buffer.length - 1;
  while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead -= 1;
  if (lead < 0) return 0;
  const first = buffer[lead]!;
  const expectedLength = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first >= 0xe0 && first <= 0xef ? 3 : first >= 0xf0 && first <= 0xf4 ? 4 : 1;
  return buffer.length - lead < expectedLength ? lead : buffer.length;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function requireRemoteUrl(url: string): void {
  if (!/^(?:https:\/\/[^\s]+|ssh:\/\/[^\s]+|git@[\w.-]+:[^\s]+)$/.test(url)) throw new Error("Clone URL must use HTTPS or SSH");
}

function requireRemoteName(remote: string): void {
  if (remote.startsWith("-") || !/^[a-zA-Z0-9_.-]+$/.test(remote)) throw new Error("Invalid Git remote name");
}

export function parseStatus(root: string, output: string): GitStatus {
  const records = output.split("\0").filter(Boolean);
  const files: GitFile[] = [];
  let branch = "HEAD";
  let unborn = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record === "# branch.oid (initial)") unborn = true;
    else if (record.startsWith("# branch.head ")) branch = record.slice(14);
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
  return { root: resolve(root), branch, unborn, ...(upstream ? { upstream } : {}), ahead, behind, files };
}

function parseLocalBranches(output: string, current: string): GitLocalBranch[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name = "", upstream = "", track = ""] = line.split("\t");
    return {
      name,
      current: name === current,
      ...(upstream ? { upstream } : {}),
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      upstreamGone: track === "gone",
    };
  });
}

function parseRemoteBranches(output: string, remotes: string[]): GitRemoteBranch[] {
  const sortedRemotes = [...remotes].sort((left, right) => right.length - left.length);
  return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    const [fullName = "", symref = ""] = line.split("\t");
    if (symref) return [];
    const remote = sortedRemotes.find((name) => fullName.startsWith(`${name}/`));
    return remote ? [{ name: fullName.slice(remote.length + 1), fullName, remote }] : [];
  });
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

function uniqueChangedPaths(status: GitStatus, paths: string[], includeRenameSource = false): string[] {
  const safe = [...new Set(paths.flatMap((path) => {
    const file = requireChangedPath(status, path);
    return includeRenameSource && file.originalPath ? [file.path, file.originalPath] : [file.path];
  }))];
  if (!safe.length) throw new Error("Select at least one changed file");
  return safe;
}
