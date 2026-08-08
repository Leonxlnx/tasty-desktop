import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type DiagnosticLevel = "info" | "warning" | "error";
export type DiagnosticRecord = { at: string; level: DiagnosticLevel; message: string; source?: string };

const SENSITIVE_KEY_SOURCE = String.raw`(?:access[_ -]?key(?:[_ -]?id)?|access[_ -]?token|api[_ -]?key|auth[_ -]?token|client[_ -]?secret|credentials?|id[_ -]?token|password|private[_ -]?key|refresh[_ -]?token|secret[_ -]?access[_ -]?key|secret|session[_ -]?token|token|authorization)`;
const SENSITIVE_KEY_PATTERN = new RegExp(`(?:^|[_ -])${SENSITIVE_KEY_SOURCE}$`, "i");
const SECRET_ASSIGNMENT_PATTERN = new RegExp(
  `((?:["'\\x60])?(?<![A-Za-z0-9])${SENSITIVE_KEY_SOURCE}\\b(?:["'\\x60])?\\s*[:=]\\s*)("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\\x60(?:\\\\.|[^\\x60\\\\])*\\x60|\\[redacted(?:-token|-key)?\\]|[^\\s,;&#}\\]]+)`,
  "gi",
);

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(\bAuthorization\b["'\x60]?\s*[:=]\s*["'\x60]?)(?:Basic|Bearer)\s+[A-Za-z0-9._~+/-]{4,}={0,2}/gi, "$1[redacted]"],
  [/\bBearer\s+(?=[A-Za-z0-9._~+/-]*[0-9._~+/-])[A-Za-z0-9._~+/-]{8,}={0,2}/gi, "Bearer [redacted]"],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})\b/g, "[redacted-token]"],
  [/\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, "[redacted-token]"],
  [/\b(?:glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, "[redacted-token]"],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[redacted-key]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted-key]"],
  [/\b(?:rk|sk)_live_[A-Za-z0-9]{16,}\b/g, "[redacted-token]"],
  [/(\bhttps?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi, "$1[redacted]$2"],
  [/([?&](?:access[_-]?token|api[_-]?key|auth[_-]?token|key|secret|password|signature)=)[^&#\s]+/gi, "$1[redacted]"],
];

const QUOTED_ABSOLUTE_PATH_PATTERN = /(["'`])((?:file:\/\/\/|[a-z]:[\\/]|\\\\|\/)(?:(?!\1)[^\r\n])+)\1/gi;
const FILE_URL_WITH_FILENAME_PATTERN = /\bfile:\/\/\/(?:[^/\r\n"'`<>|]+\/)*[^/\r\n"'`<>|]*?\.[a-z0-9][a-z0-9._-]{0,15}(?=$|[\s,;!?()[\]{}"'`<>|])/gi;
const WINDOWS_PATH_WITH_FILENAME_PATTERN = /\b[a-z]:[\\/](?:[^\\/\r\n"'`<>|:*?]+[\\/])*[^\\/\r\n"'`<>|:*?]*?\.[a-z0-9][a-z0-9._-]{0,15}(?=$|[\s,;!?()[\]{}"'`<>|])/gi;
const UNC_PATH_WITH_FILENAME_PATTERN = /\\\\[^\\/\s"'`<>|:*?]+[\\/](?:[^\\/\r\n"'`<>|:*?]+[\\/])*[^\\/\r\n"'`<>|:*?]*?\.[a-z0-9][a-z0-9._-]{0,15}(?=$|[\s,;!?()[\]{}"'`<>|])/gi;
const POSIX_PATH_WITH_FILENAME_PATTERN = /(?<![:A-Za-z0-9/])\/(?!\/)(?:[^/\r\n"'`<>|]+\/)+[^/\r\n"'`<>|]*?\.[a-z0-9][a-z0-9._-]{0,15}(?=$|[\s,;!?()[\]{}"'`<>|])/gi;
const UNQUOTED_SPACED_PATH_PATTERN = /(?:\bfile:\/\/\/|\b[a-z]:[\\/]|(?<!\\)\\\\(?=[^\\/])|(?<![:A-Za-z0-9/])\/(?!\/))[^\r\n"'`<>|;,]+?(?=\s+(?:and|or|but|because|then|retry(?:ing)?|failed|failure|error|while|when|from|at)\b|[,;]|$)/gi;
const FILE_URL_PATTERN = /\bfile:\/\/\/[^\s"'`<>|)\]},;]+/gi;
const WINDOWS_PATH_PATTERN = /\b[a-z]:[\\/][^\s"'`<>|)\]},;]*/gi;
const UNC_PATH_PATTERN = /(?<!\\)\\\\(?:[^\\\s"'`<>|)\]},;]+\\)+[^\s"'`<>|)\]},;]*/g;
const POSIX_PATH_PATTERN = /(?<![:A-Za-z0-9/])\/(?!\/)(?:[^/\s"'`<>|)\]},;]+\/)+[^\s"'`<>|)\]},;]*/g;

export function isSensitiveDiagnosticKey(value: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(value);
}

export function redactDiagnosticText(value: unknown, homePaths: string[] = [], maxLength = 2_000): string {
  let text = String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  text = text.replace(SECRET_ASSIGNMENT_PATTERN, (_match, prefix: string, secret: string) => {
    if (/^\[redacted(?:-token|-key)?\]$/i.test(secret)) return `${prefix}${secret}`;
    const quote = secret[0];
    return `${prefix}${quote === '"' || quote === "'" || quote === "`" ? `${quote}[redacted]${quote}` : "[redacted]"}`;
  });
  const privatePaths = [...new Set(homePaths.filter(Boolean).flatMap(pathVariants))].sort((a, b) => b.length - a.length);
  for (const path of privatePaths) {
    text = text.replace(new RegExp(escapeRegExp(path), "gi"), "[home]");
  }
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function redactPrivateErrorText(value: unknown, homePaths: string[] = [], maxLength = 2_000): string {
  const scanLimit = Math.min(200_000, Math.max(maxLength, maxLength * 2));
  let text = redactDiagnosticText(value, homePaths, scanLimit);
  text = text.replace(QUOTED_ABSOLUTE_PATH_PATTERN, (match, quote: string, candidate: string) => (
    isLikelyAbsolutePrivatePath(candidate, true) ? `${quote}[private-path]${quote}` : match
  ));
  for (const pattern of [FILE_URL_WITH_FILENAME_PATTERN, WINDOWS_PATH_WITH_FILENAME_PATTERN, UNC_PATH_WITH_FILENAME_PATTERN, POSIX_PATH_WITH_FILENAME_PATTERN]) {
    text = text.replace(pattern, "[private-path]");
  }
  text = text.replace(UNQUOTED_SPACED_PATH_PATTERN, (candidate) => (
    isLikelyAbsolutePrivatePath(candidate, false) ? "[private-path]" : candidate
  ));
  for (const pattern of [FILE_URL_PATTERN, WINDOWS_PATH_PATTERN, UNC_PATH_PATTERN, POSIX_PATH_PATTERN]) {
    text = text.replace(pattern, (candidate) => (
      isLikelyAbsolutePrivatePath(candidate, false) ? "[private-path]" : candidate
    ));
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
      message: level === "error"
        ? redactPrivateErrorText(message, this.#homePaths)
        : redactDiagnosticText(message, this.#homePaths),
      ...(source ? { source: redactDiagnosticText(source, this.#homePaths).slice(0, 80) } : {}),
    } satisfies DiagnosticRecord;
    this.#records.push(record);
    if (this.#records.length > 200) this.#records.splice(0, this.#records.length - 200);
    return record;
  }

  snapshot(): DiagnosticRecord[] {
    return structuredClone(this.#records);
  }

  async export(dataHome: string, environment: Record<string, string | number | boolean | null>, privatePaths: string[] = []): Promise<string> {
    const directory = join(dataHome, "diagnostics");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `kimi-code-support-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const redactionPaths = [...this.#homePaths, ...privatePaths];
    const redactedEnvironment = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, typeof value === "string" ? redactDiagnosticText(value, redactionPaths) : value]));
    const redactedDiagnostics = this.snapshot().map((record) => ({
      ...record,
      message: record.level === "error"
        ? redactPrivateErrorText(record.message, redactionPaths)
        : redactDiagnosticText(record.message, redactionPaths),
      ...(record.source ? { source: redactDiagnosticText(record.source, redactionPaths).slice(0, 80) } : {}),
    }));
    await writeFile(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), environment: redactedEnvironment, diagnostics: redactedDiagnostics }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return path;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pathVariants(path: string): string[] {
  const slashPath = path.replaceAll("\\", "/");
  const drivePath = /^([a-z]):\/(.*)$/i.exec(slashPath);
  return [path, slashPath, path.replaceAll("/", "\\"), ...(drivePath ? [`/mnt/${drivePath[1]!.toLowerCase()}/${drivePath[2]}`] : [])];
}

function isLikelyAbsolutePrivatePath(value: string, quoted: boolean): boolean {
  const candidate = value.trim();
  if (/^file:\/\/\//i.test(candidate)) return candidate.length > "file:///".length;
  if (/^[a-z]:[\\/]/i.test(candidate)) {
    const remainder = candidate.slice(3);
    return remainder.length > 0 && !/^\s/.test(remainder);
  }
  if (/^\\\\/.test(candidate)) return candidate.split(/[\\/]+/).filter(Boolean).length >= 2;
  if (!candidate.startsWith("/") || candidate.startsWith("//")) return false;
  const segments = candidate.split("/").filter(Boolean);
  if (segments.length < 2) return false;
  if (quoted) return true;
  return segments.length >= 3
    || /^(?:etc|home|mnt|opt|private|root|srv|tmp|usr|users|var|volumes)$/i.test(segments[0] ?? "")
    || /\.[a-z0-9][a-z0-9._-]{0,15}$/i.test(segments.at(-1) ?? "");
}
