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
  #write = Promise.resolve();

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  async open(): Promise<void> {
    const loaded = await readRecoverableJson(this.#path, (value) => stateSchema.safeParse(value).data);
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
    const now = new Date(this.#now()).toISOString();
    const schedule = scheduleSchema.parse({ id: randomUUID(), ...input, enabled: true, createdAt: now, updatedAt: now });
    if (Date.parse(schedule.nextRunAt) < this.#now() - 60_000) throw new Error("Schedule must start in the future");
    this.#schedules.push(schedule);
    await this.#persist();
    return structuredClone(schedule);
  }

  async update(id: string, patch: Partial<Pick<Schedule, "name" | "text" | "recurrence" | "nextRunAt" | "enabled">>): Promise<Schedule> {
    const index = this.#schedules.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("Schedule was not found");
    const schedule = scheduleSchema.parse({ ...this.#schedules[index], ...patch, updatedAt: new Date(this.#now()).toISOString() });
    this.#schedules[index] = schedule;
    await this.#persist();
    return structuredClone(schedule);
  }

  async delete(id: string): Promise<void> {
    const next = this.#schedules.filter((item) => item.id !== id);
    if (next.length === this.#schedules.length) throw new Error("Schedule was not found");
    this.#schedules = next;
    await this.#persist();
  }

  async takeDue(): Promise<Schedule[]> {
    const now = this.#now();
    const due = this.#schedules.filter((item) => item.enabled && Date.parse(item.nextRunAt) <= now);
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
    if (due.length) await this.#persist();
    return structuredClone(due);
  }

  async record(id: string, result: string): Promise<void> {
    const schedule = this.#schedules.find((item) => item.id === id);
    if (!schedule) return;
    schedule.lastResult = result.slice(0, 500);
    schedule.updatedAt = new Date(this.#now()).toISOString();
    await this.#persist();
  }

  async #persist(): Promise<void> {
    this.#write = this.#write.catch(() => undefined).then(() => writeRecoverableJson(this.#path, { version: 1, schedules: this.#schedules }));
    await this.#write;
  }
}

export function scheduleTarget(provider: ProviderId, cwd: string, instanceId?: string): Pick<NewSchedule, "provider" | "cwd" | "instanceId"> {
  return { provider, cwd, ...(instanceId ? { instanceId } : {}) };
}
