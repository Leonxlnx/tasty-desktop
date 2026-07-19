import { execFile, execFileSync } from "node:child_process";
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
        GIT_AUTHOR_NAME: "Kimi Code Desktop",
        GIT_AUTHOR_EMAIL: "checkpoint@local",
        GIT_COMMITTER_NAME: "Kimi Code Desktop",
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
