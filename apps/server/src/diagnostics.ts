import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DiagnosticLevel = "info" | "warning" | "error";
export type DiagnosticRecord = { at: string; level: DiagnosticLevel; message: string; source?: string };

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]"],
  [/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g, "[redacted-token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/(\b(?:token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]"],
  [/([?&](?:token|key|secret|password|signature)=)[^&#\s]+/gi, "$1[redacted]"],
];

export function redactDiagnosticText(value: unknown, homePaths: string[] = [], maxLength = 2_000): string {
  let text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  for (const path of homePaths.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(escapeRegExp(path), "gi"), "[home]");
  }
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export class DiagnosticJournal {
  readonly #records: DiagnosticRecord[] = [];
  readonly #homePaths: string[];

  constructor(homePaths: string[] = []) {
    this.#homePaths = homePaths;
  }

  record(level: DiagnosticLevel, message: unknown, source?: string): DiagnosticRecord {
    const record = {
      at: new Date().toISOString(),
      level,
      message: redactDiagnosticText(message, this.#homePaths),
      ...(source ? { source: redactDiagnosticText(source, this.#homePaths).slice(0, 80) } : {}),
    } satisfies DiagnosticRecord;
    this.#records.push(record);
    if (this.#records.length > 200) this.#records.splice(0, this.#records.length - 200);
    return record;
  }

  snapshot(): DiagnosticRecord[] {
    return structuredClone(this.#records);
  }

  async export(dataHome: string, environment: Record<string, string | number | boolean | null>): Promise<string> {
    const directory = join(dataHome, "diagnostics");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `tasty-support-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    await writeFile(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), environment, diagnostics: this.snapshot() }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
