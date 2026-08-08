import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { writeRecoverableJson } from "./recoverable-json.js";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.object({
  root: z.string().min(1).max(32_767).refine(isAbsolute),
  fingerprint: fingerprintSchema,
  approvedAt: z.string().datetime(),
}).strict();
const stateSchema = z.object({
  version: z.literal(1),
  approvals: z.array(approvalSchema).max(10_000),
}).strict().superRefine(({ approvals }, context) => {
  const roots = new Set<string>();
  for (const approval of approvals) {
    if (roots.has(approval.root)) {
      context.addIssue({ code: "custom", path: ["approvals"], message: "Duplicate MCP approval root" });
      return;
    }
    roots.add(approval.root);
  }
});

export type McpApproval = z.infer<typeof approvalSchema>;
export type McpApprovalStatus = {
  approved: boolean;
  changed: boolean;
  corrupt: boolean;
  approvedAt?: string;
};

export class McpApprovalStore {
  readonly #path: string;
  readonly #now: () => number;
  #approvals = new Map<string, McpApproval>();
  #corrupt = false;
  #mutation = Promise.resolve();

  constructor(path: string, now: () => number = Date.now) {
    this.#path = path;
    this.#now = now;
  }

  open(): Promise<void> {
    return this.#serialize(async () => {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(this.#path));
        const parsed = stateSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error("Invalid MCP approval state");
        this.#approvals = new Map(parsed.data.approvals.map((approval) => [approval.root, approval]));
        this.#corrupt = false;
      } catch (error) {
        this.#approvals = new Map();
        this.#corrupt = (error as NodeJS.ErrnoException).code !== "ENOENT";
      }
    });
  }

  async approve(root: string, fingerprint: string): Promise<McpApproval> {
    const exactFingerprint = fingerprintSchema.parse(fingerprint);
    const canonicalRoot = await canonicalizeRoot(root);
    return this.#mutate((approvals) => {
      const current = approvals.get(canonicalRoot);
      if (current?.fingerprint === exactFingerprint && !this.#corrupt) {
        return { result: structuredClone(current), changed: false };
      }
      const approval = approvalSchema.parse({
        root: canonicalRoot,
        fingerprint: exactFingerprint,
        approvedAt: new Date(this.#now()).toISOString(),
      });
      approvals.set(canonicalRoot, approval);
      return { result: structuredClone(approval), changed: true };
    });
  }

  async status(root: string, fingerprint: string): Promise<McpApprovalStatus> {
    const exactFingerprint = fingerprintSchema.parse(fingerprint);
    const canonicalRoot = await canonicalizeRoot(root);
    const approval = this.#approvals.get(canonicalRoot);
    return {
      approved: !this.#corrupt && approval?.fingerprint === exactFingerprint,
      changed: !this.#corrupt && Boolean(approval && approval.fingerprint !== exactFingerprint),
      corrupt: this.#corrupt,
      ...(approval ? { approvedAt: approval.approvedAt } : {}),
    };
  }

  async revoke(root: string): Promise<boolean> {
    const canonicalRoot = await canonicalizeRoot(root);
    return this.#mutate((approvals) => {
      const revoked = approvals.delete(canonicalRoot);
      return { result: revoked, changed: revoked };
    });
  }

  async #mutate<T>(change: (approvals: Map<string, McpApproval>) => { result: T; changed: boolean }): Promise<T> {
    return this.#serialize(async () => {
      const approvals = new Map(this.#approvals);
      const { result, changed } = change(approvals);
      if (!changed) return result;
      const next = stateSchema.parse({ version: 1, approvals: [...approvals.values()] });
      await writeRecoverableJson(this.#path, next);
      this.#approvals = new Map(next.approvals.map((approval) => [approval.root, approval]));
      this.#corrupt = false;
      return result;
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation);
    this.#mutation = result.then(() => undefined, () => undefined);
    return result;
  }
}

async function canonicalizeRoot(root: string): Promise<string> {
  if (!isAbsolute(root)) throw new Error("MCP approval root must be absolute");
  const canonicalRoot = await realpath(resolve(root));
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("MCP approval root must be a directory");
  return canonicalRoot;
}
