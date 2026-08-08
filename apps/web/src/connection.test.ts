import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionSupervisor, DeliveryUncertainError, RequestNotSentError } from "./connection";

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  sendError: Error | undefined;

  send(value: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(value);
  }

  close(code = 1006, reason = ""): void {
    this.readyState = 3;
    const event = new Event("close");
    Object.defineProperties(event, { code: { value: code }, reason: { value: reason } });
    this.dispatchEvent(event);
  }
}

describe("ConnectionSupervisor", () => {
  let socket: FakeSocket;
  let sockets: FakeSocket[];

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", class {
      static readonly CONNECTING = FakeSocket.CONNECTING;
      static readonly OPEN = FakeSocket.OPEN;
      constructor() {
        socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a single connecting socket across repeated start and online calls", () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    client.start();
    const online = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === "online")?.[1] as EventListener;

    online(new Event("online"));
    online(new Event("online"));

    expect(sockets).toHaveLength(1);
    client.close();
  });

  it("bounds a socket that remains CONNECTING and schedules a fresh attempt", async () => {
    const states: string[] = [];
    const client = new ConnectionSupervisor("ws://127.0.0.1", (state) => states.push(state), () => undefined, 25);
    client.start();
    const stalled = socket;

    await vi.advanceTimersByTimeAsync(25);

    expect(stalled.readyState).toBe(3);
    expect(states).toContain("error");
    expect(states.at(-1)).toBe("reconnecting");
    expect(sockets).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    client.close();
  });

  it("ignores every event from a socket replaced by retry", () => {
    const states: string[] = [];
    const messages: unknown[] = [];
    const client = new ConnectionSupervisor("ws://127.0.0.1", (state) => states.push(state), (message) => messages.push(message), 25);
    client.start();
    const stale = socket;

    client.retry();
    const current = socket;
    stale.dispatchEvent(new Event("open"));
    stale.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ channel: "events", payload: "stale" }) }));
    stale.dispatchEvent(new Event("error"));
    stale.dispatchEvent(new Event("close"));

    expect(sockets).toHaveLength(2);
    expect(messages).toEqual([]);
    expect(states).not.toContain("connected");
    expect(states).not.toContain("error");
    expect(vi.getTimerCount()).toBe(1);

    current.readyState = FakeSocket.OPEN;
    current.dispatchEvent(new Event("open"));
    expect(states.at(-1)).toBe("connected");
    expect(vi.getTimerCount()).toBe(0);
    client.close();
  });

  it.each(["threads.list", "git.repository"])("bounds the idempotent %s request", async (method) => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    const request = client.request(method);
    const failure = expect(request).rejects.toThrow(`Server request timed out: ${method}`);
    await vi.advanceTimersByTimeAsync(25);
    await failure;
    client.close();
  });

  it("bounds the idempotent bootstrap liveness request", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    const request = client.request("env.bootstrap");
    const failure = expect(request).rejects.toThrow("Server request timed out: env.bootstrap");
    await vi.advanceTimersByTimeAsync(25);
    await failure;
    client.close();
  });

  it.each(["threads.resume", "threads.setConfigOption", "threads.sendTurn"])("does not time out the side-effecting %s request", async (method) => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    const request = client.request(method);
    const { id } = JSON.parse(socket.sent[0]!) as { id: number };
    await vi.advanceTimersByTimeAsync(25);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { accepted: true } }) }));

    await expect(request).resolves.toEqual({ accepted: true });
    client.close();
  });

  it("rejects pending work before replacing a socket during recovery", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const previous = socket;
    const pending = client.request("threads.sendTurn");
    const failure = expect(pending).rejects.toThrow("Server reconnecting");

    client.retry();

    await failure;
    expect(socket).not.toBe(previous);
    client.close();
  });

  it("replays a lost threads.sendTurn acknowledgement once with the exact request", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const settled = vi.fn();
    const request = client.requestIdempotent("threads.sendTurn", {
      threadId: "thread-1", text: "ship it", mode: "queue", submissionId: "submission-1",
    });
    void request.then(settled);
    const payload = first.sent[0]!;

    first.close();
    await vi.advanceTimersByTimeAsync(500);
    const reconnected = socket;
    reconnected.readyState = FakeSocket.OPEN;
    reconnected.dispatchEvent(new Event("open"));

    expect(reconnected.sent).toEqual([payload]);
    const { id } = JSON.parse(payload) as { id: number };
    reconnected.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { accepted: true } }) }));
    reconnected.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { accepted: true } }) }));
    await expect(request).resolves.toEqual({ accepted: true });
    expect(settled).toHaveBeenCalledTimes(1);
    client.close();
  });

  it.each(["threads.create", "threads.createSide"] as const)("replays a lost %s acknowledgement once with the same creation ID", async (method) => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const request = client.requestIdempotent(method, method === "threads.create"
      ? { cwd: "E:/work", creationId: "creation-1" }
      : { threadId: "parent-1", title: "Explore", creationId: "creation-1" });
    const payload = first.sent[0]!;

    first.close();
    await vi.advanceTimersByTimeAsync(500);
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    expect(socket.sent).toEqual([payload]);
    const { id } = JSON.parse(payload) as { id: number };
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { thread: { threadId: "thread-1" } } }) }));
    await expect(request).resolves.toEqual({ thread: { threadId: "thread-1" } });
    client.close();
  });

  it("reports a replay send failure as ambiguous and does not leave the request pending", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1", text: "ship it" });

    first.close();
    await vi.advanceTimersByTimeAsync(500);
    socket.sendError = new Error("replay send failed");
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    const error = await request.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("replay send failed");
    await vi.advanceTimersByTimeAsync(2_000);
    client.close();
  });

  it("settles at the request timeout before a reconnect opens and never replays later", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1", text: "ship it" });
    const failure = request.catch((error: unknown) => error);

    first.close();
    await vi.advanceTimersByTimeAsync(25);

    const error = await failure;
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("Server request timed out: threads.sendTurn");

    await vi.advanceTimersByTimeAsync(475);
    expect(sockets).toHaveLength(2);
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    expect(socket.sent).toEqual([]);
    client.close();
  });

  it("ignores a stale response from the lost socket and settles only from the replay", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1", text: "ship it" });
    const payload = first.sent[0]!;
    const { id } = JSON.parse(payload) as { id: number };
    const settled = vi.fn();
    void request.then(settled, settled);

    first.close();
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { source: "stale" } }) }));
    expect(settled).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    expect(socket.sent).toEqual([payload]);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { source: "replay" } }) }));

    await expect(request).resolves.toEqual({ source: "replay" });
    expect(settled).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("keeps concurrent ambiguous sends separate and replays both exactly once", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const queue = client.requestIdempotent("threads.sendTurn", { threadId: "thread-1", mode: "queue", text: "one", submissionId: "submission-1" });
    const steer = client.requestIdempotent("threads.sendTurn", { threadId: "thread-1", mode: "steer", text: "two", submissionId: "submission-2" });
    const payloads = [...first.sent];

    first.close();
    await vi.advanceTimersByTimeAsync(500);
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    expect(socket.sent).toEqual(payloads);
    for (const payload of payloads) {
      const { id } = JSON.parse(payload) as { id: number };
      socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { accepted: true } }) }));
    }
    await expect(Promise.all([queue, steer])).resolves.toEqual([{ accepted: true }, { accepted: true }]);
    client.close();
  });

  it("rejects missing idempotency keys and serialization failures before send", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const cyclic: Record<string, unknown> = { submissionId: "submission-1" };
    cyclic.self = cyclic;

    await expect(client.requestIdempotent("threads.sendTurn", {})).rejects.toBeInstanceOf(RequestNotSentError);
    await expect(client.requestIdempotent("threads.create", {})).rejects.toBeInstanceOf(RequestNotSentError);
    await expect(client.requestIdempotent("threads.createSide", { threadId: "parent-1" })).rejects.toBeInstanceOf(RequestNotSentError);
    await expect(client.requestIdempotent("threads.sendTurn", cyclic)).rejects.toBeInstanceOf(RequestNotSentError);
    expect(socket.sent).toEqual([]);
    client.close();
  });

  it("reports a second transport loss as ambiguous instead of replaying forever", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" });

    socket.close();
    await vi.advanceTimersByTimeAsync(500);
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const failure = request.catch((error: unknown) => error);
    socket.close();

    const error = await failure;
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("Server disconnected");
    client.close();
  });

  it.each(["close", "retry"] as const)("does not replay after explicit %s", async (action) => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" });
    const failure = request.catch((error: unknown) => error);

    client[action]();

    const error = await failure;
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe(action === "close" ? "Connection closed" : "Server reconnecting");
    if (action === "retry") expect(socket.sent).toEqual([]);
    client.close();
  });

  it("does not replay an RPC failure", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" });
    const { id } = JSON.parse(first.sent[0]!) as { id: number };
    first.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, error: { message: "Rejected" } }) }));
    const error = await request.catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("Rejected");

    first.close();
    await vi.advanceTimersByTimeAsync(500);
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    expect(socket.sent).toEqual([]);
    client.close();
  });

  it("reports an authentication close after send as ambiguous", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" });
    const failure = request.catch((error: unknown) => error);

    socket.close(1008, "Unauthorized token");

    const error = await failure;
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("Server authentication failed");
    client.close();
  });

  it("reports an application close after send as ambiguous", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" });
    const failure = request.catch((error: unknown) => error);

    socket.close(4008, "Rate limit exceeded");

    const error = await failure;
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("Rate limit exceeded");
    client.close();
  });

  it.each(["null", "[]", '{"id":1}', '{"id":true,"result":{"accepted":true}}'])("reports a malformed %s response after send as ambiguous", async (frame) => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" });
    const failure = request.catch((error: unknown) => error);

    socket.dispatchEvent(new MessageEvent("message", { data: frame }));

    const error = await failure;
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("Invalid server response");
    client.close();
  });

  it("keeps a retryable request through a failed reconnect before a later open", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 5_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1", text: "ship it" });
    const payload = first.sent[0]!;

    first.close();
    await vi.advanceTimersByTimeAsync(500);
    socket.close();
    await vi.advanceTimersByTimeAsync(1_000);
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    expect(socket.sent).toEqual([payload]);
    const { id } = JSON.parse(payload) as { id: number };
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { accepted: true } }) }));
    await expect(request).resolves.toEqual({ accepted: true });
    client.close();
  });

  it("replays the exact retryable request after an offline and online transition", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 2_000);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const first = socket;
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1", text: "ship it" });
    const payload = first.sent[0]!;
    const offline = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === "offline")?.[1] as EventListener;
    const online = vi.mocked(window.addEventListener).mock.calls.find(([type]) => type === "online")?.[1] as EventListener;

    offline(new Event("offline"));
    online(new Event("online"));
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    expect(socket.sent).toEqual([payload]);
    const { id } = JSON.parse(payload) as { id: number };
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { accepted: true } }) }));
    await expect(request).resolves.toEqual({ accepted: true });
    client.close();
  });

  it("bounds a retryable threads.sendTurn request", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    const request = client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" });
    const failure = request.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(25);

    const error = await failure;
    expect(error).toBeInstanceOf(DeliveryUncertainError);
    expect((error as Error).message).toBe("Server request timed out: threads.sendTurn");
    client.close();
  });

  it("treats a synchronous send failure as not sent", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));
    socket.sendError = new Error("send failed");

    const error = await client.requestIdempotent("threads.sendTurn", { submissionId: "submission-1" }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(RequestNotSentError);
    expect((error as Error).message).toBe("send failed");
    client.close();
  });

  it("clears the request timeout when the server replies", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    const request = client.request("threads.list");
    const { id } = JSON.parse(socket.sent[0]!) as { id: number };
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { threads: [] } }) }));

    await expect(request).resolves.toEqual({ threads: [] });
    await vi.advanceTimersByTimeAsync(25);
    client.close();
  });

  it("reconnects instead of crashing on a malformed server frame", () => {
    const states: string[] = [];
    const client = new ConnectionSupervisor("ws://127.0.0.1", (state) => states.push(state), () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    socket.dispatchEvent(new MessageEvent("message", { data: "not-json" }));

    expect(states).toContain("error");
    expect(states.at(-1)).toBe("reconnecting");
    client.close();
  });
});
