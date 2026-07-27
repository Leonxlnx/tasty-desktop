import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadProjection } from "../src/orchestration.js";
import { exportSessionArchive } from "../src/session-export.js";

describe("session export", () => {
  it("exports useful history without credentials, private paths, or raw tool payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tasty-export-"));
    const privatePath = "C:\\Users\\owner";
    const now = "2026-07-27T08:00:00.000Z";
    const thread = {
      threadId: "thread-1", sessionId: "private-session", provider: "kimi", cwd: `${privatePath}\\project`, kind: "project", title: "Useful chat",
      createdAt: now, updatedAt: now, running: false, activeTurnId: undefined, stopReason: "end_turn", lifecycle: { phase: "idle", updatedAt: now },
      turns: [], messages: [{ turnId: "turn-1", role: "user", text: `Read ${privatePath}\\secret.txt` }], activity: [], plan: [],
      tools: [{ toolCallId: "tool-1", title: "Read file", rawInput: { token: "secret-token" }, rawOutput: "secret-token" }],
      approvals: [], configOptions: [], commands: [], modeId: undefined, checkpoints: [], backgroundTasks: [], usage: {},
    } satisfies ThreadProjection;

    const path = await exportSessionArchive(directory, [{ ...thread, queue: [{ text: "token: secret-token" }] }], [privatePath]);
    const contents = await readFile(path, "utf8");

    expect(contents).toContain("Useful chat");
    expect(contents).toContain("[home]");
    expect(contents).not.toContain(privatePath);
    expect(contents).not.toContain("private-session");
    expect(contents).not.toContain("secret-token");
    expect(contents).not.toContain("rawOutput");
  });
});
