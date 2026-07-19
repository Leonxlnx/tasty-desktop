import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/event-store.js";
import { OrchestrationEngine } from "../src/orchestration.js";

describe("orchestration engine", () => {
  it("replays legacy ThreadCreated events that predate config options", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-orchestration-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("legacy", { type: "ThreadCreated", payload: { sessionId: "s-1", cwd: "C:/work", title: "Old chat" } });
    const thread = engine.thread("legacy");
    expect(thread?.configOptions).toEqual([]);
    expect(thread?.activity).toEqual([]);
    expect(thread?.kind).toBe("project");
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
});
