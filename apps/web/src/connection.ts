export type ConnectionState = "connecting" | "reconnecting" | "connected" | "offline" | "error";
export type ServerMessage = { channel?: string; seq?: number; payload?: unknown; id?: string | number; result?: unknown; error?: { message: string } };
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
]);

export class ConnectionSupervisor {
  readonly #url: string;
  readonly #onState: (state: ConnectionState) => void;
  readonly #onMessage: (message: ServerMessage) => void;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number | undefined }>();
  readonly #requestTimeoutMs: number;
  #socket: WebSocket | undefined;
  #requestId = 0;
  #attempt = 0;
  #timer: number | undefined;
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
    window.removeEventListener("online", this.#online);
    window.removeEventListener("offline", this.#offline);
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    socket?.close();
    this.#rejectPending("Connection closed");
  }

  retry(): void {
    if (this.#closed) return;
    this.#clearReconnect();
    this.#attempt = 0;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    this.#rejectPending("Server reconnecting");
    socket?.close();
    this.#connect();
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Server is not connected"));
    const id = ++this.#requestId;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = boundedRequestMethods.has(method) ? window.setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Server request timed out: ${method}`));
      }, this.#requestTimeoutMs) : undefined;
      this.#pending.set(id, { resolve, reject, timer });
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
    socket.addEventListener("open", () => {
      if (!this.#isCurrent(socket, generation)) return;
      this.#attempt = 0;
      this.#onState("connected");
    });
    socket.addEventListener("message", (event) => {
      if (!this.#isCurrent(socket, generation)) return;
      let message: ServerMessage;
      try {
        message = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        this.#onState("error");
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
    socket.addEventListener("close", () => {
      if (!this.#isCurrent(socket, generation) || this.#closed) return;
      this.#socket = undefined;
      this.#rejectPending("Server disconnected");
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

  #isCurrent(socket: WebSocket, generation: number): boolean {
    return this.#socket === socket && this.#generation === generation;
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
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
    const socket = this.#socket;
    this.#socket = undefined;
    this.#generation += 1;
    socket?.close();
    this.#rejectPending("Server disconnected");
  };
}
