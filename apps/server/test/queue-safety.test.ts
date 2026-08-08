import { describe, expect, it, vi } from "vitest";
import { acceptQueuedInsertion, persistQueuedInsertion, persistQueueSnapshot, QueueInsertionGate, readQueueAfterPreflight, reconcileMissingSubmissionPayloads, withStableQueueWrites } from "../src/queue-safety.js";

describe("queue safety", () => {
  it("reads the current text queue only after an image preflight resumes", async () => {
    const queues = new Map<string, Array<{ queuedId: string }>>();
    let release!: (blocked: boolean) => void;
    const imageAdmission = readQueueAfterPreflight(queues, "thread", () => new Promise<boolean>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const text = { queuedId: "text-admitted-during-image-preflight" };
    queues.set("thread", [text]);

    release(false);
    await expect(imageAdmission).resolves.toEqual({ queue: [text], preflightResult: false });
  });

  it.each(["text", "image"])("keeps pending %s insertions gated, hidden, and serialized before persistence", async () => {
    const gate = new QueueInsertionGate();
    const queue = [{ queuedId: "pending" }, { queuedId: "admitted" }];
    let release!: () => void;
    const commit = gate.during("thread", "pending", () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    let admitted = false;
    const next = gate.during("thread", "admitted", async () => { admitted = true; });
    await Promise.resolve();

    expect(gate.has("thread", "pending")).toBe(true);
    expect(gate.has("thread", "admitted")).toBe(true);
    expect(gate.hasAny("thread")).toBe(true);
    expect(admitted).toBe(false);
    expect(() => gate.assertIdle("thread")).toThrow(/still being accepted/i);
    expect(gate.visible("thread", queue)).toEqual([]);
    release();
    await Promise.all([commit, next]);
    expect(admitted).toBe(true);
    expect(gate.has("thread", "pending")).toBe(false);
    expect(gate.hasAny("thread")).toBe(false);
    expect(() => gate.assertIdle("thread")).not.toThrow();
    expect(gate.visible("thread", queue)).toEqual(queue);
  });

  it("does not let a cross-thread insertion leak into a failed global persistence snapshot", async () => {
    const gate = new QueueInsertionGate();
    const queues = new Map<string, Array<{ queuedId: string }>>();
    const persisted: string[][] = [];
    let rejectFirst!: (error: Error) => void;
    const firstItem = { queuedId: "first" };
    const first = gate.during("thread-a", firstItem.queuedId, async () => {
      queues.set("thread-a", [firstItem]);
      await persistQueuedInsertion(queues, "thread-a", firstItem, () => new Promise<void>((_, reject) => { rejectFirst = reject; }));
    });
    while (!rejectFirst) await Promise.resolve();

    const secondItem = { queuedId: "second" };
    const second = gate.during("thread-b", secondItem.queuedId, async () => {
      const queue = queues.get("thread-b") ?? [];
      queue.push(secondItem);
      queues.set("thread-b", queue);
      await persistQueuedInsertion(queues, "thread-b", secondItem, async () => { persisted.push([...queues.values()].flatMap((items) => items.map((item) => item.queuedId))); });
    });
    await Promise.resolve();
    expect(queues.get("thread-a")).toEqual([firstItem]);
    expect(queues.has("thread-b")).toBe(false);

    rejectFirst(new Error("disk full"));
    await expect(first).rejects.toThrow("disk full");
    await expect(second).resolves.toBeUndefined();
    expect(queues.has("thread-a")).toBe(false);
    expect(queues.get("thread-b")).toEqual([secondItem]);
    expect(persisted).toEqual([["second"]]);
  });

  it("re-fetches the committed queue inside serialized concurrent insertions", async () => {
    const gate = new QueueInsertionGate();
    const queues = new Map<string, Array<{ queuedId: string }>>();
    const insert = (queuedId: string) => gate.during("thread", queuedId, async () => {
      const queue = queues.get("thread") ?? [];
      queue.push({ queuedId });
      queues.set("thread", queue);
    });

    await Promise.all([insert("first"), insert("second")]);
    expect(queues.get("thread")).toEqual([{ queuedId: "first" }, { queuedId: "second" }]);
  });

  it("persists an immutable global snapshot and recomputes only after a prior failure", async () => {
    let release!: () => void;
    const previous = new Promise<void>((resolve) => { release = resolve; });
    const persistence = { tail: previous, failureEpoch: 0 };
    const state = { "thread-a": [{ queuedId: "committed", mentions: ["before"] }] };
    const written: typeof state[] = [];
    const success = persistQueueSnapshot(persistence, structuredClone(state), () => structuredClone(state), async (value) => { written.push(value); });
    state["thread-a"][0]!.mentions[0] = "edited-later";
    Object.assign(state, { "thread-b": [{ queuedId: "pending", mentions: [] }] });
    release();
    await success;
    expect(written).toEqual([{ "thread-a": [{ queuedId: "committed", mentions: ["before"] }] }]);
  });

  it("invalidates every queued follower snapshot after one failed write", async () => {
    const persistence = { tail: Promise.resolve(), failureEpoch: 0 };
    let current = { "thread-a": [{ queuedId: "ghost" }], "thread-b": [{ queuedId: "committed" }] };
    const stale = structuredClone(current);
    const written: typeof current[] = [];
    let attempts = 0;
    const write = async (value: typeof current) => {
      if (attempts++ === 0) throw new Error("disk full");
      written.push(value);
    };
    const first = persistQueueSnapshot(persistence, structuredClone(stale), () => structuredClone(current), write);
    const rollback = first.catch(() => { current = { "thread-a": [], "thread-b": [{ queuedId: "committed" }] }; });
    const second = persistQueueSnapshot(persistence, structuredClone(stale), () => structuredClone(current), write);
    const third = persistQueueSnapshot(persistence, structuredClone(stale), () => structuredClone(current), write);

    await Promise.all([rollback, second, third]);
    expect(written).toEqual([
      { "thread-a": [], "thread-b": [{ queuedId: "committed" }] },
      { "thread-a": [], "thread-b": [{ queuedId: "committed" }] },
    ]);
    expect(persistence.failureEpoch).toBe(1);
  });

  it("registers an insertion write synchronously once the global tail stays stable", async () => {
    const persistence = { tail: Promise.resolve(), failureEpoch: 0 };
    let rejectFirst!: (error: Error) => void;
    const first = persistQueueSnapshot(persistence, { write: "first" }, () => ({ write: "recomputed" }), () => new Promise<void>((_, reject) => { rejectFirst = reject; }));
    while (!rejectFirst) await Promise.resolve();
    let inserted = false;
    let ownWrite!: Promise<void>;
    const insertion = withStableQueueWrites(persistence, async () => {
      inserted = true;
      ownWrite = persistQueueSnapshot(persistence, { write: "insertion" }, () => ({ write: "insertion" }), async () => undefined);
      return ownWrite;
    });
    let releaseFollower!: () => void;
    const follower = persistQueueSnapshot(persistence, { write: "follower" }, () => ({ write: "recomputed" }), () => new Promise<void>((resolve) => { releaseFollower = resolve; }));

    rejectFirst(new Error("disk full"));
    await expect(first).rejects.toThrow("disk full");
    await Promise.resolve();
    expect(inserted).toBe(false);
    releaseFollower();
    await follower;
    await insertion;
    expect(inserted).toBe(true);
    expect(persistence.tail).toBe(ownWrite);
  });

  it("rolls back the inserted queued ID after its object is replaced during persistence", async () => {
    const before = { queuedId: "before", text: "before" };
    const inserted = { queuedId: "inserted", text: "original" };
    const after = { queuedId: "after", text: "after" };
    const queues = new Map([["thread", [before, inserted, after]]]);

    await expect(persistQueuedInsertion(queues, "thread", inserted, async () => {
      queues.set("thread", [before, { ...inserted, text: "replaced" }, after]);
      throw new Error("disk full");
    })).rejects.toThrow("disk full");

    expect(queues.get("thread")).toEqual([before, after]);
  });

  it.each(["text", "image"])("removes and persists a %s item before rethrowing a receipt append failure", async () => {
    const before = { queuedId: "before", text: "before" };
    const inserted = { queuedId: "inserted", text: "original" };
    const after = { queuedId: "after", text: "after" };
    const queues = new Map([["thread", [before, inserted, after]]]);
    const persistRollback = vi.fn(async () => {
      expect(queues.get("thread")?.some((item) => item.queuedId === inserted.queuedId)).toBe(false);
    });

    await expect(acceptQueuedInsertion(queues, "thread", inserted, async () => {
      queues.set("thread", [before, { ...inserted, text: "replaced" }, after]);
      throw new Error("receipt append failed");
    }, persistRollback)).rejects.toThrow("receipt append failed");

    expect(queues.get("thread")).toEqual([before, after]);
    expect(persistRollback).toHaveBeenCalledOnce();
  });

  it("keeps the failed item out of memory when rollback persistence also fails", async () => {
    const inserted = { queuedId: "inserted" };
    const queues = new Map([["thread", [inserted]]]);

    await expect(acceptQueuedInsertion(queues, "thread", inserted, async () => {
      throw new Error("receipt append failed");
    }, async () => {
      throw new Error("rollback persistence failed");
    })).rejects.toThrow("rollback persistence failed");

    expect(queues.has("thread")).toBe(false);
  });

  it("fails reconciliation when payload-loss durability fails", async () => {
    const markPayloadLost = vi.fn(async () => {
      throw new Error("event append failed");
    });

    await expect(reconcileMissingSubmissionPayloads([{
      threadId: "thread",
      submissionReceipts: [{ submissionId: "submission", queuedId: "queued", state: "queued" }],
    }], new Map(), markPayloadLost)).rejects.toThrow("event append failed");
    expect(markPayloadLost).toHaveBeenCalledWith("thread", ["submission"]);
  });
});
