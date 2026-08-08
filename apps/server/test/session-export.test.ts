import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ThreadProjection } from "../src/orchestration.js";
import { exportSessionArchive } from "../src/session-export.js";

describe("session export", () => {
  it("exports useful history without credentials, private paths, or raw tool payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tasty-export-"));
    const privatePath = "C:\\FixtureProfiles\\ArchiveOwner";
    const worktreePath = "D:\\kimi-worktrees\\thread-1";
    const sourcePath = "E:\\clients\\private-project";
    const unlistedImagePath = "Q:\\unlisted-attachment-root\\private-camera-name.png";
    const unlistedQueueImagePath = "R:\\another-unlisted-root\\queued-private-name.jpg";
    const retiredRuntimePath = "Q:\\Retired Runtime Data\\bin\\kimi agent.exe";
    const deeplyNested = Array.from({ length: 14 }).reduce<unknown>((value) => ({ nested: value }), { token: "deep-secret", path: sourcePath });
    const now = "2026-07-27T08:00:00.000Z";
    const thread = {
      threadId: "thread-1", sessionId: "private-session", provider: "kimi", cwd: worktreePath, worktree: { sourceCwd: sourcePath, branch: "kimi/thread-1" }, kind: "project", title: "Useful chat",
      createdAt: now, updatedAt: now, running: false, activeTurnId: undefined, stopReason: "end_turn", lifecycle: { phase: "idle", updatedAt: now },
      submissionReceipts: [{ submissionId: "submission-1", fingerprint: "secret-receipt-hash", queuedId: "submission-1", state: "started", acceptedAt: now, updatedAt: now, turnId: "turn-1" }],
      turns: [{ turnId: "turn-1", startedAt: now, completedAt: now, stopReason: "error", error: `Historical runtime failed at ${retiredRuntimePath}; cache Q:\\RetiredRuntime; mirror \\\\retired-host\\Old Kimi Data\\reports\\failure report.log; retry later` }], messages: [{ turnId: "turn-1", role: "user", text: `Read ${privatePath}\\secret.txt from ${sourcePath}; work in ${worktreePath}. Token usage is visible. {"token":"quoted-secret"}`, images: [{ name: unlistedImagePath, mimeType: "image/png" }] }], activity: [], plan: [],
      tools: [{ toolCallId: "tool-1", title: "Read file", content: [{ type: "content", content: { type: "text", text: "{\"token\":\"content-secret\"}" } }], rawInput: { token: "secret-token" }, rawOutput: "secret-token" }],
      approvals: [], configOptions: [], commands: [], modeId: undefined, checkpoints: [], revertedParts: [], backgroundTasks: [{
        taskId: "bash-build1", queuedId: "queued-1", turnId: "turn-1", description: "Build", kimiHome: "Z:\\unlisted-secret-home",
        outputPath: "Y:\\historical-secret-output\\output.log", status: "running", registeredAt: now, updatedAt: now, reportQueued: false,
      }], usage: {},
    } satisfies ThreadProjection;

    const path = await exportSessionArchive(directory, [{ ...thread, queue: [{ text: "token: secret-token", deeplyNested, apiKey: "dummy-api-key-value-123", refreshToken: "oauth-refresh-secret", sessionToken: "session-secret", secretAccessKey: "aws-secret", privateKey: "private-key-secret", note: "Token usage is visible.", images: [{ name: unlistedQueueImagePath, mimeType: "image/jpeg" }] }] }], [privatePath, worktreePath, sourcePath]);
    const contents = await readFile(path, "utf8");
    const archive = JSON.parse(contents) as { threads: Array<{ messages: Array<{ images?: Array<{ name: string }> }>; queue: Array<{ images?: Array<{ name: string }> }> }> };

    expect(contents).toContain("Useful chat");
    expect(contents).toContain("[home]");
    expect(contents).not.toContain(privatePath);
    expect(contents).not.toContain(worktreePath);
    expect(contents).not.toContain(sourcePath);
    expect(contents).not.toContain("private-session");
    expect(contents).not.toContain("secret-token");
    expect(contents).not.toContain("content-secret");
    expect(contents).not.toContain("deep-secret");
    expect(contents).not.toContain("quoted-secret");
    expect(contents).not.toContain("dummy-api-key-value-123");
    expect(contents).not.toContain("oauth-refresh-secret");
    expect(contents).not.toContain("session-secret");
    expect(contents).not.toContain("aws-secret");
    expect(contents).not.toContain("private-key-secret");
    expect(contents).not.toContain("rawOutput");
    expect(contents).not.toContain("secret-receipt-hash");
    expect(contents).not.toContain("unlisted-secret-home");
    expect(contents).not.toContain("kimiHome");
    expect(contents).not.toContain("historical-secret-output");
    expect(contents).not.toContain("outputPath");
    expect(contents).not.toContain("unlisted-attachment-root");
    expect(contents).not.toContain("another-unlisted-root");
    expect(contents).not.toMatch(/Retired Runtime Data|RetiredRuntime|retired-host|Old Kimi Data/i);
    expect(contents).toContain("retry later");
    expect(archive.threads[0]?.messages[0]?.images?.[0]?.name).toBe("private-camera-name.png");
    expect(archive.threads[0]?.queue[0]?.images?.[0]?.name).toBe("queued-private-name.jpg");
    expect(contents).toContain("Token usage is visible.");
  });
});
