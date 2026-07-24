import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionSupervisor } from "./connection";

class FakeSocket extends EventTarget {
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

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal("WebSocket", class {
      static readonly OPEN = FakeSocket.OPEN;
      constructor() {
        socket = new FakeSocket();
        return socket;
      }
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it("does not time out a side effect that can still complete on the server", async () => {
    const client = new ConnectionSupervisor("ws://127.0.0.1", () => undefined, () => undefined, 25);
    client.start();
    socket.readyState = FakeSocket.OPEN;
    socket.dispatchEvent(new Event("open"));

    const request = client.request("threads.sendTurn");
    const { id } = JSON.parse(socket.sent[0]!) as { id: number };
    await vi.advanceTimersByTimeAsync(25);
    socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id, result: { accepted: true } }) }));

    await expect(request).resolves.toEqual({ accepted: true });
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
