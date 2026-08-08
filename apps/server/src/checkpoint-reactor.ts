import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type Checkpoint = {
  turnId: string;
  phase: "before" | "after" | "revert-safety" | "reverted";
  ref: string;
  commit: string;
  root: string;
  branch?: string | null;
  head?: string | null;
  tree?: string;
  index?: string;
};

export type CheckpointReviewHunk = { index: number; header: string; lines: string[] };
export type CheckpointReviewFile = { path: string; binary: boolean; canRevertHunks: boolean; hunks: CheckpointReviewHunk[] };
type ParsedReviewFile = CheckpointReviewFile & { patch: string; hunkPatches: string[] };

export class CheckpointReactor {
  readonly #git: string;
  readonly #dataHome: string;

  constructor(gitBinary: string, dataHome: string) {
    this.#git = resolve(gitBinary);
    this.#dataHome = resolve(dataHome);
  }

  async capture(threadId: string, turnId: string, phase: Checkpoint["phase"], cwd: string): Promise<Checkpoint | undefined> {
    let root: string;
    try {
      root = await this.#run(cwd, ["rev-parse", "--show-toplevel"]);
    } catch {
      return undefined;
    }
    const safeThread = safeRefPart(threadId);
    const safeTurn = safeRefPart(turnId);
    const ref = `refs/kimi-code/checkpoints/${safeThread}/${safeTurn}/${phase}`;
    const tempDir = join(this.#dataHome, "checkpoints", safeThread, safeTurn);
    const index = join(tempDir, `${phase}.index`);
    await mkdir(tempDir, { recursive: true });
    const { branch, head } = await this.#gitState(root);
    const tree = await this.#snapshotTree(root, index, head);
    const indexState = await this.#indexState(root);
    const args = ["commit-tree", tree, "-m", `Kimi Code checkpoint ${turnId} ${phase}`];
    if (head) args.push("-p", head);
    const commit = await this.#run(root, args, {
      ...process.env,
      GIT_AUTHOR_NAME: "Kimi Code",
      GIT_AUTHOR_EMAIL: "checkpoint@local",
      GIT_COMMITTER_NAME: "Kimi Code",
      GIT_COMMITTER_EMAIL: "checkpoint@local",
    });
    await this.#run(root, ["update-ref", ref, commit]);
    return { turnId, phase, ref, commit, root, branch, head, tree, index: indexState };
  }

  async diff(before: Checkpoint, after: Checkpoint): Promise<string> {
    if (before.root !== after.root) throw new Error("Checkpoint roots do not match");
    return this.#run(before.root, ["diff", "--binary", before.commit, after.commit], process.env, false);
  }

  async review(before: Checkpoint, after: Checkpoint): Promise<CheckpointReviewFile[]> {
    return parseCheckpointPatch(await this.diff(before, after)).map(({ patch: _patch, hunkPatches: _hunks, ...file }) => file);
  }

  async revertPart(threadId: string, turnId: string, before: Checkpoint, after: Checkpoint, path: string, hunkIndex?: number): Promise<Checkpoint | undefined> {
    if (before.root !== after.root) throw new Error("Checkpoint roots do not match");
    await this.#assertRevertTarget(threadId, turnId, before, after);
    const file = parseCheckpointPatch(await this.diff(before, after)).find((candidate) => candidate.path === path);
    if (!file) throw new Error("This file is not part of the selected turn");
    const patch = hunkIndex === undefined ? file.patch : file.hunkPatches[hunkIndex];
    if (!patch) throw new Error("This hunk is not part of the selected turn");
    const safety = await this.capture(threadId, turnId, "revert-safety", before.root);
    this.#assertCapturedState(after, safety);
    const patchPath = join(this.#dataHome, "checkpoints", safeRefPart(threadId), safeRefPart(turnId), `partial-revert-${randomUUID()}.patch`);
    await writeFile(patchPath, patch, "utf8");
    try {
      await this.#run(before.root, ["apply", "--reverse", "--check", "--whitespace=nowarn", patchPath]);
      await this.#run(before.root, ["apply", "--reverse", "--whitespace=nowarn", patchPath]);
    } finally {
      await rm(patchPath, { force: true });
    }
    return this.capture(threadId, turnId, "reverted", before.root);
  }

  async revert(threadId: string, turnId: string, before: Checkpoint, after: Checkpoint): Promise<Checkpoint | undefined> {
    if (before.root !== after.root) throw new Error("Checkpoint roots do not match");
    const fullRevertRef = `refs/kimi-code/checkpoints/${safeRefPart(threadId)}/${safeRefPart(turnId)}/full-reverted`;
    if (await this.#refExists(before.root, fullRevertRef)) throw new Error("This turn was already reverted");
    await this.#assertRevertTarget(threadId, turnId, before, after);
    const patch = await this.diff(before, after);
    let patchPath: string | undefined;
    let failed = false;
    try {
      if (patch) {
        patchPath = join(this.#dataHome, "checkpoints", safeRefPart(threadId), safeRefPart(turnId), "revert.patch");
        await writeFile(patchPath, patch, "utf8");
        await this.#run(before.root, ["apply", "--reverse", "--check", "--whitespace=nowarn", patchPath]);
      }
      const safety = await this.capture(threadId, turnId, "revert-safety", before.root);
      this.#assertCapturedState(after, safety);
      await this.#run(before.root, ["update-ref", fullRevertRef, after.commit, "0".repeat(after.commit.length)]);
      try {
        if (patchPath) await this.#run(before.root, ["apply", "--reverse", "--whitespace=nowarn", patchPath]);
      } catch (error) {
        await this.#run(before.root, ["update-ref", "-d", fullRevertRef, after.commit]).catch(() => undefined);
        throw error;
      }
      return await this.capture(threadId, turnId, "reverted", before.root);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (patchPath) await rm(patchPath, { force: true });
      } catch (error) {
        if (!failed) throw error;
      }
    }
  }

  async #refExists(cwd: string, ref: string): Promise<boolean> {
    try {
      await this.#run(cwd, ["show-ref", "--verify", "--quiet", ref]);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) return false;
      throw error;
    }
  }

  async #assertRevertTarget(threadId: string, turnId: string, before: Checkpoint, after: Checkpoint): Promise<void> {
    if (before.branch === undefined || before.head === undefined || !before.tree || !before.index
      || after.branch === undefined || after.head === undefined || !after.tree || !after.index) {
      throw new Error("This legacy checkpoint has no Git state and cannot be reverted safely");
    }
    if (before.branch !== after.branch) throw new Error("The task changed Git branches and cannot be reverted safely");
    if (before.head !== after.head) throw new Error("The task changed Git HEAD and cannot be reverted safely");
    if (before.index !== after.index) throw new Error("The task changed the Git index and cannot be reverted safely");
    const current = await this.#gitState(after.root);
    if (current.branch !== after.branch || current.head !== after.head) {
      throw new Error("Git branch or HEAD changed after this task; switch back before reverting");
    }
    const tempDir = join(this.#dataHome, "checkpoints", safeRefPart(threadId), safeRefPart(turnId));
    await mkdir(tempDir, { recursive: true });
    const tree = await this.#snapshotTree(after.root, join(tempDir, `revert-check-${randomUUID()}.index`), current.head);
    if (tree !== after.tree) throw new Error("Workspace changed after this task; review or preserve those changes before reverting");
    if (await this.#indexState(after.root) !== after.index) {
      throw new Error("Git staging changed after this task; review or preserve those changes before reverting");
    }
  }

  #assertCapturedState(expected: Checkpoint, actual: Checkpoint | undefined): void {
    if (!actual || actual.branch !== expected.branch || actual.head !== expected.head
      || actual.tree !== expected.tree || actual.index !== expected.index) {
      throw new Error("Workspace changed after this task; review or preserve those changes before reverting");
    }
  }

  async #indexState(cwd: string): Promise<string> {
    const entries = await this.#run(cwd, ["ls-files", "--stage", "-z"], process.env, false);
    return createHash("sha256").update(entries).digest("hex");
  }

  async #gitState(cwd: string): Promise<{ branch: string | null; head: string | null }> {
    let branch: string | null = null;
    let head: string | null = null;
    try { branch = await this.#run(cwd, ["symbolic-ref", "--quiet", "HEAD"]); } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
    }
    try { head = await this.#run(cwd, ["rev-parse", "--verify", "HEAD"]); } catch (error) {
      if ((error as { code?: number }).code !== 128) throw error;
    }
    return { branch, head };
  }

  async #snapshotTree(cwd: string, index: string, head: string | null): Promise<string> {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      await this.#run(cwd, head ? ["read-tree", head] : ["read-tree", "--empty"], env);
      await this.#run(cwd, ["add", "-A", "--", "."], env);
      return await this.#run(cwd, ["write-tree"], env);
    } finally {
      await rm(index, { force: true });
    }
  }

  async #run(cwd: string, args: string[], env = process.env, trim = true): Promise<string> {
    const result = await exec(this.#git, ["-C", resolve(cwd), ...args], { env, windowsHide: true, maxBuffer: 100 * 1024 * 1024 });
    return trim ? result.stdout.trim() : result.stdout;
  }
}

