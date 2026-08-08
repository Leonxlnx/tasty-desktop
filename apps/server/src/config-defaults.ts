import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { z } from "zod";
import { readRecoverableJson, writeRecoverableJson } from "./recoverable-json.js";

const metadataSchema = z.record(z.string(), z.unknown()).nullable().optional();
const selectValueSchema = z.object({
  value: z.string(), name: z.string(), description: z.string().nullable().optional(), _meta: metadataSchema,
});
const selectGroupSchema = z.object({
  group: z.string(), name: z.string(), options: z.array(selectValueSchema), _meta: metadataSchema,
});
const optionBase = {
  id: z.string(), name: z.string(), description: z.string().nullable().optional(), category: z.string().nullable().optional(), _meta: metadataSchema,
};
const configOptionSchema = z.discriminatedUnion("type", [
  z.object({ ...optionBase, type: z.literal("select"), currentValue: z.string(), options: z.union([z.array(selectValueSchema), z.array(selectGroupSchema)]) }),
  z.object({ ...optionBase, type: z.literal("boolean"), currentValue: z.boolean() }),
]).transform((option) => option as SessionConfigOption);
const stateSchema = z.object({ configOptions: z.array(configOptionSchema).min(1) });

/**
 * Last config option set observed from a real ACP session. Draft chats have no
 * session yet, so the composer renders these runtime-owned defaults instead of
 * inventing local options (DECISIONS.md D-012 and D-016).
 */
export class ConfigDefaults {
  readonly #path: string;
  readonly #persistence: { read: typeof readRecoverableJson; write: typeof writeRecoverableJson };
  #options: SessionConfigOption[] | undefined;
  #loaded = false;
  #mutation = Promise.resolve();
  #liveObservation = 0;
  #liveRuntime: object | undefined;

  constructor(path: string, persistence = { read: readRecoverableJson, write: writeRecoverableJson }) {
    this.#path = path;
    this.#persistence = persistence;
  }

  load(): Promise<SessionConfigOption[] | undefined> {
    return this.#serialize(async () => {
      if (this.#loaded) return this.#options;
      const loaded = await this.#persistence.read(this.#path, (value) => stateSchema.safeParse(value).data);
      this.#options = loaded.value?.configOptions;
      this.#loaded = true;
      return this.#options;
    });
  }

  async update(options: SessionConfigOption[]): Promise<void> {
    if (Array.isArray(options) && !options.length) return;
    const next = stateSchema.parse({ configOptions: options });
    await this.#serialize(async () => {
      await this.#persistence.write(this.#path, next);
      this.#options = next.configOptions;
      this.#loaded = true;
    });
  }

  beginLiveObservation(): number {
    this.#liveRuntime = undefined;
    return ++this.#liveObservation;
  }

  completeLiveObservation(observation: number, runtime: object): void {
    if (observation === this.#liveObservation) this.#liveRuntime = runtime;
  }

  hasLiveDefaults(runtime: object | undefined): boolean {
    return runtime !== undefined && this.#liveRuntime === runtime;
  }

  invalidateLiveDefaults(): void {
    this.beginLiveObservation();
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation);
    this.#mutation = result.then(() => undefined, () => undefined);
    return result;
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
