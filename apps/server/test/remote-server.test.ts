import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { KIMI_REMOTE_PROTOCOL, KIMI_REMOTE_TOKEN_PREFIX, LEGACY_REMOTE_PROTOCOL, LEGACY_REMOTE_TOKEN_PREFIX } from "../src/remote-access.js";

describe("remote server", () => {
  let child: ChildProcess | undefined;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets) socket.terminate();
    child?.kill();
    await new Promise((resolve) => child?.once("exit", resolve) ?? resolve(undefined));
  });

  it("pairs, limits methods, reconnects with a device token, and revokes", async () => {
    const localPort = await freePort();
    const remotePort = await freePort();
    const dataHome = await mkdtemp(join(tmpdir(), "tasty-remote-server-"));
    const privateInstanceHome = await mkdtemp(join(tmpdir(), "kimi-private-instance-home-"));
    const privateConfigHome = await mkdtemp(join(tmpdir(), "kimi-private-instance-config-"));
    const secondaryInstanceHome = await mkdtemp(join(tmpdir(), "kimi-secondary-instance-home-"));
    await writeFile(join(dataHome, "provider-instances.json"), JSON.stringify([
      {
        id: "private",
        name: "Private paths",
        provider: "kimi",
        binary: process.execPath,
        environment: { KIMI_CODE_HOME: privateInstanceHome, XDG_CONFIG_HOME: privateConfigHome },
      },
      {
        id: "secondary",
        name: "Secondary Kimi",
        provider: "kimi",
        binary: process.execPath,
        environment: { KIMI_CODE_HOME: secondaryInstanceHome },
      },
    ]));
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    child = spawn(process.execPath, ["--import", "tsx", serverPath], {
      env: { ...process.env, KIMI_FAKE: "1", KIMI_BINARY: process.execPath, KIMI_SERVER_PORT: String(localPort), KIMI_DESKTOP_HOME: dataHome, KIMI_CODE_HOME: join(dataHome, "kimi-home"), KIMI_FAKE_RETIRED_PRIVATE_PATH: "Q:\\retired-kimi-instance\\bin\\kimi.exe" },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    const local = await connect(`ws://127.0.0.1:${localPort}`, undefined, { origin: "http://127.0.0.1:1420" });
    sockets.push(local);
    await expect(request(local, { id: 0, method: "remote.configure", params: { enabled: true, bind: "0.0.0.0", port: localPort } })).rejects.toThrow("requires TLS");
    await request(local, { id: 1, method: "remote.configure", params: { enabled: true, bind: "127.0.0.1", port: remotePort } });
    const pairing = await request(local, { id: 2, method: "remote.createPairing", params: {} }) as { code: string; expiresAt: string };
    expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u);
    expect(Date.parse(pairing.expiresAt)).toBeGreaterThan(Date.now());

    const claimSocket = await connect(`ws://127.0.0.1:${remotePort}/pair`);
    sockets.push(claimSocket);
    const claimed = await request(claimSocket, { id: 3, method: "remote.claim", params: { code: pairing.code, name: "Test phone" } }) as { token: string; device: { id: string } };
    const claimClosed = new Promise<void>((resolve) => claimSocket.once("close", () => resolve()));
    claimSocket.close();
    await claimClosed;

    const remoteMessages: Array<{ id?: number; channel?: string; payload?: Record<string, unknown> }> = [];
    const remote = await connect(`ws://127.0.0.1:${remotePort}/remote`, [KIMI_REMOTE_PROTOCOL, `${KIMI_REMOTE_TOKEN_PREFIX}${claimed.token}`], undefined, remoteMessages);
    const legacyRemote = await connect(`ws://127.0.0.1:${remotePort}/remote`, [LEGACY_REMOTE_PROTOCOL, `${LEGACY_REMOTE_TOKEN_PREFIX}${claimed.token}`]);
    sockets.push(remote, legacyRemote);
    const remoteWelcome = await waitForCaptured(remoteMessages, (message) => message.channel === "server.welcome");
    expect(remoteWelcome.payload).not.toHaveProperty("defaultCwd");
    expect(remote.protocol).toBe(KIMI_REMOTE_PROTOCOL);
    expect(legacyRemote.protocol).toBe(LEGACY_REMOTE_PROTOCOL);
    const remoteBootstrap = await request(remote, { id: 10, method: "env.bootstrap", params: {} }) as {
      binary?: string;
      defaultCwd?: string;
      initialize?: unknown;
      auth: { home?: string };
      providers: Array<{ binary?: string }>;
    };
    expect(remoteBootstrap).not.toHaveProperty("binary");
    expect(remoteBootstrap).not.toHaveProperty("defaultCwd");
    expect(remoteBootstrap).not.toHaveProperty("initialize");
    expect(remoteBootstrap.auth).not.toHaveProperty("home");
    expect(remoteBootstrap.providers[0]).not.toHaveProperty("binary");
    const remoteProviders = await request(remote, { id: 11, method: "providers.list", params: {} }) as {
      providers: Array<{ binary?: string; home?: string }>;
    };
    expect(remoteProviders.providers[0]).not.toHaveProperty("binary");
    expect(remoteProviders.providers[0]).not.toHaveProperty("home");
    await request(local, { id: 12, method: "auth.logout", params: { provider: "kimi" } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(remoteMessages.some((message) => message.channel === "auth.status")).toBe(false);
    const threads = await request(remote, { id: 4, method: "threads.list", params: {} }) as { threads: unknown[] };
    expect(threads.threads).toEqual([]);
    expect(await request(legacyRemote, { id: 8, method: "threads.list", params: {} })).toMatchObject({ threads: [] });

    const standaloneCreatedEvent = waitForCaptured(remoteMessages, (message) => {
      const event = message.payload as { type?: string; payload?: { kind?: string } } | undefined;
      return message.channel === "orchestration.domainEvent" && event?.type === "ThreadCreated" && event.payload?.kind === "chat";
    });
    const standalone = await request(remote, { id: 40, method: "threads.create", params: { standalone: true } }) as {
      thread: { threadId: string; sessionId: string; cwd: string; kind: string };
    };
    const standaloneAlias = `kimi-code-chat://${standalone.thread.threadId}`;
    expect(standalone.thread).toMatchObject({ cwd: standaloneAlias, kind: "chat" });
    expect(JSON.stringify(standalone)).not.toContain(dataHome);
    const standaloneEvent = await standaloneCreatedEvent;
    expect((standaloneEvent.payload as { payload: { cwd: string } }).payload.cwd).toBe(standaloneAlias);
    const standaloneList = await request(remote, { id: 41, method: "threads.list", params: {} }) as {
      threads: Array<{ threadId: string; cwd: string }>;
      runtimeSessions: Array<{ sessionId: string; cwd?: string; kind?: string }>;
    };
    expect(standaloneList.threads.find((thread) => thread.threadId === standalone.thread.threadId)?.cwd).toBe(standaloneAlias);
    expect(standaloneList.runtimeSessions.find((session) => session.sessionId === standalone.thread.sessionId)).toMatchObject({
      cwd: standaloneAlias,
      kind: "chat",
    });
    const resumedStandalone = await request(remote, { id: 42, method: "threads.resume", params: {
      threadId: standalone.thread.threadId, sessionId: standalone.thread.sessionId, cwd: standaloneAlias, replay: false,
    } }) as { thread: { cwd: string } };
    expect(resumedStandalone.thread.cwd).toBe(standaloneAlias);
    const resumedLegacyStandalone = await request(remote, { id: 43, method: "threads.resume", params: {
      threadId: standalone.thread.threadId,
      sessionId: standalone.thread.sessionId,
      cwd: join(dataHome, "runtime", "chats"),
      replay: false,
    } }) as { thread: { cwd: string } };
    expect(resumedLegacyStandalone.thread.cwd).toBe(standaloneAlias);
    expect(JSON.stringify([standaloneEvent, standaloneList, resumedStandalone, resumedLegacyStandalone])).not.toContain(dataHome);
    await request(local, { id: 44, method: "threads.delete", params: { threadId: standalone.thread.threadId } });
    const localOrphanList = await request(local, { id: 440, method: "threads.list", params: {} }) as {
      runtimeSessions: Array<{ sessionId: string; cwd?: string; kind?: string }>;
    };
    expect(localOrphanList.runtimeSessions.find((session) => session.sessionId === standalone.thread.sessionId)).toMatchObject({
      cwd: join(dataHome, "runtime", "chats"),
      kind: "chat",
    });
    const orphanList = await request(remote, { id: 45, method: "threads.list", params: {} }) as {
      runtimeSessions: Array<{ sessionId: string; cwd?: string }>;
    };
    expect(orphanList.runtimeSessions.find((session) => session.sessionId === standalone.thread.sessionId)).toBeUndefined();
    expect(orphanList.runtimeSessions.every((session) => typeof session.cwd === "string")).toBe(true);

    await expect(request(remote, { id: 5, method: "threads.create", params: { cwd: join(dataHome, "unapproved"), standalone: false, isolate: false, provider: "kimi" } })).rejects.toThrow("existing Kimi Code workspace");
    const workspace = join(dataHome, "approved-workspace");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: {
      project: { command: "project-tool", env: { TOKEN: "REMOTE_SECRET_MARKER" } },
    } }));
    const privateWorkspace = await mkdtemp(join(tmpdir(), "kimi-private-session-workspace-"));
    const secondaryWorkspace = await mkdtemp(join(tmpdir(), "kimi-secondary-session-workspace-"));
    const sharedSessionId = "shared-session-id";
    await request(local, { id: 46, method: "threads.resume", params: {
      threadId: "private-shared-session",
      sessionId: sharedSessionId,
      cwd: privateWorkspace,
      provider: "kimi",
      instanceId: "private",
      replay: false,
    } });
    await request(local, { id: 47, method: "threads.resume", params: {
      threadId: "secondary-shared-session",
      sessionId: sharedSessionId,
      cwd: secondaryWorkspace,
      provider: "kimi",
      instanceId: "secondary",
      replay: false,
    } });
    const privateSessionList = await request(remote, { id: 48, method: "threads.list", params: {
      provider: "kimi",
      instanceId: "private",
    } }) as { runtimeSessions: Array<{ sessionId: string; cwd: string; kind: string }> };
    const secondarySessionList = await request(remote, { id: 49, method: "threads.list", params: {
      provider: "kimi",
      instanceId: "secondary",
    } }) as { runtimeSessions: Array<{ sessionId: string; cwd: string; kind: string }> };
    expect(privateSessionList.runtimeSessions.find((session) => session.sessionId === sharedSessionId)).toMatchObject({
      cwd: privateWorkspace,
      kind: "project",
    });
    expect(secondarySessionList.runtimeSessions.find((session) => session.sessionId === sharedSessionId)).toMatchObject({
      cwd: secondaryWorkspace,
      kind: "project",
    });
    const created = await request(local, { id: 20, method: "threads.create", params: { cwd: workspace, standalone: false, isolate: false, provider: "kimi" } }) as {
      thread: { threadId: string };
    };
    const localCapabilities = await request(local, { id: 21, method: "capabilities.list", params: { cwd: workspace } }) as { projectMcp: { fingerprint: string } };
    expect(localCapabilities.projectMcp.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    await expect(request(remote, { id: 22, method: "capabilities.list", params: { cwd: workspace } })).rejects.toThrow("not available to remote devices");
    await waitForRemoteAudit(local, "method.denied", 1);
    await waitForRemoteAudit(local, "device.connected", 3);
    await waitForRemoteAudit(local, "device.disconnected", 1);
    const blockedTemporary = join(dataHome, `remote-access.json.${child.pid}.tmp`);
    await mkdir(blockedTemporary);
    const deniedDiagnostic = waitForPush(remote, "server.diagnostics");
    await expect(request(remote, { id: 6, method: "terminal.start", params: { cwd: dataHome } })).rejects.toThrow("not available to remote devices");
    expect(await deniedDiagnostic).toMatchObject({ payload: { source: "remote-access" } });
    expect(remoteMessages.findIndex((message) => message.id === 6)).toBeLessThan(remoteMessages.findIndex((message) => message.channel === "server.diagnostics"));
    const secondStart = remoteMessages.length;
    const rejectedDiagnostic = waitForPush(remote, "server.diagnostics");
    await expect(request(remote, { id: 9, method: "threads.list", params: { cwd: join(dataHome, "unapproved") } })).rejects.toThrow("limited to existing Kimi Code workspaces");
    expect(await rejectedDiagnostic).toMatchObject({ payload: { source: "remote-access" } });
    expect(remoteMessages.slice(secondStart).findIndex((message) => message.id === 9)).toBeLessThan(remoteMessages.slice(secondStart).findIndex((message) => message.channel === "server.diagnostics"));
    await rm(blockedTemporary, { recursive: true });
    await expect(request(remote, { id: 23, method: "mcp.approveProject", params: { cwd: workspace, fingerprint: localCapabilities.projectMcp.fingerprint } })).rejects.toThrow("not available to remote devices");
    await expect(request(remote, { id: 24, method: "mcp.revokeProject", params: { cwd: workspace } })).rejects.toThrow("not available to remote devices");

    const finished = waitForDomainEvent(remote, "BackgroundTaskFinished", created.thread.threadId);
    await request(local, {
      id: 25,
      method: "threads.sendTurn",
      params: { threadId: created.thread.threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__" },
    });
    const finishedEvent = await finished;
    expect(finishedEvent.payload).not.toHaveProperty("outputPath");
    expect(finishedEvent.payload).not.toHaveProperty("kimiHome");

    const remoteList = await request(remote, { id: 26, method: "threads.list", params: {} }) as {
      threads: Array<{ threadId: string; backgroundTasks: Array<Record<string, unknown>> }>;
    };
    const remoteTask = remoteList.threads.find((thread) => thread.threadId === created.thread.threadId)?.backgroundTasks[0];
    expect(remoteTask).toBeDefined();
    expect(remoteTask).not.toHaveProperty("outputPath");
    expect(remoteTask).not.toHaveProperty("kimiHome");

    const attachmentThread = await request(local, { id: 27, method: "threads.create", params: { cwd: workspace, standalone: false, isolate: false, provider: "kimi" } }) as {
      thread: { threadId: string };
    };
    const privateImageName = "Q:\\outside-private-roots\\remote-private-name.png";
    const attachmentQueued = waitForQueuePush(remote, attachmentThread.thread.threadId);
    const attachmentStarted = waitForDomainEvent(remote, "TurnStarted", attachmentThread.thread.threadId);
    const attachmentCompleted = waitForDomainEvent(remote, "TurnCompleted", attachmentThread.thread.threadId);
    await request(local, {
      id: 28,
      method: "threads.sendTurn",
      params: { threadId: attachmentThread.thread.threadId, text: "__BACKGROUND_TASK__ __BACKGROUND_TASK_COMPLETED__ Inspect attachment", images: [{ name: privateImageName, mimeType: "image/png", data: "AQID" }] },
    });
    const attachmentQueue = await attachmentQueued;
    expect(attachmentQueue[0]?.images).toEqual([{ name: "remote-private-name.png", mimeType: "image/png" }]);
    expect(JSON.stringify(attachmentQueue)).not.toContain("outside-private-roots");
    const attachmentStartedEvent = await attachmentStarted;
    expect(attachmentStartedEvent.payload.images).toEqual([{ name: "remote-private-name.png", mimeType: "image/png" }]);
    expect(JSON.stringify(attachmentStartedEvent)).not.toContain("outside-private-roots");
    await attachmentCompleted;
    const attachmentList = await request(remote, { id: 29, method: "threads.list", params: {} }) as {
      threads: Array<{ threadId: string; messages: Array<{ images?: Array<{ name: string }> }> }>;
    };
    const attachmentProjection = attachmentList.threads.find((thread) => thread.threadId === attachmentThread.thread.threadId);
    expect(attachmentProjection?.messages.find((message) => message.images?.length)?.images?.[0]?.name).toBe("remote-private-name.png");
    expect(JSON.stringify(attachmentProjection)).not.toContain("outside-private-roots");

    let quotaError = "";
    try {
      await request(remote, { id: 30, method: "usage.quota", params: { instanceId: "private" } });
    } catch (error) {
      quotaError = error instanceof Error ? error.message : String(error);
    }
    expect(quotaError).toContain("[home]");
    expect(quotaError).not.toContain(process.cwd());
    expect(quotaError).not.toContain(process.execPath);

    const privateThread = await request(local, {
      id: 31,
      method: "threads.create",
      params: { cwd: workspace, standalone: false, isolate: false, provider: "kimi", instanceId: "private" },
    }) as { thread: { threadId: string } };
    const privateDiagnostic = waitForDiagnostic(remote, "Fake private runtime failure");
    const privateCompleted = waitForDomainEvent(remote, "TurnCompleted", privateThread.thread.threadId);
    await request(local, {
      id: 32,
      method: "threads.sendTurn",
      params: { threadId: privateThread.thread.threadId, text: "__PRIVATE_RUNTIME_ERROR__" },
    });
    const privateDiagnosticPayload = (await privateDiagnostic).payload;
    const privateCompletedPayload = (await privateCompleted).payload;
    for (const projected of [JSON.stringify(privateDiagnosticPayload), JSON.stringify(privateCompletedPayload)]) {
      expect(projected).not.toContain(process.execPath);
      expect(projected).not.toContain(privateInstanceHome);
      expect(projected).not.toContain(privateConfigHome);
      expect(projected).not.toContain("retired-kimi-instance");
    }
    expect(privateDiagnosticPayload.message).toContain("[home]");
    expect(privateCompletedPayload.error).toContain("[home]");
    const privateList = await request(remote, { id: 33, method: "threads.list", params: {} }) as {
      threads: Array<{ threadId: string; lifecycle: { error?: string }; turns: Array<{ error?: string }> }>;
    };
    const privateProjection = privateList.threads.find((thread) => thread.threadId === privateThread.thread.threadId);
    expect(privateProjection?.lifecycle.error).toContain("[home]");
    expect(privateProjection?.turns.at(-1)?.error).toContain("[home]");
    expect(JSON.stringify(privateProjection)).not.toContain(process.execPath);
    expect(JSON.stringify(privateProjection)).not.toContain(privateInstanceHome);
    expect(JSON.stringify(privateProjection)).not.toContain(privateConfigHome);
    expect(JSON.stringify(privateProjection)).not.toContain("retired-kimi-instance");

    const closed = [remote, legacyRemote].map((socket) => new Promise<number>((resolve) => socket.once("close", (code) => resolve(code))));
    await request(local, { id: 7, method: "remote.revokeDevice", params: { deviceId: claimed.device.id } });
    await expect(Promise.all(closed)).resolves.toEqual([4003, 4003]);
  }, 30_000);

  it("redacts persistence paths from pairing claim failures", async () => {
    const localPort = await freePort();
    const remotePort = await freePort();
    const dataHome = await mkdtemp(join(tmpdir(), "kimi-remote-pairing-error-"));
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), "../src/server.ts");
    child = spawn(process.execPath, ["--import", "tsx", serverPath], {
      env: { ...process.env, KIMI_FAKE: "1", KIMI_SERVER_PORT: String(localPort), KIMI_DESKTOP_HOME: dataHome, KIMI_CODE_HOME: join(dataHome, "kimi-home") },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    const local = await connect(`ws://127.0.0.1:${localPort}`, undefined, { origin: "http://127.0.0.1:1420" });
    sockets.push(local);
    await request(local, { id: 1, method: "remote.configure", params: { enabled: true, bind: "127.0.0.1", port: remotePort } });
    const pairing = await request(local, { id: 2, method: "remote.createPairing", params: {} }) as { code: string };
    const blockedTemporary = join(dataHome, `remote-access.json.${child.pid}.tmp`);
    await mkdir(blockedTemporary);

    const claimSocket = await connect(`ws://127.0.0.1:${remotePort}/pair`);
    sockets.push(claimSocket);
    let claimError = "";
    try {
      await request(claimSocket, { id: 3, method: "remote.claim", params: { code: pairing.code, name: "Failing phone" } });
    } catch (error) {
      claimError = error instanceof Error ? error.message : String(error);
    }
    expect(claimError).toContain("[home]");
    expect(claimError).not.toContain(dataHome);
    expect(claimError).not.toContain(blockedTemporary);
  });
});

