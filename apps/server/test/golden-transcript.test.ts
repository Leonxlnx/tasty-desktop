import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("real Kimi golden transcript", () => {
  it("locks the 0.26.0 capability and auth contract", async () => {
    const path = join(dirname(fileURLToPath(import.meta.url)), "fixtures/kimi-0.26.0-auth.jsonl");
    const frames = (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { message: Record<string, unknown> });
    const initialize = frames[1]?.message.result as { protocolVersion: number; agentInfo: { version: string }; agentCapabilities: { promptCapabilities: { audio: boolean } } };
    expect(initialize.protocolVersion).toBe(1);
    expect(initialize.agentInfo.version).toBe("0.26.0");
    expect(initialize.agentCapabilities.promptCapabilities.audio).toBe(false);
    expect((frames[3]?.message.error as { code: number }).code).toBe(-32000);
  });
});
