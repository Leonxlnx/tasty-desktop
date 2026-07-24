export type ConnectionState = "connecting" | "reconnecting" | "connected" | "offline" | "error";
export type ServerMessage = { channel?: string; seq?: number; payload?: unknown; id?: string | number; result?: unknown; error?: { message: string } };
const boundedRequestMethods = new Set(["threads.list", "files.tree", "files.read", "runtime.configDefaults", "capabilities.list", "usage.quota", "git.status", "git.diff"]);

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
  #closed = false;

  constructor(url: string, onState: (state: ConnectionState) => void, onMessage: (message: ServerMessage) => void, requestTimeoutMs = 30_000) {
    this.#url = url;
    this.#onState = onState;
    this.#onMessage = onMessage;
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  start(): void {
    window.addEventListener("online", this.#online);
    window.addEventListener("offline", this.#offline);
    this.#connect();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    window.removeEventListener("online", this.#online);
    window.removeEventListener("offline", this.#offline);
    this.#socket?.close();
    this.#rejectPending("Connection closed");
  }

  retry(): void {
    if (this.#closed) return;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#attempt = 0;
    this.#socket?.close();
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
    this.#onState(this.#attempt === 0 ? "connecting" : "reconnecting");
    const socket = new WebSocket(this.#url);
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#attempt = 0;
      this.#onState("connected");
    });
    socket.addEventListener("message", (event) => {
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
      if (this.#socket !== socket || this.#closed) return;
      this.#rejectPending("Server disconnected");
      this.#scheduleReconnect();
    });
    socket.addEventListener("error", () => this.#onState("error"));
  }

  #scheduleReconnect(): void {
    if (!navigator.onLine) {
      this.#onState("offline");
      return;
    }
    this.#onState("reconnecting");
    const delay = Math.min(16_000, 500 * 2 ** this.#attempt++);
    this.#timer = window.setTimeout(() => this.#connect(), delay);
  }

  #rejectPending(message: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) window.clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.#pending.clear();
  }

  #online = () => {
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#timer !== undefined) window.clearTimeout(this.#timer);
    this.#connect();
  };

  #offline = () => {
    this.#onState("offline");
    this.#socket?.close();
  };
}
