import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

  it("serializes parallel mutations and rolls back a failed write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-schedule-transactions-"));
    const path = join(directory, "schedules.json");
    const now = Date.parse("2026-07-27T08:00:00.000Z");
    const store = new ScheduleStore(path, () => now);
    await store.open();
    const input = { threadId: "thread-1", text: "Review", cwd: "C:\\project", provider: "kimi" as const, recurrence: "once" as const, nextRunAt: "2026-07-27T09:00:00.000Z" };
    const [first] = await Promise.all([
      store.create({ ...input, name: "First" }),
      store.create({ ...input, name: "Second" }),
    ]);
    expect(store.list().map((schedule) => schedule.name).sort()).toEqual(["First", "Second"]);

    await mkdir(`${path}.${process.pid}.tmp`);
    await expect(store.update(first.id, { name: "Not published" })).rejects.toThrow();
    expect(store.get(first.id)?.name).toBe("First");
    await rm(`${path}.${process.pid}.tmp`, { recursive: true });
    await expect(store.update(first.id, { name: "Published" })).resolves.toMatchObject({ name: "Published" });
  });

  it("rejects an aggregate beyond the persisted schedule limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-schedule-limit-"));
    const path = join(directory, "schedules.json");
    const now = Date.parse("2026-07-27T08:00:00.000Z");
    const schedule = {
      id: "00000000-0000-4000-8000-000000000000", name: "Existing", threadId: "thread-1", text: "Review", cwd: "C:\\project", provider: "kimi",
      recurrence: "once", nextRunAt: "2026-07-27T09:00:00.000Z", enabled: true, createdAt: "2026-07-27T08:00:00.000Z", updatedAt: "2026-07-27T08:00:00.000Z",
    };
    await writeFile(path, JSON.stringify({ version: 1, schedules: Array.from({ length: 500 }, () => schedule) }), "utf8");
    const store = new ScheduleStore(path, () => now);
    await store.open();
    await expect(store.create({ name: "Overflow", threadId: "thread-1", text: "Review", cwd: "C:\\project", provider: "kimi", recurrence: "once", nextRunAt: "2026-07-27T09:00:00.000Z" })).rejects.toThrow();
    expect(store.list()).toHaveLength(500);
  });

  it("recovers a valid backup and rejects state with no valid copy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-schedule-recovery-"));
    const path = join(directory, "schedules.json");
    const now = Date.parse("2026-07-27T08:00:00.000Z");
    const store = new ScheduleStore(path, () => now);
    await store.open();
    const input = { threadId: "thread-1", text: "Review", cwd: "C:\\project", provider: "kimi" as const, recurrence: "once" as const, nextRunAt: "2026-07-27T09:00:00.000Z" };
    const first = await store.create({ ...input, name: "First" });
    await store.create({ ...input, name: "Second" });
    await writeFile(path, "not json", "utf8");

    const recovered = new ScheduleStore(path, () => now);
    await recovered.open();
    expect(recovered.get(first.id)?.name).toBe("First");

    await writeFile(path, "not json", "utf8");
    await writeFile(`${path}.bak`, "also not json", "utf8");
    await expect(new ScheduleStore(path, () => now).open()).rejects.toThrow("no valid backup");
  });
});
