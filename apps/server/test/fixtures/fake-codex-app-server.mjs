import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let approvalPending = false;

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (approvalPending && message.id === "approval-1") {
    approvalPending = false;
    send({ method: "thread/tokenUsage/updated", params: { threadId: "codex-thread", turnId: "codex-turn", tokenUsage: { last: { totalTokens: 40, inputTokens: 30, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 }, total: { totalTokens: 40, inputTokens: 30, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 2 }, modelContextWindow: 1000 } } });
    send({ method: "turn/completed", params: { threadId: "codex-thread", turn: { id: "codex-turn", status: "completed", error: null } } });
    return;
  }
  if (!message.id) return;
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake-codex", codexHome: "C:/fake", platformFamily: "windows", platformOs: "windows" } });
  else if (message.method === "model/list") send({ id: message.id, result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", description: "Test model", hidden: false, isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }, { reasoningEffort: "high", description: "Deep" }, { reasoningEffort: "ultra", description: "Agentic" }] }], nextCursor: null } });
  else if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "codex-thread" }, model: "gpt-test", reasoningEffort: "high" } });
  else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "codex-turn", status: "inProgress" } } });
    send({ method: "item/reasoning/summaryTextDelta", params: { threadId: "codex-thread", turnId: "codex-turn", itemId: "reasoning", delta: "Checking." } });
    send({ method: "item/agentMessage/delta", params: { threadId: "codex-thread", turnId: "codex-turn", itemId: "message", delta: "Done." } });
    send({ method: "item/started", params: { threadId: "codex-thread", turnId: "codex-turn", item: { type: "collabAgentToolCall", id: "agent-1", tool: "spawnAgent", prompt: "Inspect tests", receiverThreadIds: ["child-thread"], agentsStates: {} } } });
    approvalPending = true;
    send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "codex-thread", turnId: "codex-turn", itemId: "command-1", command: "pnpm test" } });
  } else if (message.method === "turn/interrupt") send({ id: message.id, result: {} });
  else send({ id: message.id, error: { code: -32601, message: `Unsupported ${message.method}` } });
});
