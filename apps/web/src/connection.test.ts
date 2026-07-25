import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionSupervisor } from "./connection";

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readyState = 0;
  sent: string[] = [];

  send(value: string): void {
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
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
    expect(vi.getTimerCount()).toBe(0);

    current.readyState = FakeSocket.OPEN;
    current.dispatchEvent(new Event("open"));
    expect(states.at(-1)).toBe("connected");
    client.close();
  });

  it("rejects an unanswered request instead of hanging forever", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    const request = client.request("threads.list");
    const failure = expect(request).rejects.toThrow("Server request timed out: threads.list");
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
