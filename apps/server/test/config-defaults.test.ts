import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { ConfigDefaults, sanitizeSessionConfig } from "../src/config-defaults.js";

const options: SessionConfigOption[] = [
  { id: "model", name: "Model", type: "select", category: "model", currentValue: "kimi-k3", options: [{ value: "kimi-k3", name: "Kimi K3" }, { value: "kimi-k3-fast", name: "Kimi K3 Fast" }] },
  { id: "mode", name: "Mode", type: "select", category: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "yolo", name: "YOLO" }] },
  { id: "verbose", name: "Verbose", type: "boolean", currentValue: false },
];

describe("sanitizeSessionConfig", () => {
  it("keeps offered values and drops no-ops, unknown ids, and stale preferences", () => {
    expect(sanitizeSessionConfig({
      model: "kimi-k3-fast",
      mode: "default",
      thinking: "max",
      verbose: true,
    }, options)).toEqual([["model", "kimi-k3-fast"], ["verbose", true]]);
  });

  it("rejects values outside the offered choices and empty strings", () => {
    expect(sanitizeSessionConfig({ model: "kimi-k9" }, options)).toEqual([]);
    expect(sanitizeSessionConfig({ model: "" }, options)).toEqual([]);
    expect(sanitizeSessionConfig(undefined, options)).toEqual([]);
  });

  it("never forces a value onto a select that offers no choices", () => {
    const unprovisioned: SessionConfigOption[] = [{ id: "model", name: "Model", type: "select", currentValue: "", options: [] }];
    expect(sanitizeSessionConfig({ model: "kimi-k3" }, unprovisioned)).toEqual([]);
  });
});

describe("ConfigDefaults", () => {
  it("persists the last observed runtime options and reloads them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-config-defaults-"));
    const path = join(dir, "runtime-defaults.json");
    expect(await new ConfigDefaults(path).load()).toBeUndefined();
    await new ConfigDefaults(path).update(options);
    expect(await new ConfigDefaults(path).load()).toEqual(options);
  });
});
