import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { readRecoverableJson, writeRecoverableJson } from "./recoverable-json.js";

const configSchema = z.object({ enabled: z.boolean(), bind: z.enum(["127.0.0.1", "0.0.0.0"]), port: z.number().int().min(1024).max(65_535) });
const deviceSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(80), tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), lastSeenAt: z.string().datetime().optional(), revokedAt: z.string().datetime().optional(),
});
const auditSchema = z.object({ id: z.string().uuid(), at: z.string().datetime(), action: z.string().min(1).max(80), deviceId: z.string().uuid().optional(), detail: z.string().max(200).optional() });
const stateSchema = z.object({ version: z.literal(1), config: configSchema, devices: z.array(deviceSchema).max(200), audit: z.array(auditSchema).max(500) });

export type RemoteConfig = z.infer<typeof configSchema>;
type RemoteDeviceRecord = z.infer<typeof deviceSchema>;
type RemoteAuditEvent = z.infer<typeof auditSchema>;
type RemoteState = z.infer<typeof stateSchema>;
export type RemoteDevice = Omit<RemoteDeviceRecord, "tokenHash">;

const defaults: RemoteState = { version: 1, config: { enabled: false, bind: "127.0.0.1", port: 4318 }, devices: [], audit: [] };
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const KIMI_REMOTE_PROTOCOL = "kimi-code.remote.v1";
export const LEGACY_REMOTE_PROTOCOL = "tasty.remote.v1";
export const KIMI_REMOTE_TOKEN_PREFIX = "kimi-code-token.";
export const LEGACY_REMOTE_TOKEN_PREFIX = "tasty-token.";

