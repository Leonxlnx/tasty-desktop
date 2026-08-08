import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

type PendingPermission = { sessionId: string; resolve: (response: RequestPermissionResponse) => void };

export class ApprovalBroker {
  readonly #onRequest: (requestId: string, params: RequestPermissionRequest) => void;
  readonly #pending = new Map<string, PendingPermission>();
  #id = 0;

  constructor(onRequest: (requestId: string, params: RequestPermissionRequest) => void) {
    this.#onRequest = onRequest;
  }

  request(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const requestId = `permission-${++this.#id}`;
    return new Promise((resolve) => {
      this.#pending.set(requestId, { sessionId: params.sessionId, resolve });
      this.#onRequest(requestId, params);
    });
  }

  respond(requestId: string, optionId?: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) throw new Error(`Permission request ${requestId} is not pending`);
    this.#pending.delete(requestId);
    pending.resolve({ outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.#pending) if (pending.sessionId === sessionId) this.respond(requestId);
  }

  cancelAll(): void {
    for (const requestId of [...this.#pending.keys()]) this.respond(requestId);
  }
}
