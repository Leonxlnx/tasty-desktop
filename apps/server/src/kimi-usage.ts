import { spawn } from "node:child_process";
import { open, readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Usage, UsageUpdate } from "@agentclientprotocol/sdk";

const MANAGED_CONTEXT_SIZE = 262_144;
const TAIL_BYTES = 512 * 1024;

type UsageRecord = {
  type?: string;
  model?: string;
  usageScope?: string;
  usage?: { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number };
};

export type LocalKimiUsage = { context: UsageUpdate; tokens: Usage; model?: string };
export type KimiQuotaRow = {
  label: string;
  used: number;
  limit: number;
  remaining: number;
  resetTime?: string;
  resetHint?: string;
};
export type KimiQuota = {
  summary?: KimiQuotaRow;
  limits: KimiQuotaRow[];
  parallel?: number;
  planType?: string;
  updatedAt?: string;
  stale?: boolean;
};

export type KimiQuotaProbe = (options: {
  binary: string;
  kimiHome: string;
  cwd: string;
  timeoutMs?: number;
}) => Promise<string>;

export function isKimiQuotaProbePath(path: string, currentPath: string): boolean {
  const normalize = (value: string) => resolve(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const normalized = normalize(path);
  return normalized === normalize(currentPath) || /\/(?:kimicodedesktop|com\.kimicode\.desktop)\/runtime\/quota-probe$/.test(normalized);
}

export async function readKimiQuota(options: {
  binary: string;
  kimiHome: string;
  cwd: string;
  cachePath: string;
  probe?: KimiQuotaProbe;
  now?: () => Date;
}): Promise<KimiQuota> {
  const probe = options.probe ?? runKimiUsageProbe;
  try {
    await mkdir(resolve(options.cwd), { recursive: true });
    const output = await probe({
      binary: resolve(options.binary),
      kimiHome: resolve(options.kimiHome),
      cwd: resolve(options.cwd),
    });
    const parsed = parseKimiQuotaOutput(output);
    const quota = { ...parsed, updatedAt: (options.now?.() ?? new Date()).toISOString() };
    await mkdir(dirname(resolve(options.cachePath)), { recursive: true });
    await writeFile(resolve(options.cachePath), JSON.stringify(quota), "utf8");
    return quota;
  } catch (error) {
    const cached = await readQuotaCache(options.cachePath);
    if (cached) return { ...cached, stale: true };
    throw error;
  }
}

export async function readLatestKimiUsage(kimiHome: string, sessionId: string): Promise<LocalKimiUsage | undefined> {
  const sessionsRoot = join(resolve(kimiHome), "sessions");
  let workspaces;
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const sessionDirectory = sessionId.startsWith("session_") ? sessionId : `session_${sessionId}`;
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const wire = join(sessionsRoot, workspace.name, sessionDirectory, "agents", "main", "wire.jsonl");
    const record = await latestRecord(wire);
    if (!record?.usage) continue;
    const cachedReadTokens = natural(record.usage.inputCacheRead);
    const cachedWriteTokens = natural(record.usage.inputCacheCreation);
    const inputTokens = natural(record.usage.inputOther) + cachedReadTokens + cachedWriteTokens;
    const outputTokens = natural(record.usage.output);
    const totalTokens = inputTokens + outputTokens;
    return {
      context: { used: totalTokens, size: MANAGED_CONTEXT_SIZE },
      tokens: { totalTokens, inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens },
      ...(record.model ? { model: record.model } : {}),
    };
  }
  return undefined;
}

async function latestRecord(path: string): Promise<UsageRecord | undefined> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return undefined;
  }
  const length = Math.min(size, TAIL_BYTES);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const record = JSON.parse(lines[index]!) as UsageRecord;
        if (record.type === "usage.record" && record.usageScope === "turn" && record.usage) return record;
      } catch {
        // The first tail line may be partial.
      }
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function natural(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.floor(value!) : 0;
}

