import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventStore } from "../src/event-store.js";
import { OrchestrationEngine, type DomainEvent } from "../src/orchestration.js";
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
  it.each([
    ["thread flush", (ingestion: RuntimeIngestion) => ingestion.flush("thread-1")],
    ["all-thread flush", (ingestion: RuntimeIngestion) => ingestion.flushAll()],
  ] as const)("waits for ingress chained while the %s barrier is blocked", async (_name, startFlush) => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstEntered!: () => void;
    let secondEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstAppend = new Promise<void>((resolve) => { firstEntered = resolve; });
    const secondAppend = new Promise<void>((resolve) => { secondEntered = resolve; });
    let appendCount = 0;
    const engine = {
      runtimeThreadForSession: () => ({ threadId: "thread-1", activeTurnId: "turn-1", provider: "kimi", instanceId: undefined }),
      append: async () => {
        appendCount += 1;
        if (appendCount === 1) {
          firstEntered();
          await firstGate;
        } else {
          secondEntered();
          await secondGate;
        }
        return {};
      },
    } as unknown as OrchestrationEngine;
    const ingestion = new RuntimeIngestion(engine);
    const event = { type: "session_update" as const, params: { sessionId: "session-1", update: { sessionUpdate: "plan" as const, entries: [] } } };

    const first = ingestion.ingest(event, { provider: "kimi" });
    await firstAppend;
    let flushed = false;
    const flush = startFlush(ingestion).then(() => { flushed = true; });
    const second = ingestion.ingest(event, { provider: "kimi" });
    releaseFirst();
    await secondAppend;
    await Promise.resolve();
    expect(flushed).toBe(false);

    releaseSecond();
    await Promise.all([first, second, flush]);
    expect(flushed).toBe(true);
  });

  it.each([
    ["thread flush", (ingestion: RuntimeIngestion) => ingestion.flush("thread-1")],
    ["all-thread flush", (ingestion: RuntimeIngestion) => ingestion.flushAll()],
  ] as const)("rechecks stream ingress that arrives during the %s append", async (_name, startFlush) => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    let firstEntered!: () => void;
    let secondEntered!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    const firstAppend = new Promise<void>((resolve) => { firstEntered = resolve; });
    const secondAppend = new Promise<void>((resolve) => { secondEntered = resolve; });
    let appendCount = 0;
    const engine = {
      runtimeThreadForSession: () => ({ threadId: "thread-1", activeTurnId: "turn-1", provider: "kimi", instanceId: undefined }),
      append: async () => {
        appendCount += 1;
        if (appendCount === 1) {
          firstEntered();
          await firstGate;
        } else {
          secondEntered();
          await secondGate;
        }
        return {};
      },
    } as unknown as OrchestrationEngine;
    const ingestion = new RuntimeIngestion(engine);
    const stream = (text: string) => ingestion.ingest({
      type: "session_update",
      params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    }, { provider: "kimi" });

    await stream("first");
    let flushed = false;
    const flush = startFlush(ingestion).then(() => { flushed = true; });
    await firstAppend;
    await stream("second");
    releaseFirst();
    await secondAppend;
    await Promise.resolve();
    expect(flushed).toBe(false);

    releaseSecond();
    await flush;
    expect(flushed).toBe(true);
  });

  it("stably discovers a new thread while flushAll is draining another thread", async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst!: () => void;
      let releaseSecond!: () => void;
      let firstEntered!: () => void;
      let secondEntered!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
      const firstAppend = new Promise<void>((resolve) => { firstEntered = resolve; });
      const secondAppend = new Promise<void>((resolve) => { secondEntered = resolve; });
      const engine = {
        runtimeThreadForSession: (sessionId: string) => ({
          threadId: sessionId === "session-1" ? "thread-1" : "thread-2",
          activeTurnId: "turn-1",
          provider: "kimi",
          instanceId: undefined,
        }),
        append: async (threadId: string) => {
          if (threadId === "thread-1") {
            firstEntered();
            await firstGate;
          } else {
            secondEntered();
            await secondGate;
          }
          return {};
        },
      } as unknown as OrchestrationEngine;
      const ingestion = new RuntimeIngestion(engine);
      const stream = (sessionId: string, text: string) => ingestion.ingest({
        type: "session_update",
        params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
      }, { provider: "kimi" });

      await stream("session-1", "first");
      let flushed = false;
      const flush = ingestion.flushAll().then(() => { flushed = true; });
      await firstAppend;
      await stream("session-2", "second");
      releaseFirst();
      await secondAppend;
      await Promise.resolve();
      expect(flushed).toBe(false);

      releaseSecond();
      await flush;
      expect(flushed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets cancellation continue when a stalled ingestion tail cannot drain immediately", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const engine = {
      runtimeThreadForSession: () => ({ threadId: "thread-1", activeTurnId: "turn-1", provider: "kimi", instanceId: undefined }),
      append: () => gate,
    } as unknown as OrchestrationEngine;
    const ingestion = new RuntimeIngestion(engine);
    await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pending" } } } }, { provider: "kimi" });

    await expect(ingestion.flushWithin("thread-1", 10)).resolves.toBe(false);
    release();
    await expect(ingestion.flushWithin("thread-1", 100)).resolves.toBe(true);
  });

  it("coalesces adjacent message chunks before durable publication", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-stream-"));
    const path = join(dir, "events.jsonl");
    const engine = new OrchestrationEngine(new EventStore(path));
    await engine.open();
    await engine.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Stream" } });
    await engine.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Go" } });
    const ingestion = new RuntimeIngestion(engine);
    for (let index = 0; index < 100; index += 1) {
      await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "x" } } } }, { provider: "kimi" });
    }
    await ingestion.flushAll();

    const events = (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string; payload: { text?: string } });
    const deltas = events.filter((event) => event.type === "MessageDelta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.payload.text).toBe("x".repeat(100));
  });

  it("starts a new assistant segment after intervening tool activity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-stream-order-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Stream" } });
    await engine.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Go" } });
    const ingestion = new RuntimeIngestion(engine);
    await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before tool." } } } }, { provider: "kimi" });
    await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run check", status: "in_progress" } } }, { provider: "kimi" });
    await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "While running." } } } }, { provider: "kimi" });
    await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" } } }, { provider: "kimi" });
    await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After tool." } } } }, { provider: "kimi" });
    await ingestion.flushAll();

    expect(engine.thread("thread-1")?.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual([
      "Before tool.",
      "While running.",
      "After tool.",
    ]);
  });

  it("preserves notification order when one runtime delivers callbacks concurrently", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-stream-concurrent-order-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "session-1", cwd: dir, title: "Stream" } });
    await engine.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Go" } });
    const ingestion = new RuntimeIngestion(engine);
    const source = { provider: "kimi" as const };

    await Promise.all([
      ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting." } } } }, source),
      ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } } }, source),
      ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "Run check", status: "in_progress" } } }, source),
      ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "tool_call_update", toolCallId: "tool-1", status: "completed" } } }, source),
    ]);
    await ingestion.flushAll();

    expect(engine.thread("thread-1")?.tools).toEqual([
      expect.objectContaining({ toolCallId: "tool-1", title: "Run check", status: "completed" }),
    ]);
  });

  it("drops an old-generation event queued behind an in-flight append", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const appendEntered = new Promise<void>((resolve) => { entered = resolve; });
    const appended: DomainEvent[] = [];
    let current = true;
    const engine = {
      runtimeThreadForSession: () => ({ threadId: "thread-1", activeTurnId: "turn-a", provider: "kimi", instanceId: undefined }),
      append: async (_threadId: string, event: DomainEvent) => {
        appended.push(event);
        if (appended.length === 1) {
          entered();
          await gate;
        }
        return {};
      },
    } as unknown as OrchestrationEngine;
    const ingestion = new RuntimeIngestion(engine);
    const fence = { generation: {}, isCurrent: () => current };
    const first = ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } } }, { provider: "kimi" }, fence);
    await appendEntered;
    const queued = ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "plan", entries: [] } } }, { provider: "kimi" }, fence);
    current = false;
    release();

    await expect(first).resolves.toBe("thread-1");
    await expect(queued).resolves.toBeUndefined();
    expect(appended).toHaveLength(1);
  });

  it("does not merge or timer-flush stream events from a replaced generation", async () => {
    vi.useFakeTimers();
    try {
      let current = "a";
      const appended: DomainEvent[] = [];
      const engine = {
        runtimeThreadForSession: () => ({ threadId: "thread-1", activeTurnId: `turn-${current}`, provider: "kimi", instanceId: undefined }),
        append: async (_threadId: string, event: DomainEvent) => {
          appended.push(event);
          return {};
        },
      } as unknown as OrchestrationEngine;
      const ingestion = new RuntimeIngestion(engine);
      const fenceA = { generation: {}, isCurrent: () => current === "a" };
      const fenceB = { generation: {}, isCurrent: () => current === "b" };
      await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old" } } } }, { provider: "kimi" }, fenceA);
      current = "b";
      await ingestion.ingest({ type: "session_update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "new" } } } }, { provider: "kimi" }, fenceB);
      await vi.advanceTimersByTimeAsync(40);
      await ingestion.flushAll();

      expect(appended).toEqual([
        expect.objectContaining({ type: "MessageDelta", payload: expect.objectContaining({ turnId: "turn-b", text: "new" }) }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps equal session ids isolated across runtime instances", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-stream-instance-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("default", { type: "ThreadCreated", payload: { sessionId: "shared", cwd: dir, title: "Default" } });
    await engine.append("named", { type: "ThreadCreated", payload: { sessionId: "shared", provider: "kimi", instanceId: "work", cwd: dir, title: "Named" } });
    await engine.append("default", { type: "TurnStarted", payload: { turnId: "default-turn", text: "Go" } });
    await engine.append("named", { type: "TurnStarted", payload: { turnId: "named-turn", text: "Go" } });
    const ingestion = new RuntimeIngestion(engine);

    await ingestion.ingest({ type: "session_update", params: { sessionId: "shared", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "default result" } } } }, { provider: "kimi" });
    await ingestion.ingest({ type: "session_update", params: { sessionId: "shared", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "named result" } } } }, { provider: "kimi", instanceId: "work" });
    await ingestion.flushAll();

    expect(engine.thread("default")?.messages.some((message) => message.text === "default result")).toBe(true);
    expect(engine.thread("default")?.messages.some((message) => message.text === "named result")).toBe(false);
    expect(engine.thread("named")?.messages.some((message) => message.text === "named result")).toBe(true);
    expect(engine.thread("named")?.messages.some((message) => message.text === "default result")).toBe(false);
  });

  it("rejects events from another runtime that spoof a live session id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-stream-spoof-"));
    const engine = new OrchestrationEngine(new EventStore(join(dir, "events.jsonl")));
    await engine.open();
    await engine.append("thread-1", { type: "ThreadCreated", payload: { sessionId: "shared", cwd: dir, title: "Victim" } });
    await engine.append("thread-1", { type: "TurnStarted", payload: { turnId: "turn-1", text: "Go" } });
    const ingestion = new RuntimeIngestion(engine);
    const spoof = { provider: "kimi" as const, instanceId: "attacker" };

    await expect(ingestion.ingest({ type: "session_update", params: { sessionId: "shared", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "spoofed" } } } }, spoof)).resolves.toBeUndefined();
    await expect(ingestion.ingest({ type: "session_update", params: { sessionId: "shared", update: { sessionUpdate: "tool_call", toolCallId: "spoof-tool", title: "Spoof", status: "in_progress" } } }, spoof)).resolves.toBeUndefined();
    await expect(ingestion.ingest({
      type: "permission_request",
      requestId: "spoof-permission",
      params: {
        sessionId: "shared",
        toolCall: { toolCallId: "spoof-tool", title: "Spoof", status: "pending" },
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      },
    }, spoof)).resolves.toBeUndefined();
    await ingestion.flushAll();

    expect(engine.thread("thread-1")).toMatchObject({ tools: [], approvals: [] });
    expect(engine.thread("thread-1")?.messages.some((message) => message.text === "spoofed")).toBe(false);
    await expect(ingestion.ingest({ type: "session_update", params: { sessionId: "shared", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "accepted" } } } }, { provider: "kimi" })).resolves.toBe("thread-1");
    await ingestion.flushAll();
    expect(engine.thread("thread-1")?.messages.some((message) => message.text === "accepted")).toBe(true);
  });
});
