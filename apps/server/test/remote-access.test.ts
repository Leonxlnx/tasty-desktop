import { mkdtemp, readFile } from "node:fs/promises";
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
    const pairing = access.createPairing();
    const claimed = await access.claimPairing(pairing.code, "Leon's phone");
    expect(access.authenticate(claimed.token)).toMatchObject({ id: claimed.device.id, name: "Leon's phone" });
    expect(await readFile(path, "utf8")).not.toContain(claimed.token);
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
    const pairing = access.createPairing();
    now = 10 * 60_000 + 1;
    await expect(access.claimPairing(pairing.code, "Late phone")).rejects.toThrow("invalid or expired");
    expect(access.allow("device", 2)).toBe(true);
    expect(access.allow("device", 2)).toBe(true);
    expect(access.allow("device", 2)).toBe(false);
    now += 60_001;
    expect(access.allow("device", 2)).toBe(true);
  });

  it("accepts remote-control methods but rejects local administration", () => {
    expect(remoteMethodAllowed({ method: "threads.sendTurn" })).toBe(true);
    expect(remoteMethodAllowed({ method: "threads.interruptTurn" })).toBe(true);
    expect(remoteMethodAllowed({ method: "terminal.write" })).toBe(false);
    expect(remoteMethodAllowed({ method: "remote.configure" })).toBe(false);
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
