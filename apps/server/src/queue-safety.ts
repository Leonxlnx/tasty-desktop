type StableQueueItem = { queuedId: string };

export async function readQueueAfterPreflight<T, R>(
  queues: Map<string, T[]>,
  threadId: string,
  preflight: () => Promise<R>,
): Promise<{ queue: T[]; preflightResult: R }> {
  const preflightResult = await preflight();
  return { queue: queues.get(threadId) ?? [], preflightResult };
}

export class QueueInsertionGate {
  readonly #pending = new Set<string>();
  #tail = Promise.resolve();

  async during<T>(threadId: string, queuedId: string, operation: () => Promise<T>): Promise<T> {
    const key = queueKey(threadId, queuedId);
    if (this.#pending.has(key)) throw new Error(`Queue insertion ${queuedId} is already pending`);
    this.#pending.add(key);
    const result = this.#tail.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tail = tail;
    try {
      return await result;
    } finally {
      this.#pending.delete(key);
    }
  }

  has(threadId: string, queuedId: string): boolean {
    return this.#pending.has(queueKey(threadId, queuedId));
  }

  hasAny(threadId: string): boolean {
    const prefix = `${threadId.length}:${threadId}`;
    return [...this.#pending].some((key) => key.startsWith(prefix));
  }

  assertIdle(threadId: string): void {
    if (this.hasAny(threadId)) throw new Error("Queued prompt is still being accepted; retry this action shortly");
  }

  visible<T extends StableQueueItem>(threadId: string, items: T[]): T[] {
    return items.filter((item) => !this.has(threadId, item.queuedId));
  }
}

function queueKey(threadId: string, queuedId: string): string {
  return `${threadId.length}:${threadId}${queuedId}`;
}

export function removeQueuedItem<T extends StableQueueItem>(queues: Map<string, T[]>, threadId: string, item: T): boolean {
  const queue = queues.get(threadId);
  if (!queue) return false;
  const index = queue.findIndex((candidate) => candidate.queuedId === item.queuedId);
  if (index < 0) return false;
  queue.splice(index, 1);
  if (!queue.length) queues.delete(threadId);
  return true;
}

export async function persistQueuedInsertion<T extends StableQueueItem>(
  queues: Map<string, T[]>,
  threadId: string,
  item: T,
  persist: () => Promise<void>,
): Promise<void> {
  try {
    await persist();
  } catch (error) {
    removeQueuedItem(queues, threadId, item);
    throw error;
  }
}

export type QueueSnapshotState = { tail: Promise<void>; failureEpoch: number };

export function persistQueueSnapshot<T>(
  state: QueueSnapshotState,
  snapshot: T,
  current: () => T,
  write: (value: T) => Promise<void>,
): Promise<void> {
  const failureEpoch = state.failureEpoch;
  const persist = () => write(failureEpoch === state.failureEpoch ? snapshot : current());
  const operation = state.tail.then(persist, persist).catch((error) => {
    state.failureEpoch += 1;
    throw error;
  });
  state.tail = operation;
  return operation;
}

export async function withStableQueueWrites<T>(state: Pick<QueueSnapshotState, "tail">, operation: () => Promise<T>): Promise<T> {
  while (true) {
    const tail = state.tail;
    await tail.catch(() => undefined);
    if (tail === state.tail) return operation();
  }
}

export async function acceptQueuedInsertion<T extends StableQueueItem>(
  queues: Map<string, T[]>,
  threadId: string,
  item: T,
  accept: () => Promise<unknown>,
  persistRollback: () => Promise<void>,
): Promise<void> {
  try {
    await accept();
  } catch (error) {
    removeQueuedItem(queues, threadId, item);
    await persistRollback();
    throw error;
  }
}

type RecoverableThread = {
  threadId: string;
  submissionReceipts: Array<{ submissionId: string; queuedId: string; state: string }>;
};

export async function reconcileMissingSubmissionPayloads(
  threads: Iterable<RecoverableThread>,
  queues: ReadonlyMap<string, ReadonlyArray<{ queuedId: string }>>,
  markPayloadLost: (threadId: string, submissionIds: string[]) => Promise<void>,
): Promise<void> {
  for (const thread of threads) {
    const queuedIds = new Set((queues.get(thread.threadId) ?? []).map((item) => item.queuedId));
    const submissionIds = thread.submissionReceipts
      .filter((receipt) => receipt.state === "queued" && !queuedIds.has(receipt.queuedId))
      .map((receipt) => receipt.submissionId);
    if (submissionIds.length) await markPayloadLost(thread.threadId, submissionIds);
  }
}
