import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket, type RawData } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const imageSend = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Update the README", mentions: ["package.json"], images: [{ name: "pixel.png", mimeType: "image/png", data: "AQID" }] } }));
    expect((await imageSend).result).toMatchObject({ accepted: true, queued: false });
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

  it("isolates config defaults and coalesces probes by runtime instance", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-config-instances-"));
    const alphaHome = join(dataHome, "alpha-home");
    const betaHome = join(dataHome, "beta-home");
    const sessionLog = join(dataHome, "new-sessions.log");
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "alpha", name: "Alpha", provider: "kimi", environment: { KIMI_CODE_HOME: alphaHome } },
      { id: "beta", name: "Beta", provider: "kimi", environment: { KIMI_CODE_HOME: betaHome } },
    ]));
    const firstServer = await launchServer(serverPath, "45310", dataHome, children, {
      KIMI_FAKE_NEW_SESSION_DELAY_MS: "100",
      KIMI_FAKE_NEW_SESSION_LOG: sessionLog,
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45310", messages);

    const firstProbe = waitFor(socket, messages, (message) => message.id === 1);
    const duplicateProbe = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 1, method: "runtime.configDefaults", params: { instanceId: "alpha" } }));
    socket.send(JSON.stringify({ id: 2, method: "runtime.configDefaults", params: { instanceId: "alpha" } }));
    expect((await firstProbe).error).toBeUndefined();
    expect((await duplicateProbe).error).toBeUndefined();
    const probeLog = await waitForFileText(sessionLog, (text) => text.includes("config-probe"));
    expect(probeLog.split(/\r?\n/).filter((line) => line.includes("config-probe"))).toHaveLength(1);

    const alphaCreate = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.create", params: { cwd: process.cwd(), instanceId: "alpha", config: { model: "kimi-k3-fast" } } }));
    expect((await alphaCreate).error).toBeUndefined();
    const betaCreate = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.create", params: { cwd: process.cwd(), instanceId: "beta", config: { mode: "yolo" } } }));
    expect((await betaCreate).error).toBeUndefined();

    await waitForFileText(join(dataHome, "runtime-defaults-kimi-alpha.json"), (text) => text.includes("kimi-k3-fast"));
    await waitForFileText(join(dataHome, "runtime-defaults-kimi-beta.json"), (text) => text.includes("yolo"));
    const alphaDefaults = waitFor(socket, messages, (message) => message.id === 5);
    const betaDefaults = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 5, method: "runtime.configDefaults", params: { instanceId: "alpha" } }));
    socket.send(JSON.stringify({ id: 6, method: "runtime.configDefaults", params: { instanceId: "beta" } }));
    const alphaOptions = ((await alphaDefaults).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    const betaOptions = ((await betaDefaults).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(alphaOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3-fast");
    expect(betaOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3");
    expect(betaOptions.find((option) => option.id === "mode")?.currentValue).toBe("yolo");
    socket.close();

    const exited = new Promise<void>((resolveExit) => firstServer.once("exit", () => resolveExit()));
    firstServer.kill();
    await exited;
    await launchServer(serverPath, "45312", dataHome, children);
    const restartedMessages: Array<Record<string, unknown>> = [];
    const restartedSocket = await connect("45312", restartedMessages);
    const reprobed = waitFor(restartedSocket, restartedMessages, (message) => message.id === 7);
    restartedSocket.send(JSON.stringify({ id: 7, method: "runtime.configDefaults", params: { instanceId: "alpha" } }));
    const reprobedOptions = ((await reprobed).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(reprobedOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3");
    const liveDefaults = waitFor(restartedSocket, restartedMessages, (message) => message.id === 8);
    restartedSocket.send(JSON.stringify({ id: 8, method: "runtime.configDefaults", params: { instanceId: "alpha" } }));
    const liveOptions = ((await liveDefaults).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(liveOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3");
    restartedSocket.close();
  });

  it("keeps serving when live config persistence fails", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-config-write-failure-"));
    const instanceHome = join(dataHome, "broken-home");
    const defaultsPath = join(dataHome, "runtime-defaults-kimi-broken.json");
    const sessionLog = join(dataHome, "new-sessions.log");
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "broken", name: "Broken", provider: "kimi", environment: { KIMI_CODE_HOME: instanceHome } },
    ]));
    await writeFile(defaultsPath, JSON.stringify({ configOptions: [{
      id: "model", name: "Model", type: "select", category: "model", currentValue: "kimi-k3", options: [{ value: "kimi-k3", name: "Kimi K3" }, { value: "kimi-k3-fast", name: "Kimi K3 Fast" }],
    }] }));
    await launchServer(serverPath, "45311", dataHome, children, { KIMI_FAKE_NEW_SESSION_LOG: sessionLog });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45311", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd(), instanceId: "broken" } }));
    const thread = ((await created).result as { thread: { threadId: string } }).thread;
    await waitForFileText(defaultsPath, (text) => text.includes('"mode"'));
    await rm(`${defaultsPath}.bak`, { force: true });
    await mkdir(`${defaultsPath}.bak`);

    const diagnostic = waitFor(socket, messages, (message) => message.channel === "server.diagnostics"
      && (message.payload as { source?: string } | undefined)?.source === "config-defaults");
    const changed = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.setConfigOption", params: { threadId: thread.threadId, configId: "model", value: "kimi-k3-fast" } }));
    expect((await changed).error).toBeUndefined();
    expect((await diagnostic).payload).toMatchObject({ level: "error", source: "config-defaults" });

    const defaults = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "runtime.configDefaults", params: { instanceId: "broken" } }));
    const options = ((await defaults).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(options.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3-fast");
    const probeLog = await waitForFileText(sessionLog, (text) => text.includes("config-probe"));
    expect(probeLog.split(/\r?\n/).filter((line) => line.includes("config-probe"))).toHaveLength(1);
    const providers = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "providers.list", params: {} }));
    expect((await providers).error).toBeUndefined();
    socket.close();
  });

  it("waits for config probes before runtime replacement and does not reuse them", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-config-runtime-replace-"));
    const sessionLog = join(dataHome, "new-sessions.log");
    await launchServer(serverPath, "45313", dataHome, children, {
      KIMI_CODE_HOME: join(dataHome, "kimi-home"),
      KIMI_FAKE_NEW_SESSION_DELAY_MS: "500",
      KIMI_FAKE_NEW_SESSION_LOG: sessionLog,
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45313", messages);

    const staleProbe = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "runtime.configDefaults", params: {} }));
    await waitForFileText(sessionLog, (text) => text.includes("config-probe"));
    const blockedLogout = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "auth.logout", params: {} }));
    expect((await blockedLogout).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });
    const staleOptions = ((await staleProbe).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(staleOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3");
    const loggedOut = waitFor(socket, messages, (message) => message.id === 20);
    socket.send(JSON.stringify({ id: 20, method: "auth.logout", params: {} }));
    expect((await loggedOut).error).toBeUndefined();

    const replacementProbe = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "runtime.configDefaults", params: {} }));
    const replacementOptions = ((await replacementProbe).result as { configOptions: Array<{ id: string; currentValue: unknown }> }).configOptions;
    expect(replacementOptions.find((option) => option.id === "model")?.currentValue).toBe("kimi-k3");
    const probeLog = await waitForFileText(sessionLog, (text) => text.split(/\r?\n/).filter((line) => line.includes("config-probe")).length === 2);
    expect(probeLog.split(/\r?\n/).filter((line) => line.includes("config-probe"))).toHaveLength(2);
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

  it("rolls back a scheduled queue insertion when queue persistence fails", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-schedule-rollback-"));
    const child = await launchServer(serverPath, "45326", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45326", messages);

    const createdReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await createdReply).result as { thread: { threadId: string } }).thread.threadId;
    const scheduleReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({
      id: 2,
      method: "schedules.create",
      params: { threadId, name: "Persist safely", text: "Run after persistence", recurrence: "once", nextRunAt: new Date(Date.now() + 60_000).toISOString() },
    }));
    const scheduleId = ((await scheduleReply).result as { schedule: { id: string } }).schedule.id;
    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    const activeReply = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Hold the scheduled queue" } }));
    await activeReply;
    await approval;

    const blockedTemporary = join(dataHome, `pending-queues.json.${child.pid}.tmp`);
    await mkdir(blockedTemporary);
    const failedRun = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "schedules.run", params: { id: scheduleId } }));
    expect((await failedRun).error).toBeDefined();
    const afterFailure = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    expect((((await afterFailure).result as { threads: Array<{ threadId: string; queue: unknown[] }> }).threads.find((thread) => thread.threadId === threadId)?.queue)).toEqual([]);

    await rm(blockedTemporary, { recursive: true });
    const blockedScheduleTemporary = join(dataHome, `schedules.json.${child.pid}.tmp`);
    await mkdir(blockedScheduleTemporary);
    const statusDiagnostic = waitFor(socket, messages, (message) => message.channel === "server.diagnostics"
      && (message.payload as { source?: string; message?: string } | undefined)?.source === "schedules"
      && (message.payload as { message?: string }).message?.includes("Schedule status persistence failed") === true);
    const retriedRun = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "schedules.run", params: { id: scheduleId } }));
    expect((await retriedRun).result).toEqual({ accepted: true });
    await statusDiagnostic;
    expect(messages.findIndex((message) => message.id === 6)).toBeLessThan(messages.findIndex((message) => message.channel === "server.diagnostics"
      && (message.payload as { message?: string } | undefined)?.message?.includes("Schedule status persistence failed") === true));
    const afterRetry = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "threads.list", params: {} }));
    expect((((await afterRetry).result as { threads: Array<{ threadId: string; queue: Array<{ text: string }> }> }).threads.find((thread) => thread.threadId === threadId)?.queue)).toEqual([expect.objectContaining({ text: "Run after persistence" })]);
    await rm(blockedScheduleTemporary, { recursive: true });
    socket.close();
  });

  it("makes runtime admissions atomic with update preparation", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-update-runtime-admission-"));
    await launchServer(serverPath, "45405", dataHome, children, { KIMI_FAKE_INITIALIZE_DELAY_MS: "500" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45405", messages);

    const probe = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "runtime.configDefaults", params: {} }));
    const blockedPrepare = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "env.prepareUpdate", params: {} }));
    expect((await blockedPrepare).error).toMatchObject({ message: expect.stringMatching(/runtimeOperations=1/i) });
    expect((await probe).error).toBeUndefined();

    const prepared = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    const blockedRuntimeOperation = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    expect((await blockedRuntimeOperation).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });
    const cancelled = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "env.cancelUpdate", params: {} }));
    expect((await cancelled).result).toEqual({ cancelled: true });
    socket.close();
  });

  it("keeps quota probes behind runtime, authentication, and update admissions", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-quota-admission-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-quota-admission-"));
    const cachedQuota = { summary: { label: "Cached", used: 1, limit: 10, remaining: 9 }, limits: [], updatedAt: new Date().toISOString() };
    await writeFile(quotaCacheFile(dataHome, "kimi", kimiHome), JSON.stringify(cachedQuota));
    await launchServer(serverPath, "45422", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_QUOTA_DELAY_MS: "600",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45422", messages);

    const quota = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "usage.quota", params: {} }));
    const blockedUpdate = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "env.prepareUpdate", params: {} }));
    expect((await blockedUpdate).error).toMatchObject({ message: expect.stringMatching(/runtimeOperations=1/i) });
    const blockedLogin = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "auth.beginLogin", params: {} }));
    expect((await blockedLogin).error).toMatchObject({ message: expect.stringMatching(/active Kimi work.*operations=1/i) });
    expect((await quota).result).toMatchObject({ summary: { label: "Cached" }, stale: true });

    const prepared = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    const blockedQuota = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "usage.quota", params: {} }));
    expect((await blockedQuota).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });
    const cancelled = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "env.cancelUpdate", params: {} }));
    expect((await cancelled).result).toEqual({ cancelled: true });
    socket.close();
  });

  it("serializes schedule mutations against update preparation", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-schedule-mutation-admission-"));
    await launchServer(serverPath, "45423", dataHome, children, { KIMI_FAKE_SCHEDULE_MUTATION_DELAY_MS: "600" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45423", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;

    const scheduled = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({
      id: 2,
      method: "schedules.create",
      params: { threadId, name: "Atomic schedule", text: "Run later", recurrence: "once", nextRunAt: new Date(Date.now() + 60_000).toISOString() },
    }));
    const blockedUpdate = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "env.prepareUpdate", params: {} }));
    expect((await blockedUpdate).error).toMatchObject({ message: expect.stringMatching(/scheduleMutations=1/i) });
    expect((await scheduled).error).toBeUndefined();

    const prepared = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    const blockedMutation = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "schedules.create", params: {
      threadId, name: "Blocked schedule", text: "Do not write", recurrence: "once", nextRunAt: new Date(Date.now() + 60_000).toISOString(),
    } }));
    expect((await blockedMutation).error).toMatchObject({ message: expect.stringMatching(/schedule changes are temporarily paused/i) });
    const cancelled = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "env.cancelUpdate", params: {} }));
    expect((await cancelled).result).toEqual({ cancelled: true });
    socket.close();
  });

  it("blocks update preparation during a durable scheduled queue insertion", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-update-queue-insertion-"));
    await launchServer(serverPath, "45410", dataHome, children, { KIMI_FAKE_QUEUE_INSERTION_DELAY_MS: "800" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45410", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const scheduled = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({
      id: 2,
      method: "schedules.create",
      params: { threadId, name: "Durable insertion", text: "Queue safely", recurrence: "once", nextRunAt: new Date(Date.now() + 60_000).toISOString() },
    }));
    const scheduleId = ((await scheduled).result as { schedule: { id: string } }).schedule.id;
    const run = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "schedules.run", params: { id: scheduleId } }));
    const blockedUpdate = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "env.prepareUpdate", params: {} }));
    expect((await blockedUpdate).error).toMatchObject({ message: expect.stringMatching(/queueInsertions=1/i) });
    expect((await run).result).toEqual({ accepted: true });
    socket.close();
  });

  it("keeps authentication reset behind active runtime admissions", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-auth-reset-admission-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-auth-reset-admission-"));
    await mkdir(join(kimiHome, "credentials"), { recursive: true });
    const credential = join(kimiHome, "credentials", "kimi-code.json");
    await writeFile(credential, "authenticated");
    await launchServer(serverPath, "45406", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_NEW_SESSION_DELAY_MS: "500",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45406", messages);

    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const blockedLogout = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "auth.logout", params: {} }));
    expect((await blockedLogout).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });
    await expect(access(credential)).resolves.toBeUndefined();
    expect((await created).error).toBeUndefined();

    const loggedOut = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "auth.logout", params: {} }));
    expect((await loggedOut).error).toBeUndefined();
    await expect(access(credential)).rejects.toThrow();
    socket.close();
  });

  it("holds the runtime and update gate for the full login process", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-auth-login-gate-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-auth-login-gate-"));
    const findstr = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "findstr.exe");
    await launchServer(serverPath, "45417", dataHome, children, { KIMI_FAKE: "0", KIMI_CODE_HOME: kimiHome, KIMI_BINARY: findstr });
    const firstMessages: Array<Record<string, unknown>> = [];
    const secondMessages: Array<Record<string, unknown>> = [];
    const first = await connect("45417", firstMessages);
    const second = await connect("45417", secondMessages);

    const login = waitFor(first, firstMessages, (message) => message.id === 1);
    first.send(JSON.stringify({ id: 1, method: "auth.beginLogin", params: {} }));
    expect((await login).result).toMatchObject({ loginRunning: true });
    first.close();

    const blockedUpdate = waitFor(second, secondMessages, (message) => message.id === 2);
    second.send(JSON.stringify({ id: 2, method: "env.prepareUpdate", params: {} }));
    expect((await blockedUpdate).error).toMatchObject({ message: expect.stringMatching(/active|sign-in|authLogin|mcpPolicyChanges/i) });

    const completed = waitFor(second, secondMessages, (message) => {
      const payload = message.payload as { event?: { type?: string; operation?: string } } | undefined;
      return message.channel === "auth.status" && payload?.event?.type === "complete" && payload.event.operation === "login";
    });
    const cancelled = waitFor(second, secondMessages, (message) => message.id === 3);
    second.send(JSON.stringify({ id: 3, method: "auth.cancel", params: {} }));
    expect((await cancelled).error).toBeUndefined();
    await completed;

    const prepared = waitFor(second, secondMessages, (message) => message.id === 4);
    second.send(JSON.stringify({ id: 4, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    second.close();
  });

  it("does not consume a due schedule while an update lease is held", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-schedule-update-gate-"));
    await launchServer(serverPath, "45407", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45407", messages);

    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const scheduled = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({
      id: 2,
      method: "schedules.create",
      params: { threadId, name: "Wait for update", text: "Run exactly once", recurrence: "once", nextRunAt: new Date(Date.now() + 100).toISOString() },
    }));
    const scheduleId = ((await scheduled).result as { schedule: { id: string } }).schedule.id;
    const prepared = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    const blockedManualRun = waitFor(socket, messages, (message) => message.id === 30);
    socket.send(JSON.stringify({ id: 30, method: "schedules.run", params: { id: scheduleId } }));
    expect((await blockedManualRun).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });

    await new Promise((resolve) => setTimeout(resolve, 16_000));
    const held = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "schedules.list", params: {} }));
    const heldSchedule = ((await held).result as { schedules: Array<{ id: string; enabled: boolean; lastRunAt?: string }> })
      .schedules.find((schedule) => schedule.id === scheduleId);
    expect(heldSchedule).toMatchObject({ enabled: true });
    expect(heldSchedule?.lastRunAt).toBeUndefined();

    const queued = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; scheduleId?: string } | undefined;
      return message.channel === "notifications.event" && event?.type === "schedule.queued" && event.scheduleId === scheduleId;
    });
    const cancelled = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "env.cancelUpdate", params: {} }));
    expect((await cancelled).result).toEqual({ cancelled: true });
    await queued;
    const consumed = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "schedules.list", params: {} }));
    const consumedSchedule = ((await consumed).result as { schedules: Array<{ id: string; enabled: boolean; lastRunAt?: string }> })
      .schedules.find((schedule) => schedule.id === scheduleId);
    expect(consumedSchedule).toMatchObject({ enabled: false, lastRunAt: expect.any(String) });
    socket.close();
  }, 30_000);

  it("coalesces concurrent thread creation and keeps admission metadata private", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-idempotent-"));
    await launchServer(serverPath, "45319", dataHome, children, { KIMI_FAKE_NEW_SESSION_DELAY_MS: "200" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const secondMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45319", firstMessages);
    const secondSocket = await connect("45319", secondMessages);
    const creationId = crypto.randomUUID();
    const firstParams = { cwd: process.cwd(), creationId, config: { mode: "auto", model: "kimi-k3" } };
    const secondParams = { cwd: join(process.cwd(), "."), creationId, config: { model: "kimi-k3", mode: "auto" } };
    const firstReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    const secondReply = waitFor(secondSocket, secondMessages, (message) => message.id === 2);
    const conflictReply = waitFor(secondSocket, secondMessages, (message) => message.id === 3);
    const targetConflictReply = waitFor(secondSocket, secondMessages, (message) => message.id === 13);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: firstParams }));
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: secondParams }));
    secondSocket.send(JSON.stringify({ id: 3, method: "threads.create", params: { ...secondParams, config: { model: "kimi-k3-fast", mode: "auto" } } }));
    secondSocket.send(JSON.stringify({ id: 13, method: "threads.create", params: { ...secondParams, creationId: crypto.randomUUID(), config: { model: "kimi-k3-fast", mode: "auto" } } }));
    const blockersReply = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "diagnostics.snapshot", params: {} }));
    expect((((await blockersReply).result as { blockers: { threadCreations: number } }).blockers.threadCreations)).toBeGreaterThan(0);
    const blockedUpdateReply = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "env.prepareUpdate", params: {} }));
    expect((await blockedUpdateReply).error).toMatchObject({ message: expect.stringMatching(/threadCreations=/) });
    const [first, duplicate, conflict, targetConflict] = await Promise.all([firstReply, secondReply, conflictReply, targetConflictReply]);
    const created = (first.result as { thread: { threadId: string; sessionId: string } }).thread;
    expect((duplicate.result as { thread: unknown }).thread).toEqual((first.result as { thread: unknown }).thread);
    expect(conflict.error).toMatchObject({ message: expect.stringMatching(/different thread creation parameters/i) });
    expect(targetConflict.error).toMatchObject({ message: expect.stringMatching(/unresolved for this workspace/i) });
    expect(JSON.stringify([first.result, duplicate.result])).not.toMatch(/creationId|creationFingerprint/);

    const createdEvents = firstMessages.filter((message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return message.channel === "orchestration.domainEvent" && event?.type === "ThreadCreated" && event.threadId === created.threadId;
    });
    expect(createdEvents).toHaveLength(1);
    expect(JSON.stringify(createdEvents)).not.toMatch(/creationId|creationFingerprint/);

    const listedReply = waitFor(firstSocket, firstMessages, (message) => message.id === 6);
    firstSocket.send(JSON.stringify({ id: 6, method: "threads.list", params: {} }));
    const listed = (await listedReply).result as { threads: Array<Record<string, unknown>>; runtimeSessions: Array<{ sessionId: string }> };
    expect(listed.threads).toHaveLength(1);
    expect(listed.runtimeSessions.filter((session) => session.sessionId === created.sessionId)).toHaveLength(1);
    expect(JSON.stringify(listed.threads)).not.toMatch(/creationId|creationFingerprint/);

    const exportedReply = waitFor(firstSocket, firstMessages, (message) => message.id === 7);
    firstSocket.send(JSON.stringify({ id: 7, method: "threads.export", params: { threadIds: [created.threadId] } }));
    const archive = await readFile(((await exportedReply).result as { path: string }).path, "utf8");
    expect(archive).not.toContain(creationId);
    expect(archive).not.toMatch(/creationId|creationFingerprint/);

    const preparedReply = waitFor(firstSocket, firstMessages, (message) => message.id === 8);
    firstSocket.send(JSON.stringify({ id: 8, method: "env.prepareUpdate", params: {} }));
    expect((await preparedReply).result).toEqual({ ready: true });
    const blockedCreateReply = waitFor(secondSocket, secondMessages, (message) => message.id === 9);
    secondSocket.send(JSON.stringify({ id: 9, method: "threads.create", params: { cwd: process.cwd(), creationId: crypto.randomUUID() } }));
    expect((await blockedCreateReply).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });
    const cancelledReply = waitFor(firstSocket, firstMessages, (message) => message.id === 10);
    firstSocket.send(JSON.stringify({ id: 10, method: "env.cancelUpdate", params: {} }));
    expect((await cancelledReply).result).toEqual({ cancelled: true });

    const legacyFirstReply = waitFor(firstSocket, firstMessages, (message) => message.id === 11);
    firstSocket.send(JSON.stringify({ id: 11, method: "threads.create", params: { cwd: process.cwd() } }));
    const legacyFirst = ((await legacyFirstReply).result as { thread: { threadId: string; sessionId: string } }).thread;
    const legacySecondReply = waitFor(firstSocket, firstMessages, (message) => message.id === 12);
    firstSocket.send(JSON.stringify({ id: 12, method: "threads.create", params: { cwd: process.cwd() } }));
    const legacySecond = ((await legacySecondReply).result as { thread: { threadId: string; sessionId: string } }).thread;
    expect(legacySecond.threadId).not.toBe(legacyFirst.threadId);
    expect(legacySecond.sessionId).not.toBe(legacyFirst.sessionId);
    firstSocket.close();
    secondSocket.close();
  }, 30_000);

  it("returns the exact created thread after a lost ACK and server restart", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-lost-ack-"));
    const creationId = crypto.randomUUID();
    const params = { cwd: process.cwd(), creationId };
    const first = await launchServer(serverPath, "45320", dataHome, children, { KIMI_FAKE_NEW_SESSION_DELAY_MS: "400" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45320", firstMessages);
    await new Promise<void>((resolveSend, rejectSend) => firstSocket.send(
      JSON.stringify({ id: 1, method: "threads.create", params }),
      (error) => error ? rejectSend(error) : resolveSend(),
    ));
    firstSocket.close();

    const stored = await waitForStoredEvent(dataHome, (event) => event.type === "ThreadCreated"
      && (event.payload as { creationId?: string }).creationId === creationId);
    const expected = { threadId: stored.threadId, sessionId: (stored.payload as { sessionId: string }).sessionId };
    const exited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    first.kill();
    await exited;

    await launchServer(serverPath, "45321", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45321", secondMessages);
    const retryReply = waitFor(secondSocket, secondMessages, (message) => message.id === 2);
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.create", params }));
    const retried = ((await retryReply).result as { thread: { threadId: string; sessionId: string } }).thread;
    expect(retried).toMatchObject(expected);
    expect(retried).not.toHaveProperty("creationId");
    expect(retried).not.toHaveProperty("creationFingerprint");
    const compacted = await waitForStoredEvent(dataHome, (event) => event.type === "ThreadSnapshot" && event.threadId === expected.threadId);
    expect((compacted.payload as { thread: { creationId?: string } }).thread.creationId).toBe(creationId);
    secondSocket.close();
  }, 30_000);

  it("allows the same creation ID to retry after creation fails", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-retry-"));
    const workspace = join(dataHome, "workspace-created-after-failure");
    await launchServer(serverPath, "45322", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45322", messages);
    const creationId = crypto.randomUUID();
    const params = { cwd: workspace, creationId };
    const failedReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params }));
    expect((await failedReply).error).toMatchObject({ message: expect.stringMatching(/ENOENT|no such file|cannot find/i) });
    await mkdir(workspace, { recursive: true });

    const retryReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params }));
    const created = ((await retryReply).result as { thread: { threadId: string; sessionId: string } }).thread;
    const listedReply = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.list", params: {} }));
    const listed = (await listedReply).result as { threads: Array<{ threadId: string }>; runtimeSessions: Array<{ sessionId: string }> };
    expect(listed.threads).toEqual([expect.objectContaining({ threadId: created.threadId })]);
    expect(listed.runtimeSessions.filter((session) => session.sessionId === created.sessionId)).toHaveLength(1);
    expect(messages.filter((message) => (message.payload as { type?: string } | undefined)?.type === "ThreadCreated")).toHaveLength(1);
    socket.close();
  });

  it("resumes a durably bound creation after a crash before ThreadCreated", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-bound-recovery-"));
    const creationId = crypto.randomUUID();
    const params = { cwd: process.cwd(), creationId, config: { model: "kimi-k3-fast" } };
    const first = await launchServer(serverPath, "45323", dataHome, children, { KIMI_FAKE_CONFIG_DELAY_MS: "5000" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45323", firstMessages);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params }));

    const bound = await waitForCreationReservation(dataHome, creationId, (reservation) => reservation.stage === "bound" && typeof reservation.sessionId === "string");
    const hiddenListReply = waitFor(firstSocket, firstMessages, (message) => message.id === 8);
    firstSocket.send(JSON.stringify({ id: 8, method: "threads.list", params: {} }));
    expect(((await hiddenListReply).result as { runtimeSessions: Array<{ sessionId: string }> }).runtimeSessions).not.toContainEqual(expect.objectContaining({ sessionId: bound.sessionId }));
    const hijackReply = waitFor(firstSocket, firstMessages, (message) => message.id === 9);
    firstSocket.send(JSON.stringify({ id: 9, method: "threads.resume", params: { threadId: "hijack", sessionId: bound.sessionId, cwd: process.cwd() } }));
    expect((await hijackReply).error).toMatchObject({ message: expect.stringMatching(/reserved by an unfinished thread creation/i) });
    const exited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    firstSocket.close();
    first.kill();
    await exited;

    await launchServer(serverPath, "45324", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45324", secondMessages);
    const retryReply = waitFor(secondSocket, secondMessages, (message) => message.id === 2);
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.create", params }));
    const retried = ((await retryReply).result as { thread: Record<string, unknown> }).thread;
    expect(retried).toMatchObject({ threadId: bound.threadId, sessionId: bound.sessionId });
    expect(retried).not.toHaveProperty("creationId");
    expect(retried).not.toHaveProperty("creationFingerprint");
    const journal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as { reservations: unknown[] };
    expect(journal.reservations).toEqual([]);
    secondSocket.close();
  }, 30_000);

  it("fails closed after an unacknowledged shared session creation", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-uncertain-"));
    const creationId = crypto.randomUUID();
    const params = { cwd: process.cwd(), creationId };
    const first = await launchServer(serverPath, "45325", dataHome, children, { KIMI_FAKE_NEW_SESSION_DELAY_MS: "5000" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45325", firstMessages);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params }));
    await waitForCreationReservation(dataHome, creationId, (reservation) => reservation.stage === "requesting" && !reservation.sessionId);
    const exited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    firstSocket.close();
    first.kill();
    await exited;
    await writeFile(join(dataHome, "pending-thread-creations.json"), "{", "utf8");

    await launchServer(serverPath, "45326", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45326", secondMessages);
    const retryReply = waitFor(secondSocket, secondMessages, (message) => message.id === 2);
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.create", params }));
    expect((await retryReply).error).toMatchObject({ message: expect.stringMatching(/delivery is uncertain.*refusing/i) });
    const promotedJournal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as { reservations: Array<{ stage: string }> };
    expect(promotedJournal.reservations).toContainEqual(expect.objectContaining({ stage: "requesting" }));

    const bypassReply = waitFor(secondSocket, secondMessages, (message) => message.id === 3);
    secondSocket.send(JSON.stringify({ id: 3, method: "threads.create", params: { ...params, creationId: crypto.randomUUID(), config: { mode: "auto" } } }));
    expect((await bypassReply).error).toMatchObject({ message: expect.stringMatching(/unresolved for this workspace/i) });
    const legacyBypassReply = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.create", params: { cwd: process.cwd() } }));
    expect((await legacyBypassReply).error).toMatchObject({ message: expect.stringMatching(/unresolved for this workspace/i) });
    const listedReply = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    expect((await listedReply).result).toMatchObject({ threads: [], runtimeSessions: [] });
    secondSocket.close();
  }, 30_000);

  it("reuses one isolated worktree after a crash without creating a duplicate", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-worktree-recovery-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-server-create-worktree-source-"));
    const git = findGitBinary();
    await exec(git, ["-C", workspace, "init"]);
    await exec(git, ["-C", workspace, "config", "user.name", "Test"]);
    await exec(git, ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workspace, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", workspace, "add", "."]);
    await exec(git, ["-C", workspace, "commit", "-m", "base"]);
    const creationId = crypto.randomUUID();
    const params = { cwd: workspace, creationId, isolate: true };
    const first = await launchServer(serverPath, "45327", dataHome, children, { KIMI_FAKE_NEW_SESSION_DELAY_MS: "5000" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45327", firstMessages);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params }));
    const pending = await waitForCreationReservation(dataHome, creationId, (reservation) => reservation.stage === "requesting");
    await access(String(pending.targetCwd));
    const exited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    firstSocket.close();
    first.kill();
    await exited;

    await launchServer(serverPath, "45328", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45328", secondMessages);
    const retryReply = waitFor(secondSocket, secondMessages, (message) => message.id === 2);
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.create", params }));
    expect((await retryReply).error).toMatchObject({ message: expect.stringMatching(/delivery is uncertain/i) });
    const worktrees = (await exec(git, ["-C", workspace, "worktree", "list", "--porcelain"])).stdout;
    expect(worktrees.match(/^worktree /gm)).toHaveLength(2);
    expect(worktrees.replaceAll("\\", "/").toLowerCase()).toContain(String(pending.targetCwd).replaceAll("\\", "/").toLowerCase());
    expect((await exec(git, ["-C", workspace, "branch", "--list", String(pending.branch)])).stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    secondSocket.close();
  }, 30_000);

  it("retains recovery ownership when an isolated worktree cannot be cleaned", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-cleanup-failure-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-server-create-cleanup-source-"));
    const git = findGitBinary();
    await exec(git, ["-C", workspace, "init"]);
    await exec(git, ["-C", workspace, "config", "user.name", "Test"]);
    await exec(git, ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workspace, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", workspace, "add", "."]);
    await exec(git, ["-C", workspace, "commit", "-m", "base"]);
    const creationId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const params = { cwd: workspace, creationId, isolate: true, standalone: false, provider: "kimi" as const };
    const targetCwd = join(dataHome, "worktrees", threadId);
    const marker = join(targetCwd, "unowned.txt");
    await mkdir(targetCwd, { recursive: true });
    await writeFile(marker, "leave me alone", "utf8");
    const reservation = {
      creationId,
      fingerprint: testThreadCreationFingerprint(params),
      threadId,
      provider: "kimi",
      standalone: false,
      isolate: true,
      targetCwd,
      sourceCwd: await realpath(workspace),
      branch: `kimi/${threadId}`,
      baselineSessionIds: [],
      stage: "ready",
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dataHome, "pending-thread-creations.json"), JSON.stringify({ version: 1, reservations: [reservation] }), "utf8");
    await launchServer(serverPath, "45329", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45329", messages);
    const failedReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params }));
    expect((await failedReply).error).toMatchObject({ message: expect.stringMatching(/worktree target already exists/i) });
    expect(await readFile(marker, "utf8")).toBe("leave me alone");
    const journal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as { reservations: Array<{ creationId: string }> };
    expect(journal.reservations).toContainEqual(expect.objectContaining({ creationId }));
    socket.close();
  }, 30_000);

  it("clears a reservation after an explicit ACP rejection and allows retry", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-definitive-reject-"));
    const creationId = crypto.randomUUID();
    const params = { cwd: process.cwd(), creationId };
    const first = await launchServer(serverPath, "45330", dataHome, children, { KIMI_FAKE_NEW_SESSION_REJECT: "1" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45330", firstMessages);
    const rejectedReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params }));
    expect((await rejectedReply).error).toMatchObject({ message: expect.stringMatching(/fake new session rejected/i) });
    const rejectedJournal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as { reservations: unknown[] };
    expect(rejectedJournal.reservations).toEqual([]);
    const exited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    firstSocket.close();
    first.kill();
    await exited;

    await launchServer(serverPath, "45331", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45331", secondMessages);
    const retryReply = waitFor(secondSocket, secondMessages, (message) => message.id === 2);
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.create", params }));
    expect((await retryReply).error).toBeUndefined();
    secondSocket.close();
  }, 30_000);

  it("keeps a durable creation receipt after the thread is deleted", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-create-deleted-receipt-"));
    const creationId = crypto.randomUUID();
    const params = { cwd: process.cwd(), creationId };
    const first = await launchServer(serverPath, "45332", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45332", firstMessages);
    const createdReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params }));
    const created = ((await createdReply).result as { thread: { threadId: string } }).thread;
    const deletedReply = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.delete", params: { threadId: created.threadId } }));
    expect((await deletedReply).error).toBeUndefined();
    const duplicateReply = waitFor(firstSocket, firstMessages, (message) => message.id === 3);
    firstSocket.send(JSON.stringify({ id: 3, method: "threads.create", params }));
    expect((await duplicateReply).error).toMatchObject({ message: expect.stringMatching(/already used by a thread that no longer exists/i) });
    const exited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    firstSocket.close();
    first.kill();
    await exited;

    await launchServer(serverPath, "45333", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45333", secondMessages);
    const restartedRetry = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.create", params }));
    expect((await restartedRetry).error).toMatchObject({ message: expect.stringMatching(/already used by a thread that no longer exists/i) });
    const listedReply = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    expect(((await listedReply).result as { threads: unknown[] }).threads).toEqual([]);
    secondSocket.close();
  }, 30_000);

  it("coalesces idempotent side-chat creation and preserves the parent runtime snapshot", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-side-idempotent-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-server-side-worktree-"));
    const git = findGitBinary();
    await exec(git, ["-C", workspace, "init"]);
    await exec(git, ["-C", workspace, "config", "user.name", "Test"]);
    await exec(git, ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workspace, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", workspace, "add", "."]);
    await exec(git, ["-C", workspace, "commit", "-m", "base"]);
    await launchServer(serverPath, "45435", dataHome, children, { KIMI_FAKE_NEW_SESSION_DELAY_MS: "500" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const secondMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45435", firstMessages);
    const secondSocket = await connect("45435", secondMessages);
    const parentReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({
      id: 1,
      method: "threads.create",
      params: { cwd: workspace, isolate: true, creationId: crypto.randomUUID(), config: { model: "kimi-k3-fast", mode: "auto" } },
    }));
    const parent = ((await parentReply).result as { thread: { threadId: string; cwd: string; worktree: { sourceCwd: string; branch: string } } }).thread;
    const creationId = crypto.randomUUID();
    const params = { threadId: parent.threadId, title: "Explore safely", creationId };
    const firstReply = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    const secondReply = waitFor(secondSocket, secondMessages, (message) => message.id === 3);
    const conflictReply = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.createSide", params }));
    secondSocket.send(JSON.stringify({ id: 3, method: "threads.createSide", params }));
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.createSide", params: { ...params, title: "Changed title" } }));
    const blockersReply = waitFor(secondSocket, secondMessages, (message) => message.id === 6);
    secondSocket.send(JSON.stringify({ id: 6, method: "diagnostics.snapshot", params: {} }));
    expect(((await blockersReply).result as { blockers: { threadCreations: number } }).blockers.threadCreations).toBeGreaterThan(0);
    const updateReply = waitFor(secondSocket, secondMessages, (message) => message.id === 7);
    secondSocket.send(JSON.stringify({ id: 7, method: "env.prepareUpdate", params: {} }));
    expect((await updateReply).error).toMatchObject({ message: expect.stringMatching(/threadCreations=/) });
    const first = ((await firstReply).result as { thread: Record<string, unknown> }).thread;
    const second = ((await secondReply).result as { thread: Record<string, unknown> }).thread;
    expect(first).toMatchObject({
      threadId: second.threadId,
      sessionId: second.sessionId,
      parentThreadId: parent.threadId,
      cwd: parent.cwd,
      worktree: parent.worktree,
      kind: "project",
      title: "Explore safely",
    });
    expect((first.configOptions as Array<{ id: string; currentValue: unknown }>).find((option) => option.id === "model")?.currentValue).toBe("kimi-k3-fast");
    expect((first.configOptions as Array<{ id: string; currentValue: unknown }>).find((option) => option.id === "mode")?.currentValue).toBe("auto");
    expect((await conflictReply).error).toMatchObject({ message: expect.stringMatching(/different thread creation parameters/i) });
    const parentConflictReply = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.createSide", params: { ...params, threadId: "another-parent" } }));
    expect((await parentConflictReply).error).toMatchObject({ message: expect.stringMatching(/different thread creation parameters/i) });
    expect(JSON.stringify([first, second])).not.toMatch(/creationId|creationFingerprint/);
    const childEvents = firstMessages.filter((message) => {
      const event = message.payload as { type?: string; payload?: { parentThreadId?: string } } | undefined;
      return event?.type === "ThreadCreated" && event.payload?.parentThreadId === parent.threadId;
    });
    expect(childEvents).toHaveLength(1);
    expect(JSON.stringify(childEvents)).not.toMatch(/creationId|creationFingerprint/);
    firstSocket.close();
    secondSocket.close();
  }, 30_000);

  it("returns an exact side chat after lost ACK and rejects its ID after deletion and restart", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-side-recovery-"));
    const first = await launchServer(serverPath, "45436", dataHome, children, { KIMI_FAKE_NEW_SESSION_DELAY_MS: "250" });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45436", firstMessages);
    const parentReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd(), creationId: crypto.randomUUID() } }));
    const parent = ((await parentReply).result as { thread: { threadId: string } }).thread;
    const creationId = crypto.randomUUID();
    const params = { threadId: parent.threadId, title: "Durable side", creationId };
    await new Promise<void>((resolveSend, rejectSend) => firstSocket.send(
      JSON.stringify({ id: 2, method: "threads.createSide", params }),
      (error) => error ? rejectSend(error) : resolveSend(),
    ));
    firstSocket.close();
    const stored = await waitForStoredEvent(dataHome, (event) => event.type === "ThreadCreated"
      && (event.payload as { creationId?: string }).creationId === creationId);
    const expected = { threadId: stored.threadId, sessionId: (stored.payload as { sessionId: string }).sessionId };
    const firstExited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    first.kill();
    await firstExited;

    const second = await launchServer(serverPath, "45437", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45437", secondMessages);
    const retryReply = waitFor(secondSocket, secondMessages, (message) => message.id === 3);
    secondSocket.send(JSON.stringify({ id: 3, method: "threads.createSide", params }));
    const retried = ((await retryReply).result as { thread: Record<string, unknown> }).thread;
    expect(retried).toMatchObject({ ...expected, parentThreadId: parent.threadId, title: "Durable side" });
    const changedReply = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.createSide", params: { ...params, title: "Different" } }));
    expect((await changedReply).error).toMatchObject({ message: expect.stringMatching(/different thread creation parameters/i) });
    const deleteReply = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.delete", params: { threadId: expected.threadId } }));
    expect((await deleteReply).error).toBeUndefined();
    const secondExited = new Promise<void>((resolveExit) => second.once("exit", () => resolveExit()));
    secondSocket.close();
    second.kill();
    await secondExited;

    await launchServer(serverPath, "45438", dataHome, children);
    const thirdMessages: Array<Record<string, unknown>> = [];
    const thirdSocket = await connect("45438", thirdMessages);
    const deletedRetry = waitFor(thirdSocket, thirdMessages, (message) => message.id === 6);
    thirdSocket.send(JSON.stringify({ id: 6, method: "threads.createSide", params }));
    expect((await deletedRetry).error).toMatchObject({ message: expect.stringMatching(/already used by a thread that no longer exists/i) });
    const listReply = waitFor(thirdSocket, thirdMessages, (message) => message.id === 7);
    thirdSocket.send(JSON.stringify({ id: 7, method: "threads.list", params: {} }));
    expect(((await listReply).result as { threads: Array<{ threadId: string }> }).threads).not.toContainEqual(expect.objectContaining({ threadId: expected.threadId }));
    thirdSocket.close();
  }, 30_000);

  it("resumes a durably bound side chat with its original title and inherited config", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-side-bound-"));
    const first = await launchServer(serverPath, "45439", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45439", firstMessages);
    const parentReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({
      id: 1,
      method: "threads.create",
      params: { cwd: process.cwd(), creationId: crypto.randomUUID(), config: { model: "kimi-k3-fast", mode: "auto" } },
    }));
    const parent = ((await parentReply).result as { thread: { threadId: string } }).thread;
    const firstExited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    firstSocket.close();
    first.kill();
    await firstExited;

    const second = await launchServer(serverPath, "45440", dataHome, children, { KIMI_FAKE_CONFIG_DELAY_MS: "5000" });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45440", secondMessages);
    const creationId = crypto.randomUUID();
    const params = { threadId: parent.threadId, title: "Snapshot title", creationId };
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.createSide", params }));
    const bound = await waitForCreationReservation(dataHome, creationId, (reservation) => reservation.stage === "bound" && typeof reservation.sessionId === "string");
    const secondExited = new Promise<void>((resolveExit) => second.once("exit", () => resolveExit()));
    secondSocket.close();
    second.kill();
    await secondExited;

    await launchServer(serverPath, "45441", dataHome, children);
    const thirdMessages: Array<Record<string, unknown>> = [];
    const thirdSocket = await connect("45441", thirdMessages);
    const retryReply = waitFor(thirdSocket, thirdMessages, (message) => message.id === 3);
    thirdSocket.send(JSON.stringify({ id: 3, method: "threads.createSide", params }));
    const recovered = ((await retryReply).result as { thread: Record<string, unknown> }).thread;
    expect(recovered).toMatchObject({
      threadId: bound.threadId,
      sessionId: bound.sessionId,
      parentThreadId: parent.threadId,
      title: "Snapshot title",
    });
    expect((recovered.configOptions as Array<{ id: string; currentValue: unknown }>).find((option) => option.id === "model")?.currentValue).toBe("kimi-k3-fast");
    expect((recovered.configOptions as Array<{ id: string; currentValue: unknown }>).find((option) => option.id === "mode")?.currentValue).toBe("auto");
    const journal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as { reservations: unknown[] };
    expect(journal.reservations).toEqual([]);
    thirdSocket.close();
  }, 30_000);

  it("fails closed after an unacknowledged side-chat session request without creating another session", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-side-requesting-"));
    const sessionLog = join(dataHome, "new-sessions.log");
    const first = await launchServer(serverPath, "45442", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45442", firstMessages);
    const parentReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd(), creationId: crypto.randomUUID() } }));
    const parent = ((await parentReply).result as { thread: { threadId: string } }).thread;
    const firstExited = new Promise<void>((resolveExit) => first.once("exit", () => resolveExit()));
    firstSocket.close();
    first.kill();
    await firstExited;

    const second = await launchServer(serverPath, "45443", dataHome, children, {
      KIMI_FAKE_NEW_SESSION_DELAY_MS: "5000",
      KIMI_FAKE_NEW_SESSION_LOG: sessionLog,
    });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45443", secondMessages);
    const creationId = crypto.randomUUID();
    const params = { threadId: parent.threadId, creationId };
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.createSide", params }));
    await waitForCreationReservation(dataHome, creationId, (reservation) => reservation.stage === "requesting" && !reservation.sessionId);
    const sessionRequests = await waitForFileText(sessionLog, (text) => text.trim().split(/\r?\n/).filter(Boolean).length === 1);
    expect(sessionRequests.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    const secondExited = new Promise<void>((resolveExit) => second.once("exit", () => resolveExit()));
    secondSocket.close();
    second.kill();
    await secondExited;

    await launchServer(serverPath, "45444", dataHome, children, { KIMI_FAKE_NEW_SESSION_LOG: sessionLog });
    const thirdMessages: Array<Record<string, unknown>> = [];
    const thirdSocket = await connect("45444", thirdMessages);
    const retryReply = waitFor(thirdSocket, thirdMessages, (message) => message.id === 3);
    thirdSocket.send(JSON.stringify({ id: 3, method: "threads.createSide", params }));
    expect((await retryReply).error).toMatchObject({ message: expect.stringMatching(/delivery is uncertain.*refusing/i) });
    expect((await readFile(sessionLog, "utf8")).trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    const bypassReply = waitFor(thirdSocket, thirdMessages, (message) => message.id === 4);
    thirdSocket.send(JSON.stringify({ id: 4, method: "threads.createSide", params: { ...params, creationId: crypto.randomUUID() } }));
    expect((await bypassReply).error).toMatchObject({ message: expect.stringMatching(/unresolved for this workspace/i) });
    expect((await readFile(sessionLog, "utf8")).trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    thirdSocket.close();
  }, 30_000);

  it("recovers a completed side-chat reservation after the side chat was already renamed", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-side-renamed-recovery-"));
    const cwd = await realpath(process.cwd());
    const creationId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    const sessionId = `fake-${crypto.randomUUID()}`;
    const parentThreadId = crypto.randomUUID();
    const fingerprint = testSideThreadCreationFingerprint({ threadId: parentThreadId });
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append(threadId, {
      type: "ThreadCreated",
      payload: {
        sessionId,
        creationId,
        creationFingerprint: fingerprint,
        provider: "kimi",
        parentThreadId,
        cwd,
        kind: "project",
        title: "Original side title",
        configOptions: [],
      },
    });
    await store.append(threadId, { type: "ThreadRenamed", payload: { title: "Renamed before receipt" } });
    await store.drain();
    await writeFile(join(dataHome, "pending-thread-creations.json"), JSON.stringify({
      version: 1,
      reservations: [{
        creationId,
        fingerprint,
        threadId,
        provider: "kimi",
        standalone: false,
        isolate: false,
        targetCwd: cwd,
        sharedTargetKey: cwd.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase(),
        baselineSessionIds: [],
        side: { parentThreadId, title: "Original side title", kind: "project", inheritedConfig: {} },
        stage: "bound",
        sessionId,
        createdAt: new Date().toISOString(),
      }],
      receipts: [],
    }), "utf8");

    await launchServer(serverPath, "45445", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45445", messages);
    const listReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.list", params: {} }));
    expect(((await listReply).result as { threads: Array<{ threadId: string; title: string }> }).threads)
      .toContainEqual(expect.objectContaining({ threadId, title: "Renamed before receipt" }));
    const journal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as {
      reservations: unknown[];
      receipts: Array<{ creationId: string; threadId: string }>;
    };
    expect(journal.reservations).toEqual([]);
    expect(journal.receipts).toContainEqual(expect.objectContaining({ creationId, threadId }));
    socket.close();
  });

  it("coalesces concurrent submitted turns and rejects conflicting reuse", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-idempotent-"));
    await launchServer(serverPath, "45310", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45310", messages);
    const createdReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await createdReply).result as { thread: { threadId: string } }).thread.threadId;
    const submissionId = crypto.randomUUID();
    const params = { threadId, text: "Run this exactly once", submissionId };
    const firstReply = waitFor(socket, messages, (message) => message.id === 2);
    const duplicateReply = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params }));
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params }));
    const [first, duplicate] = await Promise.all([firstReply, duplicateReply]);
    expect(first.result).toMatchObject({ accepted: true, queuedId: submissionId });
    expect(duplicate.result).toMatchObject({ accepted: true, queuedId: submissionId });

    const conflict = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { ...params, text: "Different content" } }));
    expect((await conflict).error).toMatchObject({ message: expect.stringMatching(/different prompt content/i) });

    const started = await waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { sourceQueuedId?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.sourceQueuedId === submissionId;
    });
    const startedTurn = (started.payload as { payload: { text: string; turnId: string } }).payload;
    expect(startedTurn.text).toBe("Run this exactly once");
    const approval = await waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { requestId?: string } } | undefined;
      return event?.type === "ApprovalRequested" && typeof event.payload?.requestId === "string";
    });
    const requestId = (approval.payload as { payload: { requestId: string } }).payload.requestId;
    const completed = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.turnId === startedTurn.turnId;
    });
    socket.send(JSON.stringify({ id: 5, method: "threads.respondToRequest", params: { threadId, requestId, optionId: "allow-once" } }));
    await completed;

    const completedRetry = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "threads.sendTurn", params }));
    expect((await completedRetry).result).toMatchObject({ accepted: true, queuedId: submissionId, queued: false });
    expect(messages.filter((message) => {
      const event = message.payload as { type?: string; payload?: { sourceQueuedId?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.sourceQueuedId === submissionId;
    })).toHaveLength(1);

    const listed = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "threads.list", params: {} }));
    const projected = ((await listed).result as { threads: Array<{ threadId: string; messages: Array<{ role: string; text: string }> }> }).threads.find((candidate) => candidate.threadId === threadId)!;
    expect(projected.messages.filter((message) => message.role === "user" && message.text === "Run this exactly once")).toHaveLength(1);
    expect(projected).not.toHaveProperty("submissionReceipts");
    const storedEvents = (await readFile(join(dataHome, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as {
      type: string;
      payload?: { thread?: { submissionReceipts?: Array<{ submissionId: string; state: string }> } };
    });
    const storedReceipts = storedEvents.findLast((event) => event.type === "ThreadSnapshot")?.payload?.thread?.submissionReceipts;
    expect(storedReceipts).toEqual([expect.objectContaining({ submissionId, state: "completed" })]);
    socket.close();
  });

  it("keeps a lost-ACK submission deduplicated across restart and removal", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-lost-ack-"));
    const first = await launchServer(serverPath, "45311", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45311", firstMessages);
    const createdReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await createdReply).result as { thread: { threadId: string } }).thread.threadId;
    const approval = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: "Hold the active turn" } }));
    await approval;
    const submissionId = crypto.randomUUID();
    const params = { threadId, text: "Persisted before the ACK", submissionId };
    const accepted = waitFor(firstSocket, firstMessages, (message) => {
      const payload = message.payload as { threadId?: string; queue?: Array<{ queuedId?: string }> } | undefined;
      return message.channel === "thread.queueUpdated" && payload?.threadId === threadId && payload.queue?.some((item) => item.queuedId === submissionId) === true;
    });
    firstSocket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params }));
    await accepted;
    firstSocket.close();
    const exited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await exited;

    await launchServer(serverPath, "45312", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45312", secondMessages);
    const retry = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params }));
    expect((await retry).result).toMatchObject({ accepted: true, queuedId: submissionId, queued: true });
    const beforeRemoval = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    expect((((await beforeRemoval).result as { threads: Array<{ threadId: string; queue: Array<{ queuedId: string }> }> }).threads.find((thread) => thread.threadId === threadId)?.queue)).toEqual([{ queuedId: submissionId, text: "Persisted before the ACK", mode: "queue", createdAt: expect.any(String), origin: "user", images: [] }]);

    const removed = waitFor(secondSocket, secondMessages, (message) => message.id === 6);
    secondSocket.send(JSON.stringify({ id: 6, method: "threads.removeQueuedTurn", params: { threadId, queuedId: submissionId } }));
    await removed;
    const retryRemoved = waitFor(secondSocket, secondMessages, (message) => message.id === 7);
    secondSocket.send(JSON.stringify({ id: 7, method: "threads.sendTurn", params }));
    expect((await retryRemoved).result).toMatchObject({ accepted: true, queuedId: submissionId, queued: false });
    const afterRemoval = waitFor(secondSocket, secondMessages, (message) => message.id === 8);
    secondSocket.send(JSON.stringify({ id: 8, method: "threads.list", params: {} }));
    expect(((await afterRemoval).result as { threads: Array<{ threadId: string; queue: unknown[] }> }).threads.find((thread) => thread.threadId === threadId)?.queue).toEqual([]);
    secondSocket.close();
  }, 30_000);

  it("rejects a retry when a durable receipt outlives its queued payload", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-lost-payload-"));
    const first = await launchServer(serverPath, "45315", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45315", firstMessages);
    const createdReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await createdReply).result as { thread: { threadId: string } }).thread.threadId;
    const approval = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: "Hold this turn" } }));
    await approval;
    const submissionId = crypto.randomUUID();
    const params = { threadId, text: "Payload that disappears", submissionId };
    const queued = waitFor(firstSocket, firstMessages, (message) => {
      const payload = message.payload as { queue?: Array<{ queuedId?: string }> } | undefined;
      return message.channel === "thread.queueUpdated" && payload?.queue?.some((item) => item.queuedId === submissionId) === true;
    });
    firstSocket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params }));
    await queued;
    firstSocket.close();
    const exited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await exited;
    await writeFile(join(dataHome, "pending-queues.json"), "{}");

    const second = await launchServer(serverPath, "45316", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45316", secondMessages);
    const retry = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params }));
    expect((await retry).error).toMatchObject({ message: expect.stringMatching(/payload could not be recovered/i) });
    secondSocket.close();
    const secondExited = new Promise<void>((resolve) => second.once("exit", () => resolve()));
    second.kill();
    await secondExited;
    await writeFile(join(dataHome, "pending-queues.json"), JSON.stringify({
      [threadId]: [{ queuedId: submissionId, submissionId, text: params.text, mentions: [], mode: "queue", createdAt: new Date().toISOString(), origin: "user" }],
    }));

    await launchServer(serverPath, "45317", dataHome, children);
    const thirdMessages: Array<Record<string, unknown>> = [];
    const thirdSocket = await connect("45317", thirdMessages);
    const listed = waitFor(thirdSocket, thirdMessages, (message) => message.id === 5);
    thirdSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    expect(((await listed).result as { threads: Array<{ threadId: string; queue: unknown[] }> }).threads.find((thread) => thread.threadId === threadId)?.queue).toEqual([]);
    thirdSocket.close();
  }, 30_000);

  it("does not restore a stale persisted queue entry more than thirty days after its submitted turn started", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-started-receipt-"));
    const submissionId = crypto.randomUUID();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const store = new EventStore(join(dataHome, "events.jsonl"));
      await store.open(() => undefined);
      await store.append("started-thread", { type: "ThreadCreated", payload: { sessionId: "started-session", cwd: process.cwd(), title: "Started" } });
      await store.append("started-thread", { type: "TurnSubmissionAccepted", payload: { submissionId, queuedId: submissionId, fingerprint: "durable" } });
      await store.append("started-thread", { type: "TurnStarted", payload: { turnId: "started-turn", text: "Already admitted", sourceQueuedId: submissionId } });
      await store.drain();
    } finally {
      vi.useRealTimers();
    }
    await writeFile(join(dataHome, "pending-queues.json"), JSON.stringify({
      "started-thread": [{ queuedId: submissionId, submissionId, text: "Already admitted", mentions: [], mode: "queue", createdAt: new Date().toISOString(), origin: "user" }],
    }));

    await launchServer(serverPath, "45313", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45313", messages);
    const listed = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.list", params: {} }));
    const thread = ((await listed).result as { threads: Array<{ threadId: string; queue: unknown[] }> }).threads.find((candidate) => candidate.threadId === "started-thread")!;
    expect(thread.queue).toEqual([]);
    expect(thread).not.toHaveProperty("submissionReceipts");
    socket.close();
  });

  it("discards an unreceipted persisted submission and accepts only an explicit retry", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-orphaned-submission-"));
    const submissionId = crypto.randomUUID();
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append("orphan-thread", { type: "ThreadCreated", payload: { sessionId: "orphan-session", cwd: process.cwd(), title: "Orphan" } });
    await store.drain();
    const queued = { queuedId: submissionId, submissionId, text: "Recover the receipt", mentions: [], mode: "queue", createdAt: new Date().toISOString(), origin: "user" };
    await writeFile(join(dataHome, "pending-queues.json"), JSON.stringify({ "orphan-thread": [queued] }));

    await launchServer(serverPath, "45314", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45314", messages);
    const listed = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.list", params: {} }));
    const thread = ((await listed).result as { threads: Array<{ threadId: string; queue: unknown[] }> }).threads.find((candidate) => candidate.threadId === "orphan-thread")!;
    expect(thread.queue).toEqual([]);
    expect(thread).not.toHaveProperty("submissionReceipts");

    const started = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { sourceQueuedId?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.sourceQueuedId === submissionId;
    });
    const retry = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId: "orphan-thread", text: queued.text, submissionId } }));
    expect((await retry).result).toMatchObject({ accepted: true, queuedId: submissionId });
    await started;
    expect((await readFile(join(dataHome, "events.jsonl"), "utf8")).match(/"type":"TurnSubmissionAccepted"/g)).toHaveLength(1);
    socket.close();
  });

  it("rejects a submission ID that collides with another queued prompt", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-queue-id-collision-"));
    const queuedId = crypto.randomUUID();
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append("collision-thread", { type: "ThreadCreated", payload: { sessionId: "collision-session", cwd: process.cwd(), title: "Collision" } });
    await store.drain();
    await writeFile(join(dataHome, "pending-queues.json"), JSON.stringify({
      "collision-thread": [{ queuedId, text: "Existing prompt", mentions: [], mode: "queue", createdAt: new Date().toISOString(), origin: "user" }],
    }));

    await launchServer(serverPath, "45318", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45318", messages);
    const response = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.sendTurn", params: { threadId: "collision-thread", text: "Different prompt", submissionId: queuedId } }));
    expect((await response).error).toMatchObject({ message: expect.stringMatching(/conflicts with an existing queued prompt/i) });
    socket.close();
  });

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
    expect((await rejectedImage).error).toMatchObject({ message: expect.stringMatching(/image prompts must start immediately/i) });
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

  it("holds the Git lease until a failed isolated session removes its worktree", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-worktree-cleanup-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-server-worktree-cleanup-source-"));
    const git = findGitBinary();
    await exec(git, ["-C", workspace, "init"]);
    await exec(git, ["-C", workspace, "config", "user.name", "Test"]);
    await exec(git, ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workspace, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", workspace, "add", "."]);
    await exec(git, ["-C", workspace, "commit", "-m", "base"]);
    await writeFile(join(workspace, "pending.txt"), "pending\n", "utf8");
    await launchServer(serverPath, "45216", dataHome, children, {
      KIMI_FAKE_NEW_SESSION_DELAY_MS: "500",
      KIMI_FAKE_NEW_SESSION_REJECT: "1",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45216", messages);

    const failedCreate = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: workspace, isolate: true } }));
    await waitForGitWorktree(git, workspace, join(dataHome, "worktrees"));
    const blocked = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "git.stage", params: { cwd: workspace, paths: ["pending.txt"] } }));
    expect((await blocked).error).toMatchObject({ message: expect.stringMatching(/Git action/i) });
    expect((await failedCreate).error).toBeDefined();
    expect((await exec(git, ["-C", workspace, "worktree", "list", "--porcelain"])).stdout.replaceAll("\\", "/").toLowerCase())
      .not.toContain(join(dataHome, "worktrees").replaceAll("\\", "/").toLowerCase());
    expect((await exec(git, ["-C", workspace, "branch", "--list", "kimi/*"])).stdout.trim()).toBe("");

    const staged = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "git.stage", params: { cwd: workspace, paths: ["pending.txt"] } }));
    expect((await staged).error).toBeUndefined();
    socket.close();
  }, 20_000);

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
    const workspace = await mkdtemp(join(tmpdir(), "kimi-server-update-git-"));
    const git = findGitBinary();
    await exec(git, ["-C", workspace, "init"]);
    await writeFile(join(workspace, "pending.txt"), "pending\n", "utf8");
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
    const blockedGit = waitFor(socket, messages, (message) => message.id === 31);
    socket.send(JSON.stringify({ id: 31, method: "git.stage", params: { cwd: workspace, paths: ["pending.txt"] } }));
    expect((await blockedGit).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });
    const confirmed = waitFor(socket, messages, (message) => message.id === 30);
    socket.send(JSON.stringify({ id: 30, method: "env.confirmUpdate", params: {} }));
    expect((await confirmed).result).toEqual({ ready: true });
    const blockedSend = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "Must wait", images: [{ name: "blocked.png", mimeType: "image/png", data: "AQID" }] } }));
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
    const terminalServer = await launchServer(serverPath, "45212", dataHome, children);
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
    first.close();
    second.close();
    const terminalServerExited = new Promise<void>((resolve) => terminalServer.once("exit", () => resolve()));
    terminalServer.kill();
    await terminalServerExited;

    await launchServer(serverPath, "45419", dataHome, children);
    const ownerMessages: Array<Record<string, unknown>> = [];
    const peerMessages: Array<Record<string, unknown>> = [];
    const owner = await connect("45419", ownerMessages);
    const peer = await connect("45419", peerMessages);
    const prepared = waitFor(owner, ownerMessages, (message) => message.id === 4);
    owner.send(JSON.stringify({ id: 4, method: "env.prepareUpdate", params: {} }));
    expect((await prepared).result).toEqual({ ready: true });
    const foreignConfirm = waitFor(peer, peerMessages, (message) => message.id === 40);
    peer.send(JSON.stringify({ id: 40, method: "env.confirmUpdate", params: {} }));
    expect((await foreignConfirm).error).toMatchObject({ message: expect.stringMatching(/only the app window/i) });
    const ownerConfirm = waitFor(owner, ownerMessages, (message) => message.id === 41);
    owner.send(JSON.stringify({ id: 41, method: "env.confirmUpdate", params: {} }));
    expect((await ownerConfirm).result).toEqual({ ready: true });
    const foreignCancel = waitFor(peer, peerMessages, (message) => message.id === 5);
    peer.send(JSON.stringify({ id: 5, method: "env.cancelUpdate", params: {} }));
    expect((await foreignCancel).error).toMatchObject({ message: expect.stringMatching(/only the app window/i) });
    const blockedStart = waitFor(peer, peerMessages, (message) => message.id === 6);
    peer.send(JSON.stringify({ id: 6, method: "terminal.start", params: { cwd: process.cwd() } }));
    expect((await blockedStart).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });
    const blockedWrite = waitFor(peer, peerMessages, (message) => message.id === 7);
    peer.send(JSON.stringify({ id: 7, method: "terminal.write", params: { sessionId, command: "echo blocked" } }));
    expect((await blockedWrite).error).toMatchObject({ message: expect.stringMatching(/update is prepared/i) });

    const ownerClosed = new Promise<void>((resolve) => owner.once("close", resolve));
    owner.close();
    await ownerClosed;
    const restarted = waitFor(peer, peerMessages, (message) => message.id === 8);
    peer.send(JSON.stringify({ id: 8, method: "terminal.start", params: { cwd: process.cwd() } }));
    expect((await restarted).error).toBeUndefined();
    peer.close();
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

  it("blocks full and partial checkpoint revert while a turn is active", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-revert-active-"));
    await launchServer(serverPath, "45301", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45301", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;

    const started = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Keep checkpoint guard active";
    });
    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    const sendReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: "Keep checkpoint guard active" } }));
    const turnId = ((await started).payload as { payload: { turnId: string } }).payload.turnId;
    await approval;
    await sendReply;

    for (const [id, method, params] of [
      [3, "checkpoints.revert", { threadId, turnId }],
      [4, "checkpoints.revertPart", { threadId, turnId, path: "package.json" }],
    ] as const) {
      const response = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method, params }));
      expect(((await response).error as { message?: string } | undefined)?.message).toMatch(/stop the active task/i);
    }

    const cancelled = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string } } | undefined;
      return event?.type === "TurnCancelled" && event.payload?.turnId === turnId;
    });
    const interrupted = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.interruptTurn", params: { threadId } }));
    expect((await interrupted).error).toBeUndefined();
    await cancelled;
    socket.close();
  });

  it("blocks full and partial checkpoint revert during queue admission", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-revert-admission-"));
    const first = await launchServer(serverPath, "45302", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45302", firstMessages);
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    await launchServer(serverPath, "45303", dataHome, children, { KIMI_FAKE_INITIALIZE_DELAY_MS: "1500" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45303", messages);
    const queued = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: "Preparing checkpoint guard" } }));
    await queued;

    const blockedImage = waitFor(socket, messages, (message) => message.id === 20);
    socket.send(JSON.stringify({ id: 20, method: "threads.sendTurn", params: { threadId, text: "Must not queue image", images: [{ name: "blocked.png", mimeType: "image/png", data: "AQID" }] } }));
    expect((await blockedImage).error).toMatchObject({ message: expect.stringMatching(/image prompts must start immediately/i) });

    for (const [id, method, params] of [
      [3, "checkpoints.revert", { threadId, turnId: "not-started" }],
      [4, "checkpoints.revertPart", { threadId, turnId: "not-started", path: "package.json" }],
    ] as const) {
      const response = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method, params }));
      expect(((await response).error as { message?: string } | undefined)?.message).toMatch(/stop the active task/i);
    }

    const interrupted = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.interruptTurn", params: { threadId } }));
    expect((await interrupted).error).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 1700));
    expect(messages.some((message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Preparing checkpoint guard";
    })).toBe(false);
    socket.close();
  }, 20_000);

  it("steers an existing queued prompt while the queue head is preparing", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-steer-admission-"));
    const first = await launchServer(serverPath, "45304", dataHome, children);
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45304", firstMessages);
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    await launchServer(serverPath, "45305", dataHome, children, { KIMI_FAKE_INITIALIZE_DELAY_MS: "1500" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45305", messages);
    const firstQueued = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: "Original queue head" } }));
    await firstQueued;
    const selectedQueued = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Selected during admission" } }));
    const queuedId = ((await selectedQueued).result as { queuedId: string }).queuedId;

    const selectedStarted = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Selected during admission";
    });
    const steerReply = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.steerQueuedTurn", params: { threadId, queuedId } }));
    expect((await steerReply).error).toBeUndefined();
    const selected = await selectedStarted;
    expect(messages.some((message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Original queue head";
    })).toBe(false);

    const turnId = (selected.payload as { payload: { turnId: string } }).payload.turnId;
    const cancelled = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string } } | undefined;
      return event?.type === "TurnCancelled" && event.payload?.turnId === turnId;
    });
    const interrupted = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.interruptTurn", params: { threadId } }));
    expect((await interrupted).error).toBeUndefined();
    await cancelled;
    socket.close();
  }, 20_000);

  it("stops locally while delayed cancellation safely replaces the runtime before continuing", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-cancel-delayed-"));
    await launchServer(serverPath, "45306", dataHome, children, {
      KIMI_FAKE_CANCEL_DELIVERY_DELAY_MS: "1500",
      KIMI_FAKE_CANCEL_REJECT: "1",
      KIMI_FAKE_CANCEL_RESPONSE_DELAY_MS: "2500",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45306", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;

    const firstStarted = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Hold the first runtime";
    });
    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    const firstReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: "Hold the first runtime" } }));
    const firstTurnId = ((await firstStarted).payload as { payload: { turnId: string } }).payload.turnId;
    await approval;
    await firstReply;

    const queuedReply = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "Start only after replacement" } }));
    await queuedReply;
    const followUpStarted = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Start only after replacement";
    });
    const firstCancelled = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string } } | undefined;
      return event?.type === "TurnCancelled" && event.payload?.turnId === firstTurnId;
    });

    const interruptReply = waitFor(socket, messages, (message) => message.id === 4);
    const interruptStartedAt = Date.now();
    socket.send(JSON.stringify({ id: 4, method: "threads.interruptTurn", params: { threadId, clearQueue: false } }));
    expect((await interruptReply).error).toBeUndefined();
    const blockedImage = waitFor(socket, messages, (message) => message.id === 20);
    socket.send(JSON.stringify({ id: 20, method: "threads.sendTurn", params: { threadId, text: "Must wait for cancellation", images: [{ name: "blocked.png", mimeType: "image/png", data: "AQID" }] } }));
    expect((await blockedImage).error).toMatchObject({ message: expect.stringMatching(/image prompts must start immediately/i) });
    expect(Date.now() - interruptStartedAt).toBeLessThan(1000);
    await firstCancelled;
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(messages.some((message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Start only after replacement";
    })).toBe(false);

    await waitFor(socket, messages, (message) => {
      const diagnostic = message.payload as { message?: string } | undefined;
      return message.channel === "server.diagnostics" && diagnostic?.message?.includes("cancel notification failed") === true;
    });
    await followUpStarted;
    const diagnosticIndex = messages.findIndex((message) => {
      const diagnostic = message.payload as { message?: string } | undefined;
      return message.channel === "server.diagnostics" && diagnostic?.message?.includes("cancel notification failed") === true;
    });
    const followUpIndex = messages.findIndex((message) => {
      const event = message.payload as { type?: string; payload?: { text?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.text === "Start only after replacement";
    });
    expect(followUpIndex).toBeGreaterThan(diagnosticIndex);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(messages.filter((message) => {
      const event = message.payload as { type?: string; payload?: { turnId?: string } } | undefined;
      return event?.type === "TurnCancelled" && event.payload?.turnId === firstTurnId;
    })).toHaveLength(1);
    socket.close();
  }, 20_000);

  it("keeps finished background tasks passive and filters legacy report queues after restart", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-passive-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-passive-"));
    const first = await launchServer(serverPath, "45307", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_BACKGROUND_FINISH_DELAY_MS: "100",
    });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45307", firstMessages);
    const bootstrap = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;

    const registered = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskRegistered");
    const finished = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskFinished");
    const foregroundCompleted = waitFor(firstSocket, firstMessages, (message) => {
      const event = message.payload as { type?: string; payload?: { stopReason?: string } } | undefined;
      return event?.type === "TurnCompleted" && event.payload?.stopReason === "end_turn";
    });
    const sendReply = waitFor(firstSocket, firstMessages, (message) => message.id === 3);
    firstSocket.send(JSON.stringify({
      id: 3,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    }));
    await sendReply;
    await registered;
    const finishedEvent = await finished;
    await foregroundCompleted;
    expect((finishedEvent.payload as { payload: { outputPath?: string } }).payload).not.toHaveProperty("outputPath");
    expect(JSON.stringify(finishedEvent)).not.toContain(kimiHome);
    type StoredBackgroundPayload = {
      taskId?: string;
      outputPath?: string;
      thread?: { backgroundTasks?: Array<{ taskId: string; outputPath?: string }> };
    };
    const storedTaskEvent = await waitForStoredEvent(dataHome, (event) => {
      const payload = event.payload as StoredBackgroundPayload;
      if (event.type === "BackgroundTaskFinished") {
        return payload.taskId === "bash-build1" && typeof payload.outputPath === "string";
      }
      return event.type === "ThreadSnapshot"
        && event.threadId === threadId
        && payload.thread?.backgroundTasks?.some((task) => task.taskId === "bash-build1" && typeof task.outputPath === "string") === true;
    });
    const storedTaskPayload = storedTaskEvent.payload as StoredBackgroundPayload;
    const outputPath = storedTaskEvent.type === "BackgroundTaskFinished"
      ? storedTaskPayload.outputPath
      : storedTaskPayload.thread?.backgroundTasks?.find((task) => task.taskId === "bash-build1")?.outputPath;
    expect(outputPath).toEqual(expect.any(String));
    await expect(access(outputPath!)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(firstMessages.filter((message) => {
      const event = message.payload as { type?: string; threadId?: string; payload?: { taskId?: string } } | undefined;
      return event?.type === "BackgroundTaskFinished" && event.threadId === threadId && event.payload?.taskId === "bash-build1";
    })).toHaveLength(1);
    expect(firstMessages.filter((message) => {
      const notification = message.payload as { type?: string; threadId?: string } | undefined;
      return message.channel === "notifications.event" && notification?.type === "background.completed" && notification.threadId === threadId;
    })).toHaveLength(1);
    expect(firstMessages.some((message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    })).toBe(false);

    const firstList = waitFor(firstSocket, firstMessages, (message) => message.id === 4);
    firstSocket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    const beforeRestart = ((await firstList).result as { threads: Array<{
      threadId: string;
      queue: Array<{ origin?: string }>;
      backgroundTasks: Array<{ taskId: string; status: string; outputPath?: string }>;
    }> }).threads.find((candidate) => candidate.threadId === threadId);
    expect(beforeRestart?.queue).toEqual([]);
    expect(beforeRestart?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: "bash-build1", status: "completed" }),
    ]);
    expect(beforeRestart?.backgroundTasks[0]).not.toHaveProperty("outputPath");
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    await writeFile(join(dataHome, "pending-queues.json"), JSON.stringify({
      [threadId]: [{
        queuedId: crypto.randomUUID(),
        text: "A background task from the previous request has finished.",
        mentions: [],
        mode: "queue",
        createdAt: new Date().toISOString(),
        origin: "background_task",
      }],
    }), "utf8");

    await launchServer(serverPath, "45308", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45308", secondMessages);
    const secondBootstrap = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "env.bootstrap", params: {} }));
    await secondBootstrap;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(secondMessages.some((message) => {
      const event = message.payload as { type?: string; payload?: { origin?: string } } | undefined;
      return event?.type === "TurnStarted" && event.payload?.origin === "background_task";
    })).toBe(false);

    const secondList = waitFor(secondSocket, secondMessages, (message) => message.id === 6);
    secondSocket.send(JSON.stringify({ id: 6, method: "threads.list", params: {} }));
    const restored = ((await secondList).result as { threads: Array<{
      threadId: string;
      queue: Array<{ origin?: string }>;
      backgroundTasks: Array<{ taskId: string; status: string; outputPath?: string }>;
    }> }).threads.find((candidate) => candidate.threadId === threadId);
    expect(restored?.queue).toEqual([]);
    expect(restored?.backgroundTasks).toEqual([
      expect.objectContaining({ taskId: "bash-build1", status: "completed" }),
    ]);
    expect(restored?.backgroundTasks[0]).not.toHaveProperty("outputPath");
    secondSocket.close();
  }, 30_000);

  it("enforces the 20-per-thread and 100-global background-task caps across concurrent registrations", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-global-cap-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-background-global-cap-"));
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    const seeded = [
      { threadId: "cap-a", sessionId: "cap-a", running: 19 },
      { threadId: "cap-b", sessionId: "cap-b", running: 19 },
      { threadId: "cap-c", sessionId: "cap-c", running: 20 },
      { threadId: "cap-d", sessionId: "cap-d", running: 20 },
      { threadId: "cap-e", sessionId: "cap-e", running: 20 },
      { threadId: "cap-empty", sessionId: "cap-empty", running: 0 },
    ];
    for (const [threadIndex, seed] of seeded.entries()) {
      await store.append(seed.threadId, {
        type: "ThreadCreated",
        payload: { sessionId: seed.sessionId, provider: "kimi", cwd: process.cwd(), kind: "project", title: seed.threadId },
      });
      for (let index = 0; index < seed.running; index += 1) {
        await store.append(seed.threadId, {
          type: "BackgroundTaskRegistered",
          payload: {
            taskId: `bash-seed${threadIndex}-${index}`,
            queuedId: crypto.randomUUID(),
            turnId: "seed-turn",
            description: "Seeded running task",
            kimiHome,
          },
        });
      }
    }
    await store.drain();

    await launchServer(serverPath, "45425", dataHome, children, { KIMI_CODE_HOME: kimiHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45425", messages);
    const run = async (id: number, threadId: string) => {
      const completed = waitFor(socket, messages, (message) => {
        const event = message.payload as { type?: string; threadId?: string } | undefined;
        return event?.type === "TurnCompleted" && event.threadId === threadId;
      });
      const sent = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method: "threads.sendTurn", params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_PENDING__" } }));
      expect((await sent).error).toBeUndefined();
      await completed;
    };

    await Promise.all([run(1, "cap-a"), run(2, "cap-b")]);
    for (const threadId of ["cap-a", "cap-b"]) {
      expect(messages.filter((message) => {
        const event = message.payload as { type?: string; threadId?: string; payload?: { taskId?: string } } | undefined;
        return event?.type === "BackgroundTaskRegistered" && event.threadId === threadId && event.payload?.taskId === "bash-build1";
      })).toHaveLength(1);
    }

    await run(3, "cap-empty");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(messages.some((message) => {
      const event = message.payload as { type?: string; threadId?: string; payload?: { taskId?: string } } | undefined;
      return event?.type === "BackgroundTaskRegistered" && event.threadId === "cap-empty" && event.payload?.taskId === "bash-build1";
    })).toBe(false);

    const listed = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    const threads = ((await listed).result as { threads: Array<{ threadId: string; backgroundTasks: Array<{ status: string }> }> }).threads;
    const running = (threadId: string) => threads.find((thread) => thread.threadId === threadId)?.backgroundTasks.filter((task) => task.status === "running").length;
    expect(running("cap-a")).toBe(20);
    expect(running("cap-b")).toBe(20);
    expect(running("cap-empty")).toBe(0);
    expect(threads.reduce((total, thread) => total + thread.backgroundTasks.filter((task) => task.status === "running").length, 0)).toBe(100);
    socket.close();
  }, 30_000);

  it("drops delayed diagnostics from a runtime after that runtime is replaced", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-stale-diagnostic-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-stale-diagnostic-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-stale-diagnostic-"));
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "project-command" } } }));
    const child = await launchServer(serverPath, "45426", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_STALE_DIAGNOSTIC_DELAY_MS: "300",
    });
    const stdout: string[] = [];
    child.stdout?.on("data", (chunk) => stdout.push(String(chunk)));
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45426", messages);

    const capabilities = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "capabilities.list", params: { cwd: workspace } }));
    const fingerprint = ((await capabilities).result as { projectMcp: { fingerprint: string } }).projectMcp.fingerprint;
    const created = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: workspace } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const completed = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return event?.type === "TurnCompleted" && event.threadId === threadId;
    });
    socket.send(JSON.stringify({ id: 3, method: "threads.sendTurn", params: { threadId, text: "__STALE_RUNTIME_DIAGNOSTIC__" } }));
    await completed;
    await new Promise((resolve) => setTimeout(resolve, 50));

    const approved = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "mcp.approveProject", params: { cwd: workspace, fingerprint } }));
    expect((await approved).error).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stdout.join("")).not.toContain("__STALE_RUNTIME_DIAGNOSTIC__");
    socket.close();
  }, 20_000);

  it("rechecks a runtime source fence inside serialized background-task registration", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-stale-background-registration-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-stale-background-registration-"));
    await launchServer(serverPath, "45427", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_BACKGROUND_REGISTRATION_DELAY_MS: "600",
      KIMI_FAKE_CANCEL_REJECT: "1",
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45427", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;

    const toolCreated = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return event?.type === "ToolCallCreated" && event.threadId === threadId;
    });
    const sent = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({
      id: 2,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    }));
    expect((await sent).error).toBeUndefined();
    await toolCreated;

    const cancelled = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return event?.type === "TurnCancelled" && event.threadId === threadId;
    });
    const interrupted = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.interruptTurn", params: { threadId } }));
    expect((await interrupted).error).toBeUndefined();
    await cancelled;
    await new Promise((resolve) => setTimeout(resolve, 900));

    expect(messages.some((message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return event?.type === "BackgroundTaskRegistered" && event.threadId === threadId;
    })).toBe(false);
    const listed = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    const thread = ((await listed).result as { threads: Array<{ threadId: string; backgroundTasks: unknown[] }> })
      .threads.find((candidate) => candidate.threadId === threadId);
    expect(thread?.backgroundTasks).toEqual([]);
    socket.close();
  }, 20_000);

  it("closes and awaits a runtime that is still initializing during shutdown", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-shutdown-runtime-start-"));
    const child = await launchServer(serverPath, "45428", dataHome, children, {
      KIMI_FAKE_INITIALIZE_DELAY_MS: "5000",
      KIMI_FAKE_SHUTDOWN_AFTER_MS: "1000",
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45428", messages);
    socket.send(JSON.stringify({ id: 1, method: "env.bootstrap", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const snapshot = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "diagnostics.snapshot", params: {} }));
    expect(((await snapshot).result as { blockers: { runtimeStarts: number } }).blockers.runtimeStarts).toBe(1);

    const exit = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
    const exitCode = await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Server did not finish shutdown while the runtime was starting")), 4_000)),
    ]);
    expect(exitCode).not.toBeNull();
    if (exitCode !== 0) expect(stderr.join("")).toMatch(/terminate ACP process tree|taskkill/i);
    expect(child.exitCode).toBe(exitCode);
  }, 10_000);

  it("quiesces runtime callbacks, prompt settlement, and background mutations before the final shutdown flush", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-shutdown-quiescence-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-shutdown-quiescence-"));
    const child = await launchServer(serverPath, "45429", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_BACKGROUND_REGISTRATION_DELAY_MS: "2500",
      KIMI_FAKE_SHUTDOWN_STDIN: "1",
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45429", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const toolCreated = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return event?.type === "ToolCallCreated" && event.threadId === threadId;
    });
    socket.send(JSON.stringify({
      id: 2,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    }));
    await toolCreated;
    await triggerFakeShutdown(child);
    socket.close();

    const exit = new Promise<number | null>((resolveExit) => child.once("exit", (code) => resolveExit(code)));
    const exitCode = await Promise.race([
      exit,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Server did not quiesce runtime work before shutdown")), 6_000)),
    ]);
    expect(exitCode).not.toBeNull();
    if (exitCode !== 0) expect(stderr.join("")).toMatch(/terminate ACP process tree|taskkill/i);

    const events = (await readFile(join(dataHome, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as {
        threadId: string;
        type: string;
        payload?: { thread?: { running: boolean; stopReason?: string; turns: Array<{ completedAt?: string }>; backgroundTasks: unknown[] } };
      });
    expect(events.some((event) => event.threadId === threadId && event.type === "BackgroundTaskRegistered")).toBe(false);
    const snapshot = events.findLast((event) => event.threadId === threadId && event.type === "ThreadSnapshot")?.payload?.thread;
    expect(snapshot).toMatchObject({ running: false, stopReason: "end_turn", backgroundTasks: [] });
    expect(snapshot?.turns.at(-1)?.completedAt).toEqual(expect.any(String));
  }, 20_000);

  it("fences preview reconnects and closes every bridge socket as soon as shutdown begins", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-shutdown-preview-"));
    const token = "preview-shutdown-token";
    const child = await launchServer(serverPath, "45430", dataHome, children, {
      KIMI_PREVIEW_BRIDGE_TOKEN: token,
      KIMI_FAKE_QUEUE_INSERTION_DELAY_MS: "1200",
      KIMI_FAKE_SCHEDULE_RESULT_DELAY_MS: "500",
      KIMI_FAKE_SHUTDOWN_STDIN: "1",
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45430", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const scheduled = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({
      id: 2,
      method: "schedules.create",
      params: { threadId, name: "Hold shutdown drain", text: "Run after restart", recurrence: "once", nextRunAt: new Date(Date.now() + 60_000).toISOString() },
    }));
    const scheduleId = ((await scheduled).result as { schedule: { id: string } }).schedule.id;
    const preview = new WebSocket(`ws://127.0.0.1:45430/?preview-token=${token}`);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      preview.once("open", resolveOpen);
      preview.once("error", rejectOpen);
    });
    const previewClosed = new Promise<void>((resolveClose) => preview.once("close", () => resolveClose()));
    socket.send(JSON.stringify({ id: 3, method: "schedules.run", params: { id: scheduleId } }));
    const blockers = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "diagnostics.snapshot", params: {} }));
    expect(((await blockers).result as { blockers: { queueInsertions: number } }).blockers.queueInsertions).toBe(1);
    await triggerFakeShutdown(child);

    await Promise.race([
      previewClosed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Preview bridge remained connected while durable work drained")), 2_200)),
    ]);
    const reconnect = new WebSocket(`ws://127.0.0.1:45430/?preview-token=${token}`);
    const reconnectOutcome = await Promise.race([
      new Promise<"open" | "rejected">((resolveOutcome) => {
        reconnect.once("open", () => resolveOutcome("open"));
        reconnect.once("error", () => resolveOutcome("rejected"));
        reconnect.once("close", () => resolveOutcome("rejected"));
      }),
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 1_000)),
    ]);
    expect(reconnectOutcome).toBe("rejected");
    reconnect.terminate();

    const exitCode = await Promise.race([
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Preview bridge kept the server alive during shutdown")), 6_000)),
    ]);
    expect(exitCode).not.toBeNull();
    if (exitCode !== 0) expect(stderr.join("")).toMatch(/terminate ACP process tree|taskkill/i);
    preview.terminate();
  }, 20_000);

  it("drains an admitted scheduled queue write before shutdown and recovers it exactly once", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-shutdown-schedule-"));
    const first = await launchServer(serverPath, "45431", dataHome, children, {
      KIMI_FAKE_QUEUE_INSERTION_DELAY_MS: "900",
      KIMI_FAKE_SCHEDULE_RESULT_DELAY_MS: "400",
      KIMI_FAKE_SHUTDOWN_STDIN: "1",
    });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45431", firstMessages);
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const scheduled = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({
      id: 2,
      method: "schedules.create",
      params: {
        threadId,
        name: "Survive shutdown",
        text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__",
        recurrence: "once",
        nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }));
    const scheduleId = ((await scheduled).result as { schedule: { id: string } }).schedule.id;
    firstSocket.send(JSON.stringify({ id: 3, method: "schedules.run", params: { id: scheduleId } }));
    await waitForBlocker(firstSocket, firstMessages, "queueInsertions");
    await triggerFakeShutdown(first);

    const firstExit = await Promise.race([
      new Promise<number | null>((resolveExit) => first.once("exit", resolveExit)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Shutdown did not drain the admitted schedule write")), 5_000)),
    ]);
    expect(firstExit).toBe(0);
    const persistedQueues = JSON.parse(await readFile(join(dataHome, "pending-queues.json"), "utf8")) as Record<string, Array<{ text: string }>>;
    expect(persistedQueues[threadId]).toEqual([expect.objectContaining({ text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" })]);
    const persistedSchedules = JSON.parse(await readFile(join(dataHome, "schedules.json"), "utf8")) as { schedules: Array<{ id: string; enabled: boolean; lastResult?: string }> };
    expect(persistedSchedules.schedules.find((schedule) => schedule.id === scheduleId)).toMatchObject({ enabled: true, lastResult: "queued" });

    await launchServer(serverPath, "45432", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45432", secondMessages);
    const completed = waitFor(secondSocket, secondMessages, (message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return event?.type === "TurnCompleted" && event.threadId === threadId;
    });
    const bootstrapped = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "env.bootstrap", params: {} }));
    await bootstrapped;
    await completed;
    const events = (await readFile(join(dataHome, "events.jsonl"), "utf8")).trim().split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line) as { threadId: string; type: string });
    expect(events.filter((event) => event.threadId === threadId && event.type === "TurnStarted")).toHaveLength(1);
    const listed = waitFor(secondSocket, secondMessages, (message) => message.id === 5);
    secondSocket.send(JSON.stringify({ id: 5, method: "threads.list", params: {} }));
    const queue = ((await listed).result as { threads: Array<{ threadId: string; queue: unknown[] }> }).threads.find((thread) => thread.threadId === threadId)?.queue;
    expect(queue).toEqual([]);
    secondSocket.close();
  }, 25_000);

  it("drains a normal queue admission across shutdown without a duplicate start", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-shutdown-admission-"));
    const first = await launchServer(serverPath, "45433", dataHome, children, {
      KIMI_FAKE_QUEUE_ADMISSION_DELAY_MS: "900",
      KIMI_FAKE_SHUTDOWN_STDIN: "1",
    });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45433", firstMessages);
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const accepted = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({
      id: 2,
      method: "threads.sendTurn",
      params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    }));
    expect((await accepted).result).toMatchObject({ accepted: true });
    await waitForBlocker(firstSocket, firstMessages, "queueStarts");
    await triggerFakeShutdown(first);

    const firstExit = await Promise.race([
      new Promise<number | null>((resolveExit) => first.once("exit", resolveExit)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Shutdown did not drain the admitted queue start")), 5_000)),
    ]);
    expect(firstExit).toBe(0);
    const beforeRestart = (await readFile(join(dataHome, "events.jsonl"), "utf8")).trim().split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line) as { threadId: string; type: string });
    expect(beforeRestart.filter((event) => event.threadId === threadId && event.type === "TurnStarted")).toHaveLength(0);

    await launchServer(serverPath, "45434", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45434", secondMessages);
    const completed = waitFor(secondSocket, secondMessages, (message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return event?.type === "TurnCompleted" && event.threadId === threadId;
    });
    const bootstrapped = waitFor(secondSocket, secondMessages, (message) => message.id === 3);
    secondSocket.send(JSON.stringify({ id: 3, method: "env.bootstrap", params: {} }));
    await bootstrapped;
    await completed;
    const afterRestart = (await readFile(join(dataHome, "events.jsonl"), "utf8")).trim().split(/\r?\n/u).filter(Boolean)
      .map((line) => JSON.parse(line) as { threadId: string; type: string });
    expect(afterRestart.filter((event) => event.threadId === threadId && event.type === "TurnStarted")).toHaveLength(1);
    const listed = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "threads.list", params: {} }));
    const projection = ((await listed).result as { threads: Array<{ threadId: string; queue: unknown[]; running: boolean }> }).threads.find((thread) => thread.threadId === threadId);
    expect(projection).toMatchObject({ queue: [], running: false });
    secondSocket.close();
  }, 25_000);

  it("drains an admitted thread creation into an exact restart-safe reservation", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-shutdown-creation-"));
    const creationId = crypto.randomUUID();
    const first = await launchServer(serverPath, "45460", dataHome, children, {
      KIMI_FAKE_NEW_SESSION_DELAY_MS: "2000",
      KIMI_FAKE_SHUTDOWN_STDIN: "1",
    });
    const stderr: string[] = [];
    first.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45460", firstMessages);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd(), creationId } }));
    await waitForCreationReservation(dataHome, creationId, (reservation) => reservation.stage === "requesting" && !reservation.sessionId);
    await triggerFakeShutdown(first);

    const firstExit = await Promise.race([
      new Promise<number | null>((resolveExit) => first.once("exit", resolveExit)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Shutdown did not drain the admitted thread creation")), 5_000)),
    ]);
    expect(firstExit).not.toBeNull();
    if (firstExit !== 0) expect(stderr.join("")).toMatch(/terminate ACP process tree|taskkill/i);
    const journal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as {
      reservations: Array<{ creationId: string; stage: string; sessionId?: string }>;
    };
    expect(journal.reservations).toContainEqual(expect.objectContaining({ creationId, stage: "requesting" }));
    expect(journal.reservations.find((reservation) => reservation.creationId === creationId)).not.toHaveProperty("sessionId");

    await launchServer(serverPath, "45461", dataHome, children);
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45461", secondMessages);
    const retried = waitFor(secondSocket, secondMessages, (message) => message.id === 2);
    secondSocket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: process.cwd(), creationId } }));
    expect((await retried).error).toMatchObject({ message: expect.stringMatching(/delivery is uncertain.*refusing/i) });
    const listed = waitFor(secondSocket, secondMessages, (message) => message.id === 3);
    secondSocket.send(JSON.stringify({ id: 3, method: "threads.list", params: {} }));
    expect(((await listed).result as { threads: unknown[] }).threads).toEqual([]);
    secondSocket.close();
  }, 25_000);

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

  it("requires exact project MCP approval and attaches only the approved fingerprint", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-mcp-policy-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-mcp-policy-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-mcp-policy-"));
    const sessionLog = join(dataHome, "mcp-sessions.jsonl");
    await mkdir(join(workspace, ".git"));
    await writeFile(join(kimiHome, "mcp.json"), JSON.stringify({ mcpServers: {
      "user-tool": { command: "user-command", env: { TOKEN: "user-secret" } },
    } }));
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: {
      "project-tool": { command: "project-command", env: { TOKEN: "project-secret" } },
    } }));
    await launchServer(serverPath, "45401", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_NEW_SESSION_MCP_LOG: sessionLog,
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45401", messages);

    const requiredReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "capabilities.list", params: { cwd: workspace } }));
    const required = (await requiredReply).result as { projectMcp: { fingerprint: string; status: string } };
    expect(required.projectMcp.status).toBe("required");

    const approvedReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "mcp.approveProject", params: { cwd: workspace, fingerprint: required.projectMcp.fingerprint } }));
    expect((await approvedReply).result).toMatchObject({ status: "approved", fingerprint: required.projectMcp.fingerprint });
    const persistedApproval = await readFile(join(dataHome, "project-mcp-approvals.json"), "utf8");
    expect(persistedApproval).toContain(required.projectMcp.fingerprint);
    expect(persistedApproval).not.toMatch(/user-secret|project-secret|user-command|project-command/);

    const approvedCapabilitiesReply = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "capabilities.list", params: { cwd: workspace } }));
    expect(((await approvedCapabilitiesReply).result as { projectMcp: { status: string } }).projectMcp.status).toBe("approved");
    const firstCreate = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.create", params: { cwd: workspace } }));
    expect((await firstCreate).error).toBeUndefined();

    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: {
      "rotated-tool": { command: "rotated-command", env: { TOKEN: "rotated-secret" } },
    } }));
    const changedReply = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "capabilities.list", params: { cwd: workspace } }));
    const changed = (await changedReply).result as { projectMcp: { fingerprint: string; status: string } };
    expect(changed.projectMcp).toMatchObject({ status: "changed" });
    expect(changed.projectMcp.fingerprint).not.toBe(required.projectMcp.fingerprint);

    const staleApproval = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "mcp.approveProject", params: { cwd: workspace, fingerprint: required.projectMcp.fingerprint } }));
    expect((await staleApproval).error).toMatchObject({ message: expect.stringMatching(/changed.*review/i) });
    const unapprovedCreate = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "threads.create", params: { cwd: workspace } }));
    expect((await unapprovedCreate).error).toBeUndefined();

    const reapprovedReply = waitFor(socket, messages, (message) => message.id === 8);
    socket.send(JSON.stringify({ id: 8, method: "mcp.approveProject", params: { cwd: workspace, fingerprint: changed.projectMcp.fingerprint } }));
    expect((await reapprovedReply).result).toMatchObject({ status: "approved", fingerprint: changed.projectMcp.fingerprint });
    const reapprovedCreate = waitFor(socket, messages, (message) => message.id === 9);
    socket.send(JSON.stringify({ id: 9, method: "threads.create", params: { cwd: workspace } }));
    expect((await reapprovedCreate).error).toBeUndefined();

    const revokedReply = waitFor(socket, messages, (message) => message.id === 10);
    socket.send(JSON.stringify({ id: 10, method: "mcp.revokeProject", params: { cwd: workspace } }));
    expect((await revokedReply).result).toMatchObject({ revoked: true, status: "required" });
    const revokedCreate = waitFor(socket, messages, (message) => message.id === 11);
    socket.send(JSON.stringify({ id: 11, method: "threads.create", params: { cwd: workspace } }));
    expect((await revokedCreate).error).toBeUndefined();

    const log = await waitForFileText(sessionLog, (text) => text.trim().split(/\r?\n/).length === 4);
    const canonicalWorkspace = await realpath(workspace);
    const sessions = log.trim().split(/\r?\n/).map((line) => JSON.parse(line) as { cwd: string; kimiCodeHome: string; mcpServers: string[] });
    expect(sessions).toEqual([
      { cwd: canonicalWorkspace, kimiCodeHome: await realpath(kimiHome), mcpServers: ["kimi-desktop-preview", "project-tool", "user-tool"] },
      { cwd: canonicalWorkspace, kimiCodeHome: await realpath(kimiHome), mcpServers: ["kimi-desktop-preview", "user-tool"] },
      { cwd: canonicalWorkspace, kimiCodeHome: await realpath(kimiHome), mcpServers: ["kimi-desktop-preview", "rotated-tool", "user-tool"] },
      { cwd: canonicalWorkspace, kimiCodeHome: await realpath(kimiHome), mcpServers: ["kimi-desktop-preview", "user-tool"] },
    ]);
    socket.close();
  }, 20_000);

  it("uses the selected Kimi home for MCP and rejects WSL project approval", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-mcp-instances-"));
    const defaultHome = await mkdtemp(join(tmpdir(), "kimi-home-mcp-default-"));
    const namedHome = await mkdtemp(join(tmpdir(), "kimi-home-mcp-named-"));
    const siblingHome = await mkdtemp(join(tmpdir(), "kimi-home-mcp-sibling-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-mcp-instances-"));
    const sessionLog = join(dataHome, "mcp-sessions.jsonl");
    await mkdir(join(workspace, ".git"));
    await writeFile(join(defaultHome, "mcp.json"), JSON.stringify({ mcpServers: { "default-user": { command: "default-command" } } }));
    await writeFile(join(namedHome, "mcp.json"), JSON.stringify({ mcpServers: { "named-user": { command: "named-command" } } }));
    await writeFile(join(siblingHome, "mcp.json"), JSON.stringify({ mcpServers: { "sibling-user": { command: "sibling-command" } } }));
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { "project-named": { command: "project-command" } } }));
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "named", name: "Named", provider: "kimi", environment: { KIMI_CODE_HOME: namedHome } },
      { id: "sibling", name: "Sibling", provider: "kimi", environment: { KIMI_CODE_HOME: siblingHome } },
      { id: "wsl", name: "WSL", provider: "kimi", environment: {}, wsl: { distribution: "Ubuntu", binary: "/usr/bin/kimi" } },
    ]));
    await launchServer(serverPath, "45402", dataHome, children, {
      KIMI_CODE_HOME: defaultHome,
      KIMI_FAKE_NEW_SESSION_MCP_LOG: sessionLog,
      SystemRoot: dataHome,
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45402", messages);

    const namedReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "capabilities.list", params: { cwd: workspace, instanceId: "named" } }));
    const named = (await namedReply).result as {
      instanceId: string;
      mcpServers: Array<{ name: string }>;
      projectMcp: { fingerprint: string; status: string };
    };
    expect(named.instanceId).toBe("named");
    expect(named.mcpServers.map((server) => server.name)).toContain("named-user");
    expect(named.mcpServers.map((server) => server.name)).not.toContain("default-user");

    for (const [id, instanceId] of [[2, "named"], [3, "sibling"]] as const) {
      const created = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method: "threads.create", params: { cwd: workspace, instanceId } }));
      expect((await created).error).toBeUndefined();
    }
    const readyReply = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "providers.list", params: {} }));
    const readyInstances = ((await readyReply).result as { instances: Array<{ id: string; runtimeReady: boolean }> }).instances;
    expect(readyInstances).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "named", runtimeReady: true }),
      expect.objectContaining({ id: "sibling", runtimeReady: true }),
    ]));

    const approvedReply = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "mcp.approveProject", params: { cwd: workspace, instanceId: "named", fingerprint: named.projectMcp.fingerprint } }));
    expect((await approvedReply).error).toBeUndefined();
    const resetReply = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "providers.list", params: {} }));
    const resetInstances = ((await resetReply).result as { instances: Array<{ id: string; runtimeReady: boolean }> }).instances;
    expect(resetInstances).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "named", runtimeReady: false }),
      expect.objectContaining({ id: "sibling", runtimeReady: false }),
    ]));

    const createReply = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "threads.create", params: { cwd: workspace, instanceId: "named" } }));
    expect((await createReply).error).toBeUndefined();
    const logged = await waitForFileText(sessionLog, (text) => text.trim().split(/\r?\n/).length === 3);
    const sessions = logged.trim().split(/\r?\n/).map((line) => JSON.parse(line) as {
      cwd: string;
      kimiCodeHome: string;
      mcpServers: string[];
    });
    const canonicalWorkspace = await realpath(workspace);
    expect(sessions).toEqual([
      { cwd: canonicalWorkspace, kimiCodeHome: await realpath(namedHome), mcpServers: ["kimi-desktop-preview", "named-user"] },
      { cwd: canonicalWorkspace, kimiCodeHome: await realpath(siblingHome), mcpServers: ["kimi-desktop-preview", "sibling-user"] },
      { cwd: canonicalWorkspace, kimiCodeHome: await realpath(namedHome), mcpServers: ["kimi-desktop-preview", "named-user", "project-named"] },
    ]);

    const wslReply = waitFor(socket, messages, (message) => message.id === 8);
    socket.send(JSON.stringify({ id: 8, method: "capabilities.list", params: { cwd: workspace, instanceId: "wsl" } }));
    const wslCapabilities = (await wslReply).result as {
      projectMcp: { status: string; approvable: boolean };
      mcpServers: Array<{ name: string }>;
      plugins: unknown[];
      skills: unknown[];
      roots: { plugins: string; mcp: string; skills: string };
    };
    expect(wslCapabilities.projectMcp).toMatchObject({ status: "unsupported", approvable: false });
    expect(wslCapabilities).toMatchObject({ mcpServers: [], plugins: [], skills: [], roots: { plugins: "", mcp: "", skills: "" } });
    expect(JSON.stringify(wslCapabilities)).not.toContain("default-user");
    expect(JSON.stringify(wslCapabilities)).not.toContain(defaultHome);
    const wslApproval = waitFor(socket, messages, (message) => message.id === 9);
    socket.send(JSON.stringify({ id: 9, method: "mcp.approveProject", params: { cwd: workspace, instanceId: "wsl", fingerprint: named.projectMcp.fingerprint } }));
    expect((await wslApproval).error).toMatchObject({ message: expect.stringMatching(/not supported for WSL/i) });
    socket.close();
  }, 20_000);

  it("marks unsupported WSL and removed-instance background tasks lost without reading the default Windows home", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-wsl-background-"));
    const defaultHome = await mkdtemp(join(tmpdir(), "kimi-home-wsl-background-"));
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "wsl", name: "WSL", provider: "kimi", environment: {}, wsl: { distribution: "Ubuntu", binary: "/usr/bin/kimi" } },
    ]));
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append("wsl-background-thread", {
      type: "ThreadCreated",
      payload: { sessionId: "wsl-collision", provider: "kimi", instanceId: "wsl", cwd: process.cwd(), kind: "project", title: "WSL task" },
    });
    await store.append("wsl-background-thread", {
      type: "BackgroundTaskRegistered",
      payload: { taskId: "bash-build1", queuedId: crypto.randomUUID(), turnId: "turn-wsl", description: "WSL build" },
    });
    await store.append("removed-background-thread", {
      type: "ThreadCreated",
      payload: { sessionId: "removed-instance", provider: "kimi", instanceId: "removed", cwd: process.cwd(), kind: "project", title: "Removed instance task" },
    });
    await store.append("removed-background-thread", {
      type: "BackgroundTaskRegistered",
      payload: { taskId: "bash-build2", queuedId: crypto.randomUUID(), turnId: "turn-removed", description: "Removed instance build" },
    });
    await store.append("legacy-background-thread", {
      type: "ThreadCreated",
      payload: { sessionId: "legacy-home", provider: "kimi", cwd: process.cwd(), kind: "project", title: "Legacy task without home" },
    });
    await store.append("legacy-background-thread", {
      type: "BackgroundTaskRegistered",
      payload: { taskId: "bash-build3", queuedId: crypto.randomUUID(), turnId: "turn-legacy", description: "Legacy build" },
    });
    const taskPath = join(defaultHome, "sessions", "wd-test", "session_wsl-collision", "agents", "main", "tasks", "bash-build1.json");
    await mkdir(dirname(taskPath), { recursive: true });
    await writeFile(taskPath, JSON.stringify({
      taskId: "bash-build1", description: "Windows collision", status: "completed", detached: true, endedAt: Date.now(), exitCode: 0,
    }), "utf8");

    await launchServer(serverPath, "45411", dataHome, children, { KIMI_CODE_HOME: defaultHome, SystemRoot: dataHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45411", messages);
    const listed = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.list", params: {} }));
    const threads = ((await listed).result as {
      threads: Array<{ threadId: string; backgroundTasks: Array<{ status: string; outputPath?: string; reportCancelledAt?: string }> }>;
    }).threads;
    for (const threadId of ["wsl-background-thread", "removed-background-thread", "legacy-background-thread"]) {
      expect(threads.find((candidate) => candidate.threadId === threadId)?.backgroundTasks).toEqual([
        expect.objectContaining({ status: "lost", reportCancelledAt: expect.any(String) }),
      ]);
      expect(threads.find((candidate) => candidate.threadId === threadId)?.backgroundTasks[0]?.outputPath).toBeUndefined();
    }
    for (const [id, threadId] of [[2, "wsl-background-thread"], [3, "removed-background-thread"], [4, "legacy-background-thread"]] as const) {
      const deleted = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method: "threads.delete", params: { threadId } }));
      expect((await deleted).error).toBeUndefined();
    }
    socket.close();
  });

  it("keeps background polling bound to its registered Kimi home across restart", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-background-home-binding-"));
    const homeA = await mkdtemp(join(tmpdir(), "kimi-home-background-a-"));
    const homeB = await mkdtemp(join(tmpdir(), "kimi-home-background-b-"));
    const first = await launchServer(serverPath, "45414", dataHome, children, { KIMI_CODE_HOME: homeA });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45414", firstMessages);
    const created = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    firstSocket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const thread = ((await created).result as { thread: { threadId: string; sessionId: string } }).thread;
    const registered = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskRegistered");
    const completed = waitFor(firstSocket, firstMessages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCompleted");
    firstSocket.send(JSON.stringify({
      id: 2,
      method: "threads.sendTurn",
      params: { threadId: thread.threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_PENDING__" },
    }));
    const registeredEvent = await registered;
    await completed;
    expect(JSON.stringify(registeredEvent)).not.toContain(homeA);
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    const taskId = String((registeredEvent.payload as { payload: { taskId: string } }).payload.taskId);
    const sessionDirectory = thread.sessionId.startsWith("session_") ? thread.sessionId : `session_${thread.sessionId}`;
    const collisionTaskPath = join(homeB, "sessions", "wd-test", sessionDirectory, "agents", "main", "tasks", `${taskId}.json`);
    const collisionOutputPath = join(dirname(collisionTaskPath), taskId, "output.log");
    await mkdir(dirname(collisionOutputPath), { recursive: true });
    await writeFile(collisionOutputPath, "WRONG HOME", "utf8");
    await writeFile(collisionTaskPath, JSON.stringify({
      taskId, description: "Colliding task", status: "completed", detached: true, endedAt: Date.now(), exitCode: 0,
    }), "utf8");

    await launchServer(serverPath, "45415", dataHome, children, { KIMI_CODE_HOME: homeB });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45415", secondMessages);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondMessages.some((message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskFinished")).toBe(false);
    const listed = waitFor(secondSocket, secondMessages, (message) => message.id === 3);
    secondSocket.send(JSON.stringify({ id: 3, method: "threads.list", params: {} }));
    const restored = ((await listed).result as {
      threads: Array<{ threadId: string; backgroundTasks: Array<{ status: string; outputPath?: string; kimiHome?: string }> }>;
    }).threads.find((candidate) => candidate.threadId === thread.threadId);
    expect(restored?.backgroundTasks).toEqual([expect.objectContaining({ status: "running" })]);
    expect(restored?.backgroundTasks[0]).not.toHaveProperty("kimiHome");
    expect(restored?.backgroundTasks[0]?.outputPath).toBeUndefined();
    secondSocket.close();
  }, 20_000);

  it("keeps named Kimi homes private in session exports", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-export-named-home-"));
    const defaultHome = await mkdtemp(join(tmpdir(), "kimi-home-export-default-"));
    const namedHome = resolve(process.cwd(), "..", "outside-private-kimi-home");
    const namedXdgHome = resolve(process.cwd(), "..", "outside-private-xdg-home");
    const namedBinary = resolve(process.cwd(), "..", "outside-private-kimi-binary.exe");
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "named", name: "Named", provider: "kimi", binary: namedBinary, environment: { KIMI_CODE_HOME: namedHome, XDG_CONFIG_HOME: namedXdgHome } },
    ]));
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append("named-export-thread", {
      type: "ThreadCreated",
      payload: { sessionId: "named-export", provider: "kimi", instanceId: "named", cwd: process.cwd(), kind: "project", title: "Named export" },
    });
    await store.append("named-export-thread", {
      type: "BackgroundTaskRegistered",
      payload: { taskId: "bash-export1", queuedId: crypto.randomUUID(), turnId: "turn-export", description: "Export", kimiHome: namedHome },
    });
    await store.append("named-export-thread", {
      type: "BackgroundTaskFinished",
      payload: { taskId: "bash-export1", status: "completed", outputPath: join(namedHome, "sessions", "private-output.log") },
    });
    await store.append("named-export-thread", {
      type: "TurnStarted",
      payload: { turnId: "turn-private-runtime", text: "Fail privately" },
    });
    await store.append("named-export-thread", {
      type: "TurnCompleted",
      payload: { turnId: "turn-private-runtime", stopReason: "error", error: `spawn ${namedBinary} failed using ${namedXdgHome}` },
    });

    await launchServer(serverPath, "45416", dataHome, children, { KIMI_CODE_HOME: defaultHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45416", messages);
    const exported = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.export", params: { threadIds: ["named-export-thread"] } }));
    const path = ((await exported).result as { path: string }).path;
    const contents = await readFile(path, "utf8");
    expect(contents).not.toContain(namedHome);
    expect(contents).not.toContain(namedXdgHome);
    expect(contents).not.toContain(namedBinary);
    expect(contents).not.toContain("kimiHome");
    socket.close();
  });

  it("reads named-instance session usage only from that instance home", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-named-usage-"));
    const defaultHome = await mkdtemp(join(tmpdir(), "kimi-home-usage-default-"));
    const namedHome = await mkdtemp(join(tmpdir(), "kimi-home-usage-named-"));
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "named", name: "Named", provider: "kimi", environment: { KIMI_CODE_HOME: namedHome } },
    ]));
    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append("named-usage-thread", {
      type: "ThreadCreated",
      payload: { sessionId: "usage-collision", provider: "kimi", instanceId: "named", cwd: process.cwd(), kind: "project", title: "Named usage" },
    });
    for (const [home, inputOther, output] of [[defaultHome, 900, 99], [namedHome, 11, 2]] as const) {
      const wire = join(home, "sessions", "wd-test", "session_usage-collision", "agents", "main", "wire.jsonl");
      await mkdir(dirname(wire), { recursive: true });
      await writeFile(wire, `${JSON.stringify({ type: "usage.record", usageScope: "turn", usage: { inputOther, output } })}\n`, "utf8");
    }

    await launchServer(serverPath, "45418", dataHome, children, { KIMI_CODE_HOME: defaultHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45418", messages);
    const listed = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.list", params: {} }));
    const thread = ((await listed).result as {
      threads: Array<{ threadId: string; usage: { tokens?: { totalTokens: number; inputTokens: number; outputTokens: number } } }>;
    }).threads.find((candidate) => candidate.threadId === "named-usage-thread");
    expect(thread?.usage.tokens).toEqual(expect.objectContaining({ totalTokens: 13, inputTokens: 11, outputTokens: 2 }));
    socket.close();
  });

  it("keeps equal ACP session IDs isolated across Kimi instances", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-instance-session-isolation-"));
    const alphaHome = await mkdtemp(join(tmpdir(), "kimi-home-session-alpha-"));
    const betaHome = await mkdtemp(join(tmpdir(), "kimi-home-session-beta-"));
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "alpha", name: "Alpha", provider: "kimi", environment: { KIMI_CODE_HOME: alphaHome } },
      { id: "beta", name: "Beta", provider: "kimi", environment: { KIMI_CODE_HOME: betaHome } },
    ]));
    await launchServer(serverPath, "45424", dataHome, children);
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45424", messages);
    const sharedSessionId = "same-session-id";
    for (const [id, threadId, instanceId] of [[1, "alpha-thread", "alpha"], [2, "beta-thread", "beta"]] as const) {
      const resumed = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method: "threads.resume", params: {
        threadId, sessionId: sharedSessionId, cwd: process.cwd(), provider: "kimi", instanceId,
      } }));
      expect((await resumed).error).toBeUndefined();
    }

    const runTurn = async (id: number, threadId: string) => {
      const approval = waitFor(socket, messages, (message) => {
        const event = message.payload as { type?: string; threadId?: string } | undefined;
        return event?.type === "ApprovalRequested" && event.threadId === threadId;
      });
      const completed = waitFor(socket, messages, (message) => {
        const event = message.payload as { type?: string; threadId?: string } | undefined;
        return event?.type === "TurnCompleted" && event.threadId === threadId;
      });
      const sent = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method: "threads.sendTurn", params: { threadId, text: `Work in ${threadId}` } }));
      expect((await sent).error).toBeUndefined();
      const request = (await approval).payload as { payload: { requestId: string } };
      const response = waitFor(socket, messages, (message) => message.id === id + 100);
      socket.send(JSON.stringify({ id: id + 100, method: "threads.respondToRequest", params: {
        threadId, requestId: request.payload.requestId, optionId: "allow-once",
      } }));
      expect((await response).error).toBeUndefined();
      await completed;
    };
    await Promise.all([runTurn(10, "alpha-thread"), runTurn(20, "beta-thread")]);

    for (const [id, threadId] of [[30, "alpha-thread"], [40, "beta-thread"]] as const) {
      const finished = waitFor(socket, messages, (message) => {
        const event = message.payload as { type?: string; threadId?: string } | undefined;
        return event?.type === "BackgroundTaskFinished" && event.threadId === threadId;
      });
      const sent = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method: "threads.sendTurn", params: { threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" } }));
      expect((await sent).error).toBeUndefined();
      await finished;
    }

    const listed = waitFor(socket, messages, (message) => message.id === 50);
    socket.send(JSON.stringify({ id: 50, method: "threads.list", params: {} }));
    const threads = ((await listed).result as { threads: Array<{
      threadId: string;
      messages: Array<{ role: string; text: string }>;
      tools: Array<{ toolCallId: string }>;
      backgroundTasks: Array<{ taskId: string; status: string }>;
    }> }).threads;
    for (const threadId of ["alpha-thread", "beta-thread"]) {
      const thread = threads.find((candidate) => candidate.threadId === threadId)!;
      expect(thread.messages.filter((message) => message.role === "assistant" && message.text.includes("requested change is ready"))).toHaveLength(1);
      expect(thread.tools.filter((tool) => tool.toolCallId === "tool-1")).toHaveLength(1);
      expect(thread.backgroundTasks).toEqual([expect.objectContaining({ taskId: "bash-build1", status: "completed" })]);
      expect(messages.filter((message) => {
        const event = message.payload as { type?: string; threadId?: string; payload?: { taskId?: string } } | undefined;
        return event?.type === "BackgroundTaskRegistered" && event.threadId === threadId && event.payload?.taskId === "bash-build1";
      })).toHaveLength(1);
    }
    socket.close();
  }, 30_000);

  it("isolates live and stale quota reads by instance and canonical Kimi home", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-instance-quota-"));
    const defaultHome = await mkdtemp(join(tmpdir(), "kimi-home-quota-default-"));
    const namedHomeA = await mkdtemp(join(tmpdir(), "kimi-home-quota-named-a-"));
    const namedHomeB = await mkdtemp(join(tmpdir(), "kimi-home-quota-named-b-"));
    const quota = (label: string) => ({ summary: { label, used: 10, limit: 100, remaining: 90 }, limits: [], updatedAt: new Date().toISOString() });
    await writeFile(quotaCacheFile(dataHome, "kimi", defaultHome), JSON.stringify(quota("Default account")));
    await writeFile(quotaCacheFile(dataHome, "kimi:named", namedHomeA), JSON.stringify(quota("Named account A")));
    await writeFile(quotaCacheFile(dataHome, "kimi:named", namedHomeB), JSON.stringify(quota("Named account B")));
    const configureNamed = (home: string) => writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "named", name: "Named", provider: "kimi", environment: { KIMI_CODE_HOME: home } },
      { id: "wsl", name: "WSL", provider: "kimi", environment: {}, wsl: { distribution: "Ubuntu", binary: "/usr/bin/kimi" } },
    ]));
    await configureNamed(namedHomeA);

    const first = await launchServer(serverPath, "45420", dataHome, children, {
      KIMI_FAKE: "0", KIMI_CODE_HOME: defaultHome, KIMI_BINARY: join(defaultHome, "missing-kimi.exe"),
    });
    const firstMessages: Array<Record<string, unknown>> = [];
    const firstSocket = await connect("45420", firstMessages);
    const defaultReply = waitFor(firstSocket, firstMessages, (message) => message.id === 1);
    const namedReply = waitFor(firstSocket, firstMessages, (message) => message.id === 2);
    firstSocket.send(JSON.stringify({ id: 1, method: "usage.quota", params: {} }));
    firstSocket.send(JSON.stringify({ id: 2, method: "usage.quota", params: { instanceId: "named" } }));
    expect((await defaultReply).result).toMatchObject({ summary: { label: "Default account" }, stale: true });
    expect((await namedReply).result).toMatchObject({ summary: { label: "Named account A" }, stale: true });
    const wslReply = waitFor(firstSocket, firstMessages, (message) => message.id === 3);
    firstSocket.send(JSON.stringify({ id: 3, method: "usage.quota", params: { instanceId: "wsl" } }));
    expect((await wslReply).error).toMatchObject({ message: expect.stringMatching(/not supported for WSL/i) });
    firstSocket.close();
    const firstExited = new Promise<void>((resolve) => first.once("exit", () => resolve()));
    first.kill();
    await firstExited;

    await configureNamed(namedHomeB);
    await launchServer(serverPath, "45421", dataHome, children, {
      KIMI_FAKE: "0", KIMI_CODE_HOME: defaultHome, KIMI_BINARY: join(defaultHome, "missing-kimi.exe"),
    });
    const secondMessages: Array<Record<string, unknown>> = [];
    const secondSocket = await connect("45421", secondMessages);
    const repointedReply = waitFor(secondSocket, secondMessages, (message) => message.id === 4);
    secondSocket.send(JSON.stringify({ id: 4, method: "usage.quota", params: { instanceId: "named" } }));
    expect((await repointedReply).result).toMatchObject({ summary: { label: "Named account B" }, stale: true });
    secondSocket.close();
  }, 20_000);

  it("keeps named-instance background work attached to its Kimi home and MCP blocker", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-mcp-background-"));
    const defaultHome = await mkdtemp(join(tmpdir(), "kimi-home-background-default-"));
    const namedHome = await mkdtemp(join(tmpdir(), "kimi-home-background-named-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-mcp-background-"));
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "project-command" } } }));
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "named", name: "Named", provider: "kimi", environment: { KIMI_CODE_HOME: namedHome } },
    ]));
    await launchServer(serverPath, "45404", dataHome, children, { KIMI_CODE_HOME: defaultHome });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45404", messages);

    const capabilitiesReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "capabilities.list", params: { cwd: workspace, instanceId: "named" } }));
    const fingerprint = ((await capabilitiesReply).result as { projectMcp: { fingerprint: string } }).projectMcp.fingerprint;
    const createdReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: workspace, instanceId: "named" } }));
    const thread = ((await createdReply).result as { thread: { threadId: string; sessionId: string } }).thread;
    const registered = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskRegistered");
    const completed = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCompleted");
    socket.send(JSON.stringify({
      id: 3,
      method: "threads.sendTurn",
      params: { threadId: thread.threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_PENDING__" },
    }));
    await registered;
    await completed;

    const blockedApproval = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "mcp.approveProject", params: { cwd: workspace, instanceId: "named", fingerprint } }));
    expect((await blockedApproval).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });
    const blockedDelete = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.delete", params: { threadId: thread.threadId } }));
    expect((await blockedDelete).error).toMatchObject({ message: expect.stringMatching(/active work/i) });

    const sessionDirectory = thread.sessionId.startsWith("session_") ? thread.sessionId : `session_${thread.sessionId}`;
    const taskPath = join(namedHome, "sessions", "wd-test", sessionDirectory, "agents", "main", "tasks", "bash-build1.json");
    const outputPath = join(dirname(taskPath), "bash-build1", "output.log");
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, "BUILD SUCCESSFUL", "utf8");
    const finished = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "BackgroundTaskFinished");
    await writeFile(taskPath, JSON.stringify({
      taskId: "bash-build1", description: "Build APK", status: "completed", detached: true, endedAt: Date.now(), exitCode: 0,
    }), "utf8");
    const finishedEvent = await finished;
    expect((finishedEvent.payload as { payload: { outputPath?: string } }).payload.outputPath).toBeUndefined();
    expect(JSON.stringify(finishedEvent)).not.toContain(namedHome);
    const storedFinished = (await readFile(join(dataHome, "events.jsonl"), "utf8")).trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; payload: { taskId?: string; outputPath?: string } })
      .findLast((event) => event.type === "BackgroundTaskFinished" && event.payload.taskId === "bash-build1");
    expect(storedFinished?.payload.outputPath).toBe(await realpath(outputPath));

    const approved = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "mcp.approveProject", params: { cwd: workspace, instanceId: "named", fingerprint } }));
    expect((await approved).error).toBeUndefined();
    const listed = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "threads.list", params: {} }));
    const listedTask = ((await listed).result as {
      threads: Array<{ threadId: string; backgroundTasks: Array<{ outputPath?: string; kimiHome?: string }> }>;
    }).threads.find((candidate) => candidate.threadId === thread.threadId)?.backgroundTasks[0];
    expect(listedTask).not.toHaveProperty("outputPath");
    expect(listedTask).not.toHaveProperty("kimiHome");
    socket.close();
  }, 20_000);

  it("keeps a chat undeletable until ACP cancellation is quiescent", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-delete-cancellation-"));
    await launchServer(serverPath, "45408", dataHome, children, { KIMI_FAKE_CANCEL_DELIVERY_DELAY_MS: "800" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45408", messages);
    const created = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "threads.create", params: { cwd: process.cwd() } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 2, method: "threads.sendTurn", params: { threadId, text: "Hold until cancelled" } }));
    await approval;

    const quiescent = waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; threadId?: string } | undefined;
      return message.channel === "receipt" && event?.type === "turn.quiescent" && event.threadId === threadId;
    });
    const interrupted = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.interruptTurn", params: { threadId } }));
    expect((await interrupted).error).toBeUndefined();
    const blockedDelete = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.delete", params: { threadId } }));
    expect((await blockedDelete).error).toMatchObject({ message: expect.stringMatching(/active work/i) });
    await quiescent;
    const deleted = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "threads.delete", params: { threadId } }));
    expect((await deleted).error).toBeUndefined();
    socket.close();
  }, 15_000);

  it("keeps an admitted due-schedule scan mutually exclusive with MCP approval", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-mcp-schedule-admission-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-mcp-schedule-admission-"));
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "project-command" } } }));
    await launchServer(serverPath, "45409", dataHome, children, { KIMI_FAKE_SCHEDULE_ADMISSION_DELAY_MS: "5000" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45409", messages);
    const capabilities = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "capabilities.list", params: { cwd: workspace } }));
    const fingerprint = ((await capabilities).result as { projectMcp: { fingerprint: string } }).projectMcp.fingerprint;
    const created = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: workspace } }));
    const threadId = ((await created).result as { thread: { threadId: string } }).thread.threadId;
    const scheduled = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({
      id: 3,
      method: "schedules.create",
      params: { threadId, name: "MCP interleave", text: "Queue after the scan", recurrence: "once", nextRunAt: new Date().toISOString() },
    }));
    const scheduleId = ((await scheduled).result as { schedule: { id: string } }).schedule.id;
    const blockers = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "diagnostics.snapshot", params: {} }));
    expect(((await blockers).result as { blockers: { schedules: number } }).blockers.schedules).toBe(1);
    const blockedApproval = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "mcp.approveProject", params: { cwd: workspace, fingerprint } }));
    expect((await blockedApproval).error).toMatchObject({ message: expect.stringMatching(/schedules=1/i) });
    await waitFor(socket, messages, (message) => {
      const event = message.payload as { type?: string; scheduleId?: string } | undefined;
      return message.channel === "notifications.event" && event?.type === "schedule.queued" && event.scheduleId === scheduleId;
    });
    socket.close();
  }, 15_000);

  it("rejects MCP policy changes while session creation or project work is active", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-mcp-race-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-mcp-race-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-mcp-race-"));
    const sessionLog = join(dataHome, "mcp-sessions.jsonl");
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: "project-command" } } }));
    await launchServer(serverPath, "45403", dataHome, children, {
      KIMI_CODE_HOME: kimiHome,
      KIMI_FAKE_NEW_SESSION_DELAY_MS: "500",
      KIMI_FAKE_NEW_SESSION_MCP_LOG: sessionLog,
    });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45403", messages);

    const listedReply = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "capabilities.list", params: { cwd: workspace } }));
    const fingerprint = ((await listedReply).result as { projectMcp: { fingerprint: string } }).projectMcp.fingerprint;
    const createReply = waitFor(socket, messages, (message) => message.id === 2);
    socket.send(JSON.stringify({ id: 2, method: "threads.create", params: { cwd: workspace } }));
    await waitForFileText(sessionLog, (text) => text.includes("mcpServers"));
    const blockedDuringCreate = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "mcp.approveProject", params: { cwd: workspace, fingerprint } }));
    expect((await blockedDuringCreate).error).toMatchObject({ message: expect.stringMatching(/active Kimi work.*operations=1/i) });
    const threadId = ((await createReply).result as { thread: { threadId: string } }).thread.threadId;

    const permission = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 4, method: "threads.sendTurn", params: { threadId, text: "Hold project work" } }));
    await permission;
    const blockedDuringTurn = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "mcp.approveProject", params: { cwd: workspace, fingerprint } }));
    expect((await blockedDuringTurn).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });
    const interrupted = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "threads.interruptTurn", params: { threadId } }));
    expect((await interrupted).error).toBeUndefined();
    socket.close();
  }, 20_000);

  it("lists scoped Kimi skills and installs a validated workspace bundle", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-skills-"));
    const kimiHome = await mkdtemp(join(tmpdir(), "kimi-home-skills-"));
    const namedHome = await mkdtemp(join(tmpdir(), "kimi-home-skills-named-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-workspace-skills-"));
    const outside = await mkdtemp(join(tmpdir(), "kimi-outside-skills-"));
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, ".kimi-code", "skills", "project-skill"), { recursive: true });
    await writeFile(join(workspace, ".kimi-code", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: Project scoped\n---\n");
    const source = join(workspace, "install-me");
    await mkdir(source);
    await writeFile(join(source, "SKILL.md"), "---\nname: installed-skill\ndescription: Installed safely\n---\n");
    const namedSource = join(workspace, "install-named");
    await mkdir(namedSource);
    await writeFile(join(namedSource, "SKILL.md"), "---\nname: named-skill\ndescription: Installed for named runtime\n---\n");
    const external = join(outside, "external");
    await mkdir(external);
    await writeFile(join(external, "SKILL.md"), "---\nname: external\ndescription: Outside\n---\n");
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      { id: "named", name: "Named", provider: "kimi", environment: { KIMI_CODE_HOME: namedHome } },
      { id: "wsl", name: "WSL", provider: "kimi", environment: {}, wsl: { distribution: "Ubuntu", binary: "/usr/bin/kimi" } },
    ]));

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
    const namedInstalled = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "skills.install", params: { cwd: workspace, source: namedSource, instanceId: "named" } }));
    expect((await namedInstalled).error).toBeUndefined();
    await expect(access(join(namedHome, "skills", "named-skill", "SKILL.md"))).resolves.toBeUndefined();
    await expect(access(join(kimiHome, "skills", "named-skill", "SKILL.md"))).rejects.toThrow();
    const wslRejected = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "skills.install", params: { cwd: workspace, source: namedSource, instanceId: "wsl" } }));
    expect((await wslRejected).error).toMatchObject({ message: expect.stringMatching(/not supported for WSL/i) });
    const providersListed = waitFor(socket, messages, (message) => message.id === 7);
    socket.send(JSON.stringify({ id: 7, method: "providers.list", params: {} }));
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

  it("blocks Git mutations while a sibling chat sharing the workspace has active or queued work", async () => {
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-server-git-guard-"));
    const workspace = await mkdtemp(join(tmpdir(), "kimi-server-git-guard-workspace-"));
    const aliasRoot = await mkdtemp(join(tmpdir(), "kimi-server-git-guard-alias-"));
    const alias = join(aliasRoot, "workspace");
    const linked = join(aliasRoot, "linked-worktree");
    const privateSource = "Z:\\private-kimi-source";
    await symlink(workspace, alias, process.platform === "win32" ? "junction" : "dir");
    const git = findGitBinary();
    await exec(git, ["-C", workspace, "init"]);
    await exec(git, ["-C", workspace, "config", "user.name", "Test"]);
    await exec(git, ["-C", workspace, "config", "user.email", "test@example.invalid"]);
    await writeFile(join(workspace, "tracked.txt"), "base\n", "utf8");
    await exec(git, ["-C", workspace, "add", "."]);
    await exec(git, ["-C", workspace, "commit", "-m", "base"]);
    await exec(git, ["-C", workspace, "worktree", "add", "-b", "guard-linked", linked]);
    await writeFile(join(workspace, "change.txt"), "pending\n", "utf8");

    const store = new EventStore(join(dataHome, "events.jsonl"));
    await store.open(() => undefined);
    await store.append("git-owner", {
      type: "ThreadCreated",
      payload: { sessionId: "git-owner-session", provider: "kimi", cwd: workspace, kind: "project", title: `Review ${privateSource}` },
    });
    await store.append("git-worker", {
      type: "ThreadCreated",
      payload: { sessionId: "git-worker-session", provider: "kimi", cwd: alias, worktree: { sourceCwd: privateSource, branch: "kimi/worker" }, kind: "project", title: "Worker" },
    });
    await store.append("git-linked-worker", {
      type: "ThreadCreated",
      payload: { sessionId: "git-linked-worker-session", provider: "kimi", cwd: linked, kind: "project", title: "Linked worker" },
    });
    await writeFile(join(dataHome, "pending-queues.json"), JSON.stringify({
      "git-worker": [{ queuedId: crypto.randomUUID(), text: "Queued workspace task", mentions: [], mode: "queue", createdAt: new Date().toISOString(), origin: "user" }],
    }), "utf8");

    await launchServer(serverPath, "45309", dataHome, children, { KIMI_FAKE_CANCEL_DELIVERY_DELAY_MS: "250" });
    const messages: Array<Record<string, unknown>> = [];
    const socket = await connect("45309", messages);

    const status = waitFor(socket, messages, (message) => message.id === 1);
    socket.send(JSON.stringify({ id: 1, method: "git.status", params: { cwd: workspace } }));
    expect((await status).error).toBeUndefined();

    const blockedActions = [
      ["git.stage", { cwd: workspace, paths: ["change.txt"] }],
      ["git.unstage", { cwd: workspace, paths: ["change.txt"] }],
      ["git.commit", { cwd: workspace, message: "blocked" }],
      ["git.fetch", { cwd: workspace, remote: "origin" }],
      ["git.createBranch", { cwd: workspace, branch: "blocked" }],
      ["git.switchBranch", { cwd: workspace, branch: "main" }],
      ["git.checkoutRemoteBranch", { cwd: workspace, remote: "origin", branch: "blocked" }],
      ["git.renameBranch", { cwd: workspace, branch: "main", newBranch: "blocked" }],
      ["git.deleteBranch", { cwd: workspace, branch: "blocked" }],
      ["git.push", { cwd: workspace }],
      ["git.pull", { cwd: workspace }],
      ["git.publish", { cwd: workspace, name: "blocked", visibility: "private" }],
      ["git.createPullRequest", { cwd: workspace, title: "Blocked", body: "", draft: true }],
    ] as const;
    for (const [index, [method, params]] of blockedActions.entries()) {
      const id = 20 + index;
      const blocked = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method, params }));
      expect((await blocked).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });
    }
    const blockedClone = waitFor(socket, messages, (message) => message.id === 39);
    socket.send(JSON.stringify({ id: 39, method: "git.clone", params: { url: "local-path-must-not-be-reached", destination: join(alias, "nested", "clone") } }));
    expect((await blockedClone).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });
    for (const [id, method, params] of [
      [40, "git.diff", { cwd: workspace, path: "change.txt" }],
      [41, "git.repository", { cwd: workspace }],
    ] as const) {
      const readable = waitFor(socket, messages, (message) => message.id === id);
      socket.send(JSON.stringify({ id, method, params }));
      expect((await readable).error).toBeUndefined();
    }

    const exported = waitFor(socket, messages, (message) => message.id === 3);
    socket.send(JSON.stringify({ id: 3, method: "threads.export", params: { threadIds: ["git-owner"] } }));
    const archive = await readFile(((await exported).result as { path: string }).path, "utf8");
    expect(archive).not.toContain(privateSource);

    const cleared = waitFor(socket, messages, (message) => message.id === 4);
    socket.send(JSON.stringify({ id: 4, method: "threads.clearQueue", params: { threadId: "git-worker" } }));
    await cleared;
    const staged = waitFor(socket, messages, (message) => message.id === 5);
    socket.send(JSON.stringify({ id: 5, method: "git.stage", params: { cwd: workspace, paths: ["change.txt"] } }));
    expect((await staged).error).toBeUndefined();

    const bootstrap = waitFor(socket, messages, (message) => message.id === 6);
    socket.send(JSON.stringify({ id: 6, method: "env.bootstrap", params: {} }));
    await bootstrap;
    const approval = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "ApprovalRequested");
    socket.send(JSON.stringify({ id: 7, method: "threads.sendTurn", params: { threadId: "git-linked-worker", text: "Keep this workspace active" } }));
    await approval;

    const blockedActive = waitFor(socket, messages, (message) => message.id === 8);
    socket.send(JSON.stringify({ id: 8, method: "git.unstage", params: { cwd: workspace, paths: ["change.txt"] } }));
    expect((await blockedActive).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });

    const cancelled = waitFor(socket, messages, (message) => (message.payload as { type?: string } | undefined)?.type === "TurnCancelled");
    const quiescent = waitFor(socket, messages, (message) => message.channel === "receipt"
      && (message.payload as { type?: string; threadId?: string } | undefined)?.type === "turn.quiescent"
      && (message.payload as { threadId?: string }).threadId === "git-linked-worker");
    const interrupted = waitFor(socket, messages, (message) => message.id === 9);
    socket.send(JSON.stringify({ id: 9, method: "threads.interruptTurn", params: { threadId: "git-linked-worker" } }));
    await interrupted;
    await cancelled;
    const blockedUntilQuiescent = waitFor(socket, messages, (message) => message.id === 46);
    socket.send(JSON.stringify({ id: 46, method: "git.unstage", params: { cwd: workspace, paths: ["change.txt"] } }));
    expect((await blockedUntilQuiescent).error).toMatchObject({ message: expect.stringMatching(/active Kimi work/i) });
    await quiescent;
    const unstaged = waitFor(socket, messages, (message) => message.id === 10);
    socket.send(JSON.stringify({ id: 10, method: "git.unstage", params: { cwd: workspace, paths: ["change.txt"] } }));
    expect((await unstaged).error).toBeUndefined();
    socket.close();
  }, 20_000);

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

