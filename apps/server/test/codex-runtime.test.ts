import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/acp-client.js";
import { CodexRuntime } from "../src/codex-runtime.js";

describe("Codex App Server runtime", () => {
  it("discovers real effort options and translates a streamed turn", async () => {
    const events: RuntimeEvent[] = [];
    let runtime: CodexRuntime;
    runtime = new CodexRuntime({
      binary: process.execPath,
      args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-codex-app-server.mjs")],
      onEvent: async (event) => {
        events.push(event);
        if (event.type === "permission_request") runtime.respondToPermission(event.requestId, "accept");
      },
    });
    await runtime.start();
    const cwd = await mkdtemp(join(tmpdir(), "tasty-codex-runtime-"));
    const session = await runtime.newSession(cwd);
    const effort = session.configOptions?.find((option) => option.id === "thinking");
    expect(effort && "options" in effort ? effort.options.flatMap((option) => "value" in option ? [option.value] : []) : []).toEqual(["low", "high", "ultra"]);
    await runtime.setConfigOption(session.sessionId, "thinking", "ultra");

    const result = await runtime.prompt(session.sessionId, [{ type: "text", text: "Run the tests" }]);
    expect(result).toMatchObject({ stopReason: "end_turn", usage: { totalTokens: 40 } });
    expect(events.some((event) => event.type === "session_update" && event.params.update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(events.some((event) => event.type === "session_update" && event.params.update.sessionUpdate === "agent_thought_chunk")).toBe(true);
    expect(events.some((event) => event.type === "session_update" && event.params.update.sessionUpdate === "tool_call")).toBe(true);
    expect(events.some((event) => event.type === "permission_request")).toBe(true);
    await expect(runtime.inspectSubagent("child-thread")).resolves.toMatchObject({
      threadId: "child-thread",
      role: "explore",
      turns: [{ items: [{ kind: "reasoning" }, { title: "pnpm test", text: "57 tests passed" }, { kind: "message", text: "The tests are green." }] }],
    });
    await expect(runtime.stopSubagent("child-thread")).resolves.toBeUndefined();
    await runtime.close();
  });
});
