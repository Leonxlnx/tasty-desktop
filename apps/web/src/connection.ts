export type ConnectionState = "connecting" | "reconnecting" | "connected" | "offline" | "error";
export type ServerMessage = { channel?: string; seq?: number; payload?: unknown; id?: string | number; result?: unknown; error?: { message: string } };
export class DeliveryUncertainError extends Error {
  override readonly name = "DeliveryUncertainError";
}
export class RequestNotSentError extends Error {
  override readonly name = "RequestNotSentError";
}
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number | undefined;
  replay?: { payload: string; sends: number };
};
const maxIdempotentSends = 2;
const boundedRequestMethods = new Set([
  // Idempotent liveness/read calls may fail locally without hiding a committed mutation.
  "env.bootstrap",
  "threads.list",
  "files.tree",
  "files.read",
  "runtime.configDefaults",
  "capabilities.list",
  "usage.quota",
  "git.status",
  "git.diff",
  "git.repository",
  "checkpoints.review",
]);

export class ConnectionSupervisor {
  readonly #url: string;
  readonly #onState: (state: ConnectionState) => void;
  readonly #onMessage: (message: ServerMessage) => void;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #requestTimeoutMs: number;
  #socket: WebSocket | undefined;
  #requestId = 0;
  #attempt = 0;
  #timer: number | undefined;
  #connectTimer: number | undefined;
  #generation = 0;
  #started = false;
  #closed = false;

