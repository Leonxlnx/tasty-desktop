import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/event-store.js";
import { OrchestrationEngine, titleFromPrompt } from "../src/orchestration.js";

describe("event log replay", () => {
  it("rehydrates an identical projection after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-log-"));
    const path = join(dir, "events.jsonl");
    const first = new OrchestrationEngine(new EventStore(path));
    await first.open();
    await first.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Replay", configOptions: [] } });
    await first.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Hello" } });
    await first.append("thread-1", { type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "Hel" } });
    await first.append("thread-1", { type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "lo" } });
    await first.append("thread-1", { type: "ToolCallCreated", payload: { tool: { toolCallId: "tool-1", title: "Edit file" } } });
    await first.append("thread-1", { type: "UsageUpdated", payload: { usage: { used: 8_192, size: 262_144 } } });
    await first.append("thread-1", { type: "TurnCompleted", payload: { turnId: "turn-1", stopReason: "end_turn", usage: { totalTokens: 200, inputTokens: 140, outputTokens: 60 } } });
    await first.drain();

    const restarted = new OrchestrationEngine(new EventStore(path));
    await restarted.open();
    expect(restarted.threads()).toEqual(first.threads());
    expect(restarted.threads()[0]?.tools[0]?.turnId).toBe("turn-1");
    expect(restarted.threads()[0]?.turns[0]).toMatchObject({ turnId: "turn-1", stopReason: "end_turn", usage: { totalTokens: 200 } });
  });

  it("replays chat renames and deletion tombstones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-lifecycle-"));
    const path = join(dir, "events.jsonl");
    const first = new OrchestrationEngine(new EventStore(path));
    await first.open();
    await first.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Draft", configOptions: [] } });
    await first.append("thread-1", { type: "ThreadRenamed", payload: { title: "Release work" } });
    expect(first.thread("thread-1")?.title).toBe("Release work");
    await first.append("thread-1", { type: "ThreadDeleted", payload: {} });
    expect(first.thread("thread-1")).toBeUndefined();
    await first.drain();

    const restarted = new OrchestrationEngine(new EventStore(path));
    await restarted.open();
    expect(restarted.threads()).toEqual([]);
  });

  it("closes an interrupted turn when the server restarts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-interrupted-"));
    const path = join(dir, "events.jsonl");
    const first = new OrchestrationEngine(new EventStore(path));
    await first.open();
    await first.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Interrupted", configOptions: [] } });
    await first.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Keep working" } });
    await first.append("thread-1", { type: "ApprovalRequested", payload: { requestId: "approval-1", turnId: "turn-1", title: "Run tests", kind: "permission", options: [] } });
    await first.drain();

    const restarted = new OrchestrationEngine(new EventStore(path));
    await restarted.open();
    expect(restarted.thread("thread-1")).toMatchObject({ running: false, activeTurnId: undefined, stopReason: "cancelled", approvals: [] });
  });

  it("compacts completed history into one bounded snapshot per live thread", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-compact-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Compact" } });
    await engine.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Keep the useful result" } });
    await engine.append("thread-1", { type: "ToolCallPatched", payload: { tool: { toolCallId: "tool-1", rawOutput: "x".repeat(100_000) } } });
    await engine.append("thread-1", { type: "TurnCompleted", payload: { turnId: "turn-1", stopReason: "end_turn" } });

    const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).type).toBe("ThreadSnapshot");
    expect(lines[0]!.length).toBeLessThan(20_000);
    expect(engine.thread("thread-1")?.tools[0]?.rawOutput).toMatchObject({ truncated: true });
  });
});

describe("chat titles", () => {
  it("turns the first prompt into a short, readable project label", () => {
    expect(titleFromPrompt("Please redesign the settings panel with clearer categories and responsive spacing."))
      .toBe("Please redesign the settings panel with clearer…");
    expect(titleFromPrompt("   **Fix login** now! More context follows."))
      .toBe("Fix login now");
  });
});
