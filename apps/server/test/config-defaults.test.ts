import { mkdtemp, writeFile } from "node:fs/promises";
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
  it("does not load a malformed persisted option", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-config-defaults-invalid-"));
    const path = join(dir, "runtime-defaults.json");
    await writeFile(path, JSON.stringify({ configOptions: [{ id: "model", type: "select" }] }), "utf8");
    expect(await new ConfigDefaults(path).load()).toBeUndefined();
  });

  it("persists the last observed runtime options and reloads them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kimi-config-defaults-"));
    const path = join(dir, "runtime-defaults.json");
    expect(await new ConfigDefaults(path).load()).toBeUndefined();
    await new ConfigDefaults(path).update(options);
    expect(await new ConfigDefaults(path).load()).toEqual(options);
  });

  it("serializes a deferred load and concurrent updates in call order", async () => {
    let releaseRead!: () => void;
    let releaseFirstWrite!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const firstWriteGate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const written: SessionConfigOption[][] = [];
    let writes = 0;
    const persistence = {
      read: async <T>(_path: string, parse: (value: unknown) => T | undefined) => {
        await readGate;
        return { value: parse({ configOptions: options }), recovered: false, corrupt: false };
      },
      write: async (_path: string, value: unknown) => {
        writes += 1;
        if (writes === 1) await firstWriteGate;
        written.push((value as { configOptions: SessionConfigOption[] }).configOptions);
      },
    };
    const store = new ConfigDefaults("unused", persistence);
    const first = options.map((option) => option.id === "verbose" ? { ...option, currentValue: true } : option) as SessionConfigOption[];
    const second = options.map((option) => option.id === "mode" ? { ...option, currentValue: "yolo" } : option) as SessionConfigOption[];

    const loading = store.load();
    const updatingFirst = store.update(first);
    const updatingSecond = store.update(second);
    await Promise.resolve();
    expect(writes).toBe(0);
    releaseRead();
    await loading;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(writes).toBe(1);
    releaseFirstWrite();
    await Promise.all([updatingFirst, updatingSecond]);

    expect(written).toEqual([first, second]);
    expect(await store.load()).toEqual(second);
  });

  it("keeps the last published defaults when a write fails", async () => {
    let fail = false;
    const persistence = {
      read: async <T>(_path: string, parse: (value: unknown) => T | undefined) => ({ value: parse({ configOptions: options }), recovered: false, corrupt: false }),
      write: async () => { if (fail) throw new Error("disk full"); },
    };
    const store = new ConfigDefaults("unused", persistence);
    expect(await store.load()).toEqual(options);
    fail = true;
    const changed = options.map((option) => option.id === "verbose" ? { ...option, currentValue: true } : option) as SessionConfigOption[];
    await expect(store.update(changed)).rejects.toThrow("disk full");
    expect(await store.load()).toEqual(options);
  });

  it("does not publish a stale success after a newer observation fails", async () => {
    let releaseFirstWrite!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    let writes = 0;
    const store = new ConfigDefaults("unused", {
      read: async () => ({ value: undefined, recovered: false, corrupt: false }),
      write: async () => {
        writes += 1;
        if (writes === 1) await firstWrite;
        else throw new Error("disk full");
      },
    });
    const runtime = {};
    const staleObservation = store.beginLiveObservation();
    const staleUpdate = store.update(options).then(() => store.completeLiveObservation(staleObservation, runtime));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const latestObservation = store.beginLiveObservation();
    const failedUpdate = store.update(options).then(() => store.completeLiveObservation(latestObservation, runtime));

    releaseFirstWrite();
    await staleUpdate;
    await expect(failedUpdate).rejects.toThrow("disk full");
    expect(store.hasLiveDefaults(runtime)).toBe(false);
  });

  it("binds published defaults to the runtime that observed them", async () => {
    const store = new ConfigDefaults("unused", {
      read: async () => ({ value: undefined, recovered: false, corrupt: false }),
      write: async () => undefined,
    });
    const oldRuntime = {};
    const replacementRuntime = {};
    const observation = store.beginLiveObservation();
    await store.update(options);
    store.completeLiveObservation(observation, oldRuntime);

    expect(store.hasLiveDefaults(oldRuntime)).toBe(true);
    expect(store.hasLiveDefaults(replacementRuntime)).toBe(false);
  });
});
