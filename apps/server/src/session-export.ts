import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { redactDiagnosticText } from "./diagnostics.js";
import type { ThreadProjection } from "./orchestration.js";

export async function exportSessionArchive(directory: string, threads: Array<ThreadProjection & { queue?: unknown[] }>, privatePaths: string[]): Promise<string> {
  await mkdir(directory, { recursive: true });
  const exportedAt = new Date().toISOString();
  const path = join(directory, `tasty-sessions-${exportedAt.replace(/[:.]/g, "-")}.json`);
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
    messages: thread.messages.map((message) => ({ ...message, text: clean(message.text, privatePaths), ...(message.resources ? { resources: message.resources.map((resource) => clean(resource, privatePaths)) } : {}) })),
    plan: redactValue(thread.plan, privatePaths),
    activity: redactValue(thread.activity, privatePaths),
    tools: thread.tools.map(({ rawInput: _, rawOutput: __, ...tool }) => redactValue(tool, privatePaths)),
    approvals: redactValue(thread.approvals, privatePaths),
    checkpoints: redactValue(thread.checkpoints, privatePaths),
    backgroundTasks: redactValue(thread.backgroundTasks, privatePaths),
    usage: redactValue(thread.usage, privatePaths),
    queue: redactValue(thread.queue ?? [], privatePaths),
  };
}

function redactValue(value: unknown, privatePaths: string[], depth = 0): unknown {
  if (typeof value === "string") return clean(value, privatePaths);
  if (value === null || typeof value !== "object" || depth >= 12) return value;
  if (Array.isArray(value)) return value.slice(0, 2_000).map((item) => redactValue(item, privatePaths, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(?:data|token|secret|password|authorization)$/i.test(key)).map(([key, item]) => [key, redactValue(item, privatePaths, depth + 1)]));
}

function clean(value: unknown, privatePaths: string[]): string {
  return redactDiagnosticText(value, privatePaths, 200_000);
}
