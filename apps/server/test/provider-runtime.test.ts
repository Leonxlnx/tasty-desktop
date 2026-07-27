import { describe, expect, it } from "vitest";
import { providerDescriptors, providerName, resolveProviderBinary } from "../src/provider-runtime.js";

describe("provider runtime discovery", () => {
  it("exposes every supported provider without pretending missing CLIs are installed", () => {
    const providers = providerDescriptors();
    expect(providers.map((provider) => provider.id)).toEqual(["kimi", "codex", "claude", "cursor"]);
    expect(providers.find((provider) => provider.id === "cursor")?.installed).toBe(Boolean(resolveProviderBinary("cursor")));
    expect(providerName("codex")).toBe("OpenAI Codex");
    expect(providers.find((provider) => provider.id === "kimi")?.capabilities).toMatchObject({ skills: "native", quota: true, subagents: { inspect: false } });
    expect(providers.find((provider) => provider.id === "codex")?.capabilities).toMatchObject({ skills: "none", quota: false, subagents: { inspect: true, stop: true, steer: false } });
    expect(providers.find((provider) => provider.id === "claude")?.capabilities.images).toBe(false);
  });
});
