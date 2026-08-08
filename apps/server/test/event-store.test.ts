import { appendFile, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventStore } from "../src/event-store.js";
import { OrchestrationEngine, titleFromPrompt } from "../src/orchestration.js";

const { readFileSpy } = vi.hoisted(() => ({ readFileSpy: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => {
      readFileSpy(...args);
      return Reflect.apply(actual.readFile, actual, args);
    },
  };
});

describe("event log replay", () => {
  it("streams a large log without reading the whole file before replay", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-large-"));
    const path = join(dir, "events.jsonl");
    const record = `${JSON.stringify({ threadId: "thread-1", seq: 1, type: "ThreadRenamed", payload: { title: "Streamed" }, createdAt: "2026-08-02T00:00:00.000Z" })}\n`;
    const count = Math.ceil((1024 * 1024) / Buffer.byteLength(record)) + 1;
    await writeFile(path, record.repeat(count), "utf8");
    readFileSpy.mockClear();

    let replayed = 0;
    await new EventStore(path).open(() => { replayed += 1; });

    expect(replayed).toBe(count);
    expect(readFileSpy.mock.calls.some(([candidate]) => candidate === path)).toBe(false);
  });

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
    await first.append("thread-1", { type: "CheckpointPartReverted", payload: { checkpoint: { turnId: "turn-1", phase: "reverted", ref: "refs/reverted", commit: "abc", root: dir }, turnId: "turn-1", path: "src/a.ts", hunkIndex: 0 } });
    await first.drain();

    const restarted = new OrchestrationEngine(new EventStore(path));
    await restarted.open();
    expect(restarted.threads()).toEqual(first.threads());
    expect(restarted.threads()[0]?.tools[0]?.turnId).toBe("turn-1");
    expect(restarted.threads()[0]?.turns[0]).toMatchObject({ turnId: "turn-1", stopReason: "end_turn", usage: { totalTokens: 200 } });
    expect(restarted.threads()[0]?.revertedParts).toEqual([{ turnId: "turn-1", path: "src/a.ts", hunkIndex: 0, revertedAt: expect.any(String) }]);
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

  it("preserves worktree metadata and reversible archive state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasty-event-worktree-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: join(dir, "worktree"), worktree: { sourceCwd: dir, branch: "tasty/thread-1" }, title: "Isolated" } });
    await engine.append("thread-1", { type: "ThreadArchived", payload: { archived: true } });
    expect(engine.thread("thread-1")).toMatchObject({ worktree: { sourceCwd: dir, branch: "tasty/thread-1" }, archivedAt: expect.any(String) });
    await engine.append("thread-1", { type: "ThreadArchived", payload: { archived: false } });
    expect(engine.thread("thread-1")?.archivedAt).toBeUndefined();
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
    expect(restarted.thread("thread-1")).toMatchObject({ running: false, activeTurnId: undefined, stopReason: "cancelled", lifecycle: { phase: "idle" }, approvals: [] });
  });

  it("recovers interrupted preparation and ignores a stale terminal event", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tasty-event-phase-"));
    const path = join(dir, "events.jsonl");
    const first = new OrchestrationEngine(new EventStore(path));
    await first.open();
    await first.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Lifecycle" } });
    await first.append("thread-1", { type: "TurnPhaseChanged", payload: { phase: "preparing", turnId: "turn-prep", queuedId: "queued-1" } });
    await first.drain();

    const restarted = new OrchestrationEngine(new EventStore(path));
    await restarted.open();
    expect(restarted.thread("thread-1")?.lifecycle.phase).toBe("idle");
    await restarted.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-current", text: "Current" } });
    await restarted.append("thread-1", { type: "TurnCompleted", payload: { turnId: "turn-stale", stopReason: "end_turn" } });
    expect(restarted.thread("thread-1")).toMatchObject({ running: true, activeTurnId: "turn-current", lifecycle: { phase: "running", turnId: "turn-current" } });
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

  it("trims an incomplete final record without losing earlier events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-torn-tail-"));
    const path = join(dir, "events.jsonl");
    const first = new OrchestrationEngine(new EventStore(path));
    await first.open();
    await first.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Recovered" } });
    await first.drain();
    await appendFile(path, '{"threadId":"thread-1","seq":2,"type":"ThreadRenamed"', "utf8");

    const restarted = new OrchestrationEngine(new EventStore(path));
    await restarted.open();
    expect(restarted.thread("thread-1")?.title).toBe("Recovered");
    await restarted.append("thread-1", { type: "ThreadRenamed", payload: { title: "Still writable" } });
    await restarted.drain();

    const lines = (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ seq: 2, type: "ThreadRenamed" });
  });

  it("retains and safely appends after an oversized final record without a newline", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-valid-tail-"));
    const path = join(dir, "events.jsonl");
    const oversizedTitle = "x".repeat(1024 * 1024 + 1);
    const record = JSON.stringify({ threadId: "thread-1", seq: 1, type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: oversizedTitle }, createdAt: "2026-08-02T00:00:00.000Z" });
    await writeFile(path, record, "utf8");

    const replayed: string[] = [];
    const store = new EventStore(path);
    await store.open((event) => { replayed.push(event.type); });
    await store.append("thread-1", { type: "ThreadRenamed", payload: { title: "Retained" } });
    await store.drain();

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(replayed).toEqual(["ThreadCreated"]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ seq: 1, payload: { title: oversizedTitle } });
    expect(lines[1]).toMatchObject({ seq: 2, type: "ThreadRenamed", payload: { title: "Retained" } });
  });

  it("recovers an oversized incomplete final record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-oversized-torn-tail-"));
    const path = join(dir, "events.jsonl");
    const first = JSON.stringify({ threadId: "thread-1", seq: 1, type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Recovered" }, createdAt: "2026-08-02T00:00:00.000Z" });
    const incomplete = JSON.stringify({ threadId: "thread-1", seq: 2, type: "ThreadRenamed", payload: { title: "x".repeat(1024 * 1024 + 1) }, createdAt: "2026-08-02T00:00:01.000Z" }).slice(0, -1);
    await writeFile(path, `${first}\n${incomplete}`, "utf8");

    const replayed: string[] = [];
    const store = new EventStore(path);
    await store.open((event) => { replayed.push(event.type); });
    await store.append("thread-1", { type: "ThreadRenamed", payload: { title: "Still writable" } });
    await store.drain();

    const lines = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(replayed).toEqual(["ThreadCreated"]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ seq: 2, type: "ThreadRenamed", payload: { title: "Still writable" } });
  });

  it("fails closed on corruption before the final record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-interior-corrupt-"));
    const path = join(dir, "events.jsonl");
    const first = new OrchestrationEngine(new EventStore(path));
    await first.open();
    await first.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Valid" } });
    await first.drain();
    await appendFile(path, '{x\n{"threadId":"thread-1","seq":2,"type":"ThreadRenamed","payload":{"title":"Hidden"},"createdAt":"2026-07-25T00:00:00.000Z"}\n', "utf8");

    await expect(new OrchestrationEngine(new EventStore(path)).open()).rejects.toThrow("JSON");
  });

  it("does not discard a malformed final record that is not an incomplete JSON prefix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-event-final-corrupt-"));
    const path = join(dir, "events.jsonl");
    const first = new OrchestrationEngine(new EventStore(path));
    await first.open();
    await first.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Valid" } });
    await first.drain();
    await appendFile(path, "{x", "utf8");

    await expect(new OrchestrationEngine(new EventStore(path)).open()).rejects.toThrow("JSON");
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
