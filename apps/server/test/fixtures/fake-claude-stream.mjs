import { createInterface } from "node:readline";

const sessionIndex = process.argv.findIndex((arg) => arg === "--session-id" || arg === "--resume");
const sessionId = sessionIndex >= 0 ? process.argv[sessionIndex + 1] : "claude-session";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const input = JSON.parse(line);
  if (input.type !== "user") return;
  send({ type: "system", subtype: "init", session_id: sessionId });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "Inspecting." } } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Implemented." } } });
  send({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id: "tool-1", name: "Agent", input: { subagent_type: "explore", description: "Inspect UI" } }] } });
  send({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "Finished", is_error: false }] } });
  send({ type: "result", subtype: "success", is_error: false, result: "Implemented.", session_id: sessionId, usage: { input_tokens: 30, cache_read_input_tokens: 5, output_tokens: 10 } });
});