export function parseKimiQuotaOutput(output: string): KimiQuota {
  const rows = new Map<string, KimiQuotaRow>();
  for (const line of stripTerminalControl(output).split(/\r?\n/)) {
    const content = line
      .replace(/^.*?│\s*/, "")
      .replace(/\s*│.*$/, "")
      .trim();
    const match = content.match(/^(.+?)\s{2,}[█▓▒░]+\s+(\d{1,3})%\s+used(?:\s{2,}(.+))?$/u);
    if (!match) continue;
    const label = match[1]?.trim();
    const used = Number(match[2]);
    if (!label || !Number.isInteger(used) || used < 0 || used > 100) continue;
    const resetHint = match[3]?.trim();
    rows.set(label, {
      label,
      used,
      limit: 100,
      remaining: 100 - used,
      ...(resetHint ? { resetHint } : {}),
    });
  }
  const ordered = [...rows.values()];
  if (!ordered.length) {
    throw new Error("Kimi Code CLI did not return plan usage. Open Kimi Code CLI and run /usage once, then retry.");
  }
  const summaryIndex = ordered.findIndex((row) => /week|weekly|7[ -]?day/i.test(row.label));
  const summary = ordered[summaryIndex >= 0 ? summaryIndex : 0];
  return {
    ...(summary ? { summary } : {}),
    limits: ordered.filter((row) => row !== summary),
  };
}

export function runKimiUsageProbe(options: {
  binary: string;
  kimiHome: string;
  cwd: string;
  timeoutMs?: number;
}): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(options.binary, ["--continue"], {
      cwd: options.cwd,
      env: {
        ...process.env,
        KIMI_CODE_HOME: options.kimiHome,
        KIMI_CODE_NO_AUTO_UPDATE: "1",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let errorOutput = "";
    let usageSent = false;
    let exitSent = false;
    let settled = false;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolveOutput(output);
    };
    const sendUsage = () => {
      if (usageSent || child.killed || !child.stdin.writable) return;
      usageSent = true;
      child.stdin.write("/usage\r\n");
    };
    const requestExit = () => {
      if (exitSent || child.killed) return;
      exitSent = true;
      if (child.stdin.writable) {
        child.stdin.write("/exit\r\n");
        child.stdin.end();
      } else {
        child.kill();
      }
    };
    const inspect = () => {
      const plain = stripTerminalControl(output);
      if (usageSent && plain.includes("Plan usage")) {
        try {
          const parsed = parseKimiQuotaOutput(output);
          if (parsed.summary || parsed.limits.length) setTimeout(requestExit, 100);
        } catch {
          // The TUI redraw arrives in chunks; keep collecting until a row is complete.
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer | string) => {
      output += chunk.toString();
      inspect();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      errorOutput += chunk.toString();
    });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      try {
        parseKimiQuotaOutput(output);
        finish();
      } catch (error) {
        const detail = stripTerminalControl(errorOutput || output).trim();
        finish(new Error(detail || (error instanceof Error ? error.message : `Kimi quota probe exited with ${signal ?? code ?? "an error"}`)));
      }
    });

    const timeout = setTimeout(() => {
      child.kill();
      try {
        parseKimiQuotaOutput(output);
        finish();
      } catch {
        finish(new Error("Kimi Code CLI did not return plan usage before the timeout."));
      }
    }, options.timeoutMs ?? 25_000);
    setTimeout(sendUsage, 6_000);
  });
}

function stripTerminalControl(value: string): string {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

async function readQuotaCache(path: string): Promise<KimiQuota | undefined> {
  try {
    const value = JSON.parse(await readFile(resolve(path), "utf8")) as KimiQuota;
    const rows = [value.summary, ...(Array.isArray(value.limits) ? value.limits : [])].filter(Boolean);
    if (!rows.length || !rows.every(isQuotaRow)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function isQuotaRow(value: unknown): value is KimiQuotaRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<KimiQuotaRow>;
  return typeof row.label === "string"
    && Number.isFinite(row.used)
    && Number.isFinite(row.limit)
    && Number.isFinite(row.remaining);
}
