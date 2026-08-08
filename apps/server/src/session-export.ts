import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { isSensitiveDiagnosticKey, redactDiagnosticText, redactPrivateErrorText } from "./diagnostics.js";
import type { ThreadProjection } from "./orchestration.js";

export async function exportSessionArchive(directory: string, threads: Array<ThreadProjection & { queue?: unknown[] }>, privatePaths: string[]): Promise<string> {
  await mkdir(directory, { recursive: true });
  const exportedAt = new Date().toISOString();
  const path = join(directory, `kimi-code-sessions-${exportedAt.replace(/[:.]/g, "-")}.json`);
  const archive = { version: 1, exportedAt, threads: threads.map((thread) => sanitizeThread(thread, privatePaths)) };
  await writeFile(path, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return path;
}

function sanitizeThread(thread: ThreadProjection & { queue?: unknown[] }, privatePaths: string[]) {
  return {
    threadId: thread.threadId,
    provider: thread.provider,
    ...(thread.instanceId ? { instanceId: thread.instanceId } : {}),
    title: clean(thread.title, privatePaths),
    kind: thread.kind,
    workspace: { name: basename(thread.cwd), path: clean(thread.cwd, privatePaths) },
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(thread.archivedAt ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.goal ? { goal: redactValue(thread.goal, privatePaths) } : {}),
    turns: redactValue(thread.turns, privatePaths),
    messages: thread.messages.map((message) => ({
      ...message,
      text: clean(message.text, privatePaths),
      ...(message.resources ? { resources: message.resources.map((resource) => clean(resource, privatePaths)) } : {}),
      ...(message.images ? { images: message.images.map((image) => ({ ...image, name: clean(basename(image.name.replaceAll("\\", "/")), privatePaths) })) } : {}),
    })),
    plan: redactValue(thread.plan, privatePaths),
    activity: redactValue(thread.activity, privatePaths),
    tools: thread.tools.map(({ rawInput: _, rawOutput: __, content: ___, ...tool }) => redactValue(tool, privatePaths)),
    approvals: redactValue(thread.approvals, privatePaths),
    checkpoints: redactValue(thread.checkpoints, privatePaths),
    revertedParts: redactValue(thread.revertedParts, privatePaths),
    backgroundTasks: redactValue(thread.backgroundTasks.map(({ kimiHome: _kimiHome, outputPath: _outputPath, ...task }) => task), privatePaths),
    usage: redactValue(thread.usage, privatePaths),
    queue: redactValue(normalizeQueueImageNames(thread.queue ?? []), privatePaths),
  };
}

function normalizeQueueImageNames(queue: unknown[]): unknown[] {
  return queue.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (!Array.isArray(record.images)) return item;
    return {
      ...record,
      images: record.images.map((image) => {
        if (!image || typeof image !== "object" || Array.isArray(image)) return image;
        const imageRecord = image as Record<string, unknown>;
        return typeof imageRecord.name === "string"
          ? { ...imageRecord, name: basename(imageRecord.name.replaceAll("\\", "/")) }
          : image;
      }),
    };
  });
}

function redactValue(value: unknown, privatePaths: string[], depth = 0, errorField = false): unknown {
  if (typeof value === "string") return errorField ? redactPrivateErrorText(value, privatePaths, 200_000) : clean(value, privatePaths);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 12) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => redactValue(item, privatePaths, depth + 1, errorField));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key.toLowerCase() !== "data" && !isSensitiveDiagnosticKey(key))
    .map(([key, item]) => [key, redactValue(item, privatePaths, depth + 1, isExportErrorField(key))]));
}

function isExportErrorField(key: string): boolean {
  return ["error", "failure", "reportlasterror"].includes(key.toLowerCase());
}

function clean(value: unknown, privatePaths: string[]): string {
  return redactDiagnosticText(value, privatePaths, 200_000);
}
