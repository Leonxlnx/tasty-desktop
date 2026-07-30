import { execFile, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { EventStore } from "../src/event-store.js";
import { ScheduleStore } from "../src/schedule-store.js";
import { findGitBinary } from "../src/checkpoint-reactor.js";

const exec = promisify(execFile);

describe("orchestration server", () => {
  const children: ReturnType<typeof spawn>[] = [];

  afterEach(() => children.splice(0).forEach((child) => child.kill()));

  it("prefers KIMI_DESKTOP_HOME over legacy TASTY_HOME", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-home-"));
    const legacyHome = await mkdtemp(join(tmpdir(), "tasty-server-home-"));
    await launchServer(serverPath, "45215", dataHome, children, { TASTY_HOME: legacyHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45215", messages);

    const createReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { standalone: true } }));
    const created = ((await createReply).result as { thread: { cwd: string } }).thread;
    expect(created.cwd).toBe(join(await realpath(dataHome), "runtime", "chats"));
    socket.close();
  });

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
    const createdThread = (created.result as { thread: { threadId: string; sessionId: string } }).thread;
    const threadId = createdThread.threadId;
    expect((created.result as { thread: { provider: string } }).thread.provider).toBe("kimi");
    const goalReply = waitFor(socket, messages, (message) => message.id === 92);
    socket.send(JSON.stringify({ id: 92, method: "threads.setGoal", params: { threadId, objective: "Ship the provider foundation" } }));
    expect(((await goalReply).result as { thread: { goal: { objective: string } } }).thread.goal.objective).toBe("Ship the provider foundation");
    const sideReply = waitFor(socket, messages, (message) => message.id === 93);
    socket.send(JSON.stringify({ id: 93, method: "threads.createSide", params: { threadId } }));
    expect(((await sideReply).result as { thread: { provider: string; parentThreadId: string; cwd: string } }).thread).toMatchObject({
      provider: "kimi",
      parentThreadId: threadId,
      cwd: process.cwd(),
    });
    const inspectReply = waitFor(socket, messages, (message) => message.id === 94);
    socket.send(JSON.stringify({ id: 94, method: "subagents.inspect", params: { threadId, agentThreadId: "unlinked-agent" } }));
    expect(((await inspectReply).error as { message?: string } | undefined)?.message).toMatch(/not linked/i);
    const duplicateResumeReply = waitFor(socket, messages, (message) => message.id === 91);
    socket.send(JSON.stringify({
      id: 91,
      method: "threads.resume",
      params: { threadId: `${threadId}-duplicate`, sessionId: createdThread.sessionId, cwd: process.cwd(), replay: false },
    }));
    expect(((await duplicateResumeReply).error as { message?: string } | undefined)?.message).toMatch(/already owned/i);

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
    expect(standalone).toMatchObject({ cwd: join(await realpath(dataHome), "runtime", "chats"), kind: "chat", title: "New chat" });
    socket.close();
  });

  it("serves draft config defaults and applies draft config during threads.create", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const canonicalDataHome = await mkdtemp(join(tmpdir(), "kimi-server-config-"));
    const aliasRoot = await mkdtemp(join(tmpdir(), "kimi-server-config-alias-"));
    const dataHome = join(aliasRoot, "desktop-home");
    await symlink(canonicalDataHome, dataHome, process.platform === "win32" ? "junction" : "dir");
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

    const standaloneReply = waitFor(socket, messages, (message) => message.id === 30);
    socket.send(JSON.stringify({ id: 30, method: "threads.create", params: { standalone: true } }));
    const standalone = ((await standaloneReply).result as { thread: { sessionId: string } }).thread;
    const runtimeReply = waitFor(socket, messages, (message) => message.id === 31);
    socket.send(JSON.stringify({ id: 31, method: "threads.list", params: {} }));
    const runtimeSessions = ((await runtimeReply).result as { runtimeSessions: Array<{ sessionId: string; kind: string }> }).runtimeSessions;
    expect(runtimeSessions).toContainEqual(expect.objectContaining({ sessionId: standalone.sessionId, kind: "chat" }));
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
    const rejectedImage = waitFor(socket, messages, (message) => message.id === 40);
    socket.send(JSON.stringify({
      id: 40,
      method: "threads.sendTurn",
      params: { threadId, text: "Queued image", images: [{ name: "pixel.png", mimeType: "image/png", data: "AQID" }] },
    }));
    expect((await rejectedImage).error).toMatchObject({ message: expect.stringMatching(/image prompts cannot be queued/i) });
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

  it("restarts ACP and resumes the thread after the runtime connection closes", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-acp-restart-"));
    await launchServer(serverPath, "45127", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45127", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const created = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;

    const failed = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { stopReason?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.stopReason === "error";
    });
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "__CLOSE_ACP__" } }));
    const failedEvent = await failed;
    expect((failedEvent.payload as { payload?: { error?: string } }).payload?.error).toMatch(/closed|connection/i);

    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "Continue after reconnect" } }));
    const request = (await approval).payload as { payload: { requestId: string } };
    const completed = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { stopReason?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.stopReason === "end_turn";
    });
    socket.send(JSON.stringify({ id: 5, method: "threads.respondToRequest", params: { threadId, requestId: request.payload.requestId, optionId: "allow-once" } }));
    await completed;
    socket.close();
  });

  it("creates explicit isolated worktree chats and archives them reversibly", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "tasty-server-worktree-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "tasty-server-worktree-source-"));
    await exec("git", ["-C", workspace, "init"]);
    await exec("git", ["-C", workspace, "config", "user.name", "Test"]);
    await exec("git", ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workspace, "tracked.txt"), "base\n", "utf8");
    await exec("git", ["-C", workspace, "add", "."]);
    await exec("git", ["-C", workspace, "commit", "-m", "base"]);
    await launchServer(serverPath, "45214", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45214", messages);

    const createdReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: workspace, isolate: true } }));
    const created = ((await createdReply).result as { thread: { threadId: string; cwd: string; worktree: { sourceCwd: string; branch: string } } }).thread;
    expect(created.cwd).toContain(join(await realpath(dataHome), "worktrees"));
    expect(created.worktree).toMatchObject({ sourceCwd: await realpath(workspace), branch: expect.stringMatching(/^kimi\//) });
    await expect(access(join(created.cwd, "tracked.txt"))).resolves.toBeUndefined();

    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId: created.threadId, text: "Keep this active" } }));
    const requestId = ((await approval).payload as { payload: { requestId: string } }).payload.requestId;
    const blocked = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.archive", params: { threadId: created.threadId, archived: true } }));
    expect((await blocked).error).toMatchObject({ message: expect.stringMatching(/active work/i) });

    const completed = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCompleted");
    socket.send(JSON.stringify({ id: 4, method: "threads.respondToRequest", params: { threadId: created.threadId, requestId, optionId: "allow-once" } }));
    await completed;
    const archived = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.archive", params: { threadId: created.threadId, archived: true } }));
    expect(((await archived).result as { thread: { archivedAt?: string } }).thread.archivedAt).toBeTruthy();
    const rejected = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "threads.sendTurn", params: { threadId: created.threadId, text: "Must restore first" } }));
    expect((await rejected).error).toMatchObject({ message: expect.stringMatching(/restore/i) });
    const restored = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "threads.archive", params: { threadId: created.threadId, archived: false } }));
    expect(((await restored).result as { thread: { archivedAt?: string } }).thread.archivedAt).toBeUndefined();
    socket.close();
  }, 30_000);

  it("self-heals forgotten ACP sessions and serializes config projection updates", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-session-heal-"));
    await launchServer(serverPath, "45133", dataHome, children, {
      KIMI_FAKE_UNKNOWN_CONFIG_ONCE: "1",
      KIMI_FAKE_UNKNOWN_PROMPT_ONCE: "1",
      KIMI_FAKE_CONFIG_DELAY_MS: "100",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45133", messages);
    const createdReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await createdReply).result as { thread: { threadId: string } }).thread.threadId;

    const modelReply = waitFor(socket, messages, (message) => message.id === 2);
    const staleThinkingReply = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 2, method: "threads.setConfigOption", params: { threadId, configId: "model", value: "kimi-k3-fast" } }));
    socket.send(JSON.stringify({ id: 3, method: "threads.setConfigOption", params: { threadId, configId: "thinking", value: "off" } }));
    const model = await modelReply;
    expect(model.error).toBeUndefined();
    expect(((model.result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions.find((option) => option.id === "model"))?.currentValue).toBe("kimi-k3-fast");
    expect((await staleThinkingReply).error).toMatchObject({ message: expect.stringMatching(/not supported/i) });

    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "Continue after forgotten session" } }));
    const request = (await approval).payload as { payload: { requestId: string } };
    const completed = waitFor(socket, messages, (message) => (message.payload as { type?: string; payload?: { stopReason?: string } } | undefined)?.type === "TurnCompleted"
      && (message.payload as { payload?: { stopReason?: string } }).payload?.stopReason === "end_turn");
    socket.send(JSON.stringify({ id: 5, method: "threads.respondToRequest", params: { threadId, requestId: request.payload.requestId, optionId: "allow-once" } }));
    await completed;
    expect(messages.filter((message) => (message.payload as { type?: string } | undefined)?.type === "TurnStarted")).toHaveLength(1);
    expect(messages.filter((message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested")).toHaveLength(1);
    socket.close();
  });

  it("honors an explicit empty default workspace and atomically pauses sends for updates", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-update-lock-"));
    await launchServer(serverPath, "45134", dataHome, children, { KIMI_DEFAULT_CWD: "" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45134", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    expect((await bootstrap).result).toMatchObject({ defaultCwd: "" });
    const createdReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await createdReply).result as { thread: { threadId: string } }).thread.threadId;

    const prepared = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    const confirmed = waitFor(socket, messages, (message) => message.id === 30);
    socket.send(JSON.stringify({ id: 30, method: "env.confirmUpdate", params: {} }));
    expect((await confirmed).result).toEqual({ ready: true });
    const blockedSend = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "Must wait" } }));
    expect((await blockedSend).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });
    const cancelled = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "env.cancelUpdate", params: {} }));
    expect((await cancelled).result).toEqual({ cancelled: true });

    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 6, method: "threads.sendTurn", params: { threadId, text: "Run after update cancellation" } }));
    await approval;
    const refused = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "env.prepareUpdate", params: {} }));
    expect((await refused).error).toMatchObject({ message: expect.stringMatching(/activeTurns=1|approvals=1/) });
    const stopped = waitFor(socket, messages, (message) => message.id === 8);
    socket.send(JSON.stringify({ id: 8, method: "threads.interruptTurn", params: { threadId } }));
    expect((await stopped).error).toBeUndefined();
    socket.close();
  });

  it("keeps local thread history and queue controls available when ACP cannot start", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-local-recovery-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-local-recovery-"));
    await mkdir(join(kimiHome, "credentials"), { recursive: true });
    await writeFile(join(kimiHome, "credentials", "kimi-code.json"), "authenticated");
    const first = await launchServer(serverPath, "45210", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45210", firstMessages);
    const createdReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await createdReply).result as { thread: { threadId: string } }).thread.threadId;
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    await launchServer(serverPath, "45211", dataHome, children, {
      KIMI_FAKE: "0",
      KIMI_CODE_HOME: kimiHome,
      KIMI_BINARY: join(dataHome, "missing-kimi.exe"),
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45211", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    expect(await bootstrap).toMatchObject({
      result: {
        auth: { authenticated: true },
        degraded: true,
        runtimeError: expect.stringMatching(/not installed|connection closed|missing-kimi|ENOENT|spawn/i),
      },
    });
    const listed = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.list", params: {} }));
    expect(((await listed).result as { threads: Array<{ threadId: string }> }).threads).toContainEqual(expect.objectContaining({ threadId }));

    const renamed = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.rename", params: { threadId, title: "Offline recovery" } }));
    expect(((await renamed).result as { thread: { title: string } }).thread.title).toBe("Offline recovery");
    const checkpoints = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "checkpoints.list", params: { threadId } }));
    expect((await checkpoints).result).toEqual({ checkpoints: [] });

    const firstQueued = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.sendTurn", params: { threadId, text: "Keep this queued" } }));
    const firstQueuedId = ((await firstQueued).result as { queuedId: string }).queuedId;
    const secondQueued = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "threads.sendTurn", params: { threadId, text: "Edit this queued prompt" } }));
    const secondQueuedId = ((await secondQueued).result as { queuedId: string }).queuedId;
    const updated = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "threads.updateQueuedTurn", params: { threadId, queuedId: secondQueuedId, text: "Edited while offline" } }));
    expect(((await updated).result as { queued: Array<{ text: string }> }).queued).toContainEqual(expect.objectContaining({ text: "Edited while offline" }));
    const removed = waitFor(socket, messages, (message) => message.id === 8);
    socket.send(JSON.stringify({ id: 8, method: "threads.removeQueuedTurn", params: { threadId, queuedId: secondQueuedId } }));
    expect((await removed).error).toBeUndefined();
    const cleared = waitFor(socket, messages, (message) => message.id === 9);
    socket.send(JSON.stringify({ id: 9, method: "threads.removeQueuedTurn", params: { threadId, queuedId: firstQueuedId } }));
    expect((await cleared).error).toBeUndefined();
    const deleted = waitFor(socket, messages, (message) => message.id === 10);
    socket.send(JSON.stringify({ id: 10, method: "threads.delete", params: { threadId } }));
    expect((await deleted).error).toBeUndefined();
    socket.close();
  }, 30_000);

  it("owns update preparation per socket and blocks active terminal work", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-update-owner-"));
    await launchServer(serverPath, "45212", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const secondMessages: Array<Record<string, unknown>> = [];
    const first = await connect("45212", firstMessages);
    const second = await connect("45212", secondMessages);

    const started = waitFor(first, firstMessages, (message) => message.id === 1);
    first.send(JSON.stringify({ id: 1, method: "terminal.start", params: { cwd: process.cwd() } }));
    const sessionId = ((await started).result as { sessionId: string }).sessionId;
    const blockedByTerminal = waitFor(second, secondMessages, (message) => message.id === 2);
    second.send(JSON.stringify({ id: 2, method: "env.prepareUpdate", params: {} }));
    expect((await blockedByTerminal).error).toMatchObject({ message: expect.stringMatching(/terminals=1/) });
    const stopped = waitFor(first, firstMessages, (message) => message.id === 3);
    first.send(JSON.stringify({ id: 3, method: "terminal.stop", params: { sessionId } }));
    await stopped;

    const prepared = waitFor(second, secondMessages, (message) => message.id === 4);
    second.send(JSON.stringify({ id: 4, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    const foreignConfirm = waitFor(first, firstMessages, (message) => message.id === 40);
    first.send(JSON.stringify({ id: 40, method: "env.confirmUpdate", params: {} }));
    expect((await foreignConfirm).error).toMatchObject({ message: expect.stringMatching(/only the app window/i) });
    const ownerConfirm = waitFor(second, secondMessages, (message) => message.id === 41);
    second.send(JSON.stringify({ id: 41, method: "env.confirmUpdate", params: {} }));
    expect((await ownerConfirm).result).toEqual({ ready: true });
    const foreignCancel = waitFor(first, firstMessages, (message) => message.id === 5);
    first.send(JSON.stringify({ id: 5, method: "env.cancelUpdate", params: {} }));
    expect((await foreignCancel).error).toMatchObject({ message: expect.stringMatching(/only the app window/i) });
    const blockedStart = waitFor(first, firstMessages, (message) => message.id === 6);
    first.send(JSON.stringify({ id: 6, method: "terminal.start", params: { cwd: process.cwd() } }));
    expect((await blockedStart).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });
    const blockedWrite = waitFor(first, firstMessages, (message) => message.id === 7);
    first.send(JSON.stringify({ id: 7, method: "terminal.write", params: { sessionId, command: "echo blocked" } }));
    expect((await blockedWrite).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });

    const ownerClosed = new Promise<void>((resolve) => second.once("close", resolve));
    second.close();
    await ownerClosed;
    const restarted = waitFor(first, firstMessages, (message) => message.id === 8);
    first.send(JSON.stringify({ id: 8, method: "terminal.start", params: { cwd: process.cwd() } }));
    const restartedSession = ((await restarted).result as { sessionId: string }).sessionId;
    const finalStop = waitFor(first, firstMessages, (message) => message.id === 9);
    first.send(JSON.stringify({ id: 9, method: "terminal.stop", params: { sessionId: restartedSession } }));
    await finalStop;
    first.close();
  });

  it("admits prompts after pending cross-window config writes", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-config-prompt-order-"));
    await launchServer(serverPath, "45213", dataHome, children, { KIMI_FAKE_CONFIG_DELAY_MS: "300" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const secondMessages: Array<Record<string, unknown>> = [];
    const first = await connect("45213", firstMessages);
    const second = await connect("45213", secondMessages);
    const created = waitFor(first, firstMessages, (message) => message.id === 1);
    first.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const replies: string[] = [];
    first.on("message", (data) => {
      if ((JSON.parse(data.toString()) as { id?: number }).id === 2) replies.push("config");
    });
    second.on("message", (data) => {
      if ((JSON.parse(data.toString()) as { id?: number }).id === 3) replies.push("prompt");
    });

    const config = waitFor(first, firstMessages, (message) => message.id === 2);
    first.send(JSON.stringify({ id: 2, method: "threads.setConfigOption", params: { threadId, configId: "model", value: "kimi-k3-fast" } }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const prompt = waitFor(second, secondMessages, (message) => message.id === 3);
    second.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Run after config" } }));
    await prompt;
    await config;
    expect(replies).toEqual(["config", "prompt"]);
    first.close();
    second.close();
  });

  it("does not start an admitted queue head after remove, clear, or stop", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const actions = ["remove", "clear", "stop"] as const;
    for (const [index, action] of actions.entries()) {
      const dataHome = await mkdtemp(join(tmpdir(), `kimi-server-admission-${action}-`));
      const firstPort = String(45135 + (index * 2));
      const secondPort = String(45136 + (index * 2));
      const first = await launchServer(serverPath, firstPort, dataHome, children);
      const firstMessages: Array<Record<string, unknown>> = [];
      const firstSocket = await connect(firstPort, firstMessages);
      const created = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
      firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
      const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
      firstSocket.close();
      const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
      first.kill();
      await firstExited;

      await launchServer(serverPath, secondPort, dataHome, children, { KIMI_FAKE_INITIALIZE_DELAY_MS: "400" });
      const messages: Array<Record<string, unknown>> = [];
      const socket = await connect(secondPort, messages);
      const queued = waitFor(socket, messages, (message) => message.id === 2);
      socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: `Must not start: ${action}` } }));
      const queuedId = ((await queued).result as { queuedId: string }).queuedId;
      const cancelled = waitFor(socket, messages, (message) => message.id === 3);
      socket.send(JSON.stringify(action === "remove"
        ? { id: 3, method: "threads.removeQueuedTurn", params: { threadId, queuedId } }
        : action === "clear"
          ? { id: 3, method: "threads.clearQueue", params: { threadId } }
          : { id: 3, method: "threads.interruptTurn", params: { threadId, clearQueue: false } }));
      expect((await cancelled).error).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(messages.some((message) => {
        const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
        return event?.type === "TurnStarted" && event.payload?.text === `Must not start: ${action}`;
      })).toBe(false);
      const listed = waitFor(socket, messages, (message) => message.id === 4);
      socket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
      const thread = ((await listed).result as { threads: Array<{ threadId: string; running: boolean; queue: unknown[] }> })
        .threads.find((candidate) => candidate.threadId === threadId);
      expect(thread).toMatchObject({ running: false, queue: [] });
      socket.close();
    }
  }, 30_000);

  it("persists automatic background-task registration before the foreground turn settles", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-mid-turn-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-mid-turn-"));
    const first = await launchServer(serverPath, "45141", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45141", firstMessages);
    const bootstrap = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const registered = waitFor(firstSocket, firstMessages, (message) => {
      const event = message.payload as { type?: string } | undefined;
      return event?.type === "BackgroundTaskRegistered";
    });
    firstSocket.send(JSON.stringify({
      id: 3,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_PENDING__ __BACKGROUND_TASK_STALL__" },
    }));
    await registered;
    expect(firstMessages.some((message) => (message.payload as { type?: string } | undefined)?.type === "TurnCompleted")).toBe(false);
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    await launchServer(serverPath, "45142", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45142", secondMessages);
    const listed = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    const restored = ((await listed).result as { threads: Array<{
      threadId: string;
      backgroundTasks: Array<{ taskId: string; status: string }>;
    }> }).threads.find((candidate) => candidate.threadId === threadId);
    expect(restored?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: "bash-build1", status: "running" }),
    ]);
    secondSocket.close();
  }, 20_000);

  it("durably retries a background report whose fire-and-forget prompt rejects immediately", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-report-retry-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-report-retry-"));
    const first = await launchServer(serverPath, "45143", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_BACKGROUND_REPORT_REJECT_ONCE: "1",
    });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45143", firstMessages);
    const bootstrap = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const automatedTurn = waitFor(firstSocket, firstMessages, (message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    });
    firstSocket.send(JSON.stringify({
      id: 3,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    }));
    const started = await automatedTurn;
    const automated = (started.payload as { payload: { turnId: string; sourceQueuedId: string } }).payload;
    const failed = await waitFor(firstSocket, firstMessages, (message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string; stopReason?: string } } | undefined;
      return event?.type === "TurnCompleted"
        && event.payload?.turnId === automated.turnId
        && event.payload.stopReason === "error";
    });
    const failedSeq = Number(failed.seq);
    const queuedAgain = await waitFor(firstSocket, firstMessages, (message) => {
      const payload = message.payload as { queue?: Array<{ queuedId?: string; origin?: string }> } | undefined;
      return message.channel === "thread.queueUpdated"
        && Number(message.seq) > failedSeq
        && payload?.queue?.some((item) => item.origin === "background_task" && item.queuedId === automated.sourceQueuedId) === true;
    });
    expect((queuedAgain.payload as { queue: unknown[] }).queue).toHaveLength(1);
    const firstListed = waitFor(firstSocket, firstMessages, (message) => message.id === 30);
    firstSocket.send(JSON.stringify({ id: 30, method: "threads.list", params: {} }));
    const beforeRestart = ((await firstListed).result as { threads: Array<{ threadId: string; queue: Array<{ queuedId: string }> }> })
      .threads.find((candidate) => candidate.threadId === threadId);
    expect(beforeRestart?.queue).toEqual([expect.objectContaining({ queuedId: automated.sourceQueuedId })]);
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    await launchServer(serverPath, "45144", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45144", secondMessages);
    const delivered = waitFor(secondSocket, secondMessages, (message) => {
      return (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskReportDelivered";
    });
    const secondBootstrap = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "env.bootstrap", params: {} }));
    await secondBootstrap;
    await delivered;
    const listed = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    const restored = ((await listed).result as { threads: Array<{
      threadId: string;
      queue: unknown[];
      backgroundTasks: Array<{ taskId: string; reportDeliveredAt?: string }>;
    }> }).threads.find((candidate) => candidate.threadId === threadId);
    expect(restored?.queue).toEqual([]);
    expect(restored?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: "bash-build1", reportDeliveredAt: expect.any(String) }),
    ]);
    secondSocket.close();
  }, 30_000);

  it("backs off permanently failing background reports and leaves user turns usable", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-report-cap-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-report-cap-"));
    await launchServer(serverPath, "45146", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_BACKGROUND_REPORT_REJECT_ALWAYS: "1",
      KIMI_BACKGROUND_REPORT_RETRY_BASE_MS: "200",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45146", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const created = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const firstFailure = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string; stopReason?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.stopReason === "error";
    });
    socket.send(JSON.stringify({
      id: 3,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    }));
    const firstFailed = await firstFailure;
    const firstFailedSeq = Number(firstFailed.seq);
    await waitFor(socket, messages, (message) => {
      const payload = message.payload as { queue?: Array<{ origin?: string }> } | undefined;
      return message.channel === "thread.queueUpdated"
        && Number(message.seq) > firstFailedSeq
        && payload?.queue?.some((item) => item.origin === "background_task") === true;
    });

    const firstList = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    const afterFirstFailure = ((await firstList).result as { threads: Array<{
      threadId: string;
      queue: Array<{ origin: string }>;
      backgroundTasks: Array<{ reportAttemptCount?: number; reportNextAttemptAt?: string }>;
    }> }).threads.find((candidate) => candidate.threadId === threadId);
    expect(afterFirstFailure?.queue).toEqual([expect.objectContaining({ origin: "background_task" })]);
    expect(afterFirstFailure?.backgroundTasks[0]).toMatchObject({
      reportAttemptCount: 1,
      reportNextAttemptAt: expect.any(String),
    });

    const manualText = `__READ_TEXT_FILE__:${join(process.cwd(), "package.json")}`;
    const manualStarted = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === manualText;
    });
    socket.send(JSON.stringify({ id: 5, method: "threads.sendTurn", params: { threadId, text: manualText } }));
    const manualTurnId = ((await manualStarted).payload as { payload: { turnId: string } }).payload.turnId;
    await waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string; stopReason?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.turnId === manualTurnId && event.payload.stopReason === "end_turn";
    });

    await waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { failure?: string } } | undefined;
      return event?.type === "BackgroundTaskReportCancelled" && typeof event.payload?.failure === "string";
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(messages.filter((message) => {
      return (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskReportAttempted";
    })).toHaveLength(5);
    expect(messages.some((message) => {
      const diagnostic = message.payload as { type?: string; message?: string } | undefined;
      return message.channel === "server.diagnostics"
        && diagnostic?.type === "diagnostic"
        && diagnostic.message?.includes("failed after 5 attempts");
    })).toBe(true);

    const finalList = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "threads.list", params: {} }));
    const final = ((await finalList).result as { threads: Array<{
      threadId: string;
      queue: unknown[];
      backgroundTasks: Array<{
        reportAttemptCount?: number;
        reportFailedAt?: string;
        reportCancelledAt?: string;
        reportLastError?: string;
      }>;
    }> }).threads.find((candidate) => candidate.threadId === threadId);
    expect(final?.queue).toEqual([]);
    expect(final?.backgroundTasks[0]).toMatchObject({
      reportAttemptCount: 5,
      reportFailedAt: expect.any(String),
      reportCancelledAt: expect.any(String),
      reportLastError: expect.stringMatching(/.+/),
    });
    socket.close();
  }, 20_000);

  it("requeues an automated background report when a user steers it", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-steer-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-steer-"));
    await launchServer(serverPath, "45145", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_BACKGROUND_REPORT_DELAY_MS: "500",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45145", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const created = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const automatedTurn = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    });
    socket.send(JSON.stringify({
      id: 3,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    }));
    await automatedTurn;
    const steered = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Handle this first";
    });
    const steerReply = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({
      id: 4,
      method: "threads.sendTurn",
      params: { threadId, text: "Handle this first", mode: "steer" },
    }));
    expect((await steerReply).error).toBeUndefined();
    await steered;
    await waitFor(socket, messages, (message) => {
      const payload = message.payload as { queue?: Array<{ origin?: string }> } | undefined;
      return message.channel === "thread.queueUpdated"
        && payload?.queue?.some((item) => item.origin === "background_task") === true;
    });
    expect(messages.some((message) => {
      return (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskReportCancelled";
    })).toBe(false);
    socket.close();
  }, 20_000);

  it("resumes a persisted background task and queues exactly one report after restart", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-"));
    const first = await launchServer(serverPath, "45128", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45128", firstMessages);
    const bootstrap = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const create = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const thread = ((await create).result as { thread: { threadId: string; sessionId: string } }).thread;
    const registered = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskRegistered");
    const completed = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string; payload?: { turnId?: string } } | undefined)?.type === "TurnCompleted");
    firstSocket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId: thread.threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_PENDING__" } }));
    await registered;
    await completed;
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    const sessionDirectory = thread.sessionId.startsWith("session_") ? thread.sessionId : `session_${thread.sessionId}`;
    const taskPath = join(kimiHome, "sessions", "wd-test", sessionDirectory, "agents", "main", "tasks", "bash-build1.json");
    const outputPath = join(dirname(taskPath), "bash-build1", "output.log");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "BUILD SUCCESSFUL", "utf8");
    await writeFile(taskPath, JSON.stringify({
      taskId: "bash-build1",
      description: "Build APK",
      status: "completed",
      detached: true,
      startedAt: Date.now() - 1_000,
      endedAt: Date.now(),
      timeoutMs: 60_000,
      kind: "process",
      exitCode: 0,
    }), "utf8");

    const second = await launchServer(serverPath, "45129", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_BACKGROUND_REPORT_DELAY_MS: "5000",
    });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45129", secondMessages);
    const interruptedAutomatedTurn = waitFor(secondSocket, secondMessages, (message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    });
    const secondBootstrap = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "env.bootstrap", params: {} }));
    await secondBootstrap;
    await interruptedAutomatedTurn;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const inFlightList = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    const inFlight = ((await inFlightList).result as { threads: Array<{ threadId: string; queue: unknown[] }> })
      .threads.find((candidate) => candidate.threadId === thread.threadId);
    expect(inFlight?.queue).toEqual([]);
    secondSocket.close();
    const secondExited = new Promise<void>((resolve) => second.once("exit", () => resolve()));
    second.kill();
    await secondExited;
    await writeFile(join(dataHome, "pending-queues.json"), "{corrupt", "utf8");
    await writeFile(join(dataHome, "pending-queues.json.bak"), "{also-corrupt", "utf8");

    await launchServer(serverPath, "45131", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const thirdMessages: Array<Record<string, unknown>> = [];
    const thirdSocket = await connect("45131", thirdMessages);
    const retriedAutomatedTurn = waitFor(thirdSocket, thirdMessages, (message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    });
    const delivered = waitFor(thirdSocket, thirdMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskReportDelivered");
    const thirdBootstrap = waitFor(thirdSocket, thirdMessages, (message) => message.id === 6);
    thirdSocket.send(JSON.stringify({ id: 6, method: "env.bootstrap", params: {} }));
    await thirdBootstrap;
    await retriedAutomatedTurn;
    await delivered;

    const list = waitFor(thirdSocket, thirdMessages, (message) => message.id === 7);
    thirdSocket.send(JSON.stringify({ id: 7, method: "threads.list", params: {} }));
    const restored = ((await list).result as { threads: Array<{
      threadId: string;
      messages: Array<{ role: string; origin?: string; text: string }>;
      queue: unknown[];
      backgroundTasks: Array<{ taskId: string; status: string; reportQueued: boolean; reportDeliveredAt?: string }>;
    }> }).threads.find((candidate) => candidate.threadId === thread.threadId);
    expect(restored?.messages.filter((message) => message.role === "user" && message.origin === "background_task")).toHaveLength(2);
    expect(restored?.messages.filter((message) => message.role === "assistant" && message.text === "Background report delivered.")).toHaveLength(1);
    expect(restored?.queue).toEqual([]);
    expect(restored?.backgroundTasks).toEqual([expect.objectContaining({
      taskId: "bash-build1",
      status: "completed",
      reportQueued: true,
      reportDeliveredAt: expect.any(String),
    })]);
    thirdSocket.close();

    await launchServer(serverPath, "45132", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const fourthMessages: Array<Record<string, unknown>> = [];
    const fourthSocket = await connect("45132", fourthMessages);
    const fourthBootstrap = waitFor(fourthSocket, fourthMessages, (message) => message.id === 8);
    fourthSocket.send(JSON.stringify({ id: 8, method: "env.bootstrap", params: {} }));
    await fourthBootstrap;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(fourthMessages.some((message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    })).toBe(false);
    fourthSocket.close();
  }, 45_000);

  it("queues a finished background-task report even when the foreground prompt rejects", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-fast-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-fast-"));
    await launchServer(serverPath, "45130", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45130", messages);
    const bootstrap = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const create = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await create).result as { thread: { threadId: string } }).thread.threadId;
    const registered = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskRegistered");
    const finished = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskFinished");
    const automatedTurn = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    });
    const failedForeground = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { stopReason?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.stopReason === "error";
    });
    socket.send(JSON.stringify({
      id: 3,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__ __BACKGROUND_TASK_REJECT__" },
    }));
    await registered;
    await finished;
    await failedForeground;
    await automatedTurn;

    const list = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    const thread = ((await list).result as { threads: Array<{
      threadId: string;
      backgroundTasks: Array<{ taskId: string; status: string; reportQueued: boolean }>;
    }> }).threads.find((candidate) => candidate.threadId === threadId);
    expect(thread?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: "bash-build1", status: "completed", reportQueued: true }),
    ]);
    socket.close();
  }, 20_000);

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

  it("lists scoped Kimi skills and installs a validated workspace bundle", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-skills-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-skills-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-skills-"));
    const outside = await mkdtemp(join(tmpdir(), "kimi-outside-skills-"));
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".kimi-code", "skills", "project-skill"), { recursive: true });
    await writeFile(join(workspace, ".kimi-code", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: Project scoped\n---\n");
    const source = join(workspace, "install-me");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: installed-skill\ndescription: Installed safely\n---\n");
    const external = join(outside, "external");
    await mkdir(external);
    await writeFile(join(external, "SKILL.md"), "---\nname: external\ndescription: Outside\n---\n");

    await launchServer(serverPath, "45130", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45130", messages);

    const listed = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "capabilities.list", params: { cwd: workspace } }));
    const capabilities = (await listed).result as { skills: Array<{ name: string; scope: string }> };
    expect(capabilities.skills).toContainEqual(expect.objectContaining({ name: "project-skill", scope: "project" }));

    const installed = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "skills.install", params: { cwd: workspace, source } }));
    expect((await installed).result).toMatchObject({ skill: { name: "installed-skill", scope: "user" }, restartRequired: true });
    await expect(access(join(kimiHome, "skills", "installed-skill", "SKILL.md"))).resolves.toBeUndefined();

    const duplicate = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "skills.install", params: { cwd: workspace, source } }));
    expect((await duplicate).error).toMatchObject({ message: expect.stringMatching(/already installed/i) });

    const rejected = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "skills.install", params: { cwd: workspace, source: external } }));
    expect((await rejected).error).toMatchObject({ message: expect.stringMatching(/inside the active workspace/i) });
    const providersListed = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "providers.list", params: {} }));
    expect(((await providersListed).result as { providers: Array<{ id: string }> }).providers.map((provider) => provider.id)).toEqual(["kimi"]);
    socket.close();
  });

  it("routes safe remote and local branch operations", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-git-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-server-git-workspace-"));
    const remote = await mkdtemp(join(tmpdir(), "kimi-server-git-remote-"));
    const git = findGitBinary();
    await exec(git, ["-C", workspace, "init"]);
    await exec(git, ["-C", workspace, "config", "user.name", "Test"]);
    await exec(git, ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workspace, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", workspace, "add", "."]);
    await exec(git, ["-C", workspace, "commit", "-m", "base"]);
    const initial = (await exec(git, ["-C", workspace, "branch", "--show-current"])).stdout.trim();
    await exec(git, ["-C", remote, "init", "--bare"]);
    await exec(git, ["-C", workspace, "remote", "add", "origin", remote]);
    await exec(git, ["-C", workspace, "push", "origin", initial]);
    await exec(git, ["-C", workspace, "branch", "remote-only"]);
    await exec(git, ["-C", workspace, "push", "origin", "remote-only"]);
    await exec(git, ["-C", workspace, "branch", "-D", "remote-only"]);

    await launchServer(serverPath, "45148", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45148", messages);

    const fetched = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "git.fetch", params: { cwd: workspace, remote: "origin" } }));
    expect(((await fetched).result as { remoteBranches: Array<{ fullName: string }> }).remoteBranches).toContainEqual(expect.objectContaining({ fullName: "origin/remote-only" }));

    const checkedOut = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "git.checkoutRemoteBranch", params: { cwd: workspace, remote: "origin", branch: "remote-only", localBranch: "feature/tracked" } }));
    expect((await checkedOut).result).toMatchObject({ branch: "feature/tracked", upstream: "origin/remote-only" });

    const renamed = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "git.renameBranch", params: { cwd: workspace, branch: "feature/tracked", newBranch: "feature/renamed" } }));
    expect((await renamed).result).toMatchObject({ current: "feature/renamed" });

    const switched = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "git.switchBranch", params: { cwd: workspace, branch: initial } }));
    expect((await switched).result).toMatchObject({ branch: initial });

    const deleted = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "git.deleteBranch", params: { cwd: workspace, branch: "feature/renamed" } }));
    expect(((await deleted).result as { branches: string[] }).branches).not.toContain("feature/renamed");

    const rejected = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "git.fetch", params: { cwd: workspace, remote: "missing" } }));
    expect((await rejected).error).toMatchObject({ message: expect.stringMatching(/existing Git remote/i) });
    socket.close();
  });

  it("keeps historical provider chats readable but blocks new runtime work", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-historical-provider-"));
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append("historical-codex", {
      type: "ThreadCreated",
      payload: { sessionId: "codex-session", provider: "codex", cwd: process.cwd(), kind: "project", title: "Historical Codex chat" },
    });
    const scheduleStore = new ScheduleStore(join(dataHome, "schedules.json"));
    await scheduleStore.open();
    const legacySchedule = await scheduleStore.create({ name: "Legacy", threadId: "historical-codex", text: "Continue", cwd: process.cwd(), provider: "codex", recurrence: "once", nextRunAt: "2030-08-01T09:00:00.000Z" });
    await scheduleStore.update(legacySchedule.id, { enabled: false });

    await launchServer(serverPath, "45147", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45147", messages);

    const listed = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.list", params: {} }));
    expect(((await listed).result as { threads: Array<{ threadId: string; provider: string }> }).threads).toContainEqual(
      expect.objectContaining({ threadId: "historical-codex", provider: "codex" }),
    );

    for (const [id, method, params] of [
      [2, "threads.sendTurn", { threadId: "historical-codex", text: "Continue" }],
      [3, "threads.steerQueuedTurn", { threadId: "historical-codex", queuedId: crypto.randomUUID() }],
      [4, "threads.createSide", { threadId: "historical-codex" }],
      [5, "schedules.create", { threadId: "historical-codex", name: "Continue later", text: "Continue", recurrence: "once", nextRunAt: "2030-08-01T09:00:00.000Z" }],
      [6, "threads.setConfigOption", { threadId: "historical-codex", configId: "model", value: "kimi-k3" }],
      [7, "subagents.inspect", { threadId: "historical-codex", agentThreadId: "legacy-agent" }],
      [8, "threads.resume", { threadId: "historical-codex", sessionId: "codex-session", cwd: process.cwd() }],
      [9, "checkpoints.revert", { threadId: "historical-codex", turnId: "legacy-turn" }],
      [10, "schedules.update", { id: legacySchedule.id, enabled: true }],
    ] as const) {
      const response = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method, params }));
      expect(((await response).error as { message: string }).message).toMatch(/historical provider chat/i);
    }
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
    }, 10_000);
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
