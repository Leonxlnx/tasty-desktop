import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { DomainEvent } from "./orchestration.js";

const storedEventSchema = z.object({
  threadId: z.string().min(1),
  seq: z.number().int().positive(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});

export type StoredEvent = {
  threadId: string;
  seq: number;
  type: DomainEvent["type"];
  payload: DomainEvent["payload"];
  createdAt: string;
};

export class EventStore {
  readonly #path: string;
  readonly #seq = new Map<string, number>();
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string) {
    this.#path = path;
  }

  async open(replay: (event: StoredEvent) => void): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await this.#recoverBackup();
    this.#seq.clear();
    let input;
    try {
      input = createReadStream(this.#path, { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      let index = 0;
      for await (const line of lines) {
        index += 1;
        if (!line.trim()) continue;
        const parsed = storedEventSchema.safeParse(JSON.parse(line));
        if (!parsed.success) throw new Error(`Invalid event log line ${index}: ${parsed.error.message}`);
        const event = parsed.data as StoredEvent;
        this.#seq.set(event.threadId, Math.max(this.#seq.get(event.threadId) ?? 0, event.seq));
        replay(event);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      input?.close();
    }
  }

  append(threadId: string, event: DomainEvent): Promise<StoredEvent> {
    const operation = this.#tail.then(async () => {
      const stored: StoredEvent = {
        threadId,
        seq: (this.#seq.get(threadId) ?? 0) + 1,
        type: event.type,
        payload: event.payload,
        createdAt: new Date().toISOString(),
      };
      await appendFile(this.#path, `${JSON.stringify(stored)}\n`, "utf8");
      this.#seq.set(threadId, stored.seq);
      return stored;
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  replace(snapshots: Array<{ threadId: string; event: DomainEvent }>): Promise<void> {
    const operation = this.#tail.then(async () => {
      const now = new Date().toISOString();
      const stored = snapshots.map(({ threadId, event }) => ({
        threadId,
        seq: this.#seq.get(threadId) ?? 1,
        type: event.type,
        payload: event.payload,
        createdAt: now,
      } satisfies StoredEvent));
      const temporary = `${this.#path}.${process.pid}.tmp`;
      const backup = `${this.#path}.bak`;
      await writeFile(temporary, stored.map((event) => JSON.stringify(event)).join("\n") + (stored.length ? "\n" : ""), "utf8");
      await rm(backup, { force: true });
      let backedUp = false;
      try {
        await rename(this.#path, backup);
        backedUp = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await rename(temporary, this.#path);
      } catch (error) {
        if (backedUp) await rename(backup, this.#path).catch(() => undefined);
        throw error;
      }
      await rm(backup, { force: true });
      this.#seq.clear();
      for (const event of stored) this.#seq.set(event.threadId, event.seq);
    });
    this.#tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  drain(): Promise<void> {
    return this.#tail;
  }

  async #recoverBackup(): Promise<void> {
    const backup = `${this.#path}.bak`;
    try {
      await access(this.#path);
      await rm(backup, { force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await rename(backup, this.#path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