export function parseCheckpointPatch(diff: string): ParsedReviewFile[] {
  const files: ParsedReviewFile[] = [];
  for (const patch of diff.split(/(?=^diff --git )/m).filter((block) => block.startsWith("diff --git "))) {
    const path = patchPath(patch);
    if (!path) continue;
    const starts = [...patch.matchAll(/^@@ .*@@.*$/gm)].map((match) => match.index!);
    if (!starts.length) {
      files.push({ path, binary: /^(?:GIT binary patch|Binary files )/m.test(patch), canRevertHunks: false, hunks: [], patch, hunkPatches: [] });
      continue;
    }
    const canRevertHunks = !/^(?:new file mode|deleted file mode|old mode|new mode|rename from|rename to|copy from|copy to) /m.test(patch);
    const header = patch.slice(0, starts[0]);
    const hunks = starts.map((start, index) => {
      const body = patch.slice(start, starts[index + 1] ?? patch.length);
      const [hunkHeader = "", ...lines] = body.replace(/\n$/, "").split("\n");
      return { index, header: hunkHeader, lines, patch: `${header}${body}` };
    });
    files.push({
      path,
      binary: false,
      canRevertHunks,
      hunks: hunks.map(({ patch: _patch, ...hunk }) => hunk),
      patch,
      hunkPatches: canRevertHunks ? hunks.map((hunk) => hunk.patch) : [],
    });
  }
  return files;
}

function patchPath(patch: string): string | undefined {
  const target = /^\+\+\+ (.+)$/m.exec(patch)?.[1];
  const source = /^--- (.+)$/m.exec(patch)?.[1];
  return normalizePatchPath(target === "/dev/null" ? source : target);
}

function normalizePatchPath(value: string | undefined): string | undefined {
  if (!value || value === "/dev/null") return undefined;
  let path = value;
  if (path.startsWith('"')) {
    try { path = JSON.parse(path) as string; } catch { return undefined; }
  }
  return path.replace(/^[ab]\//, "");
}

export function findGitBinary(): string {
  const command = process.platform === "win32" ? "where.exe" : "which";
  const output = execFileSync(command, ["git"], { encoding: "utf8", windowsHide: true });
  const path = output.split(/\r?\n/).find(Boolean);
  if (!path) throw new Error("Git is not installed");
  return resolve(path);
}

function safeRefPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}
