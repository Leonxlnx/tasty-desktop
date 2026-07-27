import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/event-store.js";
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
    expect(engine.runtimeThreadForSession("shared")?.threadId).toBe("owner");
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

    expect(engine.runtimeThreadForSession("shared")?.threadId).toBe("first");
    expect(engine.thread("later")).toBeUndefined();
    expect(engine.runtimeThreadForSession("promoted")?.threadId).toBe("fallback");
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
        payload: { taskId, status: index === 54 ? "timed_out" : "completed", exitCode: index === 54 ? null : 0 },
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
