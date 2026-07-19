import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
    await expect(readWorkspaceFile(root, join(root, "..", "outside.txt"))).rejects.toThrow("outside workspace");
    expect((await readWorkspaceFile(root, "src/app.ts")).content).toBe("export {};\n");
  });
});
