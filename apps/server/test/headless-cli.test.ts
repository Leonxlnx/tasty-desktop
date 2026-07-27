import { describe, expect, it } from "vitest";
import { normalizeRemoteEndpoint, parseCli } from "../src/headless-cli.js";

describe("headless CLI", () => {
  it("parses remote commands without putting credentials in URLs", () => {
    expect(parseCli(["send", "thread-1", "fix", "the", "tests"])).toEqual({ name: "send", threadId: "thread-1", text: "fix the tests" });
    expect(parseCli(["watch", "thread-1"])).toEqual({ name: "watch", threadId: "thread-1" });
    expect(normalizeRemoteEndpoint("wss://tasty.example/remote")).toBe("wss://tasty.example");
    expect(() => normalizeRemoteEndpoint("ws://user:secret@host:4318?token=bad")).toThrow("plain ws:// or wss://");
  });
});
