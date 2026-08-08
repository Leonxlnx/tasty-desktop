import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  KIMI_REMOTE_PROTOCOL,
  LEGACY_REMOTE_PROTOCOL,
  RemoteAccess,
  remoteClientProtocols,
  remoteMethodAllowed,
  remoteProtocolOffered,
  remoteProtocolToken,
  selectRemoteProtocol,
} from "../src/remote-access.js";

describe("remote access", () => {
  it("pairs once, persists only a token hash, and revokes the device", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tasty-remote-"));
    const path = join(directory, "remote-access.json");
    let now = Date.parse("2026-07-27T00:00:00.000Z");
    const access = new RemoteAccess(path, () => now);
    await access.open();
    await access.configure({ enabled: true, bind: "127.0.0.1", port: 4318 });
    const pairing = await access.createPairing();
    const claimed = await access.claimPairing(pairing.code, "Leon's phone");
    expect(access.authenticate(claimed.token)).toMatchObject({ id: claimed.device.id, name: "Leon's phone" });
    expect(await readFile(path, "utf8")).not.toContain(claimed.token);
    expect(await readFile(path, "utf8")).toContain("pairing.created");
    await expect(access.claimPairing(pairing.code, "Second phone")).rejects.toThrow("invalid or expired");

    now += 1_000;
    const reopened = new RemoteAccess(path, () => now);
    await reopened.open();
    expect(reopened.authenticate(claimed.token)?.id).toBe(claimed.device.id);
    await reopened.revoke(claimed.device.id);
    expect(reopened.authenticate(claimed.token)).toBeUndefined();
    expect(reopened.status().devices[0]).not.toHaveProperty("tokenHash");
  });

  it("expires pairings and enforces bounded rate windows", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tasty-remote-expiry-"));
    let now = 0;
    const access = new RemoteAccess(join(directory, "remote-access.json"), () => now);
    await access.open();
    const pairing = await access.createPairing();
    now = 10 * 60_000 + 1;
    await expect(access.claimPairing(pairing.code, "Late phone")).rejects.toThrow("invalid or expired");
    expect(access.allow("device", 2)).toBe(true);
    expect(access.allow("device", 2)).toBe(true);
    expect(access.allow("device", 2)).toBe(false);
    now += 60_001;
    expect(access.allow("device", 2)).toBe(true);
  });

  it("serializes mutations and publishes state only after a successful write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-remote-transactions-"));
    const path = join(directory, "remote-access.json");
    const access = new RemoteAccess(path);
    await access.open();
    await access.configure({ enabled: true, bind: "127.0.0.1", port: 4318 });
    await Promise.all([access.audit("parallel.first"), access.audit("parallel.second")]);
    expect(access.status().audit.map((event) => event.action)).toEqual(expect.arrayContaining(["parallel.first", "parallel.second"]));

    const pairing = await access.createPairing();
    await mkdir(`${path}.${process.pid}.tmp`);
    await expect(access.claimPairing(pairing.code, "Phone")).rejects.toThrow();
    expect(access.status().devices).toEqual([]);
    await rm(`${path}.${process.pid}.tmp`, { recursive: true });
    await expect(access.claimPairing(pairing.code, "Phone")).resolves.toMatchObject({ device: { name: "Phone" } });

    await expect(access.audit("")).rejects.toThrow();
    await expect(access.audit("queue.recovered")).resolves.toBeUndefined();
    expect(access.status().audit.some((event) => event.action === "")).toBe(false);
  });

  it("rejects plaintext LAN binding and migrates a legacy enabled LAN config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-remote-lan-"));
    const path = join(directory, "remote-access.json");
    const access = new RemoteAccess(path);
    await access.open();
    await expect(access.configure({ enabled: true, bind: "0.0.0.0", port: 4318 })).rejects.toThrow("requires TLS");
    expect(access.status().config).toEqual({ enabled: false, bind: "127.0.0.1", port: 4318 });

    await writeFile(path, JSON.stringify({ version: 1, config: { enabled: true, bind: "0.0.0.0", port: 4318 }, devices: [], audit: [] }), "utf8");
    const migrated = new RemoteAccess(path);
    await migrated.open();
    expect(migrated.status().config).toEqual({ enabled: false, bind: "127.0.0.1", port: 4318 });
    expect(JSON.parse(await readFile(path, "utf8")).config).toEqual({ enabled: false, bind: "127.0.0.1", port: 4318 });
  });

  it("recovers a valid backup and rejects state with no valid copy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-remote-recovery-"));
    const path = join(directory, "remote-access.json");
    const access = new RemoteAccess(path);
    await access.open();
    await access.configure({ enabled: true, bind: "127.0.0.1", port: 4318 });
    await access.audit("backup.ready");
    await writeFile(path, "not json", "utf8");

    const recovered = new RemoteAccess(path);
    await recovered.open();
    expect(recovered.status().config.enabled).toBe(true);

    await writeFile(path, "not json", "utf8");
    await writeFile(`${path}.bak`, "also not json", "utf8");
    await expect(new RemoteAccess(path).open()).rejects.toThrow("no valid backup");
  });

  it("accepts remote-control methods but rejects local administration", () => {
    expect(remoteMethodAllowed({ method: "threads.sendTurn" })).toBe(true);
    expect(remoteMethodAllowed({ method: "threads.interruptTurn" })).toBe(true);
    expect(remoteMethodAllowed({ method: "capabilities.list" })).toBe(false);
    expect(remoteMethodAllowed({ method: "terminal.write" })).toBe(false);
    expect(remoteMethodAllowed({ method: "remote.configure" })).toBe(false);
    expect(remoteMethodAllowed({ method: "mcp.approveProject" })).toBe(false);
    expect(remoteMethodAllowed({ method: "mcp.revokeProject" })).toBe(false);
    expect(remoteProtocolToken("kimi-code.remote.v1, kimi-code-token.device.new")).toBe("device.new");
    expect(remoteProtocolToken("tasty.remote.v1, tasty-token.device.legacy")).toBe("device.legacy");
    expect(remoteProtocolToken("tasty-token.old, kimi-code-token.new")).toBe("new");
    expect(remoteProtocolOffered(KIMI_REMOTE_PROTOCOL)).toBe(true);
    expect(remoteProtocolOffered(LEGACY_REMOTE_PROTOCOL)).toBe(true);
    expect(selectRemoteProtocol(new Set([LEGACY_REMOTE_PROTOCOL, KIMI_REMOTE_PROTOCOL]))).toBe(KIMI_REMOTE_PROTOCOL);
    expect(remoteClientProtocols("device.secret")).toEqual([
      KIMI_REMOTE_PROTOCOL,
      LEGACY_REMOTE_PROTOCOL,
      "kimi-code-token.device.secret",
      "tasty-token.device.secret",
    ]);
  });
});
