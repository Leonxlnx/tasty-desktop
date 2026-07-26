import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/acp-client.js";
import { ClaudeRuntime } from "../src/claude-runtime.js";

describe("Claude stream-json runtime", () => {
  it("uses the CLI effort levels and translates text, reasoning, tools, and usage", async () => {
    const events: RuntimeEvent[] = [];
    const runtime = new ClaudeRuntime({
      binary: process.execPath,
      argsPrefix: [join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude-stream.mjs")],
      onEvent: (event) => { events.push(event); },
    });
    await runtime.start();
    const cwd = await mkdtemp(join(tmpdir(), "tasty-claude-runtime-"));
    const session = await runtime.newSession(cwd);
    const effort = session.configOptions?.find((option) => option.id === "thinking");
    expect(effort && "options" in effort ? effort.options.flatMap((option) => "value" in option ? [option.value] : []) : []).toEqual(["low", "medium", "high", "max"]);
    await runtime.setConfigOption(session.sessionId, "thinking", "max");

    const result = await runtime.prompt(session.sessionId, [{ type: "text", text: "Improve the UI" }]);
    expect(result).toMatchObject({ stopReason: "end_turn", usage: { inputTokens: 35, outputTokens: 10, totalTokens: 45 } });
    const updates = events.filter((event) => event.type === "session_update").map((event) => event.params.update.sessionUpdate);
    expect(updates).toEqual(expect.arrayContaining(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update"]));
    const agentTool = events.find((event) => event.type === "session_update" && event.params.update.sessionUpdate === "tool_call");
    expect(agentTool && agentTool.type === "session_update" ? agentTool.params.update : {}).toMatchObject({ rawInput: { subagent_type: "explore" } });
    await runtime.close();
  });
});