function connect(url: string, protocols?: string[], options?: { origin: string }, messages?: Array<{ id?: number; channel?: string; payload?: Record<string, unknown> }>): Promise<WebSocket> {
  const deadline = Date.now() + 8_000;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new WebSocket(url, protocols, options);
      if (messages) socket.on("message", (data) => messages.push(JSON.parse(data.toString()) as { id?: number; channel?: string; payload?: Record<string, unknown> }));
      socket.once("open", () => resolve(socket));
      socket.once("error", (error) => {
        socket.terminate();
        if (Date.now() < deadline) setTimeout(attempt, 50);
        else reject(new Error(`Timed out connecting to ${url}: ${error.message}`));
      });
    };
    attempt();
  });
}

async function waitForCaptured(
  messages: Array<{ id?: number; channel?: string; payload?: Record<string, unknown> }>,
  predicate: (message: { id?: number; channel?: string; payload?: Record<string, unknown> }) => boolean,
): Promise<{ id?: number; channel?: string; payload?: Record<string, unknown> }> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for captured remote message");
}

function request(socket: WebSocket, input: { id: number; method: string; params: unknown }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`Timed out waiting for ${input.method}`)); }, 8_000);
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message?: string } };
      if (message.id !== input.id) return;
      clearTimeout(timer);
      socket.off("message", receive);
      if (message.error) reject(new Error(message.error.message ?? "Remote request failed"));
      else resolve(message.result);
    };
    socket.on("message", receive);
    socket.send(JSON.stringify(input));
  });
}

