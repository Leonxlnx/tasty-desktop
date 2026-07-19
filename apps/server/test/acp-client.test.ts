import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AcpClient, type RuntimeEvent } from "../src/acp-client.js";

describe("AcpClient", () => {
  it("streams a full turn with a diff and permission", async () => {
    const events: RuntimeEvent[] = [];
    const fakePath = join(dirname(fileURLToPath(import.meta.url)), "../src/fake-acp.ts");
    let client!: AcpClient;
    client = new AcpClient({
      binary: process.execPath,
      args: ["--import", "tsx", fakePath],
      onEvent: (event) => {
        events.push(event);
        if (event.type === "permission_request") client.respondToPermission(event.requestId, "allow-once");
      },
    });

    try {
      const initialized = await client.start();
      expect(initialized.agentInfo?.name).toBe("Kimi Code Fake");
      const session = await client.newSession(process.cwd());
      const result = await client.prompt(session.sessionId, [{ type: "text", text: "Update the README" }]);
      expect(result.stopReason).toBe("end_turn");
      expect(events.some((event) => event.type === "permission_request")).toBe(true);
      expect(events.some((event) => event.type === "session_update" && event.params.update.sessionUpdate === "tool_call_update")).toBe(true);
      expect(events.some((event) => event.type === "session_update" && event.params.update.sessionUpdate === "agent_message_chunk")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("cancels a pending permission request before the turn stops", async () => {
    const fakePath = join(dirname(fileURLToPath(import.meta.url)), "../src/fake-acp.ts");
    let permissionReady!: () => void;
    const pendingPermission = new Promise<void>((resolve) => { permissionReady = resolve; });
    const client = new AcpClient({
      binary: process.execPath,
      args: ["--import", "tsx", fakePath],
      onEvent: (event) => event.type === "permission_request" && permissionReady(),
    });

    try {
      await client.start();
      const session = await client.newSession(process.cwd());
      const prompt = client.prompt(session.sessionId, [{ type: "text", text: "Cancel this turn" }]);
      await pendingPermission;
      await client.cancel(session.sessionId);
      await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    } finally {
      await client.close();
    }
  });

  it("treats config updates as truth when thinking disappears", async () => {
    const fakePath = join(dirname(fileURLToPath(import.meta.url)), "../src/fake-acp.ts");
    const updates: RuntimeEvent[] = [];
    const client = new AcpClient({ binary: process.execPath, args: ["--import", "tsx", fakePath], onEvent: (event) => updates.push(event) });
    try {
      await client.start();
      const session = await client.newSession(process.cwd());
      await client.setConfigOption(session.sessionId, "model", "kimi-k3-fast");
      await client.setConfigOption(session.sessionId, "mode", "auto");
      const update = updates.findLast((event) => event.type === "session_update" && event.params.update.sessionUpdate === "config_option_update");
      expect(update?.type === "session_update" && update.params.update.sessionUpdate === "config_option_update" && update.params.update.configOptions.some((option) => option.id === "thinking")).toBe(false);
      expect(update?.type === "session_update" && update.params.update.sessionUpdate === "config_option_update" && update.params.update.configOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3-fast");
    } finally {
      await client.close();
    }
  });

  it("forwards a rejected approval outcome", async () => {
    const fakePath = join(dirname(fileURLToPath(import.meta.url)), "../src/fake-acp.ts");
    const events: RuntimeEvent[] = [];
    let client!: AcpClient;
    client = new AcpClient({
      binary: process.execPath,
      args: ["--import", "tsx", fakePath],
      onEvent: (event) => {
        events.push(event);
        if (event.type === "permission_request") client.respondToPermission(event.requestId, "reject-once");
      },
    });
    try {
      await client.start();
      const session = await client.newSession(process.cwd());
      await expect(client.prompt(session.sessionId, [{ type: "text", text: "Do not run checks" }])).resolves.toEqual({ stopReason: "end_turn" });
      expect(events.some((event) => event.type === "session_update" && event.params.update.sessionUpdate === "agent_message_chunk" && "content" in event.params.update && event.params.update.content.type === "text" && event.params.update.content.text === "Permission rejected.")).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("loads client-managed MCP servers for new, resumed, and replayed sessions", async () => {
    const fakePath = join(dirname(fileURLToPath(import.meta.url)), "../src/fake-acp.ts");
    let reads = 0;
    const client = new AcpClient({
      binary: process.execPath,
      args: ["--import", "tsx", fakePath],
      mcpServers: async () => {
        reads += 1;
        return [{ name: "local", command: "server.exe", args: [], env: [] }];
      },
      onEvent: () => undefined,
    });
    try {
      await client.start();
      const session = await client.newSession(process.cwd());
      await client.resumeSession(session.sessionId, process.cwd());
      await client.loadSession(session.sessionId, process.cwd());
      expect(reads).toBe(3);
    } finally {
      await client.close();
    }
  });
});