function quotaCacheFile(dataHome: string, key: string, home: string): string {
  const canonicalHome = realpathSync(home).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const identity = createHash("sha256").update(canonicalHome).digest("hex").slice(0, 16);
  return join(dataHome, `quota-cache-${key.replaceAll(":", "-")}-${identity}.json`);
}

async function launchServer(serverPath: string, port: string, dataHome: string, children: ReturnType<typeof spawn>[], extraEnv: Record<string, string> = {}) {
  const child = spawn(process.execPath, ["--import", "tsx", serverPath], {
    env: { ...process.env, KIMI_FAKE: "1", KIMI_SERVER_PORT: port, KIMI_DESKTOP_HOME: dataHome, ...extraEnv },
    stdio: [extraEnv.KIMI_FAKE_SHUTDOWN_STDIN === "1" ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  await waitForServer(child);
  return child;
}

async function triggerFakeShutdown(child: ReturnType<typeof spawn>): Promise<void> {
  const stdin = child.stdin;
  if (!stdin) throw new Error("Server stdin is unavailable for deterministic shutdown");
  stdin.end("shutdown\n");
}

async function waitForBlocker(
  socket: WebSocket,
  messages: Array<Record<string, unknown>>,
  blocker: "queueInsertions" | "queueStarts",
): Promise<void> {
  const deadline = Date.now() + 5_000;
  let requestId = 90_000;
  while (Date.now() < deadline) {
    const id = requestId++;
    const snapshot = waitFor(socket, messages, (message) => message.id === id);
    socket.send(JSON.stringify({ id, method: "diagnostics.snapshot", params: {} }));
    const count = ((await snapshot).result as { blockers: Record<string, number> }).blockers[blocker] ?? 0;
    if (count > 0) return;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(`Timed out waiting for ${blocker} admission`);
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

async function waitForGitWorktree(git: string, workspace: string, storageRoot: string): Promise<void> {
  const expected = storageRoot.replaceAll("\\", "/").toLowerCase();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const listed = (await exec(git, ["-C", workspace, "worktree", "list", "--porcelain"])).stdout.replaceAll("\\", "/").toLowerCase();
    if (listed.includes(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for worktree under ${storageRoot}`);
}

async function waitForStoredEvent(dataHome: string, predicate: (event: { threadId: string; type: string; payload: unknown }) => boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(join(dataHome, "events.jsonl"), "utf8");
      const events = contents
        .slice(0, contents.lastIndexOf("\n") + 1)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { threadId: string; type: string; payload: unknown });
      const event = events.find(predicate);
      if (event) return event;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error("Timed out waiting for stored orchestration event");
}

async function waitForFileText(path: string, predicate: (text: string) => boolean): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const text = await readFile(path, "utf8");
      if (predicate(text)) return text;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForCreationReservation(
  dataHome: string,
  creationId: string,
  predicate: (reservation: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const journal = JSON.parse(await readFile(join(dataHome, "pending-thread-creations.json"), "utf8")) as { reservations?: Array<Record<string, unknown>> };
      const reservation = journal.reservations?.find((candidate) => candidate.creationId === creationId);
      if (reservation && predicate(reservation)) return reservation;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
  }
  throw new Error("Timed out waiting for thread creation reservation");
}

function testThreadCreationFingerprint(params: { cwd?: string; standalone: boolean; isolate: boolean; provider: "kimi"; instanceId?: string; config?: Record<string, string | boolean> }): string {
  const hash = createHash("sha256");
  const add = (value: string) => {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  add(params.provider);
  add(params.instanceId ?? "");
  add(params.standalone ? "standalone" : "project");
  add(params.isolate ? "isolated" : "shared");
  add(params.standalone ? "" : resolve(params.cwd!).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase());
  const config = Object.entries(params.config ?? {}).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  add(String(config.length));
  for (const [key, value] of config) {
    add(key);
    add(typeof value);
    add(String(value));
  }
  return hash.digest("hex");
}

function testSideThreadCreationFingerprint(params: { threadId: string; title?: string }): string {
  const hash = createHash("sha256");
  const add = (value: string) => {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  };
  add("side");
  add(params.threadId);
  add(params.title === undefined ? "omitted" : "explicit");
  add(params.title ?? "");
  return hash.digest("hex");
}