function waitForPush(socket: WebSocket, channel: string): Promise<{ channel: string; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`Timed out waiting for ${channel}`)); }, 8_000);
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { channel?: string; payload?: Record<string, unknown> };
      if (message.channel !== channel || !message.payload) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve({ channel, payload: message.payload });
    };
    socket.on("message", receive);
  });
}

function waitForDiagnostic(socket: WebSocket, text: string): Promise<{ channel: string; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`Timed out waiting for diagnostic: ${text}`)); }, 8_000);
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as { channel?: string; payload?: Record<string, unknown> };
      if (message.channel !== "server.diagnostics" || typeof message.payload?.message !== "string" || !message.payload.message.includes(text)) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve({ channel: message.channel, payload: message.payload });
    };
    socket.on("message", receive);
  });
}

function waitForDomainEvent(socket: WebSocket, type: string, threadId?: string): Promise<{ type: string; payload: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error(`Timed out waiting for ${type}`)); }, 8_000);
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as {
        channel?: string;
        payload?: { type?: string; threadId?: string; payload?: Record<string, unknown> };
      };
      if (message.channel !== "orchestration.domainEvent"
        || message.payload?.type !== type
        || (threadId && message.payload.threadId !== threadId)
        || !message.payload.payload) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve({ type, payload: message.payload.payload });
    };
    socket.on("message", receive);
  });
}

function waitForQueuePush(socket: WebSocket, threadId: string): Promise<Array<{ images?: Array<{ name: string; mimeType: string }> }>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off("message", receive); reject(new Error("Timed out waiting for queued attachment")); }, 8_000);
    const receive = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString()) as {
        channel?: string;
        payload?: { threadId?: string; queue?: Array<{ images?: Array<{ name: string; mimeType: string }> }> };
      };
      if (message.channel !== "thread.queueUpdated" || message.payload?.threadId !== threadId || !message.payload.queue?.length) return;
      clearTimeout(timer);
      socket.off("message", receive);
      resolve(message.payload.queue);
    };
    socket.on("message", receive);
  });
}

async function waitForRemoteAudit(socket: WebSocket, action: string, count: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  let id = 100;
  while (Date.now() < deadline) {
    const status = await request(socket, { id: id++, method: "remote.status", params: {} }) as { audit: Array<{ action: string }> };
    if (status.audit.filter((event) => event.action === action).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} ${action} audit events`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}
