import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertKimiProvider, historicalProviderChatMessage, providerDescriptors, providerName, readProviderInstances, resolveProviderBinary } from "../src/provider-runtime.js";

describe("provider runtime discovery", () => {
  it("exposes Kimi only while retaining historical provider labels", () => {
    const providers = providerDescriptors();
    expect(providers.map((provider) => provider.id)).toEqual(["kimi"]);
    expect(providers[0]?.installed).toBe(Boolean(resolveProviderBinary("kimi")));
    expect(resolveProviderBinary("codex")).toBeUndefined();
    expect(providerName("codex")).toBe("OpenAI Codex");
    expect(providers[0]?.capabilities).toMatchObject({ skills: "native", quota: true, subagents: { inspect: false } });
    expect(() => assertKimiProvider("codex")).toThrow(historicalProviderChatMessage);
  });

  it("loads Kimi instances while ignoring stale foreign-provider entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "kimi-provider-instances-"));
    const path = join(root, "instances.json");
    await writeFile(path, JSON.stringify([
      { id: "stale", name: "Old Codex", provider: "codex", binary: "relative.exe", environment: { OPENAI_API_KEY: "ignored" } },
      { id: "work", name: "Work Kimi", provider: "kimi", environment: { KIMI_CODE_HOME: root } },
    ]));
    expect(await readProviderInstances(path)).toEqual([{ id: "work", name: "Work Kimi", provider: "kimi", environment: { KIMI_CODE_HOME: root } }]);
    await writeFile(path, JSON.stringify([{ id: "unsafe", name: "Unsafe", provider: "kimi", environment: { OPENAI_API_KEY: "secret" } }]));
    await expect(readProviderInstances(path)).rejects.toThrow("allowed absolute provider-owned paths");
    await writeFile(path, JSON.stringify([{ id: "ubuntu", name: "Ubuntu Kimi", provider: "kimi", wsl: { distribution: "Ubuntu-24.04", binary: "/usr/local/bin/kimi" } }]));
    expect(await readProviderInstances(path)).toEqual([{ id: "ubuntu", name: "Ubuntu Kimi", provider: "kimi", environment: {}, wsl: { distribution: "Ubuntu-24.04", binary: "/usr/local/bin/kimi" } }]);
  });
});
