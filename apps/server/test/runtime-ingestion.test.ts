import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventStore } from "../src/event-store.js";
import { OrchestrationEngine } from "../src/orchestration.js";
import { classifyApproval, hasConfiguredModel, RuntimeIngestion, toDomainEvent, toolCallInput } from "../src/runtime-ingestion.js";

describe("approval classification", () => {
  it("recognizes Kimi question and plan-review option namespaces", () => {
    expect(classifyApproval([{ optionId: "q0_opt_0" }, { optionId: "q0_skip" }])).toBe("question");
    expect(classifyApproval([{ optionId: "plan_opt_0" }, { optionId: "plan_revise" }])).toBe("plan_review");
    expect(classifyApproval([{ optionId: "approve_once" }, { optionId: "reject" }])).toBe("permission");
  });
});

describe("runtime model configuration", () => {
  it("rejects the empty model picker returned for an unprovisioned account", () => {
    expect(hasConfiguredModel([{ type: "select", id: "model", name: "Model", category: "model", currentValue: "", options: [] }])).toBe(false);
    expect(hasConfiguredModel([{ type: "select", id: "model", name: "Model", category: "model", currentValue: "kimi-k3", options: [{ value: "kimi-k3", name: "Kimi K3" }] }])).toBe(true);
  });
});

describe("runtime usage", () => {
  it("projects ACP context-window updates without inventing subscription quota", () => {
    expect(toDomainEvent({ sessionUpdate: "usage_update", used: 8_192, size: 262_144 }, "turn-1")).toEqual({
      type: "UsageUpdated",
      payload: { usage: { used: 8_192, size: 262_144 } },
    });
  });
});

describe("runtime tool input", () => {
  it("preserves structured tool input for desktop-native agent views", () => {
    const update = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "agent-1",
      title: "Agent: inspect motion",
      status: "in_progress" as const,
      content: [{ type: "content" as const, content: { type: "text" as const, text: JSON.stringify({ subagent_type: "explore", description: "Inspect motion", run_in_background: true }) } }],
    };
    expect(toolCallInput(update)).toEqual({ subagent_type: "explore", description: "Inspect motion", run_in_background: true });
    expect(toDomainEvent(update, "turn-1")).toMatchObject({ payload: { tool: { rawInput: { subagent_type: "explore" } } } });
  });
});

describe("runtime streaming", () => {
  it("coalesces adjacent message chunks before durable publication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-stream-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Stream" } });
    await engine.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Go" } });
    const ingestion = new RuntimeIngestion(engine);
    for (let index = 0; index < 100; index += 1) {
      await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } });
    }
    await ingestion.flushAll();

    const events = (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; payload: { text?: string } });
    const deltas = events.filter((event) => event.type === "MessageDelta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.payload.text).toBe("x".repeat(100));
  });
});