  constructor(url: string, onState: (state: ConnectionState) => void, onMessage: (message: ServerMessage) => void, requestTimeoutMs = 30_000) {
    this.#url = url;
    this.#onState = onState;
    this.#onMessage = onMessage;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    window.addEventListener("online", this.#online);
    window.addEventListener("offline", this.#offline);
    this.#connect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearReconnect();
    this.#clearConnectTimeout();
    window.removeEventListener("online", this.#online);
    window.removeEventListener("offline", this.#offline);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    socket?.close();
    this.#rejectPending("Connection closed", true);
  }

  retry(): void {
    if (this.#closed) return;
    this.#clearReconnect();
    this.#clearConnectTimeout();
    this.#attempt = 0;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    this.#rejectPending("Server reconnecting", true);
    socket?.close();
    this.#connect();
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.#request(method, params, false);
  }

  requestIdempotent(method: "threads.sendTurn" | "threads.create" | "threads.createSide", params: Record<string, unknown>): Promise<unknown> {
    const id = method === "threads.sendTurn" ? params.submissionId : params.creationId;
    if (typeof id !== "string" || !id) return Promise.reject(new RequestNotSentError(`${method} requires a ${method === "threads.sendTurn" ? "submissionId" : "creationId"}`));
    return this.#request(method, params, true);
  }

  #request(method: string, params: Record<string, unknown>, retryable: boolean): Promise<unknown> {
    const socket = this.#socket;
    if (socket?.readyState !== WebSocket.OPEN) return Promise.reject(retryable ? new RequestNotSentError("Server is not connected") : new Error("Server is not connected"));
    const id = ++this.#requestId;
    let payload: string;
    try {
      payload = JSON.stringify({ id, method, params });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return Promise.reject(retryable ? new RequestNotSentError(message) : new Error(message));
    }
    return new Promise((resolve, reject) => {
      const timer = retryable || boundedRequestMethods.has(method) ? window.setTimeout(() => {
        this.#pending.delete(id);
        const message = `Server request timed out: ${method}`;
        reject(retryable ? new DeliveryUncertainError(message) : new Error(message));
      }, this.#requestTimeoutMs) : undefined;
      const pending: PendingRequest = { resolve, reject, timer, ...(retryable ? { replay: { payload, sends: 0 } } : {}) };
      this.#pending.set(id, pending);
      try {
        socket.send(payload);
        if (pending.replay) pending.replay.sends += 1;
      } catch (error) {
        this.#pending.delete(id);
        if (timer !== undefined) window.clearTimeout(timer);
        const message = error instanceof Error ? error.message : String(error);
        reject(retryable ? new RequestNotSentError(message) : new Error(message));
      }
    });
  }

  #connect(): void {
    if (this.#closed || !navigator.onLine) {
      this.#onState("offline");
      return;
    }
    if (this.#socket?.readyState === WebSocket.CONNECTING || this.#socket?.readyState === WebSocket.OPEN) return;
    this.#onState(this.#attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.#url);
    const generation = ++this.#generation;
    this.#socket = socket;
    this.#connectTimer = window.setTimeout(() => {
      if (!this.#isCurrent(socket, generation) || socket.readyState !== WebSocket.CONNECTING) return;
      this.#connectTimer = undefined;
      this.#socket = undefined;
      this.#generation += 1;
      socket.close();
      this.#onState("error");
      this.#scheduleReconnect();
    }, this.#requestTimeoutMs);
    socket.addEventListener("open", () => {
      if (!this.#isCurrent(socket, generation)) return;
      this.#clearConnectTimeout();
      this.#attempt = 0;
      this.#replayPending(socket);
      this.#onState("connected");
    });
    socket.addEventListener("message", (event) => {
      if (!this.#isCurrent(socket, generation)) return;
      let message: ServerMessage;
      try {
        const parsed = JSON.parse(String(event.data)) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid server response");
        const record = parsed as Record<string, unknown>;
        if (Object.hasOwn(record, "id")) {
          const responseId = record.id;
          const validId = typeof responseId === "number" ? Number.isSafeInteger(responseId) && responseId > 0 : typeof responseId === "string" && /^[1-9]\d*$/.test(responseId);
          const hasResult = Object.hasOwn(record, "result");
          const hasError = Object.hasOwn(record, "error");
          if (!validId || hasResult === hasError || (hasError && (!record.error || typeof record.error !== "object" || typeof (record.error as Record<string, unknown>).message !== "string"))) throw new Error("Invalid server response");
        } else if (typeof record.channel !== "string") {
          throw new Error("Invalid server response");
        }
        message = record as ServerMessage;
      } catch {
        this.#onState("error");
        this.#rejectPending("Invalid server response", true);
        socket.close();
        return;
      }
      if (message.id !== undefined) {
        const pending = this.#pending.get(Number(message.id));
        if (!pending) return;
        this.#pending.delete(Number(message.id));
        if (pending.timer !== undefined) window.clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      this.#onMessage(message);
    });
    socket.addEventListener("close", (event) => {
      if (!this.#isCurrent(socket, generation) || this.#closed) return;
      this.#clearConnectTimeout();
      this.#socket = undefined;
      const close = event as CloseEvent;
      const authenticationFailure = close.code === 1008 || close.code === 4001 || close.code === 4003 || /auth|token|forbidden|revoked/i.test(close.reason ?? "");
      if (authenticationFailure) this.#rejectPending("Server authentication failed", true);
      else if (close.code >= 4_000 && close.code < 5_000) this.#rejectPending(close.reason || "Server rejected the request", true);
      else this.#retainReplayablePending();
      this.#scheduleReconnect();
    });
    socket.addEventListener("error", () => {
      if (this.#isCurrent(socket, generation)) this.#onState("error");
    });
  }

  #scheduleReconnect(): void {
    if (!navigator.onLine) {
      this.#onState("offline");
      return;
    }
    this.#onState("reconnecting");
    const delay = Math.min(16_000, 500 * 2 ** this.#attempt++);
    this.#timer = window.setTimeout(() => {
      this.#timer = undefined;
      this.#connect();
    }, delay);
  }

  #clearReconnect(): void {
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #clearConnectTimeout(): void {
    if (this.#connectTimer !== undefined) window.clearTimeout(this.#connectTimer);
    this.#connectTimer = undefined;
  }

  #isCurrent(socket: WebSocket, generation: number): boolean {
    return this.#socket === socket && this.#generation === generation;
  }

  #replayPending(socket: WebSocket): void {
    for (const [id, pending] of this.#pending) {
      if (!pending.replay) continue;
      try {
        socket.send(pending.replay.payload);
        pending.replay.sends += 1;
      } catch (error) {
        this.#pending.delete(id);
        if (pending.timer !== undefined) window.clearTimeout(pending.timer);
        pending.reject(new DeliveryUncertainError(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  #retainReplayablePending(): void {
    for (const [id, pending] of this.#pending) {
      if (pending.replay && pending.replay.sends < maxIdempotentSends) continue;
      this.#pending.delete(id);
      if (pending.timer !== undefined) window.clearTimeout(pending.timer);
      pending.reject(pending.replay ? new DeliveryUncertainError("Server disconnected") : new Error("Server disconnected"));
    }
  }

  #rejectPending(message: string, uncertainDelivery = false): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) window.clearTimeout(pending.timer);
      pending.reject(uncertainDelivery && pending.replay ? new DeliveryUncertainError(message) : new Error(message));
    }
    this.#pending.clear();
  }

  #online = () => {
    if (this.#closed || this.#socket?.readyState === WebSocket.CONNECTING || this.#socket?.readyState === WebSocket.OPEN) return;
    this.#clearReconnect();
    this.#connect();
  };

  #offline = () => {
    this.#onState("offline");
    this.#clearReconnect();
    this.#clearConnectTimeout();
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    socket?.close();
    this.#retainReplayablePending();
  };
}
