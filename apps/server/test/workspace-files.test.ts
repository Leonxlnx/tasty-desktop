import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listWorkspaceFiles, readWorkspaceFile } from "../src/workspace-files.js";

describe("workspace files", () => {
  it("lists text resources and blocks paths outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-files-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "export {};\n", "utf8");
    expect(await listWorkspaceFiles(root, "app")).toEqual(["src/app.ts"]);
    const outside = join(await mkdtemp(join(tmpdir(), "kimi-files-outside-")), "outside.txt");
    await writeFile(outside, "private\n", "utf8");
    await expect(readWorkspaceFile(root, outside)).rejects.toThrow("outside workspace");
    expect((await readWorkspaceFile(root, "src/app.ts")).content).toBe("export {};\n");
  });

  it("blocks a workspace link whose canonical target is outside", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-files-"));
    const outside = await mkdtemp(join(tmpdir(), "kimi-files-outside-"));
    await writeFile(join(outside, "secret.txt"), "private\n", "utf8");
    await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(readWorkspaceFile(root, "escape/secret.txt")).rejects.toThrow("outside workspace");
  });

  it("allows a workspace link whose canonical target stays inside", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-files-"));
    const resources = join(root, "resources");
    await mkdir(resources);
    await writeFile(join(resources, "context.txt"), "context\n", "utf8");
    await symlink(resources, join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(readWorkspaceFile(root, "linked/context.txt")).resolves.toEqual({
      path: await realpath(join(resources, "context.txt")),
      content: "context\n",
    });
  });
});
