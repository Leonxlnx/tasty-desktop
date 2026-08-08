import { randomUUID } from "node:crypto";
import { z } from "zod";
import { readRecoverableJson, writeRecoverableJson } from "./recoverable-json.js";
import type { ProviderId } from "./orchestration.js";

const scheduleSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(120), threadId: z.string().min(1), text: z.string().min(1).max(100_000),
  cwd: z.string().min(1), provider: z.enum(["kimi", "codex", "claude", "cursor", "opencode"]), instanceId: z.string().optional(), permission: z.string().max(120).optional(),
  recurrence: z.enum(["once", "daily", "weekly"]), nextRunAt: z.string().datetime(), enabled: z.boolean(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  lastRunAt: z.string().datetime().optional(), lastResult: z.string().max(500).optional(),
});
const stateSchema = z.object({ version: z.literal(1), schedules: z.array(scheduleSchema).max(500) });

export type Schedule = z.infer<typeof scheduleSchema>;
type NewSchedule = Pick<Schedule, "name" | "threadId" | "text" | "cwd" | "provider" | "recurrence" | "nextRunAt"> & { instanceId?: string; permission?: string };

export class ScheduleStore {
  readonly #path: string;
  readonly #now: () => number;
  #schedules: Schedule[] = [];
  #mutation = Promise.resolve();

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  async open(): Promise<void> {
    const loaded = await readRecoverableJson(this.#path, (value) => stateSchema.safeParse(value).data);
    if (!loaded.value && loaded.corrupt) throw new Error("Schedule state is corrupt and no valid backup is available");
    this.#schedules = loaded.value?.schedules ?? [];
  }

  list(): Schedule[] {
    return structuredClone(this.#schedules).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt));
  }

  get(id: string): Schedule | undefined {
    const schedule = this.#schedules.find((item) => item.id === id);
    return schedule ? structuredClone(schedule) : undefined;
  }

  async create(input: NewSchedule): Promise<Schedule> {
    return this.#mutate((schedules) => {
      const now = new Date(this.#now()).toISOString();
      const schedule = scheduleSchema.parse({ id: randomUUID(), ...input, enabled: true, createdAt: now, updatedAt: now });
      if (Date.parse(schedule.nextRunAt) < this.#now() - 60_000) throw new Error("Schedule must start in the future");
      schedules.push(schedule);
      return { result: structuredClone(schedule), changed: true };
    });
  }

  async update(id: string, patch: Partial<Pick<Schedule, "name" | "text" | "recurrence" | "nextRunAt" | "enabled">>): Promise<Schedule> {
    return this.#mutate((schedules) => {
      const index = schedules.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Schedule was not found");
      const schedule = scheduleSchema.parse({ ...schedules[index], ...patch, updatedAt: new Date(this.#now()).toISOString() });
      schedules[index] = schedule;
      return { result: structuredClone(schedule), changed: true };
    });
  }

  async delete(id: string): Promise<void> {
    await this.#mutate((schedules) => {
      const index = schedules.findIndex((item) => item.id === id);
      if (index < 0) throw new Error("Schedule was not found");
      schedules.splice(index, 1);
      return { result: undefined, changed: true };
    });
  }

  async takeDue(): Promise<Schedule[]> {
    return this.#mutate((schedules) => {
      const now = this.#now();
      const due = schedules.filter((item) => item.enabled && Date.parse(item.nextRunAt) <= now);
      for (const schedule of due) {
        schedule.lastRunAt = new Date(now).toISOString();
        schedule.updatedAt = schedule.lastRunAt;
        if (schedule.recurrence === "once") schedule.enabled = false;
        else {
          let next = new Date(schedule.nextRunAt);
          do { next.setDate(next.getDate() + (schedule.recurrence === "weekly" ? 7 : 1)); } while (next.getTime() <= now);
          schedule.nextRunAt = next.toISOString();
        }
      }
      return { result: structuredClone(due), changed: due.length > 0 };
    });
  }

  async record(id: string, result: string): Promise<void> {
    await this.#mutate((schedules) => {
      const schedule = schedules.find((item) => item.id === id);
      if (!schedule) return { result: undefined, changed: false };
      schedule.lastResult = result.slice(0, 500);
      schedule.updatedAt = new Date(this.#now()).toISOString();
      return { result: undefined, changed: true };
    });
  }

  async #mutate<T>(change: (schedules: Schedule[]) => { result: T; changed: boolean }): Promise<T> {
    const operation = this.#mutation.then(async () => {
      const schedules = structuredClone(this.#schedules);
      const { result, changed } = change(schedules);
      if (changed) {
        const next = stateSchema.parse({ version: 1, schedules });
        await writeRecoverableJson(this.#path, next);
        this.#schedules = next.schedules;
      }
      return result;
    });
    this.#mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }
}

export function scheduleTarget(provider: ProviderId, cwd: string, instanceId?: string): Pick<NewSchedule, "provider" | "cwd" | "instanceId"> {
  return { provider, cwd, ...(instanceId ? { instanceId } : {}) };
}
