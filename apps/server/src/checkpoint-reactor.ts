import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    const env = { ...process.env, GIT_INDEX_FILE: index };
    let head: string | undefined;
    try {
      head = await this.#run(root, ["rev-parse", "HEAD"]);
      await this.#run(root, ["read-tree", head], env);
    } catch {
      await this.#run(root, ["read-tree", "--empty"], env);
    }
    try {
      await this.#run(root, ["add", "-A", "--", "."], env);
      const tree = await this.#run(root, ["write-tree"], env);
      const args = ["commit-tree", tree, "-m", `Kimi Code checkpoint ${turnId} ${phase}`];
      if (head) args.push("-p", head);
      const commit = await this.#run(root, args, {
        ...env,
        GIT_AUTHOR_NAME: "Kimi Code",
        GIT_AUTHOR_EMAIL: "checkpoint@local",
        GIT_COMMITTER_NAME: "Kimi Code",
        GIT_COMMITTER_EMAIL: "checkpoint@local",
      });
      await this.#run(root, ["update-ref", ref, commit]);
      return { turnId, phase, ref, commit, root };
    } finally {
      await rm(index, { force: true });
    }
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
    const file = parseCheckpointPatch(await this.diff(before, after)).find((candidate) => candidate.path === path);
    if (!file) throw new Error("This file is not part of the selected turn");
    const patch = hunkIndex === undefined ? file.patch : file.hunkPatches[hunkIndex];
    if (!patch) throw new Error("This hunk is not part of the selected turn");
    await this.capture(threadId, turnId, "revert-safety", before.root);
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
    await this.capture(threadId, turnId, "revert-safety", before.root);
    const patch = await this.diff(before, after);
    if (patch) {
      const patchPath = join(this.#dataHome, "checkpoints", safeRefPart(threadId), safeRefPart(turnId), "revert.patch");
      await writeFile(patchPath, patch, "utf8");
      await this.#run(before.root, ["apply", "--reverse", "--whitespace=nowarn", patchPath]);
    }
    return this.capture(threadId, turnId, "reverted", before.root);
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
