import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ScheduleStore } from "../src/schedule-store.js";

describe("ScheduleStore", () => {
  it("persists explicit targets and advances recurring work without replay storms", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tasty-schedules-"));
    let now = Date.parse("2026-07-27T08:00:00.000Z");
    const path = join(directory, "schedules.json");
    const store = new ScheduleStore(path, () => now);
    await store.open();
    const schedule = await store.create({ name: "Daily review", threadId: "thread-1", text: "Review the project", cwd: "C:\\project", provider: "kimi", permission: "default", recurrence: "daily", nextRunAt: "2026-07-27T09:00:00.000Z" });
    expect((await store.takeDue())).toEqual([]);

    now = Date.parse("2026-07-30T10:00:00.000Z");
    await expect(store.takeDue()).resolves.toMatchObject([{ id: schedule.id, cwd: "C:\\project", provider: "kimi", permission: "default" }]);
    expect(store.get(schedule.id)?.nextRunAt).toBe("2026-07-31T09:00:00.000Z");
    await store.record(schedule.id, "queued");

    const reopened = new ScheduleStore(path, () => now);
    await reopened.open();
    expect(reopened.get(schedule.id)?.lastResult).toBe("queued");
  });

  it("disables one-time work after its due slot and supports deletion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tasty-schedule-once-"));
    let now = Date.parse("2026-07-27T08:00:00.000Z");
    const store = new ScheduleStore(join(directory, "schedules.json"), () => now);
    await store.open();
    const schedule = await store.create({ name: "One review", threadId: "thread-1", text: "Review once", cwd: "C:\\project", provider: "codex", recurrence: "once", nextRunAt: "2026-07-27T08:01:00.000Z" });
    now += 60_000;
    expect((await store.takeDue())[0]?.id).toBe(schedule.id);
    expect(store.get(schedule.id)?.enabled).toBe(false);
    await store.delete(schedule.id);
    expect(store.list()).toEqual([]);
  });
});
