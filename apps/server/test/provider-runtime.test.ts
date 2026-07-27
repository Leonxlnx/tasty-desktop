import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerDescriptors, providerName, readProviderInstances, resolveProviderBinary } from "../src/provider-runtime.js";

describe("provider runtime discovery", () => {
  it("exposes every supported provider without pretending missing CLIs are installed", () => {
    const providers = providerDescriptors();
    expect(providers.map((provider) => provider.id)).toEqual(["kimi", "codex", "claude", "cursor", "opencode"]);
    expect(providers.find((provider) => provider.id === "cursor")?.installed).toBe(Boolean(resolveProviderBinary("cursor")));
    expect(providerName("codex")).toBe("OpenAI Codex");
    expect(providers.find((provider) => provider.id === "kimi")?.capabilities).toMatchObject({ skills: "native", quota: true, subagents: { inspect: false } });
    expect(providers.find((provider) => provider.id === "codex")?.capabilities).toMatchObject({ skills: "none", quota: false, subagents: { inspect: true, stop: true, steer: false } });
    expect(providers.find((provider) => provider.id === "claude")?.capabilities.images).toBe(false);
    expect(providers.find((provider) => provider.id === "opencode")?.capabilities).toMatchObject({ mcp: "native", plugins: "native", commands: true });
  });

  it("loads named instances without accepting credentials or relative provider homes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tasty-provider-instances-"));
    const path = join(root, "instances.json");
    await writeFile(path, JSON.stringify([{ id: "work", name: "Work Codex", provider: "codex", environment: { CODEX_HOME: root } }]));
    expect(await readProviderInstances(path)).toEqual([{ id: "work", name: "Work Codex", provider: "codex", environment: { CODEX_HOME: root } }]);
    await writeFile(path, JSON.stringify([{ id: "unsafe", name: "Unsafe", provider: "codex", environment: { OPENAI_API_KEY: "secret" } }]));
    await expect(readProviderInstances(path)).rejects.toThrow("allowed absolute provider-owned paths");
    await writeFile(path, JSON.stringify([{ id: "ubuntu", name: "Ubuntu OpenCode", provider: "opencode", wsl: { distribution: "Ubuntu-24.04", binary: "/usr/local/bin/opencode" } }]));
    expect(await readProviderInstances(path)).toEqual([{ id: "ubuntu", name: "Ubuntu OpenCode", provider: "opencode", environment: {}, wsl: { distribution: "Ubuntu-24.04", binary: "/usr/local/bin/opencode" } }]);
  });
});
