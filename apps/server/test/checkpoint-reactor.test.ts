import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CheckpointReactor, findGitBinary } from "../src/checkpoint-reactor.js";

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
  });
});
