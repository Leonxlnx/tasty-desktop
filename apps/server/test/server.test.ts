import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";

describe("orchestration server", () => {
  const children: ReturnType<typeof spawn>[] = [];

  afterEach(() => children.splice(0).forEach((child) => child.kill()));

  it("runs a full fake ACP turn through WebSocket", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const port = "45117";
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-test-"));
    const child = spawn(process.execPath, ["--import", "tsx", serverPath], {
      env: { ...process.env, KIMI_FAKE: "1", KIMI_SERVER_PORT: port, KIMI_DESKTOP_HOME: dataHome },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => chunk.includes("listening") && resolve());
      child.once("error", reject);
      child.once("exit", (code) => code && reject(new Error(`Server exited with ${code}`)));
    });

    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "http://127.0.0.1:1420" });
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    const bootstrapReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrapReply;
    const previewPush = waitFor(socket, messages, (message) => message.channel === "preview.command");
    const previewReply = waitFor(socket, messages, (message) => message.id === 90);
    socket.send(JSON.stringify({ id: 90, method: "preview.agentCommand", params: { action: "open", url: "localhost:4173", panelWidth: 1200, viewportWidth: 1440, viewportHeight: 900 } }));
    expect((await previewReply).error).toBeUndefined();
    expect((await previewPush).payload).toMatchObject({ action: "open", url: "http://localhost:4173/", panelWidth: 1200 });
    const createReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const created = await createReply;
    const threadId = ((created.result as { thread: { threadId: string } }).thread).threadId;

    const modelUpdated = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { options?: Array<{ id: string; currentValue: unknown }> } } | undefined;
      return event?.type === "ConfigOptionsReplaced" && event.payload?.options?.some((option) => option.id === "model" && option.currentValue === "kimi-k3-fast") === true;
    });
    socket.send(JSON.stringify({ id: 20, method: "threads.setConfigOption", params: { threadId, configId: "model", value: "kimi-k3-fast" } }));
    expect(((await modelUpdated).payload as { payload: { options: Array<{ id: string }> } }).payload.options.some((option) => option.id === "thinking")).toBe(false);

    const modeUpdated = waitFor(socket, messages, (message) => (message.payload as { type?: string; payload?: { modeId?: string } } | undefined)?.type === "ModeChanged" && (message.payload as { payload: { modeId: string } }).payload.modeId === "auto");
    socket.send(JSON.stringify({ id: 21, method: "threads.setConfigOption", params: { threadId, configId: "mode", value: "auto" } }));
    await modeUpdated;

    const permissionRequest = waitFor(socket, messages, (message) => {
      const event = message.payload as Record<string, unknown> | undefined;
      return message.channel === "orchestration.domainEvent" && event?.type === "ApprovalRequested";
    });
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Update the README", mentions: ["package.json"], images: [{ name: "pixel.png", mimeType: "image/png", data: "AQID" }] } }));
    const permissionMessage = await permissionRequest;
    const permission = (permissionMessage.payload as { payload: { requestId: string } }).payload;
    const turnCompleted = waitFor(socket, messages, (message) => message.channel === "orchestration.domainEvent" && (message.payload as Record<string, unknown> | undefined)?.type === "TurnCompleted");
    socket.send(JSON.stringify({ id: 4, method: "threads.respondToRequest", params: { threadId, requestId: permission.requestId, optionId: "allow-once" } }));
    const completed = await turnCompleted;
    expect((completed.payload as { payload: { stopReason: string } }).payload.stopReason).toBe("end_turn");
    expect(messages.some((message) => {
      const payload = message.payload as { type?: string } | undefined;
      return message.channel === "orchestration.domainEvent" && payload?.type === "ToolCallPatched";
    })).toBe(true);
    const eventTypes = messages.filter((message) => message.channel === "orchestration.domainEvent").map((message) => (message.payload as { type: string }).type);
    expect(eventTypes).toEqual(expect.arrayContaining(["MessageDelta", "PlanReplaced", "ToolCallCreated", "ToolCallPatched", "ApprovalRequested", "ApprovalResolved", "TurnCompleted"]));
    const messageRoles = messages.filter((message) => (message.payload as { type?: string } | undefined)?.type === "MessageDelta").map((message) => ((message.payload as { payload: { role: string } }).payload).role);
    expect(messageRoles).toEqual(expect.arrayContaining(["thought", "assistant"]));

    const standaloneReply = waitFor(socket, messages, (message) => message.id === 22);
    socket.send(JSON.stringify({ id: 22, method: "threads.create", params: { standalone: true } }));
    const standalone = ((await standaloneReply).result as { thread: { cwd: string; kind: string; title: string } }).thread;
    expect(standalone).toMatchObject({ cwd: join(dataHome, "runtime", "chats"), kind: "chat", title: "New chat" });
    socket.close();
  });

  it("serves draft config defaults and applies draft config during threads.create", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-config-"));
    await writeFile(join(dataHome, "runtime-defaults.json"), JSON.stringify({ configOptions: [{
      id: "thinking", name: "Thinking", type: "select", category: "thought_level", currentValue: "legacy", options: [{ value: "legacy", name: "Legacy" }],
    }] }));
    await launchServer(serverPath, "45125", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45125", messages);

    const defaultsReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "runtime.configDefaults", params: {} }));
    const defaults = ((await defaultsReply).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(defaults.some((option) => option.id === "model" && option.currentValue === "kimi-k3")).toBe(true);
    expect(defaults.some((option) => option.id === "mode")).toBe(true);
    expect(defaults.some((option) => option.id === "thinking")).toBe(true);
    expect(defaults.some((option) => option.currentValue === "legacy")).toBe(false);

    const listReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.list", params: {} }));
    const listed = (await listReply).result as { runtimeSessions: Array<{ cwd: string }> };
    expect(listed.runtimeSessions.some((session) => /config-probe/.test(session.cwd))).toBe(false);

    const createReply = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.create", params: { cwd: process.cwd(), config: { model: "kimi-k3-fast", mode: "auto", thinking: "off", bogus: "", unknown: "value" } } }));
    const thread = ((await createReply).result as { thread: { threadId: string; configOptions: Array<{ id: string; currentValue: unknown }> } }).thread;
    expect(thread.configOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3-fast");
    expect(thread.configOptions.find((option) => option.id === "mode")?.currentValue).toBe("auto");
    expect(thread.configOptions.some((option) => option.id === "thinking")).toBe(false);

    const updatedDefaults = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "runtime.configDefaults", params: {} }));
    const cached = ((await updatedDefaults).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(cached.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3-fast");
    expect(cached.find((option) => option.id === "mode")?.currentValue).toBe("auto");
    socket.close();
  });

  it("rehydrates the same thread projection after a server restart", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-restart-"));
    const first = await launchServer(serverPath, "45118", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45118", firstMessages);

    const bootstrap = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const createdReply = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const created = await createdReply;
    const threadId = (created.result as { thread: { threadId: string } }).thread.threadId;
    const permission = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    firstSocket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Persist this turn" } }));
    const request = (await permission).payload as { payload: { requestId: string } };
    const completed = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCompleted");
    firstSocket.send(JSON.stringify({ id: 4, method: "threads.respondToRequest", params: { threadId, requestId: request.payload.requestId, optionId: "allow-once" } }));
    await completed;
    const listReply = waitFor(firstSocket, firstMessages, (message) => message.id === 5);
    firstSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    const beforeRestart = (await listReply).result as { threads: unknown[] };
    firstSocket.close();
    first.kill();

    await launchServer(serverPath, "45119", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45119", secondMessages);
    await waitFor(secondSocket, secondMessages, (message) => message.channel === "server.welcome");
    const restartedList = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    expect(((await restartedList).result as { threads: unknown[] }).threads).toEqual(beforeRestart.threads);

    const configAfterRestart = waitFor(secondSocket, secondMessages, (message) => message.id === 50);
    secondSocket.send(JSON.stringify({ id: 50, method: "threads.setConfigOption", params: { threadId, configId: "mode", value: "yolo" } }));
    const configReply = await configAfterRestart;
    expect(configReply.error).toBeUndefined();
    expect(((configReply.result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions.find((option) => option.id === "mode"))?.currentValue).toBe("yolo");

    const resumedApproval = waitFor(secondSocket, secondMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    secondSocket.send(JSON.stringify({ id: 6, method: "threads.sendTurn", params: { threadId, text: "Continue after restart" } }));
    const resumedRequest = (await resumedApproval).payload as { payload: { requestId: string } };
    const resumedCompleted = waitFor(secondSocket, secondMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCompleted");
    secondSocket.send(JSON.stringify({ id: 7, method: "threads.respondToRequest", params: { threadId, requestId: resumedRequest.payload.requestId, optionId: "allow-once" } }));
    await resumedCompleted;
    secondSocket.close();
  }, 30_000);

  it("restores queued text prompts after a server restart", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-queue-restart-"));
    const first = await launchServer(serverPath, "45126", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45126", firstMessages);
    const bootstrap = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const create = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await create).result as { thread: { threadId: string } }).thread.threadId;
    const approval = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    firstSocket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Keep working" } }));
    await approval;
    const queued = waitFor(firstSocket, firstMessages, (message) => message.id === 4);
    firstSocket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "Run this after restart" } }));
    await queued;
    firstSocket.close();
    first.kill();

    await launchServer(serverPath, "45127", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45127", secondMessages);
    const list = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    const restored = ((await list).result as { threads: Array<{ queue: Array<{ text: string }> }> }).threads[0]?.queue;
    expect(restored).toEqual([expect.objectContaining({ text: "Run this after restart" })]);
    secondSocket.close();
  }, 30_000);

  it("persists approval cancellation before a cancelled turn", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-cancel-"));
    await launchServer(serverPath, "45120", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45120", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const create = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await create).result as { thread: { threadId: string } }).thread.threadId;
    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Cancel at permission" } }));
    await approval;
    const cancelled = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCancelled");
    socket.send(JSON.stringify({ id: 4, method: "threads.interruptTurn", params: { threadId } }));
    await cancelled;
    const domainTypes = messages.filter((message) => message.channel === "orchestration.domainEvent").map((message) => (message.payload as { type: string }).type);
    expect(domainTypes.indexOf("ApprovalResolved")).toBeLessThan(domainTypes.indexOf("TurnCancelled"));
    socket.close();
  });

  it("queues prompts sequentially and supports chat rename and deletion", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-queue-"));
    await launchServer(serverPath, "45123", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45123", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const create = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await create).result as { thread: { threadId: string } }).thread.threadId;

    const firstApproval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "First task" } }));
    const firstRequest = (await firstApproval).payload as { payload: { requestId: string } };
    const queuedUpdate = waitFor(socket, messages, (message) => {
      const payload = message.payload as { queue?: Array<{ text: string }> } | undefined;
      return message.channel === "thread.queueUpdated" && payload?.queue?.some((item) => item.text === "Second task") === true;
    });
    const queuedReply = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "Second task", mode: "queue" } }));
    await queuedUpdate;
    const queuedId = ((await queuedReply).result as { queuedId: string }).queuedId;
    expect(messages.some((message) => (message.payload as { type?: string; payload?: { text?: string } } | undefined)?.type === "TurnStarted" && (message.payload as { payload: { text?: string } }).payload.text === "Second task")).toBe(false);

    const editedUpdate = waitFor(socket, messages, (message) => {
      const payload = message.payload as { queue?: Array<{ text: string }> } | undefined;
      return message.channel === "thread.queueUpdated" && payload?.queue?.some((item) => item.text === "Edited second task") === true;
    });
    socket.send(JSON.stringify({ id: 5, method: "threads.updateQueuedTurn", params: { threadId, queuedId, text: "Edited second task" } }));
    await editedUpdate;

    const secondStarted = waitFor(socket, messages, (message) => (message.payload as { type?: string; payload?: { text?: string } } | undefined)?.type === "TurnStarted" && (message.payload as { payload: { text?: string } }).payload.text === "Edited second task");
    const secondQueueCleared = waitFor(socket, messages, (message) => {
      const payload = message.payload as { queue?: Array<{ text: string }> } | undefined;
      const secondHasStarted = messages.some((candidate) => (candidate.payload as { type?: string; payload?: { text?: string } } | undefined)?.type === "TurnStarted" && (candidate.payload as { payload: { text?: string } }).payload.text === "Edited second task");
      return secondHasStarted && message.channel === "thread.queueUpdated" && payload?.queue?.some((item) => item.text === "Edited second task") === false;
    });
    socket.send(JSON.stringify({ id: 6, method: "threads.respondToRequest", params: { threadId, requestId: firstRequest.payload.requestId, optionId: "allow-once" } }));
    const startedMessage = await secondStarted;
    const secondTurn = startedMessage.payload as { payload: { turnId: string } };
    await secondQueueCleared;
    const queuedIndex = messages.findIndex((message) => message.channel === "thread.queueUpdated" && (message.payload as { queue?: Array<{ text: string }> }).queue?.some((item) => item.text === "Edited second task"));
    const startedIndex = messages.findIndex((message) => (message.payload as { type?: string; payload?: { text?: string } } | undefined)?.type === "TurnStarted" && (message.payload as { payload: { text?: string } }).payload.text === "Edited second task");
    expect(messages.slice(queuedIndex, startedIndex).some((message) => message.channel === "thread.queueUpdated" && !(message.payload as { queue?: Array<{ text: string }> }).queue?.some((item) => item.text === "Edited second task"))).toBe(false);
    const secondApproval = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { requestId?: string } } | undefined;
      return event?.type === "ApprovalRequested" && event.payload?.requestId !== firstRequest.payload.requestId;
    });
    const secondRequest = (await secondApproval).payload as { payload: { requestId: string } };
    const secondCompleted = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.turnId === secondTurn.payload.turnId;
    });
    socket.send(JSON.stringify({ id: 7, method: "threads.respondToRequest", params: { threadId, requestId: secondRequest.payload.requestId, optionId: "allow-once" } }));
    await secondCompleted;

    const renamed = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ThreadRenamed");
    socket.send(JSON.stringify({ id: 8, method: "threads.rename", params: { threadId, title: "Queued release" } }));
    await renamed;
    const deleted = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ThreadDeleted");
    socket.send(JSON.stringify({ id: 9, method: "threads.delete", params: { threadId } }));
    await deleted;
    const list = waitFor(socket, messages, (message) => message.id === 10);
    socket.send(JSON.stringify({ id: 10, method: "threads.list", params: {} }));
    expect(((await list).result as { threads: unknown[] }).threads).toEqual([]);
    socket.close();
  });

  it("steers a queued prompt by cancelling the active turn and prioritizing it", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-steer-"));
    await launchServer(serverPath, "45124", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45124", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const create = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await create).result as { thread: { threadId: string } }).thread.threadId;
    const firstApproval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Initial direction" } }));
    const firstRequest = (await firstApproval).payload as { payload: { requestId: string } };
    const queuedReply = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "New direction", mode: "queue" } }));
    const queuedId = ((await queuedReply).result as { queuedId: string }).queuedId;
    const cancelled = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCancelled");
    const steeredStarted = waitFor(socket, messages, (message) => (message.payload as { type?: string; payload?: { text?: string } } | undefined)?.type === "TurnStarted" && (message.payload as { payload: { text?: string } }).payload.text === "New direction");
    socket.send(JSON.stringify({ id: 5, method: "threads.steerQueuedTurn", params: { threadId, queuedId } }));
    await cancelled;
    await steeredStarted;
    const steeredApproval = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { requestId?: string } } | undefined;
      return event?.type === "ApprovalRequested" && event.payload?.requestId !== firstRequest.payload.requestId;
    });
    const request = (await steeredApproval).payload as { payload: { requestId: string } };
    socket.send(JSON.stringify({ id: 6, method: "threads.respondToRequest", params: { threadId, requestId: request.payload.requestId, optionId: "allow-once" } }));
    await waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCompleted");
    socket.close();
  });

  it("bootstraps onboarding when Kimi CLI is not installed", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-onboarding-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-onboarding-"));
    const child = spawn(process.execPath, ["--import", "tsx", serverPath], {
      env: { ...process.env, KIMI_SERVER_PORT: "45121", KIMI_DESKTOP_HOME: dataHome, KIMI_CODE_HOME: kimiHome, KIMI_BINARY: join(kimiHome, "missing-kimi.exe") },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    children.push(child);
    await waitForServer(child);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45121", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    const result = (await bootstrap).result as { initialize?: unknown; auth: { installed: boolean; authenticated: boolean } };
    expect(result.initialize).toBeUndefined();
    expect(result.auth).toMatchObject({ installed: false, authenticated: false });
    socket.close();
  });

  it("logs out only the temporary Kimi OAuth credential", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-logout-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-logout-"));
    await mkdir(join(kimiHome, "credentials"));
    const oauth = join(kimiHome, "credentials", "kimi-code.json");
    const unrelated = join(kimiHome, "credentials", "mcp-auth.json");
    await writeFile(oauth, "oauth");
    await writeFile(unrelated, "mcp");
    await launchServer(serverPath, "45122", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45122", messages);
    const reply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "auth.logout", params: {} }));
    expect(((await reply).result as { authenticated: boolean }).authenticated).toBe(false);
    await expect(access(oauth)).rejects.toThrow();
    await expect(access(unrelated)).resolves.toBeUndefined();
    socket.close();
  });
});

async function launchServer(serverPath: string, port: string, dataHome: string, children: ReturnType<typeof spawn>[], extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", serverPath], {
    env: { ...process.env, KIMI_FAKE: "1", KIMI_SERVER_PORT: port, KIMI_DESKTOP_HOME: dataHome, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  await waitForServer(child);
  return child;
}

async function waitForServer(child: ReturnType<typeof spawn>) {
  await new Promise<void>((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error("Server stdout is unavailable"));
      return;
    }
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => chunk.includes("listening") && resolve());
    child.once("error", reject);
    child.once("exit", (code) => code && reject(new Error(`Server exited with ${code}`)));
  });
}

async function connect(port: string, messages: Array<Record<string, unknown>>): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "http://127.0.0.1:1420" });
  socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as Record<string, unknown>));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}

function waitFor(socket: WebSocket, messages: Array<Record<string, unknown>>, predicate: (message: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const existing = messages.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error(`Timed out waiting for WebSocket message; recent=${JSON.stringify(messages.slice(-5))}`));
    }, 5_000);
    const onMessage = (data: RawData) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}
