import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

/**
 * Last config option set observed from a real ACP session. Draft chats have no
 * session yet, so the composer renders these runtime-owned defaults instead of
 * inventing local options (DECISIONS.md D-012 and D-016).
 */
export class ConfigDefaults {
  readonly #path: string;
  #options: SessionConfigOption[] | undefined;

  constructor(path: string) {
    this.#path = path;
  }

  async load(): Promise<SessionConfigOption[] | undefined> {
    if (this.#options) return this.#options;
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as { configOptions?: unknown };
      if (Array.isArray(parsed.configOptions) && parsed.configOptions.length) this.#options = parsed.configOptions as SessionConfigOption[];
    } catch {
      // No usable cache yet: defaults are taken from live sessions or probed from the runtime.
    }
    return this.#options;
  }

  update(options: SessionConfigOption[]): Promise<void> {
    if (!Array.isArray(options) || !options.length) return Promise.resolve();
    this.#options = options;
    return mkdir(dirname(this.#path), { recursive: true })
      .then(() => writeFile(this.#path, JSON.stringify({ configOptions: options }), "utf8"))
      .catch(() => undefined);
  }
}

/**
 * Keeps only the draft config values the runtime actually offers for this
 * session. Unknown ids, values outside the offered choices, empty strings, and
 * no-ops are dropped, so an outdated local preference can never force a stale
 * value onto a fresh session.
 */
export function sanitizeSessionConfig(config: Record<string, string | boolean> | undefined, options: SessionConfigOption[]): Array<[string, string | boolean]> {
  if (!config) return [];
  const applicable: Array<[string, string | boolean]> = [];
  for (const [configId, value] of Object.entries(config)) {
    if (typeof value === "string" && !value) continue;
    const option = options.find((candidate) => candidate.id === configId);
    if (!option) continue;
    if (option.type === "select" && !option.options.some((choice) => "value" in choice && choice.value === String(value))) continue;
    if (String(option.currentValue) === String(value)) continue;
    applicable.push([configId, value]);
  }
  return applicable;
}
