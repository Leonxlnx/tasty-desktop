import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventStore, type StoredEvent } from "../src/event-store.js";
import { OrchestrationEngine } from "../src/orchestration.js";

describe("orchestration engine", () => {
  it("keeps durable appends successful when a live publisher fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-orchestration-publisher-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    const originalError = console.error;
    console.error = () => undefined;
    try {
      engine.setPublisher(() => { throw new Error("socket closed"); });
      await expect(engine.append("publisher", {
        type: "ThreadCreated",
        payload: { sessionId: "s-publisher", cwd: "C:/work", title: "Publisher" },
      })).resolves.toBeDefined();
    } finally {
      console.error = originalError;
    }
    expect(engine.thread("publisher")?.title).toBe("Publisher");
  });

  it("scrubs historical runtime errors while compacting without changing runtime identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-orchestration-error-migration-"));
    const path = join(dir, "events.jsonl");
    const store = new EventStore(path);
    await store.open(() => undefined);
    const runtimeError = 'spawn "Q:\\Retired Kimi\\bin\\kimi.exe" failed';
    const cancellationError = "Could not stop \\\\archive-host\\Retired Kimi Data\\runtime\\close.log";
    const reportError = "Could not read '/opt/Retired Kimi/reports/failure.json'";
    await store.append("historical-errors", {
      type: "ThreadCreated",
      payload: { sessionId: "historical-session", provider: "kimi", instanceId: "removed", cwd: "C:/workspace", title: "Historical errors" },
    });
    await store.append("historical-errors", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Run" } });
    await store.append("historical-errors", { type: "TurnCompleted", payload: { turnId: "turn-1", stopReason: "error", error: runtimeError } });
    await store.append("historical-errors", { type: "TurnPhaseChanged", payload: { phase: "blocked", turnId: "turn-1", error: cancellationError } });
    await store.append("historical-errors", {
      type: "BackgroundTaskRegistered",
      payload: { taskId: "bash-history", queuedId: "queued-history", turnId: "turn-1", description: "Historical task" },
    });
    await store.append("historical-errors", { type: "BackgroundTaskReportCancelled", payload: { taskId: "bash-history", failure: reportError } });
    await store.drain();

    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    const thread = engine.thread("historical-errors");
    expect(thread).toMatchObject({
      sessionId: "historical-session",
      provider: "kimi",
      instanceId: "removed",
      cwd: "C:/workspace",
      lifecycle: { phase: "blocked", error: expect.stringContaining("[private-path]") },
      turns: [expect.objectContaining({ error: expect.stringContaining("[private-path]") })],
      backgroundTasks: [expect.objectContaining({ reportLastError: expect.stringContaining("[private-path]") })],
    });

    const compacted = await readFile(path, "utf8");
    expect(compacted).not.toMatch(/Retired Kimi|archive-host/i);
    const records = compacted.trim().split("\n").map((line) => JSON.parse(line) as { type: string; payload: { thread?: unknown } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: "ThreadSnapshot", payload: { thread: expect.any(Object) } });

    const replayed = new OrchestrationEngine(new EventStore(path));
    await replayed.open();
    expect(replayed.thread("historical-errors")).toEqual(thread);
    expect(await readFile(path, "utf8")).not.toMatch(/Retired Kimi|archive-host/i);
  });

  it("sanitizes fresh error events before persistence, publication, and projection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-orchestration-error-ingress-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("fresh-errors", { type: "ThreadCreated", payload: { sessionId: "fresh-session", cwd: "C:/workspace", title: "Fresh errors" } });
    await engine.append("fresh-errors", {
      type: "BackgroundTaskRegistered",
      payload: { taskId: "bash-fresh", queuedId: "queued-fresh", turnId: "turn-1", description: "Fresh task" },
    });

    const published: StoredEvent[] = [];
    engine.setPublisher((event) => published.push(event));
    const cancellationError = 'Close failed at "Q:\\Former Runtime\\state\\cancel.log"';
    const reportError = "Report failed at /opt/former-kimi/reports/error.json";
    const runtimeError = "Runtime failed at \\\\former-host\\kimi-runtime\\failure.log";
    const phase = await engine.append("fresh-errors", {
      type: "TurnPhaseChanged",
      payload: { phase: "blocked", error: cancellationError },
    });
    const report = await engine.append("fresh-errors", {
      type: "BackgroundTaskReportCancelled",
      payload: { taskId: "bash-fresh", failure: reportError },
    });
    const beforeCompaction = await readFile(path, "utf8");
    expect(beforeCompaction).not.toMatch(/Former Runtime|former-kimi/i);
    expect(beforeCompaction).toContain("[private-path]");
    await engine.append("fresh-errors", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Run" } });
    const completed = await engine.append("fresh-errors", {
      type: "TurnCompleted",
      payload: { turnId: "turn-1", stopReason: "error", error: runtimeError },
    });

    expect((phase.payload as { error: string }).error).toContain("[private-path]");
    expect((report.payload as { failure: string }).failure).toContain("[private-path]");
    expect((completed.payload as { error: string }).error).toContain("[private-path]");
    expect(JSON.stringify(published)).not.toMatch(/Former Runtime|former-kimi|former-host/i);
    expect(engine.thread("fresh-errors")).toMatchObject({
      sessionId: "fresh-session",
      cwd: "C:/workspace",
      lifecycle: { phase: "failed", error: expect.stringContaining("[private-path]") },
      turns: [expect.objectContaining({ error: expect.stringContaining("[private-path]") })],
      backgroundTasks: [expect.objectContaining({ reportLastError: expect.stringContaining("[private-path]") })],
    });
    expect(await readFile(path, "utf8")).not.toMatch(/Former Runtime|former-kimi|former-host/i);
  });

  it("replays legacy ThreadCreated events that predate config options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-orchestration-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("legacy", { type: "ThreadCreated", payload: { sessionId: "s-1", cwd: "C:/work", title: "Old chat" } });
    expect(engine.thread("legacy")?.provider).toBe("kimi");
    const thread = engine.thread("legacy");
    expect(thread?.configOptions).toEqual([]);
    expect(thread?.activity).toEqual([]);
    expect(thread?.kind).toBe("project");
    expect(thread).not.toHaveProperty("creationId");
    expect(thread).not.toHaveProperty("creationFingerprint");
  });

  it("persists bounded submission receipts and terminal queue states", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-submission-receipts-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("receipts", { type: "ThreadCreated", payload: { sessionId: "s-receipts", cwd: dir, title: "Receipts" } });
    for (let index = 0; index < 260; index += 1) {
      await engine.append("receipts", {
        type: "TurnSubmissionAccepted",
        payload: { submissionId: `submission-${index}`, fingerprint: `fingerprint-${index}`, queuedId: `submission-${index}` },
      });
    }
    expect(engine.thread("receipts")?.submissionReceipts).toHaveLength(260);
    await engine.append("receipts", { type: "TurnSubmissionsRemoved", payload: { submissionIds: Array.from({ length: 260 }, (_, index) => `submission-${index}`) } });
    expect(engine.thread("receipts")?.submissionReceipts).toHaveLength(256);
    expect(engine.thread("receipts")?.submissionReceipts[0]?.submissionId).toBe("submission-4");

    await engine.append("receipts", { type: "TurnSubmissionAccepted", payload: { submissionId: "current", fingerprint: "current", queuedId: "current" } });
    expect(engine.thread("receipts")?.submissionReceipts).toHaveLength(257);
    await engine.append("receipts", { type: "TurnStarted", payload: { turnId: "turn-current", text: "Run once", sourceQueuedId: "current" } });
    await engine.append("receipts", { type: "TurnCompleted", payload: { turnId: "turn-current", stopReason: "end_turn" } });
    expect(engine.thread("receipts")?.submissionReceipts).toHaveLength(256);
    expect(engine.thread("receipts")?.submissionReceipts.slice(-2)).toMatchObject([
      { submissionId: "submission-259", state: "removed" },
      { submissionId: "current", state: "completed", turnId: "turn-current" },
    ]);

    const replayed = new OrchestrationEngine(new EventStore(path));
    await replayed.open();
    expect(replayed.thread("receipts")?.submissionReceipts).toEqual(engine.thread("receipts")?.submissionReceipts);
  });

  it("keeps only the newest 256 completed submission receipts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-completed-receipts-"));
    const path = join(dir, "events.jsonl");
    const store = new EventStore(path);
    const engine = new OrchestrationEngine(store);
    await engine.open();
    await engine.append("completed", { type: "ThreadCreated", payload: { sessionId: "s-completed", cwd: dir, title: "Completed" } });
    const snapshot = engine.thread("completed")!;
    const now = new Date().toISOString();
    snapshot.submissionReceipts = Array.from({ length: 260 }, (_, index) => ({
      submissionId: `completed-${index}`,
      fingerprint: `fingerprint-${index}`,
      queuedId: `completed-${index}`,
      state: "completed" as const,
      acceptedAt: now,
      updatedAt: now,
      turnId: `turn-${index}`,
    }));
    await engine.drain();
    await store.replace([{ threadId: "completed", event: { type: "ThreadSnapshot", payload: { thread: snapshot } } }]);

    const replayed = new OrchestrationEngine(new EventStore(path));
    await replayed.open();
    expect(replayed.thread("completed")?.submissionReceipts).toHaveLength(256);
    expect(replayed.thread("completed")?.submissionReceipts[0]).toMatchObject({ submissionId: "completed-4", state: "completed" });
  });

  it("expires submission receipts after thirty days", async () => {
    vi.useFakeTimers();
    try {
      const dir = await mkdtemp(join(tmpdir(), "kimi-expired-receipts-"));
      const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      await engine.open();
      await engine.append("expiring", { type: "ThreadCreated", payload: { sessionId: "s-expiring", cwd: dir, title: "Expiring" } });
      await engine.append("expiring", { type: "TurnSubmissionAccepted", payload: { submissionId: "old", fingerprint: "old", queuedId: "old" } });
      await engine.append("expiring", { type: "TurnSubmissionAccepted", payload: { submissionId: "completed-old", fingerprint: "completed-old", queuedId: "completed-old" } });
      await engine.append("expiring", { type: "TurnStarted", payload: { turnId: "turn-completed-old", text: "Complete", sourceQueuedId: "completed-old" } });
      await engine.append("expiring", { type: "TurnCompleted", payload: { turnId: "turn-completed-old", stopReason: "end_turn" } });
      vi.setSystemTime(new Date("2026-02-01T00:00:00.001Z"));
      await engine.append("expiring", { type: "TurnSubmissionAccepted", payload: { submissionId: "current", fingerprint: "current", queuedId: "current" } });
      expect(engine.thread("expiring")?.submissionReceipts.map((receipt) => receipt.submissionId)).toEqual(["old", "current"]);
      await engine.append("expiring", { type: "TurnSubmissionsRemoved", payload: { submissionIds: ["old"] } });
      expect(engine.thread("expiring")?.submissionReceipts.map((receipt) => receipt.submissionId)).toEqual(["old", "current"]);
      vi.setSystemTime(new Date("2026-03-04T00:00:00.002Z"));
      await engine.append("expiring", { type: "TurnSubmissionAccepted", payload: { submissionId: "next", fingerprint: "next", queuedId: "next" } });
      expect(engine.thread("expiring")?.submissionReceipts.map((receipt) => receipt.submissionId)).toEqual(["current", "next"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists provider ownership, side-thread lineage, and goals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasty-thread-meta-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("side", {
      type: "ThreadCreated",
      payload: {
        sessionId: "codex-side-session",
        provider: "codex",
        instanceId: "work",
        parentThreadId: "parent",
        cwd: "C:/work",
        title: "Side chat",
      },
    });
    await engine.append("side", { type: "ThreadGoalSet", payload: { objective: "Verify the provider layer" } });
    await engine.drain();

    const restored = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await restored.open();
    expect(restored.thread("side")).toMatchObject({
      provider: "codex",
      instanceId: "work",
      parentThreadId: "parent",
      goal: { objective: "Verify the provider layer", status: "active" },
    });
    await restored.append("side", { type: "ThreadGoalCleared", payload: {} });
    expect(restored.thread("side")?.goal).toBeUndefined();
  });

  it("rejects a second live thread for the same ACP session", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-session-owner-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("owner", { type: "ThreadCreated", payload: { sessionId: "shared", cwd: "C:/one", title: "Owner" } });

    await expect(engine.append("duplicate", {
      type: "ThreadCreated",
      payload: { sessionId: "shared", cwd: "C:/two", title: "Duplicate" },
    })).rejects.toThrow("already owned by thread owner");
    expect(engine.thread("duplicate")).toBeUndefined();
    expect(engine.runtimeThreadForSession("shared", { provider: "kimi" })?.threadId).toBe("owner");
  });

  it("allows the same ACP session id in different runtime instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-session-instance-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("default", { type: "ThreadCreated", payload: { sessionId: "shared", cwd: "C:/default", title: "Default" } });
    await engine.append("named", { type: "ThreadCreated", payload: { sessionId: "shared", provider: "kimi", instanceId: "work", cwd: "C:/work", title: "Work" } });
    await engine.append("codex", { type: "ThreadCreated", payload: { sessionId: "shared", provider: "codex", cwd: "C:/codex", title: "Codex" } });

    expect(engine.runtimeThreadForSession("shared", { provider: "kimi" })?.threadId).toBe("default");
    expect(engine.runtimeThreadForSession("shared", { provider: "kimi", instanceId: "work" })?.threadId).toBe("named");
    expect(engine.runtimeThreadForSession("shared", { provider: "codex" })?.threadId).toBe("codex");
    await expect(engine.append("duplicate", {
      type: "ThreadCreated",
      payload: { sessionId: "shared", provider: "kimi", instanceId: "work", cwd: "C:/duplicate", title: "Duplicate" },
    })).rejects.toThrow("already owned by thread named");
  });

  it("keeps the first live owner when replaying legacy duplicate sessions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-session-replay-"));
    const path = join(dir, "events.jsonl");
    const store = new EventStore(path);
    await store.open(() => undefined);
    await store.append("first", { type: "ThreadCreated", payload: { sessionId: "shared", cwd: "C:/one", title: "First" } });
    await store.append("later", { type: "ThreadCreated", payload: { sessionId: "shared", cwd: "C:/two", title: "Later" } });
    await store.append("retired", { type: "ThreadCreated", payload: { sessionId: "promoted", cwd: "C:/old", title: "Retired" } });
    await store.append("fallback", { type: "ThreadCreated", payload: { sessionId: "promoted", cwd: "C:/new", title: "Fallback" } });
    await store.append("retired", { type: "ThreadDeleted", payload: {} });

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message) => warnings.push(String(message));
    const engine = new OrchestrationEngine(new EventStore(path));
    try {
      await engine.open();
    } finally {
      console.warn = originalWarn;
    }

    expect(engine.runtimeThreadForSession("shared", { provider: "kimi" })?.threadId).toBe("first");
    expect(engine.thread("later")).toBeUndefined();
    expect(engine.runtimeThreadForSession("promoted", { provider: "kimi" })?.threadId).toBe("fallback");
    expect(warnings).toEqual([expect.stringContaining("Ignored duplicate thread later")]);
  });

  it("keeps real thought and tool activity ordered and stable across replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-activity-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("activity", { type: "ThreadCreated", payload: { sessionId: "s-2", cwd: "C:/work", title: "Activity" } });
    await engine.append("activity", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Fix it" } });
    await engine.append("activity", { type: "MessageDelta", payload: { turnId: "turn-1", role: "thought", text: "Inspecting files" } });
    await engine.append("activity", { type: "ToolCallCreated", payload: { tool: { toolCallId: "tool-1", turnId: "turn-1", title: "Read App.tsx", status: "in_progress" } } });
    await engine.append("activity", { type: "MessageDelta", payload: { turnId: "turn-1", role: "thought", text: "Applying the fix" } });
    await engine.append("activity", { type: "ToolCallPatched", payload: { tool: { toolCallId: "tool-1", title: "Read App.tsx", status: "completed" } } });
    await engine.append("activity", { type: "MessageDelta", payload: { turnId: "turn-1", role: "thought", text: " now" } });
    await engine.append("activity", { type: "TurnCompleted", payload: { turnId: "turn-1", stopReason: "end_turn" } });

    const before = engine.thread("activity")?.activity;
    expect(before?.map(({ id, kind, text, status }) => ({ id, kind, text, status }))).toEqual([
      { id: "thought-3", kind: "thought", text: "Inspecting files", status: "completed" },
      { id: "tool-tool-1", kind: "tool", text: "Read App.tsx", status: "completed" },
      { id: "thought-5", kind: "thought", text: "Applying the fix now", status: "completed" },
    ]);
    expect(before?.every((entry) => entry.createdAt && entry.updatedAt && entry.seq > 0)).toBe(true);

    const replayed = new OrchestrationEngine(new EventStore(path));
    await replayed.open();
    expect(replayed.thread("activity")?.activity).toEqual(before);
  });

  it("keeps assistant updates separated by activity and persists failure details", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-message-order-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("ordered", { type: "ThreadCreated", payload: { sessionId: "s-3", cwd: "C:/work", title: "Ordered" } });
    await engine.append("ordered", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Fix it" } });
    await engine.append("ordered", { type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "Inspecting " } });
    await engine.append("ordered", { type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "first." } });
    await engine.append("ordered", { type: "ToolCallCreated", payload: { tool: { toolCallId: "tool-1", turnId: "turn-1", title: "Read files", status: "in_progress" } } });
    await engine.append("ordered", { type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "Now testing." } });
    await engine.append("ordered", { type: "ToolCallPatched", payload: { tool: { toolCallId: "tool-1", status: "completed" } } });
    await engine.append("ordered", { type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "Tests failed." } });
    await engine.append("ordered", { type: "TurnCompleted", payload: { turnId: "turn-1", stopReason: "error", error: "Command exited with code 1" } });

    const before = engine.thread("ordered");
    expect(before?.messages.filter((message) => message.role === "assistant").map(({ text, seq, updatedSeq }) => ({ text, seq, updatedSeq }))).toEqual([
      { text: "Inspecting first.", seq: 3, updatedSeq: 4 },
      { text: "Now testing.", seq: 6, updatedSeq: 6 },
      { text: "Tests failed.", seq: 8, updatedSeq: 8 },
    ]);
    expect(before?.turns[0]?.error).toBe("Command exited with code 1");

    const replayed = new OrchestrationEngine(new EventStore(path));
    await replayed.open();
    expect(replayed.thread("ordered")?.messages).toEqual(before?.messages);
    expect(replayed.thread("ordered")?.turns[0]?.error).toBe("Command exited with code 1");
  });

  it("keeps late buffered activity settled after a local cancellation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasty-late-cancel-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("cancelled", { type: "ThreadCreated", payload: { sessionId: "s-cancelled", cwd: "C:/work", title: "Cancelled" } });
    await engine.append("cancelled", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Stop" } });
    await engine.append("cancelled", { type: "TurnCancelled", payload: { turnId: "turn-1" } });
    await engine.append("cancelled", { type: "MessageDelta", payload: { turnId: "turn-1", role: "thought", text: "Buffered thought" } });
    await engine.append("cancelled", { type: "ToolCallCreated", payload: { tool: { toolCallId: "tool-late", turnId: "turn-1", title: "Late tool", status: "in_progress" } } });

    expect(engine.thread("cancelled")).toMatchObject({
      running: false,
      activeTurnId: undefined,
      activity: [
        expect.objectContaining({ kind: "thought", status: "completed" }),
        expect.objectContaining({ kind: "tool", status: "completed" }),
      ],
    });
  });

  it("persists background task completion and bounds reported history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-background-events-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("tasks", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: "C:/work", title: "Tasks" } });
    for (let index = 0; index < 55; index += 1) {
      const taskId = `bash-task${index}`;
      await engine.append("tasks", { type: "BackgroundTaskRegistered", payload: { taskId, queuedId: `queued-${index}`, turnId: "turn-1", description: `Task ${index}` } });
      await engine.append("tasks", {
        type: "BackgroundTaskFinished",
        payload: {
          taskId,
          status: index === 54 ? "timed_out" : "completed",
          exitCode: index === 54 ? null : 0,
          outputPath: `C:/work/tasks/${taskId}/output.log`,
        },
      });
      await engine.append("tasks", { type: "BackgroundTaskReportQueued", payload: { taskId } });
      await engine.append("tasks", { type: "BackgroundTaskReportDelivered", payload: { taskId } });
    }
    await engine.compact();

    const before = engine.thread("tasks")?.backgroundTasks;
    expect(before).toHaveLength(50);
    expect(before?.at(0)?.taskId).toBe("bash-task5");
    expect(before?.at(-1)).toMatchObject({
      taskId: "bash-task54",
      status: "timed_out",
      exitCode: null,
      outputPath: "C:/work/tasks/bash-task54/output.log",
      reportQueued: true,
      reportDeliveredAt: expect.any(String),
    });

    const replayed = new OrchestrationEngine(new EventStore(path));
    await replayed.open();
    expect(replayed.thread("tasks")?.backgroundTasks).toEqual(before);
  });

  it("persists background report retry deadlines and terminal failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-background-retry-events-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("retry", { type: "ThreadCreated", payload: { sessionId: "session-retry", cwd: "C:/work", title: "Retry" } });
    await engine.append("retry", { type: "BackgroundTaskRegistered", payload: { taskId: "bash-retry", queuedId: "queued-retry", turnId: "turn-1", description: "Build APK" } });
    await engine.append("retry", { type: "BackgroundTaskFinished", payload: { taskId: "bash-retry", status: "completed", exitCode: 0 } });
    await engine.append("retry", { type: "BackgroundTaskReportQueued", payload: { taskId: "bash-retry" } });
    await engine.append("retry", {
      type: "BackgroundTaskReportAttempted",
      payload: { taskId: "bash-retry", attempt: 5, nextAttemptAt: "2026-07-25T12:00:00.000Z" },
    });
    await engine.append("retry", {
      type: "BackgroundTaskReportCancelled",
      payload: { taskId: "bash-retry", failure: "Report service unavailable" },
    });
    await engine.compact();

    const task = engine.thread("retry")?.backgroundTasks[0];
    expect(task).toMatchObject({
      taskId: "bash-retry",
      status: "completed",
      reportAttemptCount: 5,
      reportFailedAt: expect.any(String),
      reportCancelledAt: expect.any(String),
      reportLastError: "Report service unavailable",
    });
    expect(task?.reportNextAttemptAt).toBeUndefined();

    const replayed = new OrchestrationEngine(new EventStore(path));
    await replayed.open();
    expect(replayed.thread("retry")?.backgroundTasks[0]).toEqual(task);
  });
});