export class RemoteAccess {
  readonly #path: string;
  readonly #now: () => number;
  readonly #pairings = new Map<string, number>();
  readonly #rates = new Map<string, number[]>();
  #state: RemoteState = structuredClone(defaults);
  #write = Promise.resolve();

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  async open(): Promise<void> {
    const loaded = await readRecoverableJson(this.#path, (value) => stateSchema.safeParse(value).data);
    if (loaded.value) this.#state = loaded.value;
  }

  status(): { config: RemoteConfig; devices: RemoteDevice[]; audit: RemoteAuditEvent[] } {
    return {
      config: { ...this.#state.config },
      devices: this.#state.devices.map(publicDevice),
      audit: this.#state.audit.slice(-100).reverse().map((event) => ({ ...event })),
    };
  }

  async configure(config: RemoteConfig): Promise<void> {
    this.#state.config = configSchema.parse(config);
    this.#pairings.clear();
    await this.#record("configuration.updated", undefined, `${config.enabled ? "enabled" : "disabled"} ${config.bind}:${config.port}`);
  }

  createPairing(): { code: string; expiresAt: string } {
    for (const [code, expires] of this.#pairings) if (expires <= this.#now()) this.#pairings.delete(code);
    const code = Array.from(randomBytes(8), (byte) => alphabet[byte! % alphabet.length]).join("");
    const expires = this.#now() + 10 * 60_000;
    this.#pairings.set(code, expires);
    void this.#record("pairing.created", undefined, `expires ${new Date(expires).toISOString()}`);
    return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt: new Date(expires).toISOString() };
  }

  async claimPairing(code: string, name: string): Promise<{ device: RemoteDevice; token: string }> {
    const normalized = code.toUpperCase().replace(/[^A-Z2-9]/g, "");
    const expires = this.#pairings.get(normalized);
    this.#pairings.delete(normalized);
    if (!expires || expires <= this.#now()) throw new Error("Pairing code is invalid or expired");
    const cleanName = name.trim().slice(0, 80);
    if (!cleanName) throw new Error("Device name is required");
    const id = randomUUID();
    const token = `${id}.${randomBytes(32).toString("base64url")}`;
    const createdAt = new Date(this.#now()).toISOString();
    const record: RemoteDeviceRecord = { id, name: cleanName, tokenHash: hash(token), createdAt, lastSeenAt: createdAt };
    this.#state.devices.push(record);
    await this.#record("device.paired", id, cleanName);
    return { device: publicDevice(record), token };
  }

  authenticate(token: string | undefined): RemoteDevice | undefined {
    if (!token || token.length > 200) return undefined;
    const id = token.split(".", 1)[0];
    const device = this.#state.devices.find((candidate) => candidate.id === id && !candidate.revokedAt);
    if (!device || !safeEqual(device.tokenHash, hash(token))) return undefined;
    return publicDevice(device);
  }

  async seen(deviceId: string): Promise<void> {
    const device = this.#state.devices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt);
    if (!device) return;
    device.lastSeenAt = new Date(this.#now()).toISOString();
    await this.#record("device.connected", deviceId, device.name);
  }

  async revoke(deviceId: string): Promise<void> {
    const device = this.#state.devices.find((candidate) => candidate.id === deviceId && !candidate.revokedAt);
    if (!device) throw new Error("Remote device was not found");
    device.revokedAt = new Date(this.#now()).toISOString();
    await this.#record("device.revoked", deviceId, device.name);
  }

  allow(key: string, limit: number, windowMs = 60_000): boolean {
    const cutoff = this.#now() - windowMs;
    const recent = (this.#rates.get(key) ?? []).filter((value) => value > cutoff);
    if (recent.length >= limit) return false;
    recent.push(this.#now());
    this.#rates.set(key, recent);
    return true;
  }

  async audit(action: string, deviceId?: string, detail?: string): Promise<void> {
    await this.#record(action, deviceId, detail);
  }

  async #record(action: string, deviceId?: string, detail?: string): Promise<void> {
    this.#state.audit.push({ id: randomUUID(), at: new Date(this.#now()).toISOString(), action: action.slice(0, 80), ...(deviceId ? { deviceId } : {}), ...(detail ? { detail: detail.slice(0, 200) } : {}) });
    this.#state.audit = this.#state.audit.slice(-500);
    this.#write = this.#write.catch(() => undefined).then(() => writeRecoverableJson(this.#path, this.#state));
    await this.#write;
  }
}

export function remoteProtocolToken(header: string | string[] | undefined): string | undefined {
  const values = (Array.isArray(header) ? header : header?.split(","))?.map((value) => value.trim()) ?? [];
  for (const prefix of [KIMI_REMOTE_TOKEN_PREFIX, LEGACY_REMOTE_TOKEN_PREFIX]) {
    const token = values.find((value) => value.startsWith(prefix));
    if (token) return token.slice(prefix.length);
  }
  return undefined;
}

export function remoteProtocolOffered(header: string | string[] | undefined): boolean {
  const values = (Array.isArray(header) ? header : header?.split(","))?.map((value) => value.trim()) ?? [];
  return values.includes(KIMI_REMOTE_PROTOCOL) || values.includes(LEGACY_REMOTE_PROTOCOL);
}

export function selectRemoteProtocol(protocols: ReadonlySet<string>): string | false {
  if (protocols.has(KIMI_REMOTE_PROTOCOL)) return KIMI_REMOTE_PROTOCOL;
  if (protocols.has(LEGACY_REMOTE_PROTOCOL)) return LEGACY_REMOTE_PROTOCOL;
  return false;
}

export function remoteClientProtocols(token?: string): string[] {
  return [
    KIMI_REMOTE_PROTOCOL,
    LEGACY_REMOTE_PROTOCOL,
    ...(token ? [`${KIMI_REMOTE_TOKEN_PREFIX}${token}`, `${LEGACY_REMOTE_TOKEN_PREFIX}${token}`] : []),
  ];
}

const remoteMethods = new Set([
  "env.bootstrap", "providers.list", "threads.list", "threads.create", "threads.createSide", "threads.resume", "threads.rename",
  "threads.setGoal", "threads.clearGoal", "threads.sendTurn", "threads.updateQueuedTurn", "threads.steerQueuedTurn",
  "threads.removeQueuedTurn", "threads.clearQueue", "threads.interruptTurn", "threads.respondToRequest", "threads.setConfigOption",
  "runtime.configDefaults", "checkpoints.list", "usage.quota", "capabilities.list",
]);

export function remoteMethodAllowed(input: unknown): boolean {
  return Boolean(input && typeof input === "object" && "method" in input && typeof input.method === "string" && remoteMethods.has(input.method));
}

function publicDevice(device: RemoteDeviceRecord): RemoteDevice {
  const { tokenHash: _, ...result } = device;
  return { ...result };
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
