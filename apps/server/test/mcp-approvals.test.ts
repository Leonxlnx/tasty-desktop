import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpApprovalStore } from "../src/mcp-approvals.js";

const fingerprint = "a".repeat(64);
const changedFingerprint = "b".repeat(64);

describe("McpApprovalStore", () => {
  it("persists only the canonical root, exact fingerprint, and approval time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-mcp-approvals-"));
    const root = join(directory, "project");
    const alias = join(directory, "project-alias");
    const path = join(directory, "approvals.json");
    await mkdir(root);
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const now = Date.parse("2026-08-02T12:00:00.000Z");
    const store = new McpApprovalStore(path, () => now);
    await store.open();

    const approved = await store.approve(alias, fingerprint);
    expect(approved).toEqual({ root: await realpath(root), fingerprint, approvedAt: "2026-08-02T12:00:00.000Z" });
    expect(await store.status(root, fingerprint)).toEqual({ approved: true, changed: false, corrupt: false, approvedAt: approved.approvedAt });
    expect(await store.status(root, changedFingerprint)).toEqual({ approved: false, changed: true, corrupt: false, approvedAt: approved.approvedAt });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ version: 1, approvals: [approved] });

    const reopened = new McpApprovalStore(path);
    await reopened.open();
    expect(await reopened.status(alias, fingerprint)).toMatchObject({ approved: true, changed: false, corrupt: false });
  });

  it("serializes copy-on-write mutations and keeps published state after a failed write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-mcp-approval-transactions-"));
    const first = join(directory, "first");
    const second = join(directory, "second");
    const third = join(directory, "third");
    const path = join(directory, "approvals.json");
    await Promise.all([mkdir(first), mkdir(second), mkdir(third)]);
    const store = new McpApprovalStore(path);
    await store.open();
    await Promise.all([store.approve(first, fingerprint), store.approve(second, changedFingerprint)]);
    expect(await store.status(first, fingerprint)).toMatchObject({ approved: true });
    expect(await store.status(second, changedFingerprint)).toMatchObject({ approved: true });

    await mkdir(`${path}.${process.pid}.tmp`);
    await expect(store.approve(third, fingerprint)).rejects.toThrow();
    expect(await store.status(third, fingerprint)).toMatchObject({ approved: false, corrupt: false });
    expect(await store.status(first, fingerprint)).toMatchObject({ approved: true });
    await rm(`${path}.${process.pid}.tmp`, { recursive: true });
    await expect(store.approve(third, fingerprint)).resolves.toMatchObject({ fingerprint });
  });

  it("keeps approval idempotent, replaces changed fingerprints, and revokes by canonical root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-mcp-approval-lifecycle-"));
    const root = join(directory, "project");
    const path = join(directory, "approvals.json");
    await mkdir(root);
    let now = Date.parse("2026-08-02T12:00:00.000Z");
    const store = new McpApprovalStore(path, () => now);
    await store.open();
    const first = await store.approve(root, fingerprint);
    now += 60_000;
    await mkdir(`${path}.${process.pid}.tmp`);
    expect(await store.approve(root, fingerprint)).toEqual(first);
    await rm(`${path}.${process.pid}.tmp`, { recursive: true });
    const changed = await store.approve(root, changedFingerprint);
    expect(changed.approvedAt).toBe("2026-08-02T12:01:00.000Z");
    expect(await store.status(root, fingerprint)).toMatchObject({ approved: false, changed: true });
    expect(await store.status(root, changedFingerprint)).toMatchObject({ approved: true, changed: false });
    await expect(store.revoke(root)).resolves.toBe(true);
    await expect(store.revoke(root)).resolves.toBe(false);
    expect(await store.status(root, changedFingerprint)).toMatchObject({ approved: false, changed: false });
  });

  it("never restores a revoked approval from a stale backup", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-mcp-approval-recovery-"));
    const root = join(directory, "project");
    const path = join(directory, "approvals.json");
    await mkdir(root);
    const store = new McpApprovalStore(path);
    await store.open();
    await store.approve(root, fingerprint);
    await store.revoke(root);
    expect(JSON.parse(await readFile(`${path}.bak`, "utf8"))).toMatchObject({ approvals: [expect.objectContaining({ fingerprint })] });

    await rm(path);
    const missing = new McpApprovalStore(path);
    await missing.open();
    expect(await missing.status(root, fingerprint)).toEqual({ approved: false, changed: false, corrupt: false });

    await writeFile(path, "not json", "utf8");
    const denied = new McpApprovalStore(path);
    await denied.open();
    expect(await denied.status(root, fingerprint)).toEqual({ approved: false, changed: false, corrupt: true });
    await denied.approve(root, changedFingerprint);
    expect(await denied.status(root, changedFingerprint)).toMatchObject({ approved: true, corrupt: false });
    const repaired = new McpApprovalStore(path);
    await repaired.open();
    expect(await repaired.status(root, changedFingerprint)).toMatchObject({ approved: true, corrupt: false });
  });

  it("rejects ambiguous roots, non-exact fingerprints, and unsupported persisted fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kimi-mcp-approval-validation-"));
    const root = join(directory, "project");
    const path = join(directory, "approvals.json");
    await mkdir(root);
    const store = new McpApprovalStore(path);
    await store.open();
    await expect(store.approve("relative-project", fingerprint)).rejects.toThrow("must be absolute");
    await expect(store.approve(root, fingerprint.toUpperCase())).rejects.toThrow();
    await expect(store.approve(root, fingerprint.slice(1))).rejects.toThrow();

    const canonicalRoot = await realpath(root);
    const approval = { root: canonicalRoot, fingerprint, approvedAt: "2026-08-02T12:00:00.000Z" };
    await writeFile(path, JSON.stringify({ version: 1, approvals: [{ ...approval, command: "secret" }] }), "utf8");
    await writeFile(`${path}.bak`, JSON.stringify({ version: 1, approvals: [approval, approval] }), "utf8");
    const denied = new McpApprovalStore(path);
    await denied.open();
    expect(await denied.status(root, fingerprint)).toEqual({ approved: false, changed: false, corrupt: true });
  });
});
