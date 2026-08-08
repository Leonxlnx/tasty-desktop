import { createReadStream } from "node:fs";
import { access, appendFile, mkdir, open as openFile, rename, rm, truncate, writeFile } from "node:fs/promises";
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

function isIncompleteFinalRecord(line: string, error: unknown): boolean {
  if (!(error instanceof SyntaxError) || !line.trimStart().startsWith("{")) return false;
  if (/unexpected end of json input/i.test(error.message)) return true;
  const position = /\bposition\s+(\d+)\b/i.exec(error.message)?.[1];
  return position !== undefined && Number(position) >= line.length;
}

const RECOVERY_TAIL_CHUNK_BYTES = 64 * 1024;

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
    await this.#recoverTornTail();
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

  async #recoverTornTail(): Promise<void> {
    let file: Awaited<ReturnType<typeof openFile>>;
    try {
      file = await openFile(this.#path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let repair: "newline" | number | undefined;
    try {
      const { size } = await file.stat();
      if (size === 0) return;
      const eof = Buffer.allocUnsafe(1);
      if ((await file.read(eof, 0, 1, size - 1)).bytesRead !== 1 || eof[0] === 0x0a) return;

      // Fixed-size reads retain only the final record instead of the whole log.
      const chunks: Buffer[] = [];
      let cursor = size;
      let tailStart = 0;
      while (cursor > 0) {
        const length = Math.min(cursor, RECOVERY_TAIL_CHUNK_BYTES);
        const start = cursor - length;
        const bytes = Buffer.allocUnsafe(length);
        let bytesRead = 0;
        while (bytesRead < length) {
          const read = await file.read(bytes, bytesRead, length - bytesRead, start + bytesRead);
          if (read.bytesRead === 0) throw new Error("Event log changed while recovering its final record");
          bytesRead += read.bytesRead;
        }
        const newline = bytes.lastIndexOf(0x0a);
        if (newline >= 0) {
          chunks.push(bytes.subarray(newline + 1));
          tailStart = start + newline + 1;
          break;
        }
        chunks.push(bytes);
        cursor = start;
      }
      const tail = Buffer.concat(chunks.reverse()).toString("utf8");
      if (!tail.trim()) return;

      try {
        const parsed = storedEventSchema.safeParse(JSON.parse(tail));
        if (parsed.success) repair = "newline";
      } catch (error) {
        if (isIncompleteFinalRecord(tail, error)) repair = tailStart;
      }
    } finally {
      await file.close();
    }
    if (repair === "newline") await appendFile(this.#path, "\n", "utf8");
    else if (repair !== undefined) await truncate(this.#path, repair);
  }
}
