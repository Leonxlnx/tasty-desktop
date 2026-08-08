import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isKimiQuotaProbePath, parseKimiQuotaOutput, readKimiQuota, readLatestKimiUsage } from "../src/kimi-usage.js";

describe("local Kimi usage fallback", () => {
  it("reads the latest turn usage without reading credentials", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-usage-"));
    const directory = join(home, "sessions", "workspace", "session_session-1", "agents", "main");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "wire.jsonl"), [
      JSON.stringify({ type: "usage.record", usageScope: "turn", model: "kimi-code/k3", usage: { inputOther: 100, output: 20, inputCacheRead: 1_000, inputCacheCreation: 40 } }),
      JSON.stringify({ type: "other" }),
      JSON.stringify({ type: "usage.record", usageScope: "turn", model: "kimi-code/k3", usage: { inputOther: 197, output: 26, inputCacheRead: 21_248, inputCacheCreation: 0 } }),
    ].join("\n"), "utf8");

    const expected = {
      model: "kimi-code/k3",
      context: { used: 21_471, size: 262_144 },
      tokens: { totalTokens: 21_471, inputTokens: 21_445, outputTokens: 26, cachedReadTokens: 21_248, cachedWriteTokens: 0 },
    };
    expect(await readLatestKimiUsage(home, "session-1")).toEqual(expected);
    expect(await readLatestKimiUsage(home, "session_session-1")).toEqual(expected);
  });
});

describe("Kimi subscription quota", () => {
  it("recognizes current and legacy app-owned quota workspaces", () => {
    const current = "C:/Profile/AppData/Roaming/com.kimicode.desktop/runtime/quota-probe";
    expect(isKimiQuotaProbePath(current, current)).toBe(true);
    expect(isKimiQuotaProbePath("C:/Profile/AppData/Roaming/KimiCodeDesktop/runtime/quota-probe", current)).toBe(true);
    expect(isKimiQuotaProbePath("C:/work/quota-probe", current)).toBe(false);
  });

  it("parses the official CLI usage panel and reuses the last verified result", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-quota-"));
    const output = [
      "\u001b[2K   │ Plan usage                                                           │\u001b[0m",
      "\u001b[2K   │   Weekly limit  ████░░░░░░░░░░░░░░░░  22% used  resets in 5d 16h │\u001b[0m",
      "\u001b[2K   │   5h limit      █░░░░░░░░░░░░░░░░░░░  3% used   resets in 3h 15m  │\u001b[0m",
      "\u001b[2K   │   Monthly limit  ██████░░░░░░░░░░░░░░  31% used  resets in 12d 4h  │\u001b[0m",
    ].join("\n");
    expect(parseKimiQuotaOutput(output)).toEqual({
      summary: { label: "Weekly limit", used: 22, limit: 100, remaining: 78, resetHint: "resets in 5d 16h" },
      limits: [
        { label: "5h limit", used: 3, limit: 100, remaining: 97, resetHint: "resets in 3h 15m" },
        { label: "Monthly limit", used: 31, limit: 100, remaining: 69, resetHint: "resets in 12d 4h" },
      ],
    });

    const options = {
      binary: join(home, "kimi.exe"),
      kimiHome: home,
      cwd: join(home, "probe"),
      cachePath: join(home, "quota-cache.json"),
      now: () => new Date("2026-07-17T22:45:00Z"),
    };
    expect(await readKimiQuota({ ...options, probe: async () => output })).toEqual({
      summary: { label: "Weekly limit", used: 22, limit: 100, remaining: 78, resetHint: "resets in 5d 16h" },
      limits: [
        { label: "5h limit", used: 3, limit: 100, remaining: 97, resetHint: "resets in 3h 15m" },
        { label: "Monthly limit", used: 31, limit: 100, remaining: 69, resetHint: "resets in 12d 4h" },
      ],
      updatedAt: "2026-07-17T22:45:00.000Z",
    });
    expect(await readKimiQuota({ ...options, probe: async () => { throw new Error("offline"); } })).toMatchObject({
      summary: { remaining: 78 },
      stale: true,
    });
  });
});
