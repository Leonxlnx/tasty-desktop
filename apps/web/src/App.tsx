import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowCounterClockwise, ArrowSquareOut, ArrowsClockwise, ArrowUp, Brain, Browser, Broom, Bug, CaretDown, CaretRight, ChatCircleDots, Check, Circle, Copy, CornersIn, CornersOut, Cpu, DotsThree, DownloadSimple, FileText, FolderOpen, FolderSimple, Gauge, GearSix, GitBranch, GitCommit, Hammer, ImageSquare, Info, MagnifyingGlass, Minus, Palette, PaperPlaneRight, Paperclip, PencilSimple, PlugsConnected, Plus, Robot, ShieldCheck, SidebarSimple, SignIn, SignOut, SlidersHorizontal, Square, Stop, TerminalWindow, Trash, UserCircle, WarningCircle, X } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ConnectionSupervisor, type ConnectionState, type ServerMessage } from "./connection";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";

type Message = { turnId: string; role: "user" | "assistant" | "thought"; text: string; resources?: string[]; images?: Array<{ name: string; mimeType: string }> };
type ConfigOption = { id: string; name: string; category?: string; type?: string; currentValue: string | boolean; options?: Array<{ value: string; name: string }> };
type AvailableCommand = { name: string; description: string; input?: { hint?: string } | null };
type ToolContent = { type: string; path?: string; oldText?: string; newText?: string; content?: { type: string; text?: string } };
type Tool = { toolCallId: string; turnId?: string; title?: string; status?: string; content?: ToolContent[]; locations?: Array<{ path: string; line?: number }>; rawInput?: unknown; rawOutput?: unknown };
type Approval = { requestId: string; turnId?: string; title: string; kind?: "permission" | "question" | "plan_review"; options: Array<{ optionId: string; name: string; kind: string }> };
type Checkpoint = { turnId: string; phase: string; ref: string; commit: string; root: string; diff?: string };
type PendingImage = { name: string; mimeType: string; data: string };
type Usage = { context?: { used: number; size: number; cost?: { amount: number; currency: string } }; tokens?: { totalTokens: number; inputTokens: number; outputTokens: number; thoughtTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number } };
type KimiQuotaRow = { label: string; used: number; limit: number; remaining: number; resetTime?: string; resetHint?: string };
type KimiQuota = { summary?: KimiQuotaRow; limits: KimiQuotaRow[]; parallel?: number; planType?: string; updatedAt?: string; stale?: boolean };
type KimiPlugin = { name: string; version: string; description: string; toolCount: number };
type KimiMcpServer = { name: string; transport: "http" | "stdio" | "unknown"; target: string; needsAuthorization: boolean; connectable: boolean };
type KimiAgent = { name: "coder" | "explore" | "plan"; description: string; access: string; supportsBackground: boolean };
type KimiCapabilities = { plugins: KimiPlugin[]; mcpServers: KimiMcpServer[]; agents: KimiAgent[]; roots: { plugins: string; mcp: string }; warnings: string[]; updatedAt: string };
type CapabilityTab = "plugins" | "mcp" | "agents";
type SubagentRun = { id: string; type: string; description: string; status: "running" | "completed" | "failed"; background: boolean; agentId?: string };
type GitFile = { path: string; originalPath?: string; staged: boolean; unstaged: boolean; untracked: boolean; indexStatus: string; worktreeStatus: string };
type GitStatus = { root: string; branch: string; upstream?: string; ahead: number; behind: number; files: GitFile[] };
type TurnRecord = { turnId: string; startedAt: string; completedAt?: string; stopReason?: string; usage?: NonNullable<Usage["tokens"]> };
type ActivityEntry = { id: string; turnId: string; kind: "thought" | "tool"; status: "pending" | "in_progress" | "completed" | "failed"; text: string; toolCallId?: string; seq: number; createdAt: string; updatedAt: string };
type QueuedPrompt = { queuedId: string; text: string; mode: "queue" | "steer"; createdAt: string; images: Array<{ name: string; mimeType: string }> };
type DesktopPreviewCommand = { action: "open" | "resize"; url?: string; panelWidth?: number; viewportWidth?: number; viewportHeight?: number };
type Thread = {
  threadId: string; sessionId: string; cwd: string; kind: "project" | "chat"; title: string; createdAt: string; updatedAt: string; running: boolean;
  activeTurnId: string | undefined; stopReason: string | undefined; turns: TurnRecord[]; messages: Message[]; plan: Array<{ content: string; status: string }>;
  activity: ActivityEntry[]; tools: Tool[]; approvals: Approval[]; configOptions: ConfigOption[]; commands: AvailableCommand[]; modeId: string | undefined; checkpoints: Checkpoint[]; usage?: Usage; queue: QueuedPrompt[];
};
type StoredEvent = { threadId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string };
type RuntimeSession = { sessionId: string; cwd: string; kind?: "project" | "chat"; title?: string; updatedAt?: string };
type AuthState = {
  installed: boolean; authenticated: boolean; loginRunning: boolean; installRunning: boolean; home: string;
  event?: { type: "progress" | "complete"; operation: "install" | "login" | "logout"; message: string; url?: string; code?: string; success?: boolean };
};
type Preferences = {
  density: "comfortable" | "compact";
  sendKey: "enter" | "ctrl-enter";
  workspace: string;
  onboardingDone: boolean;
  sidebarCollapsed: boolean;
  projects: string[];
  zoom: number;
  theme: "system" | "dark" | "light";
  font: "system" | "humanist" | "mono";
  fontSize: number;
  accent: "neutral" | "blue" | "violet" | "teal";
  paletteVersion: 4;
  sidebarSide: "left" | "right";
  railSide: "left" | "right";
  sidebarWidth: number;
  railWidth: number;
  projectAliases: Record<string, string>;
  hiddenProjects: string[];
  hiddenSessions: string[];
  composerConfig: Record<string, string>;
  yoloAcknowledged: boolean;
};
type ProjectGroup = { cwd: string; name: string; threads: Thread[]; runtimeSessions: RuntimeSession[] };
type DraftChat = { kind: "project" | "chat"; cwd?: string };
type UpdateStatus = { phase: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error"; version?: string; currentVersion?: string; percent?: number; message?: string };
type RailView = "git" | "terminal" | "preview" | "agents";
type SettingsCategory = "general" | "appearance" | "layout" | "account" | "usage" | "updates" | "about";
type TerminalSessionInfo = { sessionId: string; cwd: string; shell: string };
type TerminalEvent = { sessionId: string; type: "stdout" | "stderr" | "exit"; text?: string; code?: number | null };
type TerminalEntry = { id: number; kind: "command" | "stdout" | "stderr" | "system"; text: string };
type ItemMenu = { kind: "project"; id: string } | { kind: "thread"; id: string } | { kind: "session"; id: string };
type ManageDialog =
  | { kind: "rename-project"; cwd: string; name: string }
  | { kind: "remove-project"; cwd: string; name: string }
  | { kind: "remove-runtime-session"; sessionId: string; name: string }
  | { kind: "delete-project-chats"; cwd: string; name: string; threadIds: string[]; sessionIds: string[] }
  | { kind: "rename-thread"; threadId: string; name: string }
  | { kind: "delete-thread"; threadId: string; sessionId: string; name: string };
const preferenceKey = "kimi-code-desktop.preferences.v1";
const defaultPreferences: Preferences = {
  density: "comfortable", sendKey: "enter", workspace: "", onboardingDone: false, sidebarCollapsed: false, projects: [], zoom: 1,
  theme: "system", font: "system", fontSize: 15, accent: "neutral", paletteVersion: 4, sidebarSide: "left", railSide: "right", sidebarWidth: 272, railWidth: 420,
  projectAliases: {}, hiddenProjects: [], hiddenSessions: [], composerConfig: {}, yoloAcknowledged: false,
};
let terminalEntryId = 0;
const coreCommandNames = new Set(["compact", "status", "usage", "mcp", "tasks", "help"]);
const fallbackCommands: AvailableCommand[] = [
  { name: "compact", description: "Compact the current Kimi session context." },
  { name: "status", description: "Show the current session and runtime status." },
  { name: "usage", description: "Show subscription usage reported by Kimi." },
  { name: "mcp", description: "Show MCP servers and tools available to Kimi." },
  { name: "tasks", description: "Show tasks managed by the current session." },
  { name: "help", description: "Show Kimi Code commands and input help." },
  { name: "mcp-config", description: "Configure MCP servers for Kimi Code." },
  { name: "plugins", description: "Install or manage Kimi plugins and bundled skills." },
  { name: "update-config", description: "Review or update Kimi Code configuration." },
  { name: "check-kimi-code-docs", description: "Check the official Kimi Code documentation." },
  { name: "custom-theme", description: "Create or update a Kimi Code theme." },
  { name: "import-from-cc-codex", description: "Import compatible Claude Code or Codex configuration." },
  { name: "sub-skill", description: "Create or work with a reusable Kimi skill." },
  { name: "sub-skill.review", description: "Review a Kimi skill." },
  { name: "sub-skill.consolidate", description: "Consolidate related Kimi skills." },
  { name: "write-goal", description: "Write a persistent goal for the current workspace." },
];

function terminalEntry(kind: TerminalEntry["kind"], text: string): TerminalEntry {
  return { id: ++terminalEntryId, kind, text: text.slice(-100_000) };
}

function cleanTerminalOutput(text: string): string {
  return text
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n");
}

export function shouldSubmitPrompt(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, sendKey: Preferences["sendKey"]): boolean {
  if (event.key !== "Enter" || event.shiftKey) return false;
  return sendKey === "enter" || event.ctrlKey || event.metaKey;
}

export type ComposerPrimaryAction = "send" | "stop" | "queue" | "steer";

export function composerPrimaryAction(running: boolean, hasText: boolean, mode: "queue" | "steer"): ComposerPrimaryAction {
  if (!running) return "send";
  if (!hasText) return "stop";
  return mode;
}

function composerPrimaryLabel(action: ComposerPrimaryAction): string {
  if (action === "stop") return "Stop task and clear queue";
  if (action === "steer") return "Steer active task";
  if (action === "queue") return "Queue after active task";
  return "Send task";
}

export function hasBlockingWork(threads: Array<Pick<Thread, "running" | "queue" | "approvals">>, draftSending = false): boolean {
  return draftSending || threads.some((thread) => thread.running || thread.queue.length > 0 || thread.approvals.length > 0);
}

export function showSidebarUpdate(phase: UpdateStatus["phase"]): boolean {
  return phase === "available" || phase === "downloading" || phase === "installing";
}

export function App() {
  const supervisor = useRef<ConnectionSupervisor | undefined>(undefined);
  const wasConnected = useRef(false);
  const serverRestarting = useRef(false);
  const automaticRestartAttempted = useRef(false);
  const pendingDomainEvents = useRef<StoredEvent[]>([]);
  const domainEventFrame = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const composerTools = useRef<HTMLDivElement | null>(null);
  const terminalEnd = useRef<HTMLDivElement | null>(null);
  const menuBar = useRef<HTMLElement | null>(null);
  const pendingUpdate = useRef<Update | undefined>(undefined);
  const quotaRefreshInFlight = useRef(false);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [showOnboarding, setShowOnboarding] = useState(() => !loadPreferences().onboardingDone);
  const [cwd, setCwd] = useState(() => loadPreferences().workspace);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [startupDelayed, setStartupDelayed] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSession[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [auth, setAuth] = useState<AuthState>();
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string }>();
  const [threadFilter, setThreadFilter] = useState("");
  const [navView, setNavView] = useState<"projects" | "chats">("projects");
  const [capabilityCenterOpen, setCapabilityCenterOpen] = useState(false);
  const [capabilityTab, setCapabilityTab] = useState<CapabilityTab>("plugins");
  const [capabilities, setCapabilities] = useState<KimiCapabilities>();
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [railView, setRailView] = useState<RailView>();
  const [openMenu, setOpenMenu] = useState<"file" | "edit" | "view" | "help" | undefined>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("general");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [gitStatus, setGitStatus] = useState<GitStatus>();
  const [gitDiff, setGitDiff] = useState<{ path: string; diff: string }>();
  const [commitMessage, setCommitMessage] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [quota, setQuota] = useState<KimiQuota>();
  const [quotaError, setQuotaError] = useState<string>();
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: "idle" });
  const [updateNotice, setUpdateNotice] = useState<string>();
  const [terminalSession, setTerminalSession] = useState<TerminalSessionInfo>();
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState(-1);
  const [terminalStarting, setTerminalStarting] = useState(false);
  const [previewDraft, setPreviewDraft] = useState("http://localhost:3000");
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewRevision, setPreviewRevision] = useState(0);
  const [sendMode, setSendMode] = useState<"queue" | "steer">("queue");
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [itemMenu, setItemMenu] = useState<ItemMenu>();
  const [manageDialog, setManageDialog] = useState<ManageDialog>();
  const [draftChat, setDraftChat] = useState<DraftChat>();
  const [draftSending, setDraftSending] = useState(false);
  const [configDefaults, setConfigDefaults] = useState<ConfigOption[]>([]);
  const [draftConfig, setDraftConfig] = useState<Record<string, string>>({});
  const [yoloConfirm, setYoloConfirm] = useState<{ configId: string; value: string }>();
  const [draggingProject, setDraggingProject] = useState<string>();

  const activeThread = threads.find((thread) => thread.threadId === activeThreadId);
  const agentRuns = useMemo(() => subagentRuns(activeThread), [activeThread]);
  const composerOptions = useMemo(() => activeThread ? activeThread.configOptions : applyDraftConfig(configDefaults, draftConfig), [activeThread, configDefaults, draftConfig]);
  const workBlocksUpdate = hasBlockingWork(threads, draftSending);
  const primaryComposerAction = composerPrimaryAction(Boolean(activeThread?.running), Boolean(prompt.trim()), sendMode);
  const previewPanelMode = preferences.railWidth >= 1_080 ? "Wide" : preferences.railWidth >= 760 ? "Desktop" : "Compact";
  const setDiagnostic = useCallback((message: string) => setDiagnostics((current) => [...current, message].slice(-50)), []);
  const openExternalLink = useCallback(async (url: string) => {
    try {
      await openExternal(url);
    } catch (error) {
      setDiagnostic(`Could not open link: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setDiagnostic]);
  const rememberWorkspace = useCallback((path: string) => {
    if (!path) return;
    setPreferences((current) => ({
      ...current,
      workspace: path,
      projects: current.projects.some((project) => samePath(project, path)) ? current.projects : [path, ...current.projects].slice(0, 12),
      hiddenProjects: current.hiddenProjects.filter((hidden) => !samePath(hidden, path)),
    }));
  }, []);

  useEffect(() => { localStorage.setItem(preferenceKey, JSON.stringify(preferences)); }, [preferences]);

  useEffect(() => {
    const syncVisibility = () => { document.documentElement.dataset.visibility = document.visibilityState; };
    syncVisibility();
    document.addEventListener("visibilitychange", syncVisibility);
    return () => {
      document.removeEventListener("visibilitychange", syncVisibility);
      delete document.documentElement.dataset.visibility;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = preferences.theme;
    root.dataset.font = preferences.font;
    root.dataset.accent = preferences.accent;
    root.style.setProperty("--base-font-size", `${preferences.fontSize}px`);
  }, [preferences.accent, preferences.font, preferences.fontSize, preferences.theme]);

  useEffect(() => { void applyZoom(preferences.zoom); }, [preferences.zoom]);

  useEffect(() => { setSendMode("queue"); }, [activeThreadId, activeThread?.activeTurnId]);
  useEffect(() => { if (!workBlocksUpdate) setUpdateNotice(undefined); }, [workBlocksUpdate]);

  useEffect(() => {
    if (!openMenu) return;
    const closeMenu = (event: PointerEvent) => {
      if (!menuBar.current?.contains(event.target as Node)) setOpenMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(undefined);
    };
    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!itemMenu) return;
    const close = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".item-menu-wrap, .item-menu-portal")) setItemMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setItemMenu(undefined);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [itemMenu]);

  useEffect(() => {
    if (!composerMenuOpen) return;
    const close = (event: PointerEvent) => {
      if (!composerTools.current?.contains(event.target as Node)) setComposerMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setComposerMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [composerMenuOpen]);

  useEffect(() => {
    if (!settingsOpen) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setSettingsQuery("");
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      returnFocus?.focus();
    };
  }, [settingsOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSearchOpen(false);
        setThreadFilter("");
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      returnFocus?.focus();
    };
  }, [searchOpen]);

  const checkForUpdates = useCallback(async (manual = false) => {
    setUpdateStatus({ phase: "checking" });
    try {
      if (!isTauri()) return setUpdateStatus({ phase: "idle" });
      const { getVersion } = await import("@tauri-apps/api/app");
      const { check } = await import("@tauri-apps/plugin-updater");
      const currentVersion = await getVersion();
      const update = await check({ timeout: 30_000 });
      if (pendingUpdate.current && pendingUpdate.current !== update) await pendingUpdate.current.close();
      pendingUpdate.current = update ?? undefined;
      setUpdateStatus(update ? { phase: "available", version: update.version, currentVersion } : { phase: "current", version: currentVersion, currentVersion });
    } catch (error) {
      setUpdateStatus(manual ? { phase: "error", message: error instanceof Error ? error.message : String(error) } : { phase: "idle" });
    }
  }, []);

  useEffect(() => {
    void checkForUpdates();
    return () => { void pendingUpdate.current?.close(); };
  }, [checkForUpdates]);

  useEffect(() => {
    if (!activeThread?.cwd || activeThread.kind === "chat") return;
    setCwd(activeThread.cwd);
    rememberWorkspace(activeThread.cwd);
  }, [activeThread?.cwd, activeThread?.kind, rememberWorkspace]);

  useEffect(() => {
    if (activeThreadId && !threads.some((thread) => thread.threadId === activeThreadId)) setActiveThreadId(undefined);
  }, [activeThreadId, threads]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() === "n" && !event.shiftKey) {
        event.preventDefault();
        if (runtimeReady) navView === "chats" ? createStandaloneChat() : createThread(cwd);
      } else if (event.key.toLowerCase() === "n" && event.shiftKey) {
        event.preventDefault();
        void createAppWindow();
      } else if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void chooseWorkspace();
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        setPreferences((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }));
      } else if (event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleRail("terminal");
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key.toLowerCase() === "w") {
        event.preventDefault();
        void runWindowAction("close");
      } else if (event.key === ",") {
        event.preventDefault();
        setSettingsCategory("general");
        setSettingsOpen(true);
      } else if (event.key === "0") {
        event.preventDefault();
        setPreferences((current) => ({ ...current, zoom: 1 }));
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setPreferences((current) => ({ ...current, zoom: clampZoom(current.zoom + .1) }));
      } else if (event.key === "-") {
        event.preventDefault();
        setPreferences((current) => ({ ...current, zoom: clampZoom(current.zoom - .1) }));
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [cwd, navView, runtimeReady]);

  const call = useCallback((method: string, params: Record<string, unknown> = {}) => supervisor.current?.request(method, params) ?? Promise.reject(new Error("Server is not connected")), []);
  const restartLocalServer = useCallback(async () => {
    if (serverRestarting.current) return;
    serverRestarting.current = true;
    try {
      await invoke("restart_server");
      supervisor.current?.retry();
      setStartupDelayed(false);
    } catch (error) {
      setDiagnostic(`Local runtime restart failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      serverRestarting.current = false;
    }
  }, [setDiagnostic]);
  const workspaceCwd = activeThread?.kind === "project" ? activeThread.cwd : draftChat?.kind === "project" ? draftChat.cwd : cwd;

  useEffect(() => {
    if (activeThread?.kind === "chat" && railView && railView !== "agents") setRailView("agents");
  }, [activeThread?.kind, railView]);

  const refreshQuota = useCallback(async () => {
    if (quotaRefreshInFlight.current) return;
    quotaRefreshInFlight.current = true;
    setQuotaLoading(true);
    setQuotaError(undefined);
    try {
      setQuota(await call("usage.quota") as KimiQuota);
    } catch (error) {
      setQuotaError(error instanceof Error ? error.message : String(error));
    } finally {
      quotaRefreshInFlight.current = false;
      setQuotaLoading(false);
    }
  }, [call]);

  const refreshCapabilities = useCallback(async () => {
    setCapabilitiesLoading(true);
    try {
      setCapabilities(await call("capabilities.list") as KimiCapabilities);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setCapabilitiesLoading(false);
    }
  }, [call, setDiagnostic]);

  useEffect(() => {
    if (connection === "connected") void refreshCapabilities();
  }, [connection, refreshCapabilities]);

  const refreshGit = useCallback(async () => {
    if (!workspaceCwd) return;
    setGitBusy(true);
    try {
      setGitStatus(await call("git.status", { cwd: workspaceCwd }) as GitStatus);
    } catch (error) {
      setGitStatus(undefined);
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setGitBusy(false);
    }
  }, [call, setDiagnostic, workspaceCwd]);

  useEffect(() => {
    if (railView === "git") void refreshGit();
  }, [railView, refreshGit]);

  useEffect(() => {
    if (connection !== "connected" || !auth?.authenticated) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshQuota();
    };
    const interval = window.setInterval(() => void refreshQuota(), 60_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [auth?.authenticated, connection, refreshQuota]);

  useEffect(() => {
    if (connection !== "connected") {
      setTerminalSession(undefined);
      setTerminalStarting(false);
    }
  }, [connection]);

  useEffect(() => {
    terminalEnd.current?.scrollIntoView({ block: "end" });
  }, [terminalEntries]);

  useEffect(() => {
    if (railView !== "terminal" || connection !== "connected" || !workspaceCwd) return;
    if (terminalSession && samePath(terminalSession.cwd, workspaceCwd)) return;
    let disposed = false;
    setTerminalStarting(true);
    void (async () => {
      try {
        if (terminalSession) await call("terminal.stop", { sessionId: terminalSession.sessionId });
        const session = await call("terminal.start", { cwd: workspaceCwd }) as TerminalSessionInfo;
        if (disposed) {
          await call("terminal.stop", { sessionId: session.sessionId });
          return;
        }
        setTerminalSession(session);
        setTerminalEntries((current) => [...current, terminalEntry("system", `${session.shell} · ${session.cwd}\n`)].slice(-1_000));
      } catch (error) {
        if (!disposed) setDiagnostic(error instanceof Error ? error.message : String(error));
      } finally {
        if (!disposed) setTerminalStarting(false);
      }
    })();
    return () => { disposed = true; };
  }, [call, connection, railView, setDiagnostic, terminalSession, workspaceCwd]);

  useEffect(() => {
    let disposed = false;
    let client: ConnectionSupervisor | undefined;
    void localServerUrl().then((url) => {
      if (disposed) return;
      client = new ConnectionSupervisor(url, setConnection, handleMessage);
      supervisor.current = client;
      client.start();
    });
    return () => {
      disposed = true;
      client?.close();
      if (domainEventFrame.current !== undefined) window.cancelAnimationFrame(domainEventFrame.current);
    };

    function handleMessage(message: ServerMessage) {
      if (message.channel === "server.welcome") {
        const payload = message.payload as { defaultCwd: string; threads?: Thread[] };
        setCwd((value) => value || payload.defaultCwd);
        if (payload.threads) {
          const incoming = payload.threads.map(normalizeThread);
          setThreads(incoming);
          setActiveThreadId((current) => current ?? incoming[0]?.threadId);
        }
      } else if (message.channel === "orchestration.domainEvent") {
        const event = message.payload as StoredEvent;
        pendingDomainEvents.current.push(event);
        if (domainEventFrame.current === undefined) {
          domainEventFrame.current = window.requestAnimationFrame(() => {
            const events = pendingDomainEvents.current.splice(0);
            domainEventFrame.current = undefined;
            setThreads((current) => applyEvents(current, events));
          });
        }
        if (event.type === "ThreadCreated") setActiveThreadId(event.threadId);
        if (event.type === "ToolCallCreated" && isSubagentTool(event.payload.tool as Tool | undefined)) setRailView("agents");
      } else if (message.channel === "thread.queueUpdated") {
        const payload = message.payload as { threadId: string; queue: QueuedPrompt[] };
        setThreads((current) => current.map((thread) => thread.threadId === payload.threadId ? { ...thread, queue: payload.queue } : thread));
      } else if (message.channel === "preview.command") {
        applyAgentPreviewCommand(message.payload as DesktopPreviewCommand);
      } else if (message.channel === "server.diagnostics") {
        setDiagnostic(String((message.payload as { message?: string }).message ?? "Runtime error"));
      } else if (message.channel === "auth.status") {
        const status = message.payload as AuthState;
        setAuth(status);
        if (status.event?.message) setDiagnostic(status.event.message);
        if (status.event?.type === "complete" && status.event.operation === "logout") {
          setRuntimeReady(false);
          setQuota(undefined);
          return;
        }
        if (status.authenticated && status.event?.type === "complete") {
          void call("env.bootstrap").then((result) => setRuntimeReady(Boolean((result as { initialize?: unknown }).initialize))).catch((error: Error) => setDiagnostic(error.message));
        }
      } else if (message.channel === "terminal.output") {
        const event = message.payload as TerminalEvent;
        const text = event.type === "exit" ? `Process exited${event.code == null ? "" : ` with code ${event.code}`}\n` : cleanTerminalOutput(event.text ?? "");
        if (text) setTerminalEntries((current) => [...current, terminalEntry(event.type === "exit" ? "system" : event.type, text)].slice(-1_000));
        if (event.type === "exit") setTerminalSession((current) => current?.sessionId === event.sessionId ? undefined : current);
      }
    }
  }, []);

  useEffect(() => {
    if (connection === "connected") {
      wasConnected.current = true;
      automaticRestartAttempted.current = false;
      setStartupDelayed(false);
      return;
    }
    if (!bootstrapping) return;
    const timer = window.setTimeout(() => setStartupDelayed(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [bootstrapping, connection]);

  useEffect(() => {
    if (!wasConnected.current || automaticRestartAttempted.current || (connection !== "error" && connection !== "reconnecting")) return;
    automaticRestartAttempted.current = true;
    const timer = window.setTimeout(() => void restartLocalServer(), 900);
    return () => window.clearTimeout(timer);
  }, [connection, restartLocalServer]);

  useEffect(() => {
    if (connection !== "connected") return;
    setBootstrapping(true);
    void call("env.bootstrap").then((result) => {
      const environment = result as { initialize?: unknown; auth: AuthState };
      setAuth(environment.auth);
      setRuntimeReady(Boolean(environment.initialize));
      if (!environment.auth.authenticated) return { threads: [], runtimeSessions: [] };
      void refreshQuota();
      return call("threads.list");
    }).then((result) => {
      const listed = result as { threads: Thread[]; runtimeSessions: RuntimeSession[] };
      const incoming = listed.threads.map(normalizeThread);
      setThreads(incoming);
      setRuntimeSessions(listed.runtimeSessions);
      setActiveThreadId((current) => current ?? incoming[0]?.threadId);
    }).catch((error: Error) => setDiagnostic(error.message)).finally(() => setBootstrapping(false));
  }, [call, connection, refreshQuota]);

  useEffect(() => {
    const trigger = composerTrigger(prompt);
    const promptCwd = activeThread?.kind === "project" ? activeThread.cwd : draftChat?.kind === "project" ? draftChat.cwd : undefined;
    if (trigger?.kind !== "file" || !promptCwd) {
      setFileSuggestions([]);
      return;
    }
    const timer = window.setTimeout(() => {
      void call("files.tree", { cwd: promptCwd, query: trigger.query }).then((result) => setFileSuggestions((result as { files: string[] }).files.slice(0, 8))).catch(() => setFileSuggestions([]));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [activeThread, call, draftChat, prompt]);

  useEffect(() => {
    if (!runtimeReady || configDefaults.length) return;
    let cancelled = false;
    void call("runtime.configDefaults").then((result) => {
      if (cancelled) return;
      const options = (result as { configOptions?: unknown }).configOptions;
      if (Array.isArray(options)) setConfigDefaults(options as ConfigOption[]);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [call, configDefaults.length, runtimeReady]);

  useEffect(() => {
    if (!draftChat || activeThread) return;
    setDraftConfig(draftConfigOverrides(configDefaults, preferences.composerConfig));
  }, [activeThread, configDefaults, draftChat, preferences.composerConfig]);

  useEffect(() => {
    if (!runtimeReady || !activeThread || activeThread.running) return;
    let cancelled = false;
    void call("threads.resume", { threadId: activeThread.threadId, sessionId: activeThread.sessionId, cwd: activeThread.cwd, replay: false })
      .catch((error: Error) => { if (!cancelled) setDiagnostic(error.message); });
    return () => { cancelled = true; };
  }, [activeThread?.cwd, activeThread?.running, activeThread?.sessionId, activeThread?.threadId, call, runtimeReady]);

  function createThread(targetCwd = cwd) {
    if (!targetCwd) return;
    setCwd(targetCwd);
    rememberWorkspace(targetCwd);
    setNavView("projects");
    setCapabilityCenterOpen(false);
    setActiveThreadId(undefined);
    setDraftChat({ kind: "project", cwd: targetCwd });
    setDiagnostics([]);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function createStandaloneChat() {
    setNavView("chats");
    setCapabilityCenterOpen(false);
    setActiveThreadId(undefined);
    setDraftChat({ kind: "chat" });
    setDiagnostics([]);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function changeThreadMenu(threadId: string, forceOpen = false) {
    setItemMenu((current) => forceOpen ? { kind: "thread", id: threadId } : current?.kind === "thread" && current.id === threadId ? undefined : { kind: "thread", id: threadId });
  }

  function changeRuntimeSessionMenu(sessionId: string, forceOpen = false) {
    setItemMenu((current) => forceOpen ? { kind: "session", id: sessionId } : current?.kind === "session" && current.id === sessionId ? undefined : { kind: "session", id: sessionId });
  }

  function useStarterPrompt(text: string) {
    if (!activeThread && !draftChat) {
      if (navView === "chats") createStandaloneChat();
      else if (cwd) createThread(cwd);
      else return;
    }
    setPrompt(text);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function selectThread(thread: Thread) {
    setCapabilityCenterOpen(false);
    setDraftChat(undefined);
    setActiveThreadId(thread.threadId);
    setNavView(thread.kind === "chat" ? "chats" : "projects");
  }

  async function resumeSession(session: RuntimeSession): Promise<Thread | undefined> {
    try {
      if (session.kind !== "chat") {
        setCwd(session.cwd);
        rememberWorkspace(session.cwd);
      }
      const result = await call("threads.resume", { threadId: session.sessionId, sessionId: session.sessionId, cwd: session.cwd, replay: false }) as { thread: Thread };
      const thread = normalizeThread(result.thread);
      setThreads((current) => current.some((item) => item.threadId === thread.threadId) ? current : [thread, ...current]);
      selectThread(thread);
      return thread;
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
      return undefined;
    }
  }

  async function renameRuntimeSession(session: RuntimeSession) {
    const thread = await resumeSession(session);
    if (thread) setManageDialog({ kind: "rename-thread", threadId: thread.threadId, name: session.title ?? thread.title });
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || (!activeThread && !draftChat) || draftSending) return;
    const mentions = [...text.matchAll(/@\{([^}]+)\}/g)].map((match) => match[1]!);
    const mode = activeThread?.running ? sendMode : "queue";
    setPrompt("");
    setFileSuggestions([]);
    setComposerMenuOpen(false);
    const attachedImages = images;
    setImages([]);
    setDraftSending(Boolean(draftChat));
    try {
      const created = activeThread ? undefined : await call("threads.create", {
        ...(draftChat?.kind === "chat" ? { standalone: true } : { cwd: draftChat?.cwd }),
        ...(Object.keys(draftConfig).length ? { config: draftConfig } : {}),
      }) as { thread: Thread };
      const thread = activeThread ?? normalizeThread(created!.thread);
      if (draftChat) {
        setDraftChat(undefined);
        setActiveThreadId(thread.threadId);
      }
      await call("threads.sendTurn", { threadId: thread.threadId, text, mentions, images: attachedImages, mode });
    } catch (error) {
      setPrompt((current) => current || text);
      setImages((current) => current.length ? current : attachedImages);
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setDraftSending(false);
    }
  }

  function stopThread(threadId: string) {
    void call("threads.interruptTurn", { threadId, clearQueue: true }).catch((error: Error) => setDiagnostic(error.message));
  }

  function removeQueuedPrompt(threadId: string, queuedId: string) {
    void call("threads.removeQueuedTurn", { threadId, queuedId }).catch((error: Error) => setDiagnostic(error.message));
  }

  function updateQueuedPrompt(threadId: string, queuedId: string, text: string) {
    void call("threads.updateQueuedTurn", { threadId, queuedId, text }).catch((error: Error) => setDiagnostic(error.message));
  }

  function steerQueuedPrompt(threadId: string, queuedId: string) {
    void call("threads.steerQueuedTurn", { threadId, queuedId }).catch((error: Error) => setDiagnostic(error.message));
  }

  function clearQueuedPrompts(threadId: string) {
    void call("threads.clearQueue", { threadId }).catch((error: Error) => setDiagnostic(error.message));
  }

  async function confirmManageAction(value?: string) {
    const dialog = manageDialog;
    if (!dialog) return;
    try {
      if (dialog.kind === "rename-thread") {
        const title = value?.trim();
        if (!title) return;
        await call("threads.rename", { threadId: dialog.threadId, title });
      } else if (dialog.kind === "delete-thread") {
        await call("threads.delete", { threadId: dialog.threadId });
        setPreferences((current) => ({ ...current, hiddenSessions: [...new Set([dialog.sessionId, ...current.hiddenSessions])] }));
      } else if (dialog.kind === "rename-project") {
        const title = value?.trim();
        if (!title) return;
        setPreferences((current) => ({ ...current, projectAliases: { ...current.projectAliases, [pathKey(dialog.cwd)]: title } }));
      } else if (dialog.kind === "remove-project") {
        setPreferences((current) => ({
          ...current,
          projects: current.projects.filter((path) => !samePath(path, dialog.cwd)),
          hiddenProjects: uniquePaths([dialog.cwd, ...current.hiddenProjects]),
        }));
      } else if (dialog.kind === "remove-runtime-session") {
        setPreferences((current) => ({ ...current, hiddenSessions: [...new Set([dialog.sessionId, ...current.hiddenSessions])] }));
      } else if (dialog.kind === "delete-project-chats") {
        await Promise.all(dialog.threadIds.map((threadId) => call("threads.delete", { threadId })));
        setPreferences((current) => ({ ...current, hiddenSessions: [...new Set([...dialog.sessionIds, ...current.hiddenSessions])] }));
      }
      setManageDialog(undefined);
      setItemMenu(undefined);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  function reorderProject(source: string, target: string) {
    if (samePath(source, target)) return;
    setPreferences((current) => ({ ...current, projects: reorderPaths(current.projects, source, target) }));
  }

  function respond(approval: Approval, optionId?: string) {
    if (!activeThread) return;
    void call("threads.respondToRequest", { threadId: activeThread.threadId, requestId: approval.requestId, optionId }).catch((error: Error) => setDiagnostic(error.message));
  }

  function setConfig(configId: string, value: string) {
    setPreferences((current) => ({ ...current, composerConfig: { ...current.composerConfig, [configId]: value } }));
    if (activeThread) {
      void call("threads.setConfigOption", { threadId: activeThread.threadId, configId, value }).catch((error: Error) => setDiagnostic(error.message));
    } else if (draftChat) {
      setDraftConfig((current) => {
        const option = configDefaults.find((candidate) => candidate.id === configId);
        const next = { ...current };
        if (option && String(option.currentValue) === value) delete next[configId];
        else next[configId] = value;
        return next;
      });
    }
  }

  function changeConfig(configId: string, value: string) {
    const option = composerOptions.find((candidate) => candidate.id === configId);
    if (isYoloChoice(option, value) && !preferences.yoloAcknowledged) {
      setYoloConfirm({ configId, value });
      return;
    }
    setConfig(configId, value);
  }

  function insertMention(file: string) {
    setPrompt((value) => replaceComposerTrigger(value, `@{${file}} `));
    setFileSuggestions([]);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function insertCommand(command: AvailableCommand) {
    setPrompt((value) => replaceComposerTrigger(value, `/${command.name} `));
    setFileSuggestions([]);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function startComposerTrigger(prefix: "/" | "$" | "#") {
    setComposerMenuOpen(false);
    setPrompt((value) => `${value}${value && !/\s$/.test(value) ? " " : ""}${prefix}`);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function toggleComposerCommandPicker() {
    setComposerMenuOpen(false);
    setPrompt((value) => toggleComposerTrigger(value, "/"));
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function startComposerCommand(command: string) {
    setComposerMenuOpen(false);
    setPrompt((value) => `${value}${value && !/\s$/.test(value) ? " " : ""}/${command} `);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function useCapabilityPrompt(text: string) {
    setCapabilityCenterOpen(false);
    if (!activeThread && !draftChat && !cwd) {
      setNavView("chats");
      setActiveThreadId(undefined);
      setDraftChat({ kind: "chat" });
      setPrompt(text);
      window.setTimeout(() => composerInput.current?.focus(), 0);
      return;
    }
    useStarterPrompt(text);
  }

  async function attachWorkspaceFiles() {
    const promptCwd = activeThread?.kind === "project" ? activeThread.cwd : draftChat?.kind === "project" ? draftChat.cwd : undefined;
    if (!promptCwd) {
      setDiagnostic("Open a project before attaching workspace files.");
      return;
    }
    setComposerMenuOpen(false);
    try {
      if (!isTauri()) throw new Error("The native file picker is available in the desktop app");
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: false,
        multiple: true,
        defaultPath: promptCwd,
        title: "Attach project files",
      });
      const paths = typeof selected === "string" ? [selected] : selected ?? [];
      const relative = paths.map((path) => workspaceRelativePath(promptCwd, path)).filter((path): path is string => Boolean(path));
      if (relative.length !== paths.length) setDiagnostic("Only files inside the active project can be attached.");
      if (relative.length) {
        setPrompt((value) => `${value}${value && !/\s$/.test(value) ? " " : ""}${relative.map((path) => `@{${path}}`).join(" ")} `);
        window.setTimeout(() => composerInput.current?.focus(), 0);
      }
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function attachImages(files: FileList | null) {
    if (!files) return;
    const selected = [...files].filter((file) => file.type.startsWith("image/")).slice(0, 5 - images.length);
    const loaded = await Promise.all(selected.map(readImage));
    setImages((current) => [...current, ...loaded]);
  }

  async function openLocation(path: string) {
    if (!activeThread) return;
    try {
      setSelectedFile(await call("files.read", { cwd: activeThread.cwd, path }) as { path: string; content: string });
      setRailView("git");
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function openGitDiff(path: string) {
    if (!workspaceCwd) return;
    try {
      setGitDiff(await call("git.diff", { cwd: workspaceCwd, path }) as { path: string; diff: string });
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function changeGitStage(file: GitFile) {
    if (!workspaceCwd) return;
    setGitBusy(true);
    try {
      const method = file.staged ? "git.unstage" : "git.stage";
      setGitStatus(await call(method, { cwd: workspaceCwd, paths: [file.path] }) as GitStatus);
      if (gitDiff?.path === file.path) await openGitDiff(file.path);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setGitBusy(false);
    }
  }

  async function commitGit() {
    if (!workspaceCwd || !commitMessage.trim()) return;
    setGitBusy(true);
    try {
      const result = await call("git.commit", { cwd: workspaceCwd, message: commitMessage }) as { commit: string; status: GitStatus };
      setGitStatus(result.status);
      setGitDiff(undefined);
      setCommitMessage("");
      setDiagnostic(`Committed ${result.commit}`);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setGitBusy(false);
    }
  }

  function runTerminalCommand(event: FormEvent) {
    event.preventDefault();
    const command = terminalCommand.trim();
    if (!command || !terminalSession) return;
    setTerminalCommand("");
    setTerminalHistoryIndex(-1);
    if (command === "clear" || command === "cls") {
      setTerminalEntries([]);
      return;
    }
    setTerminalEntries((current) => [...current, terminalEntry("command", `› ${command}\n`)].slice(-1_000));
    setTerminalHistory((current) => [...current.filter((item) => item !== command), command].slice(-100));
    void call("terminal.write", { sessionId: terminalSession.sessionId, command }).catch((error: Error) => {
      setTerminalEntries((current) => [...current, terminalEntry("stderr", `${error.message}\n`)].slice(-1_000));
    });
  }

  async function restartTerminal() {
    const current = terminalSession;
    setTerminalSession(undefined);
    setTerminalEntries([]);
    if (current) await call("terminal.stop", { sessionId: current.sessionId }).catch(() => undefined);
  }

  function showPreview(candidate = previewDraft) {
    const normalized = normalizeLocalPreviewUrl(candidate);
    if (!normalized) {
      setDiagnostic("Preview accepts localhost or 127.0.0.1 URLs only");
      return;
    }
    setPreviewDraft(normalized);
    setPreviewUrl(normalized);
    setRailView("preview");
  }

  function applyAgentPreviewCommand(command: DesktopPreviewCommand) {
    const normalized = command.url ? normalizeLocalPreviewUrl(command.url) : undefined;
    if (normalized) {
      setPreviewDraft(normalized);
      setPreviewUrl(normalized);
    }
    if (command.panelWidth !== undefined) {
      setPreferences((current) => ({ ...current, railWidth: clampPanelWidth("rail", command.panelWidth!) }));
    }
    if (command.action === "open") setPreviewRevision((value) => value + 1);
    setRailView("preview");
  }

  function toggleRail(view: RailView) {
    setRailView((current) => current === view ? undefined : view);
  }

  async function revertTurn(turnId: string) {
    if (!activeThread) return;
    try {
      await call("checkpoints.revert", { threadId: activeThread.threadId, turnId });
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function chooseWorkspace() {
    try {
      if (!isTauri()) throw new Error("The native folder picker is available in the desktop app");
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true, multiple: false, title: "Choose a Kimi Code workspace" });
      if (typeof selected === "string") {
        setCwd(selected);
        rememberWorkspace(selected);
        setNavView("projects");
        setCapabilityCenterOpen(false);
        setDraftChat(undefined);
        setActiveThreadId(threads.find((thread) => samePath(thread.cwd, selected))?.threadId);
      }
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function beginLogin() {
    try {
      setAuth((current) => current ? { ...current, loginRunning: true } : current);
      setAuth(await call("auth.beginLogin") as AuthState);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function installCli() {
    try {
      setAuth((current) => current ? { ...current, installRunning: true } : current);
      setAuth(await call("env.installCli") as AuthState);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function logout() {
    try {
      setAuth(await call("auth.logout") as AuthState);
      setRuntimeReady(false);
      setQuota(undefined);
      setSettingsCategory("account");
      setSettingsOpen(true);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function installUpdate() {
    const update = pendingUpdate.current;
    if (!update) return;
    if (workBlocksUpdate) {
      setUpdateNotice("Finish or stop active work before updating.");
      return;
    }
    setUpdateNotice(undefined);
    let downloaded = 0;
    let total: number | undefined;
    const currentVersion = updateStatus.currentVersion;
    setUpdateStatus({ phase: "downloading", version: update.version, ...(currentVersion ? { currentVersion } : {}), percent: 0 });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (event.event !== "Finished") {
          const percent = updatePercent(downloaded, total);
          setUpdateStatus({ phase: "downloading", version: update.version, ...(currentVersion ? { currentVersion } : {}), ...(percent === undefined ? {} : { percent }) });
        }
      });
      setUpdateStatus({ phase: "installing", version: update.version, ...(currentVersion ? { currentVersion } : {}), percent: 100 });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setUpdateStatus({ phase: "error", version: update.version, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async function runWindowAction(action: "minimize" | "maximize" | "close") {
    try {
      if (!isTauri()) return;
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const window = getCurrentWindow();
      if (action === "minimize") await window.minimize();
      else if (action === "maximize") await window.toggleMaximize();
      else await window.close();
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function createAppWindow() {
    try {
      if (!isTauri()) throw new Error("New windows are available in the desktop app");
      const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
      const window = new WebviewWindow(`kimi-${Date.now()}`, { url: "/", title: "Kimi Code", width: 1280, height: 800, minWidth: 900, minHeight: 620, decorations: false });
      await window.once("tauri://error", (event) => setDiagnostic(String(event.payload)));
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function exitApp() {
    try {
      const { exit } = await import("@tauri-apps/plugin-process");
      await exit(0);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function edit(command: "cut" | "copy" | "paste" | "delete" | "selectAll") {
    try {
      let applied = false;
      const target = document.activeElement;
      if (command === "paste" && (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && !target.disabled && !target.readOnly) {
        const text = await navigator.clipboard.readText();
        target.setRangeText(text, target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length, "end");
        target.dispatchEvent(new Event("input", { bubbles: true }));
        applied = true;
      } else {
        applied = document.execCommand(command);
      }
      if (!applied) setDiagnostic(`${command === "selectAll" ? "Select all" : command[0]!.toUpperCase() + command.slice(1)} is not available for the current selection.`);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setOpenMenu(undefined);
    }
  }

  function finishOnboarding() {
    setPreferences((current) => ({ ...current, workspace: cwd || current.workspace, onboardingDone: true, projects: cwd ? uniquePaths([cwd, ...current.projects]) : current.projects }));
    setShowOnboarding(false);
  }

  function beginPanelResize(panel: "sidebar" | "rail", event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = panel === "sidebar" ? preferences.sidebarWidth : preferences.railWidth;
    const side = panel === "sidebar" ? preferences.sidebarSide : preferences.railSide;
    const direction = side === "left" ? 1 : -1;
    const move = (pointer: PointerEvent) => {
      const width = clampPanelWidth(panel, startWidth + (pointer.clientX - startX) * direction);
      setPreferences((current) => panel === "sidebar" ? { ...current, sidebarCollapsed: false, sidebarWidth: width } : { ...current, railWidth: width });
    };
    const stop = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function resizePanelWithKeyboard(panel: "sidebar" | "rail", event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const side = panel === "sidebar" ? preferences.sidebarSide : preferences.railSide;
    const direction = (event.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
    setPreferences((current) => panel === "sidebar"
      ? { ...current, sidebarCollapsed: false, sidebarWidth: clampPanelWidth(panel, current.sidebarWidth + direction * 12) }
      : { ...current, railWidth: clampPanelWidth(panel, current.railWidth + direction * 12) });
  }

  const projectedRuntimeSessions = useMemo(() => filterRuntimeSessions(runtimeSessions, threads, preferences.hiddenSessions), [preferences.hiddenSessions, runtimeSessions, threads]);
  const standaloneThreads = useMemo(() => threads.filter((thread) => thread.kind === "chat"), [threads]);
  const projectThreads = useMemo(() => threads.filter((thread) => thread.kind !== "chat"), [threads]);
  const standaloneRuntimeSessions = useMemo(() => projectedRuntimeSessions.filter((session) => session.kind === "chat"), [projectedRuntimeSessions]);
  const projectRuntimeSessions = useMemo(() => projectedRuntimeSessions.filter((session) => session.kind !== "chat"), [projectedRuntimeSessions]);
  const visibleThreads = useMemo(() => filterByTitle(standaloneThreads, threadFilter), [standaloneThreads, threadFilter]);
  const visibleRuntimeSessions = useMemo(() => filterByTitle(standaloneRuntimeSessions, threadFilter), [standaloneRuntimeSessions, threadFilter]);
  const projects = useMemo(() => groupProjects(preferences.projects, projectThreads, projectRuntimeSessions, preferences.projectAliases)
    .filter((project) => !preferences.hiddenProjects.some((hidden) => samePath(hidden, project.cwd))), [preferences.hiddenProjects, preferences.projectAliases, preferences.projects, projectRuntimeSessions, projectThreads]);
  const visibleProjects = useMemo(() => filterProjects(projects, threadFilter), [projects, threadFilter]);
  const turnViews = useMemo(() => activeThread ? projectTurns(activeThread) : [], [activeThread]);
  const runtimeCommands = activeThread?.commands.length ? activeThread.commands : threads.find((thread) => thread.commands.length)?.commands;
  const commandCatalog = useMemo(() => runtimeCommands?.length ? runtimeCommands : fallbackCommands, [runtimeCommands]);
  const nativeCapabilityCommands = useMemo(() => new Set((runtimeCommands ?? []).map((command) => command.name)), [runtimeCommands]);
  const promptTrigger = useMemo(() => composerTrigger(prompt), [prompt]);
  const commandSuggestions = useMemo(() => {
    if (promptTrigger?.kind !== "command" && promptTrigger?.kind !== "skill") return [];
    const query = promptTrigger.query.toLowerCase();
    return commandCatalog
      .filter((command) => promptTrigger.kind === "command" || !coreCommandNames.has(command.name))
      .filter((command) => !query || command.name.toLowerCase().includes(query) || command.description.toLowerCase().includes(query))
      .slice(0, 10);
  }, [commandCatalog, promptTrigger]);
  const sidebarIconOnly = preferences.sidebarCollapsed || preferences.sidebarWidth < 168;
  const workspaceTools = activeThread ? activeThread.kind === "project" : draftChat ? draftChat.kind === "project" : navView === "projects" && Boolean(cwd);
  const railAvailable = Boolean(activeThread) || workspaceTools;
  const composerProjectCwd = activeThread?.kind === "project" ? activeThread.cwd : draftChat?.kind === "project" ? draftChat.cwd : undefined;
  const quotaLeft = quotaPercent(quota);
  const context = activeThread?.usage?.context;
  const contextUsed = contextPercent(activeThread?.usage);
  const shellStyle = {
    "--sidebar-current-width": `${preferences.sidebarCollapsed ? 60 : preferences.sidebarWidth}px`,
    "--rail-current-width": `${preferences.railWidth}px`,
  } as CSSProperties;
  const railResizeHandle = railView ? <div className="panel-resizer rail-resizer" role="separator" aria-label="Resize side panel" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={1200} aria-valuenow={preferences.railWidth} tabIndex={0} onPointerDown={(event) => beginPanelResize("rail", event)} onKeyDown={(event) => resizePanelWithKeyboard("rail", event)} /> : null;
  const railTabs = railView ? <RailTabs current={railView} workspace={workspaceTools} activeAgents={agentRuns.filter((run) => run.status === "running").length} onSelect={setRailView} onClose={() => setRailView(undefined)} /> : null;

  return (
    <main style={shellStyle} className={`shell ${railView ? "rail-open" : ""} ${preferences.sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarIconOnly ? "sidebar-icon-only" : ""} sidebar-${preferences.sidebarSide} rail-${preferences.railSide} density-${preferences.density}`}>
      <header className="app-titlebar">
        <div className="titlebar-logo" title="Kimi Code"><img src="/kimi-logo.png" alt="" aria-hidden="true" /></div>
        <nav ref={menuBar} className="menu-bar" aria-label="Application menu">
          <div className={`app-menu ${openMenu === "file" ? "open" : ""}`} onPointerEnter={() => { if (openMenu) setOpenMenu("file"); }}>
            <button className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "file"} onClick={() => setOpenMenu((current) => current === "file" ? undefined : "file")}>File</button>
            {openMenu === "file" && <div className="menu-popover" role="menu" onKeyDown={moveMenuFocus}>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void createAppWindow(); }}><span>New Window</span><kbd>Ctrl Shift N</kbd></button>
              <button type="button" role="menuitem" disabled={!runtimeReady || (navView === "projects" && !cwd)} onClick={() => { setOpenMenu(undefined); navView === "chats" ? createStandaloneChat() : createThread(cwd); }}><span>New Chat</span><kbd>Ctrl N</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void chooseWorkspace(); }}><span>Open Folder…</span><kbd>Ctrl O</kbd></button>
              <span className="menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void runWindowAction("close"); }}><span>Close Window</span><kbd>Ctrl W</kbd></button>
              <button type="button" role="menuitem" disabled={!auth?.authenticated} onClick={() => { setOpenMenu(undefined); void logout(); }}>Log Out</button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void exitApp(); }}>Exit</button>
            </div>}
          </div>
          <div className={`app-menu ${openMenu === "edit" ? "open" : ""}`} onPointerEnter={() => { if (openMenu) setOpenMenu("edit"); }}>
            <button className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "edit"} onPointerDown={(event) => event.preventDefault()} onClick={() => setOpenMenu((current) => current === "edit" ? undefined : "edit")}>Edit</button>
            {openMenu === "edit" && <div className="menu-popover" role="menu" onKeyDown={moveMenuFocus} onPointerDown={(event) => event.preventDefault()}>
              <button type="button" role="menuitem" onClick={() => void edit("cut")}><span>Cut</span><kbd>Ctrl X</kbd></button>
              <button type="button" role="menuitem" onClick={() => void edit("copy")}><span>Copy</span><kbd>Ctrl C</kbd></button>
              <button type="button" role="menuitem" onClick={() => void edit("paste")}><span>Paste</span><kbd>Ctrl V</kbd></button>
              <button type="button" role="menuitem" onClick={() => void edit("delete")}>Delete</button>
              <span className="menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => void edit("selectAll")}><span>Select All</span><kbd>Ctrl A</kbd></button>
            </div>}
          </div>
          <div className={`app-menu ${openMenu === "view" ? "open" : ""}`} onPointerEnter={() => { if (openMenu) setOpenMenu("view"); }}>
            <button className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "view"} onClick={() => setOpenMenu((current) => current === "view" ? undefined : "view")}>View</button>
            {openMenu === "view" && <div className="menu-popover" role="menu" onKeyDown={moveMenuFocus}>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); setPreferences((current) => ({ ...current, zoom: clampZoom(current.zoom + .1) })); }}><span>Zoom In</span><kbd>Ctrl +</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); setPreferences((current) => ({ ...current, zoom: clampZoom(current.zoom - .1) })); }}><span>Zoom Out</span><kbd>Ctrl −</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); setPreferences((current) => ({ ...current, zoom: 1 })); }}><span>Actual Size</span><kbd>Ctrl 0</kbd></button>
              <span className="menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); setPreferences((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed })); }}><span>{preferences.sidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}</span><kbd>Ctrl B</kbd></button>
              <button type="button" role="menuitem" disabled={!workspaceTools} onClick={() => { setOpenMenu(undefined); toggleRail("git"); }}>Git Changes</button>
              <button type="button" role="menuitem" disabled={!workspaceTools} onClick={() => { setOpenMenu(undefined); toggleRail("terminal"); }}><span>Terminal</span><kbd>Ctrl J</kbd></button>
              <button type="button" role="menuitem" disabled={!workspaceTools} onClick={() => { setOpenMenu(undefined); showPreview(); }}>App Preview</button>
            </div>}
          </div>
          <div className={`app-menu ${openMenu === "help" ? "open" : ""}`} onPointerEnter={() => { if (openMenu) setOpenMenu("help"); }}>
            <button className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "help"} onClick={() => setOpenMenu((current) => current === "help" ? undefined : "help")}>Help</button>
            {openMenu === "help" && <div className="menu-popover" role="menu" onKeyDown={moveMenuFocus}>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void openExternalLink("https://www.kimi.com/code/docs/en/"); }}>Kimi Code Documentation</button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void openExternalLink("https://github.com/Leonxlnx/kimi-code-desktop#readme"); }}>Kimi Code Desktop Documentation</button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void openExternalLink("https://github.com/MoonshotAI/kimi-cli"); }}>Kimi Code CLI on GitHub</button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); setSettingsCategory("about"); setSettingsOpen(true); }}>About Kimi Code Desktop</button>
            </div>}
          </div>
          <button className="menu-settings" type="button" onClick={() => { setOpenMenu(undefined); setSettingsCategory("general"); setSettingsOpen(true); }}>Settings</button>
        </nav>
        <div className="titlebar-drag" data-tauri-drag-region onDoubleClick={() => void runWindowAction("maximize")} />
        <div className="window-controls">
          <button type="button" aria-label="Minimize" onClick={() => void runWindowAction("minimize")}><Minus /></button>
          <button type="button" aria-label="Maximize or restore" onClick={() => void runWindowAction("maximize")}><Square /></button>
          <button className="window-close" type="button" aria-label="Close" onClick={() => void runWindowAction("close")}><X /></button>
        </div>
      </header>

      <aside className="sidebar" aria-label="Kimi Code navigation">
        {!preferences.sidebarCollapsed && <div className="panel-resizer sidebar-resizer" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" aria-valuemin={84} aria-valuemax={420} aria-valuenow={preferences.sidebarWidth} tabIndex={0} onPointerDown={(event) => beginPanelResize("sidebar", event)} onKeyDown={(event) => resizePanelWithKeyboard("sidebar", event)} />}
        <div className="sidebar-toolbar">
          <button className="toolbar-icon" type="button" aria-label={preferences.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={preferences.sidebarCollapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"} onClick={() => setPreferences((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))}><SidebarSimple /></button>
          <nav className="view-switch" aria-label="Workspace views">
            <button className={!capabilityCenterOpen && navView === "projects" ? "active" : ""} type="button" aria-current={!capabilityCenterOpen && navView === "projects" ? "page" : undefined} title="Projects" onClick={() => { setCapabilityCenterOpen(false); setNavView("projects"); }}><FolderSimple /><span>Projects</span></button>
            <button className={!capabilityCenterOpen && navView === "chats" ? "active" : ""} type="button" aria-current={!capabilityCenterOpen && navView === "chats" ? "page" : undefined} title="Chats" onClick={() => { setCapabilityCenterOpen(false); setNavView("chats"); }}><ChatCircleDots /><span>Chats</span></button>
          </nav>
          <button className="toolbar-icon" type="button" aria-label="Search projects and chats" title="Search (Ctrl+K)" onClick={() => setSearchOpen(true)}><MagnifyingGlass /></button>
        </div>

        <button className={`capability-link ${capabilityCenterOpen ? "active" : ""}`} type="button" aria-current={capabilityCenterOpen ? "page" : undefined} title="Plugins, MCP, and subagents" onClick={() => { setRailView(undefined); setCapabilityCenterOpen(true); void refreshCapabilities(); }}><PlugsConnected /><span><strong>Plugins</strong><small>{capabilities ? `${capabilities.plugins.length} installed · ${capabilities.mcpServers.length} MCP` : "Kimi capabilities"}</small></span><CaretRight /></button>

        <div className="sidebar-body">
          <div className="sidebar-heading"><span>{navView === "projects" ? "Projects" : "Chats"}</span><button type="button" title={navView === "projects" ? "Open folder" : "New chat"} aria-label={navView === "projects" ? "Open folder" : "New chat"} disabled={navView === "chats" && !runtimeReady} onClick={() => navView === "projects" ? void chooseWorkspace() : createStandaloneChat()}>{navView === "projects" ? <FolderOpen /> : <Plus />}</button></div>
          <div className="sidebar-list">
            {bootstrapping ? <SidebarSkeleton /> : navView === "projects" ? visibleProjects.map((project) => <details className={`project-group ${draggingProject && samePath(draggingProject, project.cwd) ? "dragging" : ""}`} key={project.cwd} open>
              <summary className={`project-row ${samePath(project.cwd, cwd) ? "active" : ""}`} title={project.cwd} draggable onDragStart={() => setDraggingProject(project.cwd)} onDragEnd={() => setDraggingProject(undefined)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); if (draggingProject) reorderProject(draggingProject, project.cwd); setDraggingProject(undefined); }} onContextMenu={(event) => { event.preventDefault(); setItemMenu({ kind: "project", id: project.cwd }); }} onClick={() => { setCapabilityCenterOpen(false); setCwd(project.cwd); rememberWorkspace(project.cwd); setDraftChat(undefined); const first = project.threads[0]; if (first) selectThread(first); else setActiveThreadId(undefined); }}>
                <CaretRight className="project-caret" size={13} /><FolderSimple size={15} /><span>{project.name}</span>
                <span className="row-actions">
                  <button className="project-new" type="button" aria-label={`New chat in ${project.name}`} title={`New chat in ${project.name}`} disabled={!runtimeReady} onClick={(event) => { event.preventDefault(); event.stopPropagation(); void createThread(project.cwd); }}><Plus /></button>
                  <ItemActions open={itemMenu?.kind === "project" && itemMenu.id === project.cwd} label={`Manage ${project.name}`} onToggle={() => setItemMenu((current) => current?.kind === "project" && current.id === project.cwd ? undefined : { kind: "project", id: project.cwd })} items={[
                    { label: "Rename project", icon: <PencilSimple />, onSelect: () => setManageDialog({ kind: "rename-project", cwd: project.cwd, name: project.name }) },
                    { label: "Remove from sidebar", icon: <X />, onSelect: () => setManageDialog({ kind: "remove-project", cwd: project.cwd, name: project.name }) },
                    ...(project.threads.length ? [{ label: `Delete ${project.threads.length} chat${project.threads.length === 1 ? "" : "s"}`, icon: <Trash />, danger: true, onSelect: () => setManageDialog({ kind: "delete-project-chats" as const, cwd: project.cwd, name: project.name, threadIds: project.threads.map((thread) => thread.threadId), sessionIds: project.threads.map((thread) => thread.sessionId) }) }] : []),
                  ]} />
                </span>
              </summary>
              <div className="project-threads">
                {project.threads.map((thread) => <ThreadNavItem thread={thread} active={thread.threadId === activeThread?.threadId} key={thread.threadId} menuOpen={itemMenu?.kind === "thread" && itemMenu.id === thread.threadId} onSelect={() => selectThread(thread)} onMenu={(forceOpen) => changeThreadMenu(thread.threadId, forceOpen)} onStop={() => stopThread(thread.threadId)} onRename={() => setManageDialog({ kind: "rename-thread", threadId: thread.threadId, name: thread.title })} onDelete={() => setManageDialog({ kind: "delete-thread", threadId: thread.threadId, sessionId: thread.sessionId, name: thread.title })} />)}
                {project.runtimeSessions.map((session) => <RuntimeSessionNavItem session={session} key={session.sessionId} menuOpen={itemMenu?.kind === "session" && itemMenu.id === session.sessionId} onSelect={() => void resumeSession(session)} onMenu={(forceOpen) => changeRuntimeSessionMenu(session.sessionId, forceOpen)} onRename={() => void renameRuntimeSession(session)} onRemove={() => setManageDialog({ kind: "remove-runtime-session", sessionId: session.sessionId, name: session.title ?? "Kimi session" })} />)}
              </div>
            </details>) : <>
              {visibleThreads.map((thread) => <ThreadNavItem thread={thread} active={thread.threadId === activeThread?.threadId} chat key={thread.threadId} menuOpen={itemMenu?.kind === "thread" && itemMenu.id === thread.threadId} onSelect={() => selectThread(thread)} onMenu={(forceOpen) => changeThreadMenu(thread.threadId, forceOpen)} onStop={() => stopThread(thread.threadId)} onRename={() => setManageDialog({ kind: "rename-thread", threadId: thread.threadId, name: thread.title })} onDelete={() => setManageDialog({ kind: "delete-thread", threadId: thread.threadId, sessionId: thread.sessionId, name: thread.title })} />)}
              {visibleRuntimeSessions.map((session) => <RuntimeSessionNavItem session={session} chat key={session.sessionId} menuOpen={itemMenu?.kind === "session" && itemMenu.id === session.sessionId} onSelect={() => void resumeSession(session)} onMenu={(forceOpen) => changeRuntimeSessionMenu(session.sessionId, forceOpen)} onRename={() => void renameRuntimeSession(session)} onRemove={() => setManageDialog({ kind: "remove-runtime-session", sessionId: session.sessionId, name: session.title ?? "Kimi chat" })} />)}
            </>}
            {!bootstrapping && threadFilter && (navView === "projects" ? !visibleProjects.length : !visibleThreads.length && !visibleRuntimeSessions.length) && <p className="thread-empty">No matches</p>}
            {!bootstrapping && !threadFilter && navView === "projects" && !visibleProjects.length && <button className="sidebar-empty" type="button" onClick={() => void chooseWorkspace()}><FolderOpen /> Open your first folder</button>}
            {!bootstrapping && !threadFilter && navView === "chats" && !visibleThreads.length && !visibleRuntimeSessions.length && <button className="sidebar-empty" type="button" disabled={!runtimeReady} onClick={createStandaloneChat}><ChatCircleDots /> Start a chat</button>}
          </div>
        </div>

        <footer className="sidebar-footer">
          <button className="sidebar-quota" type="button" title={quotaLeft === undefined ? "Subscription usage unavailable" : `${quotaLeft}% of current Kimi quota left`} onClick={() => { setSettingsCategory("usage"); setSettingsOpen(true); }}>
            <Gauge />
            <span><small>Usage limits</small><strong>{quotaLeft === undefined ? (quotaLoading ? "Updating…" : "View usage") : `${quotaLeft}% left`}</strong>{quotaLeft !== undefined && <i><b style={{ transform: `scaleX(${quotaLeft / 100})` }} /></i>}</span>
          </button>
          {updateNotice && <div className="sidebar-update-note" role="status">{updateNotice}</div>}
          <div className="sidebar-footer-actions">
            <button className={`nav-item settings-link ${settingsOpen ? "active" : ""}`} type="button" title="Settings" onClick={() => { setSettingsCategory("general"); setSettingsOpen(true); }}><GearSix size={17} /><span>Settings</span></button>
            {showSidebarUpdate(updateStatus.phase) && <button className={`sidebar-update ${updateStatus.phase}`} type="button" aria-label={updateStatus.phase === "available" ? `Install Kimi Code Desktop ${updateStatus.version ?? "update"} and restart` : `${updateStatus.phase === "downloading" ? "Downloading" : "Installing"} Kimi Code Desktop update`} title={updateStatus.phase === "available" ? "Install update & restart" : `${updateStatus.phase === "downloading" ? "Downloading" : "Installing"} update`} disabled={updateStatus.phase !== "available"} onClick={() => void installUpdate()}>{updateStatus.phase === "available" ? <DownloadSimple /> : <ArrowsClockwise />}<span>{updateStatus.phase === "available" ? "Update" : updateStatus.phase === "downloading" && updateStatus.percent !== undefined ? `${updateStatus.percent}%` : "Updating"}</span></button>}
          </div>
        </footer>
      </aside>

      <section className="conversation">
        <header className="topbar">
          <div className="topbar-title"><strong>{capabilityCenterOpen ? "Kimi capabilities" : activeThread?.title ?? (draftChat ? "New chat" : navView === "chats" ? "Chats" : cwd ? workspaceName(cwd) : "Kimi")}</strong></div>
          <div className="topbar-actions">
            {railAvailable && !capabilityCenterOpen && <button className={`panel-toggle rail-master-toggle ${railView ? "active" : ""}`} type="button" title={railView ? "Close work panel" : "Open work panel"} aria-label={railView ? "Close work panel" : "Open work panel"} aria-expanded={Boolean(railView)} onClick={() => setRailView((current) => current ? undefined : activeThread?.kind === "chat" ? "agents" : agentRuns.some((run) => run.status === "running") ? "agents" : "git")}><SidebarSimple /></button>}
          </div>
        </header>

        <div className={`timeline ${capabilityCenterOpen ? "capability-timeline" : ""}`}>
          {bootstrapping ? <StartupScreen delayed={startupDelayed} onRetry={() => void restartLocalServer()} /> : capabilityCenterOpen ? <CapabilitiesCenter data={capabilities} loading={capabilitiesLoading} tab={capabilityTab} nativePlugins={nativeCapabilityCommands.has("plugins")} nativeMcp={nativeCapabilityCommands.has("mcp-config") || nativeCapabilityCommands.has("mcp")} onTab={setCapabilityTab} onRefresh={refreshCapabilities} onUsePrompt={useCapabilityPrompt} onCopyPath={(path) => void navigator.clipboard.writeText(path)} /> : showOnboarding && auth ? <Onboarding auth={auth} cwd={cwd} onInstall={installCli} onLogin={beginLogin} onOpenUrl={openExternalLink} onChooseWorkspace={chooseWorkspace} onCancel={() => void call("auth.cancel")} onFinish={finishOnboarding} onSkip={finishOnboarding} /> : !auth?.authenticated ? <AuthCard auth={auth} onInstall={installCli} onLogin={beginLogin} onOpenUrl={openExternalLink} onCancel={() => void call("auth.cancel")} /> : !activeThread || !turnViews.length ? <EmptyConversation kind={activeThread?.kind ?? draftChat?.kind ?? (navView === "chats" ? "chat" : "project")} workspace={activeThread?.kind === "project" ? activeThread.cwd : draftChat?.kind === "project" ? draftChat.cwd : cwd} canPrompt={runtimeReady && Boolean(activeThread || draftChat || navView === "chats" || cwd)} onPrompt={useStarterPrompt} onOpenFolder={() => void chooseWorkspace()} /> : null}
          {!bootstrapping && !capabilityCenterOpen && !showOnboarding && <div className="conversation-stage" key={activeThread?.threadId ?? `${draftChat?.kind ?? "empty"}-${navView}`}>{turnViews.map((turn) => <TurnBlock key={turn.record.turnId} turn={turn} onOpenUrl={openExternalLink} onOpenPreview={showPreview} onOpenLocation={openLocation} onRespond={respond} onRevert={revertTurn} onReview={() => { setRailView("git"); void refreshGit(); }} />)}</div>}
        </div>

        {!bootstrapping && !capabilityCenterOpen && !showOnboarding && <form className={`composer ${draftSending ? "sending" : activeThread?.running ? "working" : ""}`} onSubmit={send}>
          {activeThread?.queue.length ? <PromptQueue
            queue={activeThread.queue}
            onClear={() => clearQueuedPrompts(activeThread.threadId)}
            onRemove={(queuedId) => removeQueuedPrompt(activeThread.threadId, queuedId)}
            onUpdate={(queuedId, text) => updateQueuedPrompt(activeThread.threadId, queuedId, text)}
            onSteer={(queuedId) => steerQueuedPrompt(activeThread.threadId, queuedId)}
          /> : null}
          <textarea ref={composerInput} aria-label="Task prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (shouldSubmitPrompt(event, preferences.sendKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={activeThread?.running ? (sendMode === "steer" ? "Steer the active task with a new instruction" : "Queue the next instruction") : activeThread?.kind === "chat" || draftChat?.kind === "chat" ? "Message Kimi" : activeThread || draftChat ? "Ask Kimi to work in this project" : "Start a chat first"} disabled={!auth?.authenticated || (!activeThread && !draftChat) || showOnboarding || draftSending} />
          {diagnostics.length > 0 && <div className="composer-diagnostic" role="status"><WarningCircle /><span>{diagnostics[diagnostics.length - 1]}</span><button type="button" aria-label="Dismiss diagnostic" onClick={() => setDiagnostics([])}><X /></button></div>}
          {commandSuggestions.length > 0 && <div className="mention-menu command-mention-menu" role="listbox" aria-label={promptTrigger?.kind === "skill" ? "Kimi skills" : "Kimi commands"}>
            <small>{promptTrigger?.kind === "skill" ? "Skills from Kimi Code" : "Commands from Kimi Code"}</small>
            {commandSuggestions.map((command) => <button type="button" role="option" aria-selected="false" key={command.name} onClick={() => insertCommand(command)}>{promptTrigger?.kind === "skill" ? <SlidersHorizontal /> : <TerminalWindow />}<span><strong>/{command.name}</strong><small>{command.description}</small></span></button>)}
          </div>}
          {fileSuggestions.length > 0 && <div className="mention-menu" role="listbox" aria-label="Project files">{fileSuggestions.map((file) => <button type="button" role="option" aria-selected="false" key={file} onClick={() => insertMention(file)}><FileText />{file}</button>)}</div>}
          {images.length > 0 && <div className="pending-images">{images.map((image) => <span key={image.name}>{image.name}<button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((item) => item !== image))}><X /></button></span>)}</div>}
          <div className="composer-footer">
            <div ref={composerTools} className="composer-tools">
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(event) => void attachImages(event.target.files)} />
              <button className={`composer-action ${composerMenuOpen ? "active" : ""}`} type="button" title="Add context and Kimi capabilities" aria-label="Add context and Kimi capabilities" aria-haspopup="menu" aria-expanded={composerMenuOpen} disabled={!auth?.authenticated || (!activeThread && !draftChat) || showOnboarding || draftSending} onClick={() => setComposerMenuOpen((current) => !current)}><Plus /></button>
              <button className={`composer-action composer-skill-action ${promptTrigger?.prefix === "/" ? "active" : ""}`} type="button" title="Use a Kimi command (/)" aria-label="Toggle Kimi commands" aria-pressed={promptTrigger?.prefix === "/"} disabled={!auth?.authenticated || (!activeThread && !draftChat) || showOnboarding || draftSending} onClick={toggleComposerCommandPicker}>/</button>
              {composerMenuOpen && <div className="composer-tools-menu" role="menu" onKeyDown={moveMenuFocus}>
                <button type="button" role="menuitem" disabled={!composerProjectCwd} onClick={() => void attachWorkspaceFiles()}><Paperclip /><span><strong>Add files…</strong><small>{composerProjectCwd ? "Attach files from this project" : "Available inside a project"}</small></span></button>
                <button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); fileInput.current?.click(); }}><ImageSquare /><span><strong>Add images…</strong><small>Attach up to five images</small></span></button>
                <span className="composer-menu-separator" role="separator" />
                <button type="button" role="menuitem" onClick={() => startComposerTrigger("/")}><TerminalWindow /><span><strong>Commands</strong><small>Type / to use Kimi commands</small></span><kbd>/</kbd></button>
                <button type="button" role="menuitem" onClick={() => startComposerTrigger("$")}><SlidersHorizontal /><span><strong>Skills</strong><small>Type $ to invoke a Kimi skill</small></span><kbd>$</kbd></button>
                <button type="button" role="menuitem" onClick={() => startComposerCommand("plugins")}><DownloadSimple /><span><strong>Install skills & plugins…</strong><small>Use Kimi's native plugin manager</small></span><kbd>/plugins</kbd></button>
                <button type="button" role="menuitem" disabled={!composerProjectCwd} onClick={() => startComposerTrigger("#")}><FileText /><span><strong>Project files</strong><small>Type # to mention workspace context</small></span><kbd>#</kbd></button>
              </div>}
              <div className="composer-context-wrap">
                <button className="composer-context" type="button" aria-label={context ? `Context: ${formatTokens(context.used)} of ${formatTokens(context.size)} used` : "Context usage unavailable"} aria-describedby="composer-context-details"><Gauge /><span>{contextUsed === undefined ? "n/a" : `${contextUsed}%`}</span></button>
                <div className="composer-context-popover" id="composer-context-details" role="tooltip"><div><span>Context window</span><strong>{contextUsed === undefined ? "n/a" : `${contextUsed}%`}</strong></div>{context ? <><i><b style={{ transform: `scaleX(${contextUsed! / 100})` }} /></i><small><span>{formatTokens(context.used)} used</span><span>{formatTokens(context.size)} limit</span></small></> : <p>Available after the first model update.</p>}</div>
              </div>
            </div>
            <div className="composer-controls">
              {activeThread?.running && <div className="composer-run-mode" role="group" aria-label="Prompt delivery"><button className={sendMode === "queue" ? "active" : ""} type="button" aria-pressed={sendMode === "queue"} title="Run after the current task" onClick={() => setSendMode("queue")}>Queue</button><button className={sendMode === "steer" ? "active" : ""} type="button" aria-pressed={sendMode === "steer"} title="Stop the current turn and continue with this instruction" onClick={() => setSendMode("steer")}>Steer</button></div>}
              {(activeThread || draftChat) && <ComposerConfig options={composerOptions} onChange={changeConfig} />}
              <button className={`icon-button primary composer-submit ${primaryComposerAction === "stop" ? "composer-stop" : ""}`} type={primaryComposerAction === "stop" ? "button" : "submit"} aria-label={composerPrimaryLabel(primaryComposerAction)} title={composerPrimaryLabel(primaryComposerAction)} disabled={!auth?.authenticated || (!activeThread && !draftChat) || showOnboarding || draftSending || (primaryComposerAction !== "stop" && !prompt.trim())} onClick={primaryComposerAction === "stop" && activeThread ? () => stopThread(activeThread.threadId) : undefined}>{primaryComposerAction === "stop" ? <Stop weight="fill" /> : <ArrowUp weight="bold" />}</button>
            </div>
          </div>
        </form>}
      </section>

      {railView && <aside className={`rail ${railView}-rail`}>
        {railResizeHandle}{railTabs}
        <div className={`rail-view rail-view-${railView}`} key={railView}>
          {railView === "git" && <>
            <div className="rail-contextbar"><span><GitBranch /> {gitStatus?.branch ?? "Git changes"}</span><button className="rail-icon" type="button" aria-label="Refresh Git status" disabled={gitBusy} onClick={() => void refreshGit()}><ArrowsClockwise /></button></div>
            {selectedFile && <section className="git-file-preview file-preview"><div><h2>{selectedFile.path}</h2><button type="button" aria-label="Close file preview" onClick={() => setSelectedFile(undefined)}><X /></button></div><pre>{selectedFile.content}</pre></section>}
            {gitStatus ? <>
              <div className="git-summary"><span>{gitStatus.files.length ? `${gitStatus.files.length} changed` : "Working tree clean"}</span>{gitStatus.upstream && <small>{gitStatus.ahead ? `↑${gitStatus.ahead}` : ""}{gitStatus.behind ? ` ↓${gitStatus.behind}` : ""} {gitStatus.upstream}</small>}</div>
              <section className="git-files" aria-label="Changed files">
                {gitStatus.files.map((file) => <div className={`git-file ${gitDiff?.path === file.path ? "active" : ""}`} key={file.path}><button type="button" onClick={() => void openGitDiff(file.path)}><span className="git-file-status">{file.untracked ? "U" : `${file.indexStatus.replace(".", "")}${file.worktreeStatus.replace(".", "")}`}</span><span title={file.path}>{file.path}</span></button><button type="button" disabled={gitBusy} onClick={() => void changeGitStage(file)}>{file.staged ? "Unstage" : "Stage"}</button></div>)}
                {!gitStatus.files.length && <div className="git-empty"><Check /> No local changes</div>}
              </section>
              <section className="git-commit"><label htmlFor="commit-message">Commit message</label><textarea id="commit-message" value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Describe this change" /><button className="primary" type="button" disabled={gitBusy || !commitMessage.trim() || !gitStatus.files.some((file) => file.staged)} onClick={() => void commitGit()}><GitCommit /> Commit staged</button></section>
              {gitDiff && <section className="git-diff"><div><strong>{gitDiff.path}</strong><button type="button" onClick={() => setGitDiff(undefined)} aria-label="Close diff"><X /></button></div><pre>{gitDiff.diff || "No textual diff available."}</pre></section>}
            </> : <div className="git-empty">{gitBusy ? "Reading repository…" : "This workspace is not a Git repository."}</div>}
          </>}

          {railView === "terminal" && <>
            <div className="rail-contextbar"><span title={terminalSession?.cwd ?? workspaceCwd}><TerminalWindow /> {terminalSession?.cwd ?? workspaceCwd ?? "Open a workspace first"}</span><div><button className="rail-icon" type="button" aria-label="Clear terminal" title="Clear terminal" onClick={() => setTerminalEntries([])}><Broom /></button><button className="rail-icon" type="button" aria-label="Restart terminal" title="Restart terminal" onClick={() => void restartTerminal()}><ArrowsClockwise /></button></div></div>
            <div className="terminal-screen" role="log" aria-live="polite" aria-label="Terminal output">
              {!terminalEntries.length && <div className="terminal-empty">{terminalStarting ? "Starting PowerShell…" : "Run a command in this workspace."}</div>}
              {terminalEntries.map((entry) => <pre className={entry.kind} key={entry.id}>{entry.text}</pre>)}
              <div ref={terminalEnd} />
            </div>
            <form className="terminal-input" onSubmit={runTerminalCommand}>
              <span aria-hidden="true">›</span>
              <input value={terminalCommand} onChange={(event) => { setTerminalCommand(event.target.value); setTerminalHistoryIndex(-1); }} onKeyDown={(event) => {
                if (event.key === "ArrowUp" && terminalHistory.length) {
                  event.preventDefault();
                  const next = Math.min(terminalHistory.length - 1, terminalHistoryIndex + 1);
                  setTerminalHistoryIndex(next);
                  setTerminalCommand(terminalHistory[terminalHistory.length - 1 - next] ?? "");
                } else if (event.key === "ArrowDown" && terminalHistoryIndex >= 0) {
                  event.preventDefault();
                  const next = terminalHistoryIndex - 1;
                  setTerminalHistoryIndex(next);
                  setTerminalCommand(next < 0 ? "" : terminalHistory[terminalHistory.length - 1 - next] ?? "");
                }
              }} aria-label="Terminal command" autoComplete="off" spellCheck={false} placeholder={terminalSession ? "Type a command" : "Terminal is starting…"} disabled={!terminalSession} />
              <button type="submit" aria-label="Run command" disabled={!terminalSession || !terminalCommand.trim()}><PaperPlaneRight weight="fill" /></button>
            </form>
          </>}

          {railView === "preview" && <>
            <form className="preview-address" onSubmit={(event) => { event.preventDefault(); showPreview(); }}>
              <label><Browser /><input value={previewDraft} onChange={(event) => setPreviewDraft(event.target.value)} aria-label="Local preview URL" spellCheck={false} /></label>
              <button className="preview-open" type="submit">Open</button>
              <div className="preview-actions"><button className="rail-icon" type="button" aria-label="Reload preview" title="Reload preview" onClick={() => setPreviewRevision((value) => value + 1)}><ArrowsClockwise /></button><button className="rail-icon" type="button" aria-label="Open preview in default browser" title="Open in browser" disabled={!previewUrl} onClick={() => { if (previewUrl) void openExternalLink(previewUrl); }}><ArrowSquareOut /></button><button className="preview-size" type="button" aria-label={`Cycle preview width; current ${previewPanelMode.toLowerCase()}`} title="Cycle preview width" onClick={() => setPreferences((current) => ({ ...current, railWidth: current.railWidth >= 1_080 ? 420 : current.railWidth >= 760 ? 1_200 : 960 }))}>{previewPanelMode === "Wide" ? <CornersIn /> : <CornersOut />}<span>{previewPanelMode}</span></button></div>
            </form>
            <div className="preview-frame">
              {previewUrl ? <iframe key={`${previewUrl}-${previewRevision}`} src={previewUrl} title={`Preview of ${previewUrl}`} sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" referrerPolicy="no-referrer" /> : <div className="preview-empty"><Browser /><strong>No local app open</strong><span>Enter a localhost URL above.</span></div>}
            </div>
          </>}

          {railView === "agents" && <SubagentsRail runs={agentRuns} onUseAgent={(agent) => useCapabilityPrompt(`Use the ${agent} subagent for this task: `)} onOpenCenter={() => { setCapabilityTab("agents"); setCapabilityCenterOpen(true); setRailView(undefined); }} />}
        </div>
      </aside>}

      {searchOpen && <div className="command-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) { setSearchOpen(false); setThreadFilter(""); } }}>
        <section className="command-palette" role="dialog" aria-modal="true" aria-label="Search projects and chats" onKeyDown={trapDialogFocus}>
          <label className="command-input"><MagnifyingGlass /><input autoFocus value={threadFilter} onChange={(event) => setThreadFilter(event.target.value)} placeholder="Search projects and chats…" /><kbd>Esc</kbd></label>
          <div className="command-results">
            {visibleProjects.length > 0 && <section><h2>Projects</h2>{visibleProjects.slice(0, 6).map((project) => <button type="button" key={project.cwd} onClick={() => { setCapabilityCenterOpen(false); setCwd(project.cwd); rememberWorkspace(project.cwd); setNavView("projects"); setDraftChat(undefined); const first = project.threads[0]; if (first) selectThread(first); else setActiveThreadId(undefined); setSearchOpen(false); setThreadFilter(""); }}><FolderSimple /><span><strong>{project.name}</strong><small>{project.cwd}</small></span></button>)}</section>}
            {(visibleThreads.length > 0 || visibleRuntimeSessions.length > 0) && <section><h2>Chats</h2>{visibleThreads.slice(0, 8).map((thread) => <button type="button" key={thread.threadId} onClick={() => { selectThread(thread); setSearchOpen(false); setThreadFilter(""); }}><ChatCircleDots /><span><strong>{thread.title}</strong><small>Personal chat</small></span></button>)}{visibleRuntimeSessions.slice(0, Math.max(0, 8 - visibleThreads.length)).map((session) => <button type="button" key={session.sessionId} onClick={() => { setSearchOpen(false); setThreadFilter(""); void resumeSession(session); }}><ChatCircleDots /><span><strong>{session.title ?? "Kimi chat"}</strong><small>Personal chat</small></span></button>)}</section>}
            {!visibleProjects.length && !visibleThreads.length && !visibleRuntimeSessions.length && <div className="command-empty"><MagnifyingGlass /><strong>No matches</strong><span>Try a project, folder, or chat title.</span></div>}
          </div>
          <footer><span>Search all local projects and chats</span><span><kbd>Ctrl K</kbd></span></footer>
        </section>
      </div>}

      {settingsOpen && <SettingsDialog
        category={settingsCategory}
        query={settingsQuery}
        preferences={preferences}
        auth={auth}
        cwd={cwd}
        quota={quota}
        quotaError={quotaError}
        quotaLoading={quotaLoading}
        updateStatus={updateStatus}
        turnRunning={workBlocksUpdate}
        onCategory={setSettingsCategory}
        onQuery={setSettingsQuery}
        onPreferences={(patch) => setPreferences((current) => ({ ...current, ...patch }))}
        onClose={() => { setSettingsOpen(false); setSettingsQuery(""); }}
        onChooseWorkspace={chooseWorkspace}
        onInstallCli={installCli}
        onLogin={beginLogin}
        onLogout={logout}
        onRefreshQuota={refreshQuota}
        onCheckUpdates={checkForUpdates}
        onInstallUpdate={installUpdate}
        onShowOnboarding={() => { setShowOnboarding(true); setSettingsOpen(false); setSettingsQuery(""); }}
      />}
      {manageDialog && <ManageItemDialog dialog={manageDialog} onCancel={() => setManageDialog(undefined)} onConfirm={confirmManageAction} />}
      {yoloConfirm && <YoloConfirmDialog onCancel={() => setYoloConfirm(undefined)} onConfirm={() => {
        const pending = yoloConfirm;
        setYoloConfirm(undefined);
        setPreferences((current) => ({ ...current, yoloAcknowledged: true }));
        setConfig(pending.configId, pending.value);
      }} />}
    </main>
  );
}

function PromptQueue({ queue, onClear, onRemove, onUpdate, onSteer }: {
  queue: QueuedPrompt[];
  onClear: () => void;
  onRemove: (queuedId: string) => void;
  onUpdate: (queuedId: string, text: string) => void;
  onSteer: (queuedId: string) => void;
}) {
  const [editing, setEditing] = useState<{ queuedId: string; text: string }>();
  useEffect(() => {
    if (editing && !queue.some((queued) => queued.queuedId === editing.queuedId)) setEditing(undefined);
  }, [editing, queue]);

  const save = () => {
    const text = editing?.text.trim();
    if (!editing || !text) return;
    onUpdate(editing.queuedId, text);
    setEditing(undefined);
  };

  return <section className="prompt-queue" aria-label={`${queue.length} queued prompts`}>
    <header><strong>{queue.length} queued</strong><span>Runs in order</span><button type="button" onClick={onClear}>Clear</button></header>
    <div className="prompt-queue-list">
      {queue.map((queued, index) => editing?.queuedId === queued.queuedId ? <div className="queued-prompt editing" key={queued.queuedId}>
        <input autoFocus aria-label="Edit queued prompt" value={editing.text} onChange={(event) => setEditing({ queuedId: queued.queuedId, text: event.target.value })} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); save(); }
          if (event.key === "Escape") { event.preventDefault(); setEditing(undefined); }
        }} />
        <div className="queued-prompt-actions"><button type="button" disabled={!editing.text.trim()} onClick={save}>Save</button><button type="button" onClick={() => setEditing(undefined)}>Cancel</button></div>
      </div> : <div className="queued-prompt" key={queued.queuedId}>
        <span><b>{queued.mode === "steer" ? "Steer" : `Next ${index + 1}`}</b><span title={queued.text}>{queued.text}</span></span>
        <div className="queued-prompt-actions">
          <button type="button" onClick={() => setEditing({ queuedId: queued.queuedId, text: queued.text })}><PencilSimple /> Edit</button>
          <button type="button" onClick={() => onSteer(queued.queuedId)}>Steer</button>
          <button className="queued-remove" type="button" aria-label={`Remove queued prompt: ${queued.text}`} onClick={() => onRemove(queued.queuedId)}><X /></button>
        </div>
      </div>)}
    </div>
  </section>;
}

function EmptyConversation({ kind, workspace, canPrompt, onPrompt, onOpenFolder }: { kind: "project" | "chat"; workspace: string | undefined; canPrompt: boolean; onPrompt: (text: string) => void; onOpenFolder: () => void }) {
  const projectName = workspace ? workspaceName(workspace) : undefined;
  const starters = kind === "chat" ? [
    { icon: <ChatCircleDots />, label: "Explain a difficult topic", prompt: "Explain a difficult topic in simple terms" },
    { icon: <Plus />, label: "Help me plan something", prompt: "Help me turn an idea into a clear, practical plan" },
    { icon: <FileText />, label: "Improve some writing", prompt: "Review and improve this writing while keeping my voice: " },
    { icon: <MagnifyingGlass />, label: "Research a question", prompt: "Research this question and give me a concise, well-sourced answer: " },
  ] : [
    { icon: <MagnifyingGlass />, label: "Explore and understand the code", prompt: "Explore this project and explain how it works" },
    { icon: <Hammer />, label: "Build a new feature", prompt: "Build a new feature in this project: " },
    { icon: <GitBranch />, label: "Review code and suggest changes", prompt: "Review this project and suggest the highest-impact code improvements" },
    { icon: <Bug />, label: "Find and fix an issue", prompt: "Find and fix an issue in this project: " },
  ];
  return <div className="empty empty-conversation">
    <div className="empty-mark"><img src="/kimi-logo.png" alt="" aria-hidden="true" /></div>
    <h1>{kind === "chat" ? "What would you like to ask Kimi?" : projectName ? <>What should we work on in <span>{projectName}</span>?</> : "Open a folder to start building"}</h1>
    <p>{kind === "chat" ? "This is a standalone chat, separate from your project workspaces." : projectName ? "Pick a starting point or describe exactly what you want to change." : "Choose any folder on this PC. Kimi opens it here without restarting the app."}</p>
    {kind === "project" && !projectName ? <button className="secondary empty-open-folder" type="button" onClick={onOpenFolder}><FolderOpen /> Open folder</button> : <div className="empty-prompts" aria-label="Suggested prompts">
      {starters.map((starter) => <button type="button" key={starter.label} disabled={!canPrompt} onClick={() => onPrompt(starter.prompt)}><span>{starter.icon}</span><strong>{starter.label}</strong></button>)}
    </div>}
  </div>;
}

function ItemActions({ open, label, items, onToggle }: { open: boolean; label: string; items: Array<{ label: string; icon: React.ReactNode; danger?: boolean; onSelect: () => void }>; onToggle: () => void }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current || !menu.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      setPosition(floatingMenuPosition(
        { top: anchor.top, right: anchor.right, bottom: anchor.bottom },
        { width: menu.current.offsetWidth, height: menu.current.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    place();
    const focusFrame = window.requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus());
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      if (menu.current?.contains(document.activeElement)) trigger.current?.focus();
    };
  }, [open]);

  return <span className="item-menu-wrap">
    <button ref={trigger} className="item-menu-trigger" type="button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onToggle(); }} onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); onToggle(); } }}><DotsThree weight="bold" /></button>
    {open && createPortal(<div ref={menu} className="item-menu item-menu-portal" role="menu" onKeyDown={moveMenuFocus} style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? "visible" : "hidden" }}>{items.map((item) => <button className={item.danger ? "danger" : ""} type="button" role="menuitem" key={item.label} onClick={(event) => { event.preventDefault(); event.stopPropagation(); item.onSelect(); onToggle(); }}>{item.icon}<span>{item.label}</span></button>)}</div>, document.body)}
  </span>;
}

function ThreadNavItem({ thread, active, chat = false, menuOpen, onSelect, onMenu, onStop, onRename, onDelete }: { thread: Thread; active: boolean; chat?: boolean; menuOpen: boolean; onSelect: () => void; onMenu: (forceOpen?: boolean) => void; onStop: () => void; onRename: () => void; onDelete: () => void }) {
  const items = [
    ...(thread.running ? [{ label: "Stop task", icon: <Stop weight="fill" />, onSelect: onStop }] : []),
    { label: "Rename chat", icon: <PencilSimple />, onSelect: onRename },
    { label: "Delete chat", icon: <Trash />, danger: true, onSelect: onDelete },
  ];
  return <div className={`thread-row-wrap ${active ? "active" : ""}`} onContextMenu={(event) => { event.preventDefault(); onMenu(true); }}>
    <button className={`thread ${chat ? "chat-thread" : ""} ${active ? "active" : ""}`} type="button" aria-current={active ? "page" : undefined} onClick={onSelect}>
      {chat ? <span className="thread-copy"><strong>{thread.title}</strong></span> : <span>{thread.title}</span>}
    </button>
    <span className="thread-row-actions">{thread.running && <i className="thread-running" role="status" aria-label="Task running" />}<ItemActions open={menuOpen} label={`Manage ${thread.title}`} items={items} onToggle={onMenu} /></span>
  </div>;
}

function RuntimeSessionNavItem({ session, chat = false, menuOpen, onSelect, onMenu, onRename, onRemove }: { session: RuntimeSession; chat?: boolean; menuOpen: boolean; onSelect: () => void; onMenu: (forceOpen?: boolean) => void; onRename: () => void; onRemove: () => void }) {
  const title = session.title ?? (chat ? "Kimi chat" : "Kimi session");
  const items = [
    { label: "Open chat", icon: <ChatCircleDots />, onSelect },
    { label: "Rename chat", icon: <PencilSimple />, onSelect: onRename },
    { label: "Remove from sidebar", icon: <X />, onSelect: onRemove },
  ];
  return <div className="thread-row-wrap" onContextMenu={(event) => { event.preventDefault(); onMenu(true); }}>
    <button className={`thread resumable ${chat ? "chat-thread" : ""}`} type="button" onClick={onSelect}>
      {chat ? <span className="thread-copy"><strong>{title}</strong></span> : <span>{title}</span>}
    </button>
    <span className="thread-row-actions"><ItemActions open={menuOpen} label={`Manage ${title}`} items={items} onToggle={onMenu} /></span>
  </div>;
}

function ManageItemDialog({ dialog, onCancel, onConfirm }: { dialog: ManageDialog; onCancel: () => void; onConfirm: (value?: string) => void | Promise<void> }) {
  const renaming = dialog.kind === "rename-project" || dialog.kind === "rename-thread";
  const [value, setValue] = useState(dialog.name);
  const [busy, setBusy] = useState(false);
  const copy = dialog.kind === "rename-project"
    ? { title: "Rename project", description: "This changes only the display name in Kimi Code Desktop.", action: "Rename" }
    : dialog.kind === "rename-thread"
      ? { title: "Rename chat", description: "Give this chat a clear name. Its history stays intact.", action: "Rename" }
      : dialog.kind === "remove-project"
        ? { title: "Remove project?", description: "The folder and its files stay on your computer. You can open it again anytime.", action: "Remove" }
        : dialog.kind === "remove-runtime-session"
          ? { title: `Remove “${dialog.name}”?`, description: "This hides the resumable session in Kimi Code Desktop. Its official Kimi history stays untouched.", action: "Remove" }
        : dialog.kind === "delete-project-chats"
          ? { title: `Delete chats in ${dialog.name}?`, description: `This removes ${dialog.threadIds.length} local chat${dialog.threadIds.length === 1 ? "" : "s"}. Project files are never deleted.`, action: "Delete chats" }
          : { title: `Delete “${dialog.name}”?`, description: "This removes the local chat history from the desktop harness. Project files stay untouched.", action: "Delete chat" };
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [busy, onCancel]);
  return <div className="manage-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <form className="manage-dialog" role="dialog" aria-modal="true" aria-labelledby="manage-title" onKeyDown={trapDialogFocus} onSubmit={(event) => { event.preventDefault(); setBusy(true); void Promise.resolve(onConfirm(renaming ? value : undefined)).finally(() => setBusy(false)); }}>
      <header><span><strong id="manage-title">{copy.title}</strong><small>{copy.description}</small></span><button type="button" aria-label="Close" disabled={busy} onClick={onCancel}><X /></button></header>
      {renaming && <label><span>Name</span><input autoFocus value={value} maxLength={120} onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.currentTarget.select()} /></label>}
      <footer><button className="secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className={renaming || dialog.kind === "remove-project" || dialog.kind === "remove-runtime-session" ? "primary" : "danger"} type="submit" disabled={busy || (renaming && !value.trim())}>{busy ? "Working…" : copy.action}</button></footer>
    </form>
  </div>;
}

type ComposerControl = {
  id: string;
  label: string;
  tooltip: string;
  icon: React.ReactNode;
  current: string;
  value: string;
  note?: string;
  disabled?: boolean;
  choices: Array<{ value: string; name: string; description?: string; danger?: boolean }>;
};

export function ComposerConfig({ options, onChange }: { options: ConfigOption[]; onChange: (configId: string, value: string) => void }) {
  const [openId, setOpenId] = useState<string>();
  const model = options.find(isModelOption);
  const thinking = options.find(isThinkingOption);
  const mode = options.find(isModeOption);
  const controls: ComposerControl[] = [];
  if (model) {
    const choices = flattenOptions(model);
    controls.push({
      id: model.id, label: "Model", icon: <Cpu />, tooltip: "Model Kimi uses for this chat",
      current: currentChoiceName(model), value: String(model.currentValue), disabled: choices.length < 2,
      choices: choices.map((choice) => ({ value: choice.value, name: choice.name, description: modelDescription(choice.name) })),
    });
  }
  if (thinking) {
    const choices = flattenOptions(thinking);
    const offersExplicitEfforts = choices.some((choice) => !/^(?:on|off|enabled|disabled|true|false|1|0)$/i.test(choice.value)
      && !/^(?:thinking[ -]?)?(?:on|off|enabled|disabled)$/i.test(choice.name));
    controls.push({
      id: thinking.id, label: "Reasoning", icon: <Brain />, tooltip: "Thinking effort Kimi applies for the selected model",
      current: thinkingEffortLabel(model, thinking), value: String(thinking.currentValue), disabled: choices.length < 2,
      ...(offersExplicitEfforts ? {} : { note: "Kimi Code CLI maps thinking to this model's supported effort. Other levels are not offered and are never simulated." }),
      choices: choices.map((choice) => {
        const label = thinkingEffortLabel(model, { ...thinking, currentValue: choice.value });
        return { value: choice.value, name: label, ...(choice.name.toLowerCase() === label.toLowerCase() ? {} : { description: `Runtime option: ${choice.name}` }) };
      }),
    });
  }
  if (mode) {
    const choices = flattenOptions(mode);
    controls.push({
      id: mode.id, label: "Permissions", icon: <ShieldCheck />, tooltip: "Permission mode. YOLO runs every tool without asking first.",
      current: currentChoiceName(mode), value: String(mode.currentValue), disabled: choices.length < 2,
      choices: choices.map((choice) => ({ value: choice.value, name: choice.name, description: modeDescription(choice.value, choice.name), danger: isYoloChoice(mode, choice.value) })),
    });
  }
  for (const option of options) {
    if (option === model || option === thinking || option === mode) continue;
    const choices = flattenOptions(option);
    if (choices.length < 2) continue;
    controls.push({
      id: option.id, label: option.name, icon: <SlidersHorizontal />, tooltip: `${option.name}: runtime configuration`,
      current: currentChoiceName(option), value: String(option.currentValue),
      choices: choices.map((choice) => ({ value: choice.value, name: choice.name })),
    });
  }
  if (!controls.length) return null;
  return <div className="composer-configs">
    {controls.map((control) => <ConfigControl control={control} key={control.id} open={openId === control.id} onToggle={() => setOpenId((current) => current === control.id ? undefined : control.id)} onClose={() => setOpenId(undefined)} onPick={(value) => { onChange(control.id, value); setOpenId(undefined); }} />)}
  </div>;
}

function ConfigControl({ control, open, onToggle, onClose, onPick }: { control: ComposerControl; open: boolean; onToggle: () => void; onClose: () => void; onPick: (value: string) => void }) {
  const trigger = useRef<HTMLButtonElement | null>(null);
  const popover = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = trigger.current?.getBoundingClientRect();
    const menu = popover.current?.getBoundingClientRect();
    if (!anchor || !menu) return;
    setPosition(floatingMenuPosition(anchor, { width: menu.width, height: menu.height }, { width: window.innerWidth, height: window.innerHeight }));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (trigger.current?.contains(event.target as Node) || popover.current?.contains(event.target as Node)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        trigger.current?.focus();
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape, true);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    (popover.current?.querySelector<HTMLButtonElement>(".config-options button.active") ?? popover.current?.querySelector<HTMLButtonElement>(".config-options button"))?.focus();
  }, [open]);

  function moveFocus(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const items = [...(popover.current?.querySelectorAll<HTMLButtonElement>(".config-options > button") ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  return <>
    <button ref={trigger} className={`config-trigger ${open ? "open" : ""}`} type="button" title={control.tooltip} aria-label={`${control.label}: ${control.current}`} aria-haspopup="menu" aria-expanded={open} disabled={control.disabled} onClick={onToggle} onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); onToggle(); } }}>
      {control.icon}<span>{control.current}</span><CaretDown />
    </button>
    {open && createPortal(
      <div ref={popover} className="config-popover config-popover-portal" role="menu" aria-label={control.label} style={position ?? { visibility: "hidden", top: 0, left: 0 }} onKeyDown={moveFocus}>
        <header><strong>{control.label}</strong><small>{control.tooltip}</small></header>
        <div className="config-options">
          {control.choices.map((choice) => {
            const active = choice.value === control.value;
            return <button className={active ? "active" : ""} type="button" role="menuitemradio" aria-checked={active} key={choice.value} onClick={() => onPick(choice.value)}>
              <span><strong>{choice.name}</strong>{choice.description && <small>{choice.description}</small>}</span>
              {choice.danger && <WarningCircle className="config-danger" />}
              {active && <Check weight="bold" />}
            </button>;
          })}
        </div>
        {control.note && <footer className="config-note">{control.note}</footer>}
      </div>, document.body)}
  </>;
}

function YoloConfirmDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);
  return <div className="manage-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="manage-dialog" role="alertdialog" aria-modal="true" aria-labelledby="yolo-title" aria-describedby="yolo-description" onKeyDown={trapDialogFocus}>
      <header><span><strong id="yolo-title">Enable YOLO mode?</strong><small id="yolo-description">Kimi will run every tool and command without asking first. Enable this only for workspaces you fully trust. You will not be asked again.</small></span><button type="button" aria-label="Close" onClick={onCancel}><X /></button></header>
      <footer><button className="secondary" type="button" onClick={onCancel}>Cancel</button><button className="danger" type="button" autoFocus onClick={onConfirm}>Enable YOLO</button></footer>
    </div>
  </div>;
}

export function thinkingEffortLabel(model?: ConfigOption, thinking?: ConfigOption): string {
  const modelName = model ? currentChoiceName(model) : "";
  const current = thinking ? currentChoiceName(thinking) : "";
  if (current && !/^(?:thinking[ -]?)?(?:on|off|enabled|disabled|true|false|1|0)$/i.test(current)) return current;
  if (/\bk3\b/i.test(modelName) && /^(true|on|enabled|1)$/i.test(String(thinking?.currentValue ?? "on"))) return "Max";
  return /^(false|off|disabled|0)$/i.test(String(thinking?.currentValue ?? "")) ? "Off" : "Default";
}

function currentChoiceName(option: ConfigOption): string {
  return flattenOptions(option).find((choice) => choice.value === String(option.currentValue))?.name ?? String(option.currentValue);
}

function modelDescription(name: string): string {
  if (/swarm/i.test(name)) return "Parallel agent orchestration";
  if (/k3/i.test(name)) return "Flagship coding and agent model";
  if (/k2/i.test(name)) return "Fast, efficient coding model";
  return "Available in your Kimi plan";
}

function isModelOption(option: ConfigOption): boolean {
  return option.id.toLowerCase() === "model" || option.category?.toLowerCase() === "model";
}

function isThinkingOption(option: ConfigOption): boolean {
  return /thinking|effort/i.test(`${option.id} ${option.name} ${option.category ?? ""}`);
}

export function isModeOption(option: ConfigOption): boolean {
  return option.id.toLowerCase() === "mode" || option.category?.toLowerCase() === "mode";
}

export function isYoloChoice(option: ConfigOption | undefined, value: string): boolean {
  if (!option || !isModeOption(option)) return false;
  const choice = flattenOptions(option).find((candidate) => candidate.value === value);
  return /yolo|full[ -]?access|bypass/i.test(`${value} ${choice?.name ?? ""}`);
}

export function modeDescription(value: string, name: string): string {
  const key = `${value} ${name}`.toLowerCase();
  if (/yolo|full[ -]?access|bypass/.test(key)) return "Full access: runs everything without asking";
  if (/plan/.test(key)) return "Kimi plans first and asks before acting";
  if (/auto|accept|agent/.test(key)) return "Runs actions without asking each time";
  if (/default|ask/.test(key)) return "Asks before sensitive actions";
  return "Runtime permission mode";
}

/**
 * Draft-time selection for a chat that has no ACP session yet. Only values the
 * user deliberately chose are kept; anything the runtime no longer offers falls
 * back to the runtime's own current value instead of forcing a stale choice.
 */
export function draftConfigOverrides(defaults: ConfigOption[], persisted: Record<string, string>): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (const option of defaults) {
    const wanted = persisted[option.id];
    if (wanted === undefined) continue;
    if (!flattenOptions(option).some((choice) => choice.value === wanted)) continue;
    if (String(option.currentValue) !== wanted) overrides[option.id] = wanted;
  }
  return overrides;
}

export function applyDraftConfig(defaults: ConfigOption[], draft: Record<string, string>): ConfigOption[] {
  return defaults.map((option) => draft[option.id] !== undefined ? { ...option, currentValue: draft[option.id]! } : option);
}

function SettingsDialog({ category, query, preferences, auth, cwd, quota, quotaError, quotaLoading, updateStatus, turnRunning, onCategory, onQuery, onPreferences, onClose, onChooseWorkspace, onInstallCli, onLogin, onLogout, onRefreshQuota, onCheckUpdates, onInstallUpdate, onShowOnboarding }: {
  category: SettingsCategory;
  query: string;
  preferences: Preferences;
  auth: AuthState | undefined;
  cwd: string;
  quota: KimiQuota | undefined;
  quotaError: string | undefined;
  quotaLoading: boolean;
  updateStatus: UpdateStatus;
  turnRunning: boolean;
  onCategory: (category: SettingsCategory) => void;
  onQuery: (query: string) => void;
  onPreferences: (patch: Partial<Preferences>) => void;
  onClose: () => void;
  onChooseWorkspace: () => Promise<void>;
  onInstallCli: () => Promise<void>;
  onLogin: () => Promise<void>;
  onLogout: () => Promise<void>;
  onRefreshQuota: () => Promise<void>;
  onCheckUpdates: (manual?: boolean) => Promise<void>;
  onInstallUpdate: () => Promise<void>;
  onShowOnboarding: () => void;
}) {
  const categories: Array<{ id: SettingsCategory; label: string; keywords: string; icon: React.ReactNode }> = [
    { id: "general", label: "General", keywords: "workspace folder startup onboarding density send enter shift keyboard", icon: <SlidersHorizontal /> },
    { id: "appearance", label: "Appearance", keywords: "theme light dark colors accent font text zoom", icon: <Palette /> },
    { id: "layout", label: "Layout", keywords: "sidebar side panel rail resize left right", icon: <SidebarSimple /> },
    { id: "account", label: "Account", keywords: "profile login logout kimi plan cli", icon: <UserCircle /> },
    { id: "usage", label: "Usage & limits", keywords: "quota subscription plan limits", icon: <Gauge /> },
    { id: "updates", label: "Updates", keywords: "version install restart release", icon: <DownloadSimple /> },
    { id: "about", label: "About", keywords: "open source github license desktop", icon: <Info /> },
  ];
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCategories = categories.filter((item) => !normalizedQuery || `${item.label} ${item.keywords}`.toLowerCase().includes(normalizedQuery));
  const current = categories.find((item) => item.id === category) ?? categories[0]!;
  const updateTitle = updateStatus.phase === "available" ? `Version ${updateStatus.version} is available` : updateStatus.phase === "downloading" ? `Downloading ${updateStatus.version}` : updateStatus.phase === "installing" ? `Installing ${updateStatus.version}` : updateStatus.phase === "checking" ? "Checking for updates" : updateStatus.phase === "current" ? "Kimi Code Desktop is up to date" : updateStatus.phase === "error" ? "Update check failed" : "Automatic updates";
  const updateMessage = updateStatus.phase === "downloading" ? `${updateStatus.percent ?? 0}% complete` : updateStatus.phase === "installing" ? "The app will restart when installation finishes." : updateStatus.phase === "error" ? updateStatus.message : updateStatus.currentVersion ? `Installed version ${updateStatus.currentVersion}` : updateStatus.version ? `Installed version ${updateStatus.version}` : "Updates are checked automatically when the app starts.";

  return <div className="settings-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={trapDialogFocus}>
      <header className="settings-titlebar"><div><GearSix /><span><strong id="settings-title">Settings</strong><small>Customize Kimi Code Desktop</small></span></div><button className="rail-icon" type="button" aria-label="Close settings" onClick={onClose}><X /></button></header>
      <div className="settings-shell">
        <aside className="settings-nav">
          <label className="settings-search"><MagnifyingGlass /><input autoFocus value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search settings…" aria-label="Search settings" />{query && <button type="button" aria-label="Clear settings search" onClick={() => onQuery("")}><X /></button>}</label>
          <nav aria-label="Settings categories">
            {visibleCategories.map((item) => <button className={category === item.id ? "active" : ""} type="button" key={item.id} onClick={() => onCategory(item.id)}>{item.icon}<span>{item.label}</span></button>)}
            {!visibleCategories.length && <p>No matching settings</p>}
          </nav>
        </aside>
        <main className="settings-main">
          <header className="settings-page-header"><span>{current.icon}</span><div><h1>{current.label}</h1><p>{settingsDescription(category)}</p></div></header>
          <div className="settings-page">
            {category === "general" && <>
              <section className="settings-group"><h2>Workspace</h2><SettingsRow title="Current project" description={cwd || "No project folder selected."}><button className="secondary" type="button" onClick={() => void onChooseWorkspace()}><FolderOpen /> Open folder</button></SettingsRow></section>
              <section className="settings-group"><h2>Behavior</h2><SettingsRow title="Interface density" description="Choose how much information fits on screen."><ChoiceButtons value={preferences.density} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} onChange={(density) => onPreferences({ density: density as Preferences["density"] })} /></SettingsRow><SettingsRow title="Send message" description="Shift+Enter always inserts a new line."><ChoiceButtons value={preferences.sendKey} options={[{ value: "enter", label: "Enter" }, { value: "ctrl-enter", label: "Ctrl+Enter" }]} onChange={(sendKey) => onPreferences({ sendKey: sendKey as Preferences["sendKey"] })} /></SettingsRow><SettingsRow title="Getting started" description="Run the optional setup flow again without changing projects or sessions."><button className="secondary" type="button" onClick={onShowOnboarding}><ArrowsClockwise /> Show onboarding</button></SettingsRow></section>
            </>}

            {category === "appearance" && <>
              <section className="settings-group"><h2>Theme</h2><SettingsRow title="Color mode" description="Follow Windows or keep a fixed light or dark appearance."><ChoiceButtons value={preferences.theme} options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} onChange={(theme) => onPreferences({ theme: theme as Preferences["theme"] })} /></SettingsRow><SettingsRow title="Accent color" description="Used for focus, progress, and selected controls."><div className="accent-choices" role="radiogroup" aria-label="Accent color">{(["neutral", "blue", "violet", "teal"] as const).map((accent) => <button className={`${accent} ${preferences.accent === accent ? "active" : ""}`} type="button" role="radio" aria-checked={preferences.accent === accent} aria-label={accent === "neutral" ? "Graphite" : accent} key={accent} onClick={() => onPreferences({ accent })}><span />{accent === "neutral" ? "Graphite" : accent}</button>)}</div></SettingsRow></section>
              <section className="settings-group"><h2>Typography</h2><SettingsRow title="Interface font" description="System is recommended; mono is useful for a technical workspace."><select className="settings-select" value={preferences.font} onChange={(event) => onPreferences({ font: event.target.value as Preferences["font"] })}><option value="system">System</option><option value="humanist">Humanist</option><option value="mono">Monospace</option></select></SettingsRow><SettingsRow title="Base font size" description="Scales navigation, chat, and controls together."><label className="settings-range"><input type="range" min="13" max="18" step="1" value={preferences.fontSize} onChange={(event) => onPreferences({ fontSize: Number(event.target.value) })} /><output>{preferences.fontSize}px</output></label></SettingsRow><SettingsRow title="Interface scale" description="Zoom every part of the desktop app."><div className="settings-zoom"><div><button type="button" aria-label="Zoom out" onClick={() => onPreferences({ zoom: clampZoom(preferences.zoom - .1) })}>−</button><strong>{Math.round(preferences.zoom * 100)}%</strong><button type="button" aria-label="Zoom in" onClick={() => onPreferences({ zoom: clampZoom(preferences.zoom + .1) })}>+</button></div></div></SettingsRow></section>
            </>}

            {category === "layout" && <>
              <section className="settings-group"><h2>Panel placement</h2><SettingsRow title="Project sidebar" description="Place projects and chats on either edge."><ChoiceButtons value={preferences.sidebarSide} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} onChange={(sidebarSide) => onPreferences({ sidebarSide: sidebarSide as Preferences["sidebarSide"] })} /></SettingsRow><SettingsRow title="Work panel" description="Choose where Changes, Terminal, and Preview open."><ChoiceButtons value={preferences.railSide} options={[{ value: "left", label: "Left" }, { value: "right", label: "Right" }]} onChange={(railSide) => onPreferences({ railSide: railSide as Preferences["railSide"] })} /></SettingsRow></section>
              <section className="settings-group"><h2>Sizing</h2><SettingsRow title="Sidebar width" description="Drag the divider in the workspace or adjust it here."><label className="settings-range"><input type="range" min="84" max="420" step="4" value={preferences.sidebarWidth} onChange={(event) => onPreferences({ sidebarCollapsed: false, sidebarWidth: clampPanelWidth("sidebar", Number(event.target.value)) })} /><output>{preferences.sidebarWidth}px</output></label></SettingsRow><SettingsRow title="Work panel width" description="Applies to every work-panel tab, including desktop preview."><label className="settings-range"><input type="range" min="260" max="1200" step="4" value={preferences.railWidth} onChange={(event) => onPreferences({ railWidth: clampPanelWidth("rail", Number(event.target.value)) })} /><output>{preferences.railWidth}px</output></label></SettingsRow><SettingsRow title="Restore layout" description="Return panels to their balanced default positions and sizes."><button className="secondary" type="button" onClick={() => onPreferences({ sidebarCollapsed: false, sidebarSide: "left", railSide: "right", sidebarWidth: defaultPreferences.sidebarWidth, railWidth: defaultPreferences.railWidth })}><ArrowsClockwise /> Reset panels</button></SettingsRow></section>
            </>}

            {category === "account" && <section className="settings-group"><h2>Kimi account</h2><div className="account-card"><UserCircle /><div><strong>{auth?.authenticated ? "Kimi account connected" : "Not signed in"}</strong><small>{auth?.installed ? "Official Kimi Code CLI detected" : "Kimi Code CLI is not installed"}</small></div></div><code className="account-home">{auth?.home ?? "Loading local Kimi home…"}</code><p className="settings-note">The app uses each person's own local Kimi login and subscription. Credentials never enter this repository.</p>{auth?.authenticated ? <button className="secondary danger-text" type="button" disabled={auth.loginRunning || auth.installRunning} onClick={() => void onLogout()}><SignOut /> Log out</button> : auth?.installed ? <button className="primary" type="button" disabled={auth.loginRunning} onClick={() => void onLogin()}><SignIn /> Sign in</button> : <button className="primary" type="button" disabled={auth?.installRunning} onClick={() => void onInstallCli()}><DownloadSimple /> Install Kimi CLI</button>}</section>}

            {category === "usage" && <div className="settings-usage"><UsagePanel quota={quota} error={quotaError} loading={quotaLoading} onRefresh={onRefreshQuota} /><p className="settings-note">Subscription limits come from the official local Kimi CLI <code>/usage</code> panel and refresh on focus and every minute. New official limit windows appear automatically.</p></div>}

            {category === "updates" && <section className="settings-group update-settings"><h2>App updates</h2><div className={`update-card ${updateStatus.phase}`}><span className="update-state-icon">{updateStatus.phase === "current" ? <Check /> : updateStatus.phase === "error" ? <WarningCircle /> : updateStatus.phase === "available" ? <DownloadSimple /> : <ArrowsClockwise />}</span><div><strong>{updateTitle}</strong><small>{updateMessage}</small></div><div className="update-actions"><button className="secondary" type="button" disabled={updateStatus.phase === "checking" || updateStatus.phase === "downloading" || updateStatus.phase === "installing"} onClick={() => void onCheckUpdates(true)}><ArrowsClockwise /> Check now</button>{updateStatus.phase === "available" && <button className="primary" type="button" title={turnRunning ? "Finish or cancel the active turn first" : "Install update and restart"} disabled={turnRunning} onClick={() => void onInstallUpdate()}><DownloadSimple /> Install & restart</button>}</div></div>{updateStatus.phase === "downloading" && <div className="update-meter"><span style={{ transform: `scaleX(${(updateStatus.percent ?? 0) / 100})` }} /></div>}<p className="settings-note">Signed releases are verified before installation. Check now performs a real update lookup.</p></section>}

            {category === "about" && <section className="settings-group about-settings"><img src="/kimi-logo.png" alt="" aria-hidden="true" /><h2>Kimi Code Desktop</h2><p>A polished open-source desktop harness for the official Kimi Code CLI. It keeps authentication, workspaces, event history, Git checkpoints, terminal sessions, and previews on your computer.</p><dl><div><dt>Runtime</dt><dd>Official Kimi Code CLI via ACP</dd></div><div><dt>Storage</dt><dd>Local compact event log</dd></div><div><dt>Source</dt><dd>github.com/Leonxlnx/kimi-code-desktop</dd></div></dl></section>}
          </div>
        </main>
      </div>
    </section>
  </div>;
}

function SettingsRow({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong><small>{description}</small></div><div>{children}</div></div>;
}

function ChoiceButtons({ value, options, onChange }: { value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <div className="settings-choices">{options.map((option) => <button className={value === option.value ? "active" : ""} type="button" aria-pressed={value === option.value} key={option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function settingsDescription(category: SettingsCategory): string {
  return {
    general: "Workspace defaults and everyday behavior.",
    appearance: "Theme, typography, color, and interface scale.",
    layout: "Place and resize every part of the workspace.",
    account: "Your local Kimi CLI and subscription identity.",
    usage: "Live Kimi subscription quota.",
    updates: "Signed releases and update installation.",
    about: "Runtime architecture and open-source information.",
  }[category];
}

function RailTabs({ current, workspace, activeAgents, onSelect, onClose }: { current: RailView; workspace: boolean; activeAgents: number; onSelect: (view: RailView) => void; onClose: () => void }) {
  return <nav className="rail-tabs" aria-label="Side panel tabs">
    <div>
      {workspace && <button className={current === "git" ? "active" : ""} type="button" aria-current={current === "git" ? "page" : undefined} onClick={() => onSelect("git")}><GitBranch /><span>Changes</span></button>}
      {workspace && <button className={current === "terminal" ? "active" : ""} type="button" aria-current={current === "terminal" ? "page" : undefined} onClick={() => onSelect("terminal")}><TerminalWindow /><span>Terminal</span></button>}
      {workspace && <button className={current === "preview" ? "active" : ""} type="button" aria-current={current === "preview" ? "page" : undefined} onClick={() => onSelect("preview")}><Browser /><span>Preview</span></button>}
      <button className={current === "agents" ? "active" : ""} type="button" aria-current={current === "agents" ? "page" : undefined} onClick={() => onSelect("agents")}><Robot /><span>Agents</span>{activeAgents > 0 && <small className="rail-agent-count">{activeAgents}</small>}</button>
    </div>
    <button className="rail-tabs-close" type="button" aria-label="Close side panel" onClick={onClose}><X /></button>
  </nav>;
}

function CapabilitiesCenter({ data, loading, tab, nativePlugins, nativeMcp, onTab, onRefresh, onUsePrompt, onCopyPath }: {
  data: KimiCapabilities | undefined;
  loading: boolean;
  tab: CapabilityTab;
  nativePlugins: boolean;
  nativeMcp: boolean;
  onTab: (tab: CapabilityTab) => void;
  onRefresh: () => Promise<void>;
  onUsePrompt: (text: string) => void;
  onCopyPath: (path: string) => void;
}) {
  const count = tab === "plugins" ? data?.plugins.length : tab === "mcp" ? data?.mcpServers.length : data?.agents.length;
  return <section className="capabilities-center" aria-label="Kimi capabilities">
    <header className="capabilities-hero">
      <div className="capabilities-mark"><PlugsConnected /></div>
      <div><span>Extend Kimi</span><h1>Plugins, tools, and focused agents.</h1><p>Everything here comes from your official local Kimi installation. The desktop app never copies credentials or invents a second plugin runtime.</p></div>
      <button className="capabilities-refresh" type="button" disabled={loading} onClick={() => void onRefresh()}><ArrowsClockwise className={loading ? "rotating" : ""} /><span>{loading ? "Refreshing" : "Refresh"}</span></button>
    </header>
    <nav className="capabilities-tabs" aria-label="Capability categories">
      <button className={tab === "plugins" ? "active" : ""} type="button" onClick={() => onTab("plugins")}><PlugsConnected /><span>Plugins</span><small>{data?.plugins.length ?? 0}</small></button>
      <button className={tab === "mcp" ? "active" : ""} type="button" onClick={() => onTab("mcp")}><Cpu /><span>MCP servers</span><small>{data?.mcpServers.length ?? 0}</small></button>
      <button className={tab === "agents" ? "active" : ""} type="button" onClick={() => onTab("agents")}><Robot /><span>Subagents</span><small>{data?.agents.length ?? 3}</small></button>
    </nav>
    <div className="capabilities-content" key={tab}>
      <div className="capabilities-section-title"><div><strong>{tab === "plugins" ? "Installed plugins" : tab === "mcp" ? "Configured tool servers" : "Kimi-native agent shortcuts"}</strong><span>{count ?? 0} {tab === "agents" ? "shortcuts" : "configured"}</span></div>{tab === "plugins" ? <button type="button" onClick={() => onUsePrompt(nativePlugins ? "/plugins " : "Help me install or manage a Kimi Code plugin using the capabilities available in this Kimi version. ")}><Plus /> Install with Kimi</button> : tab === "mcp" ? <button type="button" onClick={() => onUsePrompt(nativeMcp ? "/mcp-config " : "Help me configure an MCP server for Kimi Code using the capabilities available in this Kimi version. ")}><Plus /> Configure MCP</button> : null}</div>
      {loading && !data ? <CapabilitySkeleton /> : tab === "plugins" ? <div className="capability-grid">
        {data?.plugins.map((plugin) => <article className="capability-card" key={plugin.name}><span className="capability-icon"><PlugsConnected /></span><div><strong>{plugin.name}</strong><small>v{plugin.version} · {plugin.toolCount} {plugin.toolCount === 1 ? "tool" : "tools"}</small><p>{plugin.description || "Local Kimi plugin"}</p></div><button type="button" onClick={() => onUsePrompt(nativePlugins ? `/plugins ${plugin.name} ` : `Help me inspect and manage the installed Kimi plugin ${plugin.name}. `)}>Manage</button></article>)}
        {!data?.plugins.length && <CapabilityEmpty icon={<PlugsConnected />} title="No plugins installed yet" text={nativePlugins ? "Install a Kimi plugin from a folder, ZIP URL, or Git repository through Kimi's native manager." : "This Kimi runtime has not exposed its native plugin manager in the current session. Kimi can still inspect the installed version and guide a compatible setup."} action={nativePlugins ? "Open plugin manager" : "Ask Kimi"} onAction={() => onUsePrompt(nativePlugins ? "/plugins " : "Check my installed Kimi Code version and help me enable or install compatible plugins. ")} />}
      </div> : tab === "mcp" ? <div className="capability-list">
        {data?.mcpServers.map((server) => <article className="mcp-row" key={server.name}><span className={`mcp-status ${server.connectable ? "ready" : "attention"}`} /><div><strong>{server.name}</strong><small>{server.transport.toUpperCase()} · {server.target}</small></div>{!server.connectable && <span className="capability-badge">{server.needsAuthorization ? "OAuth" : "Unsupported"}</span>}<button type="button" onClick={() => onUsePrompt(nativeMcp ? "/mcp " : `Check the configured MCP server ${server.name} and report its available tools. `)}>Check</button></article>)}
        {!data?.mcpServers.length && <CapabilityEmpty icon={<Cpu />} title="No MCP servers configured" text={nativeMcp ? "Connect Kimi to APIs, databases, and local tools using its standard MCP configuration." : "This Kimi runtime has not exposed MCP configuration commands in the current session. Ask Kimi to use the configuration supported by your installed version."} action={nativeMcp ? "Configure MCP" : "Ask Kimi"} onAction={() => onUsePrompt(nativeMcp ? "/mcp-config " : "Check my installed Kimi Code version and help me configure a compatible MCP server. ")} />}
      </div> : <div className="agent-grid">
        {(data?.agents ?? defaultAgentCapabilities()).map((agent) => <article className={`agent-card agent-${agent.name}`} key={agent.name}><div className="agent-card-top"><span><Robot /></span><small>{agent.supportsBackground ? "Foreground or background" : "Foreground"}</small></div><h2>{agent.name}</h2><p>{agent.description}</p><footer><span>{agent.access}</span><button type="button" onClick={() => onUsePrompt(`Use the ${agent.name} subagent for this task: `)}>Use agent <CaretRight /></button></footer></article>)}
      </div>}
      {data?.warnings.length ? <div className="capability-warning"><WarningCircle /><span>{data.warnings.join(" ")}</span></div> : null}
      {data && <footer className="capabilities-paths"><span>Local Kimi data</span><button type="button" title={tab === "mcp" ? data.roots.mcp : data.roots.plugins} onClick={() => onCopyPath(tab === "mcp" ? data.roots.mcp : data.roots.plugins)}><Copy /> Copy {tab === "mcp" ? "config" : "plugin folder"} path</button></footer>}
    </div>
  </section>;
}

function CapabilitySkeleton() {
  return <div className="capability-skeleton" aria-label="Loading Kimi capabilities" aria-busy="true"><span /><span /><span /></div>;
}

function CapabilityEmpty({ icon, title, text, action, onAction }: { icon: React.ReactNode; title: string; text: string; action: string; onAction: () => void }) {
  return <div className="capability-empty"><span>{icon}</span><strong>{title}</strong><p>{text}</p><button type="button" onClick={onAction}>{action}</button></div>;
}

function SubagentsRail({ runs, onUseAgent, onOpenCenter }: { runs: SubagentRun[]; onUseAgent: (agent: string) => void; onOpenCenter: () => void }) {
  const active = runs.filter((run) => run.status === "running").length;
  return <section className="agents-rail-content">
    <header><div><span>{active ? `${active} active` : "Kimi subagents"}</span><strong>Focused work, separate context.</strong></div><button type="button" onClick={onOpenCenter}>Browse agents</button></header>
    {runs.length ? <div className="agent-run-list">{runs.map((run) => <article className={`agent-run ${run.status}`} key={run.id}><span className="agent-run-state">{run.status === "running" ? <i /> : run.status === "completed" ? <Check /> : <WarningCircle />}</span><div><strong>{run.description}</strong><small><b>{run.type}</b>{run.background ? " · background" : " · foreground"}{run.agentId ? ` · ${run.agentId}` : ""}</small></div><span>{run.status}</span></article>)}</div> : <div className="agents-empty"><Robot /><strong>No subagents in this chat</strong><p>Ask Kimi to delegate exploration, planning, or implementation without filling the main context.</p><div><button type="button" onClick={() => onUseAgent("explore")}>Explore</button><button type="button" onClick={() => onUseAgent("plan")}>Plan</button><button type="button" onClick={() => onUseAgent("coder")}>Code</button></div></div>}
  </section>;
}

function Onboarding({ auth, cwd, onInstall, onLogin, onOpenUrl, onChooseWorkspace, onCancel, onFinish, onSkip }: {
  auth: AuthState; cwd: string; onInstall: () => Promise<void>; onLogin: () => Promise<void>; onOpenUrl: (url: string) => Promise<void>;
  onChooseWorkspace: () => Promise<void>; onCancel: () => void; onFinish: () => void; onSkip: () => void;
}) {
  return <section className="onboarding">
    <header><div className="onboarding-mark"><img src="/kimi-logo.png" alt="" aria-hidden="true" /></div><div><span>Welcome</span><h1>Your Kimi plan, in a focused desktop workspace.</h1><p>Kimi Code Desktop wraps the official CLI. Your login, quota, files, and sessions stay on this Windows account.</p></div></header>
    <ol className="setup-steps">
      <li className={auth.installed ? "complete" : ""}><span>{auth.installed ? <Check /> : "1"}</span><div><strong>Install Kimi Code CLI</strong><p>{auth.installed ? "Found the local Kimi CLI." : "Runs Kimi's official Windows installer."}</p>{!auth.installed && <button className="primary" type="button" disabled={auth.installRunning} onClick={() => void onInstall()}><DownloadSimple />{auth.installRunning ? "Installing…" : "Install Kimi CLI"}</button>}</div></li>
      <li className={auth.authenticated ? "complete" : ""}><span>{auth.authenticated ? <Check /> : "2"}</span><div><strong>Connect your Kimi account</strong><p>{auth.authenticated ? "Your local Kimi account is connected." : "Kimi opens a device-code flow for your own subscription."}</p>{!auth.authenticated && auth.installed && <div className="auth-actions"><button className="primary" type="button" disabled={auth.loginRunning} onClick={() => void onLogin()}><SignIn />{auth.loginRunning ? "Waiting for sign-in…" : "Begin sign-in"}</button>{auth.loginRunning && <button className="secondary" type="button" onClick={onCancel}>Cancel</button>}</div>}{auth.event?.operation === "login" && auth.event.url && <button className="verification-link" type="button" onClick={() => void onOpenUrl(auth.event!.url!)}>Open Kimi verification</button>}{auth.event?.operation === "login" && auth.event.code && <button className="pairing-code" type="button" onClick={() => void navigator.clipboard.writeText(auth.event?.code ?? "")}><Copy />{auth.event.code}</button>}</div></li>
      <li className={cwd ? "complete" : ""}><span>{cwd ? <Check /> : "3"}</span><div><strong>Choose a workspace</strong><p>{cwd || "Pick the folder Kimi is allowed to work in."}</p><button className="secondary" type="button" onClick={() => void onChooseWorkspace()}><FolderOpen />{cwd ? "Change folder" : "Choose folder"}</button></div></li>
    </ol>
    <footer><button className="text-button" type="button" onClick={onSkip}>Skip for now</button><button className="primary" type="button" disabled={!auth.installed || !auth.authenticated || !cwd} onClick={onFinish}>Start coding</button></footer>
  </section>;
}

function AuthCard({ auth, onInstall, onLogin, onOpenUrl, onCancel }: {
  auth: AuthState | undefined; onInstall: () => Promise<void>; onLogin: () => Promise<void>; onOpenUrl: (url: string) => Promise<void>; onCancel: () => void;
}) {
  if (!auth) return <section className="auth-card" aria-live="polite"><ArrowsClockwise size={24} /><div><h1>Starting Kimi Code</h1><p>Checking the local CLI and account…</p></div></section>;
  return <section className="auth-card"><SignIn size={24} /><div><h1>{auth?.installed ? "Connect Kimi Code" : "Install Kimi Code CLI"}</h1><p>{auth?.installed ? "Sign in with your own Kimi plan. Credentials stay in your local Kimi Code home." : "The desktop app needs Kimi's official CLI. Installation uses Kimi's published Windows script."}</p>{auth?.event?.operation === "login" && auth.event.url && <button className="verification-link" type="button" onClick={() => void onOpenUrl(auth.event!.url!)}>Open Kimi verification</button>}{auth?.event?.operation === "login" && auth.event.code && <button className="pairing-code" type="button" onClick={() => void navigator.clipboard.writeText(auth.event?.code ?? "")}><Copy />{auth.event.code}</button>}<div className="auth-actions">{auth?.installed ? <button className="primary" type="button" disabled={auth.loginRunning} onClick={() => void onLogin()}>{auth.loginRunning ? "Waiting for sign-in…" : "Begin sign-in"}</button> : <button className="primary" type="button" disabled={auth?.installRunning} onClick={() => void onInstall()}>{auth?.installRunning ? "Installing…" : "Install Kimi CLI"}</button>}{(auth?.loginRunning || auth?.installRunning) && <button className="secondary" type="button" onClick={onCancel}>Cancel</button>}</div></div></section>;
}

function SidebarSkeleton() {
  return <div className="sidebar-skeleton" aria-label="Loading projects" aria-busy="true">{[72, 54, 80, 62, 46, 76].map((width, index) => <span style={{ width: `${width}%` }} key={`${width}-${index}`} />)}</div>;
}

function StartupScreen({ delayed, onRetry }: { delayed: boolean; onRetry: () => void }) {
  return <div className="startup-screen" aria-label="Starting Kimi Code" aria-busy={!delayed}><div className="startup-intro"><img src="/kimi-logo.png" alt="" aria-hidden="true" /><span>Kimi Code Desktop</span><strong>{delayed ? "The local runtime needs attention" : "Opening your workspace"}</strong><small>{delayed ? "Kimi Code did not become ready in time. Restart it safely without closing the app." : "Connecting to your local Kimi runtime and restoring sessions"}</small>{delayed ? <button type="button" onClick={onRetry}><ArrowsClockwise /> Restart local runtime</button> : <div className="startup-progress" aria-hidden="true"><i /></div>}</div></div>;
}

async function localServerUrl(): Promise<string> {
  try {
    const connection = await invoke<{ port: number; token: string }>("server_connection");
    const token = connection.token ? `?token=${encodeURIComponent(connection.token)}` : "";
    return `ws://127.0.0.1:${connection.port}${token}`;
  } catch {
    return "ws://127.0.0.1:4317";
  }
}

export function workspaceName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "") || cwd;
  return trimmed.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
  return normalize(left) === normalize(right);
}

function pathKey(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
}

function uniquePaths(paths: string[]): string[] {
  return paths.filter((path, index) => Boolean(path) && paths.findIndex((candidate) => samePath(candidate, path)) === index);
}

export function groupProjects(projectPaths: string[], threads: Thread[], runtimeSessions: RuntimeSession[], aliases: Record<string, string> = {}): ProjectGroup[] {
  const projectThreads = threads.filter((thread) => thread.kind !== "chat");
  const projectSessions = runtimeSessions.filter((session) => session.kind !== "chat");
  return uniquePaths([...projectPaths, ...projectThreads.map((thread) => thread.cwd), ...projectSessions.map((session) => session.cwd)]).filter((cwd) => !isInternalWorkspace(cwd)).map((cwd) => ({
    cwd,
    name: aliases[pathKey(cwd)] || workspaceName(cwd),
    threads: projectThreads.filter((thread) => samePath(thread.cwd, cwd)),
    runtimeSessions: projectSessions.filter((session) => samePath(session.cwd, cwd)),
  }));
}

export function filterRuntimeSessions(runtimeSessions: RuntimeSession[], threads: Thread[], hiddenSessionIds: string[]): RuntimeSession[] {
  const hidden = new Set(hiddenSessionIds);
  const managed = new Set(threads.map((thread) => thread.sessionId));
  return runtimeSessions.filter((session) => !hidden.has(session.sessionId) && !managed.has(session.sessionId));
}

export function reorderPaths(paths: string[], source: string, target: string): string[] {
  const sourceIndex = paths.findIndex((path) => samePath(path, source));
  const targetIndex = paths.findIndex((path) => samePath(path, target));
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return paths;
  const reordered = [...paths];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved!);
  return reordered;
}

function filterProjects(projects: ProjectGroup[], query: string): ProjectGroup[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return projects;
  return projects.flatMap((project) => {
    if (`${project.name} ${project.cwd}`.toLocaleLowerCase().includes(normalized)) return [project];
    const threads = filterByTitle(project.threads, normalized);
    const runtimeSessions = filterByTitle(project.runtimeSessions, normalized);
    return threads.length || runtimeSessions.length ? [{ ...project, threads, runtimeSessions }] : [];
  });
}

function isInternalWorkspace(path: string): boolean {
  return /\/(?:kimicodedesktop|com\.kimicode\.desktop)\/runtime\/(?:quota-probe|chats|config-probe)$/i.test(path.replaceAll("\\", "/").replace(/\/+$/, ""));
}

function loadPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(preferenceKey) ?? "{}") as Partial<Preferences>;
    const savedWorkspace = typeof value.workspace === "string" ? value.workspace : "";
    const workspace = isInternalWorkspace(savedWorkspace) ? "" : savedWorkspace;
    const projects = Array.isArray(value.projects) ? value.projects.filter((path): path is string => typeof path === "string" && !isInternalWorkspace(path)) : [];
    const projectAliases = value.projectAliases && typeof value.projectAliases === "object" && !Array.isArray(value.projectAliases)
      ? Object.fromEntries(Object.entries(value.projectAliases).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1].trim())))
      : {};
    const hiddenProjects = Array.isArray(value.hiddenProjects) ? value.hiddenProjects.filter((path): path is string => typeof path === "string") : [];
    const hiddenSessions = Array.isArray(value.hiddenSessions) ? [...new Set(value.hiddenSessions.filter((sessionId): sessionId is string => typeof sessionId === "string"))] : [];
    const composerConfig = value.composerConfig && typeof value.composerConfig === "object" && !Array.isArray(value.composerConfig)
      ? Object.fromEntries(Object.entries(value.composerConfig).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1])))
      : {};
    const savedPaletteVersion = Number(value.paletteVersion);
    const fontSize = savedPaletteVersion === 4 && typeof value.fontSize === "number" ? Math.min(18, Math.max(13, Math.round(value.fontSize))) : defaultPreferences.fontSize;
    return {
      density: value.density === "compact" ? "compact" : "comfortable",
      sendKey: value.sendKey === "ctrl-enter" ? "ctrl-enter" : "enter",
      workspace,
      onboardingDone: value.onboardingDone === true,
      sidebarCollapsed: value.sidebarCollapsed === true,
      projects: uniquePaths([...projects, workspace]),
      zoom: typeof value.zoom === "number" ? clampZoom(value.zoom) : 1,
      theme: value.theme === "light" || value.theme === "dark" ? value.theme : "system",
      font: value.font === "humanist" || value.font === "mono" ? value.font : "system",
      fontSize,
      accent: savedPaletteVersion >= 3 && (value.accent === "neutral" || value.accent === "blue" || value.accent === "violet" || value.accent === "teal") ? value.accent : "neutral",
      paletteVersion: 4,
      sidebarSide: value.sidebarSide === "right" ? "right" : "left",
      railSide: value.railSide === "left" ? "left" : "right",
      sidebarWidth: clampPanelWidth("sidebar", value.sidebarWidth ?? defaultPreferences.sidebarWidth),
      railWidth: clampPanelWidth("rail", value.railWidth ?? defaultPreferences.railWidth),
      projectAliases,
      hiddenProjects: uniquePaths(hiddenProjects),
      hiddenSessions,
      composerConfig,
      yoloAcknowledged: value.yoloAcknowledged === true,
    };
  } catch {
    return { ...defaultPreferences };
  }
}

export function clampPanelWidth(panel: "sidebar" | "rail", width: number): number {
  return Math.round(Math.min(panel === "sidebar" ? 420 : 1200, Math.max(panel === "sidebar" ? 84 : 260, width)));
}

export function floatingMenuPosition(anchor: { top: number; right: number; bottom: number }, menu: { width: number; height: number }, viewport: { width: number; height: number }): { top: number; left: number } {
  const margin = 8;
  const maxLeft = Math.max(margin, viewport.width - menu.width - margin);
  const left = Math.max(margin, Math.min(maxLeft, anchor.right - menu.width));
  const below = anchor.bottom + 4;
  const top = below + menu.height <= viewport.height - margin ? below : Math.max(margin, anchor.top - menu.height - 4);
  return { top, left };
}

function clampZoom(value: number): number {
  return Math.min(1.4, Math.max(.8, Math.round(value * 10) / 10));
}

export function normalizeAvailableCommands(value: unknown): AvailableCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: AvailableCommand[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as { name?: unknown; description?: unknown; input?: unknown };
    const name = typeof raw.name === "string" ? raw.name.trim().replace(/^\/+/, "") : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    const input = raw.input && typeof raw.input === "object" && typeof (raw.input as { hint?: unknown }).hint === "string"
      ? { hint: (raw.input as { hint: string }).hint }
      : undefined;
    commands.push({
      name,
      description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : "Kimi Code command.",
      ...(input ? { input } : {}),
    });
    seen.add(name.toLowerCase());
  }
  return commands;
}

export function composerTrigger(value: string): { kind: "command" | "skill" | "file"; prefix: "/" | "$" | "#" | "@"; query: string; start: number } | undefined {
  const match = /(^|\s)([/#$@])(\{?[^}\s]*)$/.exec(value);
  if (!match) return undefined;
  const prefix = match[2] as "/" | "$" | "#" | "@";
  return {
    kind: prefix === "/" ? "command" : prefix === "$" ? "skill" : "file",
    prefix,
    query: (match[3] ?? "").replace(/^\{/, ""),
    start: match.index + (match[1]?.length ?? 0),
  };
}

export function toggleComposerTrigger(value: string, prefix: "/" | "$" | "#"): string {
  const active = composerTrigger(value);
  if (active?.prefix === prefix) return value.slice(0, active.start).replace(/\s+$/, "");
  return `${value}${value && !/\s$/.test(value) ? " " : ""}${prefix}`;
}

function replaceComposerTrigger(value: string, replacement: string): string {
  const trigger = composerTrigger(value);
  return trigger ? `${value.slice(0, trigger.start)}${replacement}` : `${value}${value && !/\s$/.test(value) ? " " : ""}${replacement}`;
}

export function workspaceRelativePath(root: string, file: string): string | undefined {
  const normalize = (value: string) => {
    const slashes = value.trim().replaceAll("\\", "/");
    const collapsed = slashes.replace(/\/{2,}/g, "/");
    const normalized = slashes.startsWith("//") ? `/${collapsed}` : collapsed;
    return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
  };
  const normalizedRoot = normalize(root);
  const normalizedFile = normalize(file);
  if (!normalizedRoot || !normalizedFile || normalizedRoot === normalizedFile) return undefined;
  const insensitive = /^[a-z]:\//i.test(normalizedRoot) || normalizedRoot.startsWith("//");
  const comparedRoot = insensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparedFile = insensitive ? normalizedFile.toLowerCase() : normalizedFile;
  const prefix = comparedRoot === "/" ? "/" : `${comparedRoot}/`;
  if (!comparedFile.startsWith(prefix)) return undefined;
  return normalizedFile.slice(prefix.length).replace(/^\/+/, "") || undefined;
}

async function applyZoom(value: number): Promise<void> {
  if (!isTauri()) return;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().setZoom(value);
}

async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

function UsagePanel({ quota, error, loading, onRefresh }: { quota: KimiQuota | undefined; error: string | undefined; loading: boolean; onRefresh: () => Promise<void> }) {
  const quotaRows = [quota?.summary, ...(quota?.limits ?? [])].filter((row): row is KimiQuotaRow => Boolean(row));
  return <section className="quota-panel">
      <div className="quota-title"><div><span>Subscription quota</span>{quota?.updatedAt ? <small>{quota.stale ? "Last verified" : "Updated"} {formatReset(quota.updatedAt)}</small> : quota?.planType && <small>{quota.planType === "purchase" ? "Purchased plan" : quota.planType}</small>}</div><button type="button" aria-label="Refresh subscription quota" disabled={loading} onClick={() => void onRefresh()}><ArrowsClockwise /></button></div>
      {loading && !quotaRows.length ? <div className="quota-skeleton" aria-label="Fetching Kimi quota" aria-busy="true"><span /><span /><span /></div> : quotaRows.map((row) => <QuotaRow key={row.label} row={row} />)}
      {!loading && !quotaRows.length && <p className="quota-empty">{error ?? "Quota unavailable"}</p>}
      {quota?.parallel !== undefined && <div className="quota-parallel"><span>Parallel sessions</span><strong>{quota.parallel}</strong></div>}
    </section>;
}

function QuotaRow({ row }: { row: KimiQuotaRow }) {
  const percent = quotaRowPercent(row) ?? 0;
  const used = 100 - percent;
  const reset = row.resetHint ?? (row.resetTime ? `resets ${formatReset(row.resetTime)}` : undefined);
  return <div className="quota-row"><div><span>{row.label}</span><strong>{percent}% left</strong></div><div className="quota-meter"><span style={{ transform: `scaleX(${percent / 100})` }} /></div><small>{used}% used · {percent}% left{reset ? ` · ${reset}` : ""}</small></div>;
}

function quotaPercent(quota?: KimiQuota): number | undefined {
  return quotaRowPercent(quota?.summary);
}

function quotaRowPercent(row?: KimiQuotaRow): number | undefined {
  return row?.limit ? Math.max(0, Math.min(100, Math.round((row.remaining / row.limit) * 100))) : undefined;
}

export function contextPercent(usage?: Usage): number | undefined {
  const context = usage?.context;
  return context?.size ? Math.max(0, Math.min(100, Math.round((context.used / context.size) * 100))) : undefined;
}

function defaultAgentCapabilities(): KimiAgent[] {
  return [
    { name: "coder", description: "General software engineering with workspace read, write, search, and shell tools.", access: "Read, write, shell", supportsBackground: true },
    { name: "explore", description: "Fast read-only codebase exploration, search, and technical summaries.", access: "Read and search", supportsBackground: true },
    { name: "plan", description: "Architecture analysis and implementation planning without changing files.", access: "Read and plan", supportsBackground: true },
  ];
}

export function subagentRuns(thread: Pick<Thread, "tools"> | undefined): SubagentRun[] {
  if (!thread) return [];
  return thread.tools.filter(isSubagentTool).map<SubagentRun>((tool) => {
    const input = isRecordValue(tool.rawInput) ? tool.rawInput : {};
    const output = `${safeStringify(tool.rawOutput)} ${tool.content?.map((item) => safeStringify(item)).join(" ") ?? ""}`;
    const agentId = /\bagent_id:\s*([\w-]+)/i.exec(output)?.[1];
    const type = typeof input.subagent_type === "string" ? input.subagent_type : /actual_subagent_type:\s*([\w-]+)/i.exec(output)?.[1] ?? "coder";
    const description = typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : (tool.title ?? "Agent task").replace(/^Agent\s*:\s*/i, "");
    return {
      id: tool.toolCallId,
      type,
      description,
      status: tool.status === "in_progress" || tool.status === "pending" ? "running" : tool.status === "failed" ? "failed" : "completed",
      background: input.run_in_background === true || /\bkind:\s*agent\b/i.test(output),
      ...(agentId ? { agentId } : {}),
    };
  }).reverse();
}

function isSubagentTool(tool: Tool | undefined): tool is Tool {
  return Boolean(tool && (/^Agent(?:\b|:)/i.test(tool.title ?? "") || isRecordValue(tool.rawInput) && typeof tool.rawInput.subagent_type === "string"));
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatReset(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(value);
}

export function updatePercent(downloaded: number, total?: number): number | undefined {
  return total ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;
}

type TurnView = { record: TurnRecord; messages: Message[]; activity: ActivityEntry[]; tools: Tool[]; approvals: Approval[]; checkpoint?: Checkpoint; canRevert: boolean; running: boolean };

export function projectTurns(thread: Thread): TurnView[] {
  const ids = [...new Set([
    ...thread.turns.map((turn) => turn.turnId),
    ...thread.messages.map((message) => message.turnId),
    ...thread.activity.map((entry) => entry.turnId),
    ...thread.tools.flatMap((tool) => tool.turnId ? [tool.turnId] : []),
  ])];
  return ids.map((turnId) => {
    const checkpoint = thread.checkpoints.findLast((item) => item.turnId === turnId && item.phase === "after");
    return {
      record: thread.turns.find((turn) => turn.turnId === turnId) ?? { turnId, startedAt: thread.createdAt },
      messages: thread.messages.filter((message) => message.turnId === turnId),
      activity: thread.activity.filter((entry) => entry.turnId === turnId).sort((a, b) => a.seq - b.seq),
      tools: thread.tools.filter((tool) => tool.turnId === turnId),
      approvals: thread.approvals.filter((approval) => approval.turnId === turnId || (!approval.turnId && thread.activeTurnId === turnId)),
      ...(checkpoint ? { checkpoint } : {}),
      canRevert: Boolean(checkpoint && thread.checkpoints.some((item) => item.turnId === turnId && item.phase === "before")),
      running: thread.activeTurnId === turnId,
    };
  });
}

function TurnBlock({ turn, onOpenUrl, onOpenPreview, onOpenLocation, onRespond, onRevert, onReview }: {
  turn: TurnView;
  onOpenUrl: (url: string) => Promise<void>;
  onOpenPreview: (url: string) => void;
  onOpenLocation: (path: string) => void;
  onRespond: (approval: Approval, optionId?: string) => void;
  onRevert: (turnId: string) => Promise<void>;
  onReview: () => void;
}) {
  const user = turn.messages.filter((message) => message.role === "user");
  const assistant = turn.messages.filter((message) => message.role === "assistant");
  const report = assistant.map((message) => message.text).join("\n\n");
  const previewLink = findLocalPreviewUrl([
    ...turn.messages.map((message) => message.text),
    ...turn.tools.flatMap((tool) => [tool.title ?? "", ...tool.content?.map((item) => item.content?.text ?? "") ?? [], safeStringify(tool.rawOutput)]),
  ].join("\n"));
  return <section className={`turn-block ${turn.running ? "running" : "complete"}`}>
    {user.map((message, index) => <article className="user-message" key={`${message.turnId}-user-${index}`}><MarkdownText text={message.text} onOpenUrl={onOpenUrl} /><AttachmentSummary message={message} /><button className="message-copy" type="button" aria-label="Copy task" title="Copy task" onClick={() => void navigator.clipboard.writeText(message.text)}><Copy /></button></article>)}
    <div className="turn-output">
      {(turn.running || turn.activity.length > 0) && <ActivityTimeline turn={turn} onOpenUrl={onOpenUrl} onOpenLocation={onOpenLocation} />}
      {assistant.map((message, index) => <article className="assistant-message markdown" key={`${message.turnId}-assistant-${index}`}><MarkdownText text={message.text} onOpenUrl={onOpenUrl} /></article>)}
      {turn.approvals.map((approval) => <article className="approval" key={approval.requestId}>
        <div><strong>{approval.kind === "question" ? "Question" : approval.kind === "plan_review" ? "Review plan" : "Permission required"}</strong><p>{approval.title}</p></div>
        <div className="approval-actions">{approval.options.map((option) => <button className={permissionClass(option.kind)} type="button" key={option.optionId} onClick={() => onRespond(approval, option.optionId)}>{option.name}</button>)}</div>
      </article>)}
      {turn.record.completedAt && (report || turn.canRevert || turn.record.usage?.totalTokens != null || turn.record.stopReason === "cancelled") && <footer className="turn-report">
        <div className="turn-report-meta">{turn.record.usage?.totalTokens != null && <span>{formatTokens(turn.record.usage.totalTokens)} tokens</span>}{turn.record.stopReason === "cancelled" && <span>Cancelled</span>}</div>
        <div className="turn-report-actions">{report && <button type="button" onClick={() => void navigator.clipboard.writeText(report)}><Copy /> Copy report</button>}{turn.canRevert && <button type="button" onClick={() => void onRevert(turn.record.turnId)}><ArrowCounterClockwise /> Revert</button>}</div>
      </footer>}
      {turn.record.completedAt && previewLink && <div className="turn-preview-link"><span><i />{previewLink}</span><div><button type="button" onClick={() => onOpenPreview(previewLink)}><Browser /> Preview</button><button type="button" onClick={() => void onOpenUrl(previewLink)}><ArrowSquareOut /> Browser</button></div></div>}
      {turn.record.completedAt && turn.checkpoint?.diff && <ChangesCard diff={turn.checkpoint.diff} onReview={onReview} />}
    </div>
  </section>;
}

export function ActivityTimeline({ turn, onOpenUrl, onOpenLocation }: { turn: TurnView; onOpenUrl: (url: string) => Promise<void>; onOpenLocation: (path: string) => void }) {
  const [open, setOpen] = useState(turn.running);
  const [showEarlier, setShowEarlier] = useState(false);
  const wasRunning = useRef(turn.running);
  const duration = useElapsedDuration(turn.record.startedAt, turn.record.completedAt, turn.running);
  useEffect(() => {
    if (turn.running) setOpen(true);
    else if (wasRunning.current) setOpen(false);
    wasRunning.current = turn.running;
  }, [turn.running]);
  const activity = dedupeActivityEntries(turn.activity);
  const hidden = Math.max(0, activity.length - 8);
  const entries = showEarlier ? activity : activity.slice(-8);
  const currentEntryId = activity.findLast((entry) => entry.status === "pending" || entry.status === "in_progress")?.id;
  return <details className="turn-activity" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span className={`activity-state ${turn.running ? "active" : ""}`}>{turn.running ? <i className="activity-spinner" aria-hidden="true" /> : <Check />}</span><strong>{turn.running ? "Working" : `Worked for ${duration}`}</strong><small>{turn.running ? duration : `${activity.length} ${activity.length === 1 ? "step" : "steps"}`}</small><CaretDown /></summary>
    <div className="activity-content">
      {hidden > 0 && !showEarlier && <button className="activity-earlier" type="button" onClick={() => setShowEarlier(true)}>Show {hidden} earlier {hidden === 1 ? "step" : "steps"}</button>}
      {entries.map((entry) => <ActivityStep key={entry.id} entry={entry} current={entry.id === currentEntryId} tool={entry.toolCallId ? turn.tools.find((tool) => tool.toolCallId === entry.toolCallId) : undefined} onOpenUrl={onOpenUrl} onOpenLocation={onOpenLocation} />)}
    </div>
  </details>;
}

function ActivityStep({ entry, current, tool, onOpenUrl, onOpenLocation }: { entry: ActivityEntry; current: boolean; tool: Tool | undefined; onOpenUrl: (url: string) => Promise<void>; onOpenLocation: (path: string) => void }) {
  return <details className={`activity-step ${entry.status}`}>
    <summary><span className="activity-step-state">{entry.status === "completed" ? <Check /> : entry.status === "failed" ? <WarningCircle /> : current ? <i className="activity-spinner" aria-label="Current step" /> : <Circle />}</span><span>{activityPreview(entry.text)}</span><CaretRight /></summary>
    <div className="activity-detail">{entry.kind === "tool" && tool ? <ToolCard tool={tool} onOpenLocation={onOpenLocation} /> : <div className="markdown"><MarkdownText text={entry.text} onOpenUrl={onOpenUrl} /></div>}</div>
  </details>;
}

export function activityPreview(text: string, maxLength = 96): string {
  const cleaned = text.replace(/```[\s\S]*?```/g, " code ").replace(/[`*_#>\[\]]/g, "").replace(/\s+/g, " ").trim() || "…";
  return cleaned.length > maxLength ? `${cleaned.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…` : cleaned;
}

export function dedupeActivityEntries(entries: ActivityEntry[]): ActivityEntry[] {
  const result: ActivityEntry[] = [];
  for (const entry of entries) {
    const previous = result.at(-1);
    const duplicateThought = entry.kind === "thought"
      && previous?.kind === "thought"
      && activityPreview(previous.text, 10_000) === activityPreview(entry.text, 10_000);
    if (!duplicateThought) result.push(entry);
  }
  return result;
}

function useElapsedDuration(start: string, end: string | undefined, running: boolean): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return formatDuration(start, end);
}

function MarkdownText({ text, onOpenUrl }: { text: string; onOpenUrl: (url: string) => Promise<void> }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    a: ({ href, children }) => <a href={href} onClick={(event) => { event.preventDefault(); if (href) void onOpenUrl(href); }}>{children}</a>,
  }}>{text}</ReactMarkdown>;
}

type DiffSummary = { files: Array<{ path: string; additions: number; deletions: number }>; additions: number; deletions: number };

export function summarizeDiff(diff: string): DiffSummary {
  const files: DiffSummary["files"] = [];
  let current: DiffSummary["files"][number] | undefined;
  for (const line of diff.split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) {
      current = { path: match[2]!, additions: 0, deletions: 0 };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
    else if (current && line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
  }
  return { files, additions: files.reduce((sum, file) => sum + file.additions, 0), deletions: files.reduce((sum, file) => sum + file.deletions, 0) };
}

function ChangesCard({ diff, onReview }: { diff: string; onReview: () => void }) {
  const [showAll, setShowAll] = useState(false);
  const summary = summarizeDiff(diff);
  if (!summary.files.length) return null;
  return <details className="changes-card">
    <summary><span><GitBranch /><strong>Edited {summary.files.length} {summary.files.length === 1 ? "file" : "files"}</strong></span><span className="diff-totals"><b>+{summary.additions}</b><i>−{summary.deletions}</i><CaretDown /></span></summary>
    <div className="change-list">{summary.files.slice(0, showAll ? undefined : 3).map((file) => <div className="change-row" key={file.path}><span>{file.path}</span><small><b>+{file.additions}</b><i>−{file.deletions}</i></small></div>)}<div className="changes-actions">{summary.files.length > 3 && <button type="button" onClick={() => setShowAll((value) => !value)}>{showAll ? "Show less" : `Show ${summary.files.length - 3} more`}</button>}<button type="button" onClick={onReview}>Open Changes</button></div></div>
  </details>;
}

function formatDuration(start: string, end?: string): string {
  const elapsed = Math.max(0, new Date(end ?? Date.now()).getTime() - new Date(start).getTime());
  const seconds = Math.max(1, Math.round(elapsed / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

export function normalizeLocalPreviewUrl(value: string): string | undefined {
  let candidate = value.trim();
  if (/^\d{2,5}$/.test(candidate)) candidate = `http://localhost:${candidate}`;
  else if (/^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/|$)/i.test(candidate)) candidate = `http://${candidate}`;
  try {
    const url = new URL(candidate);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname.toLowerCase())) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function findLocalPreviewUrl(text: string): string | undefined {
  const explicit = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/[^\s<>"'`)*\]}]*)?/i.exec(text)?.[0];
  if (explicit) return normalizeLocalPreviewUrl(explicit);
  const bare = /\b(?:localhost|127\.0\.0\.1):\d{1,5}(?:\/[^\s<>"'`)*\]}]*)?/i.exec(text)?.[0];
  return bare ? normalizeLocalPreviewUrl(bare) : undefined;
}

function safeStringify(value: unknown): string {
  try { return value === undefined ? "" : JSON.stringify(value); } catch { return String(value); }
}

function moveMenuFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
    : event.key === 'ArrowDown' ? (current + 1 + items.length) % items.length
      : (current - 1 + items.length) % items.length;
  items[next]?.focus();
}

function trapDialogFocus(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((item) => item.offsetParent !== null);
  if (!items.length) return;
  const first = items[0]!;
  const last = items.at(-1)!;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function compactToolPreview(text: string | undefined, maxLines = 4, maxCharacters = 560): string {
  if (!text) return "";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const preview = lines.length > maxLines
    ? [...lines.slice(0, Math.max(1, maxLines - 1)), `… ${lines.length - Math.max(1, maxLines - 1)} more lines`]
    : lines.slice(0, maxLines);
  const joined = preview.join("\n");
  return joined.length > maxCharacters ? `${joined.slice(0, Math.max(1, maxCharacters - 1)).trimEnd()}…` : joined;
}

function ToolCard({ tool, onOpenLocation }: { tool: Tool; onOpenLocation: (path: string) => void }) {
  const diff = tool.content?.find((item) => item.type === "diff");
  return <article className="tool-card">
    <header><span className={`tool-state ${tool.status}`}>{tool.status === "completed" ? <Check /> : <Circle />}</span><strong>{tool.title ?? "Tool call"}</strong><span>{(tool.status ?? "pending").replace("_", " ")}</span></header>
    {tool.locations && <div className="tool-locations">{tool.locations.map((location) => <button type="button" key={`${location.path}:${location.line ?? ""}`} onClick={() => onOpenLocation(location.path)}><FileText />{location.path}{location.line ? `:${location.line}` : ""}</button>)}</div>}
    {tool.content?.filter((item) => item.type === "content" && item.content?.type === "text").map((item, index) => <pre className="tool-content" key={index}>{compactToolPreview(item.content?.text)}</pre>)}
    {diff && <div className="diff"><div className="diff-path">{diff.path}</div><pre className="removed">{compactToolPreview(diff.oldText, 2, 280)}</pre><pre className="added">{compactToolPreview(diff.newText, 2, 280)}</pre></div>}
    {(tool.rawInput !== undefined || tool.rawOutput !== undefined) && <details className="tool-raw"><summary>Metadata preview</summary><pre>{compactToolPreview(safeStringify({ input: tool.rawInput, output: tool.rawOutput }))}</pre></details>}
  </article>;
}

function AttachmentSummary({ message }: { message: Message }) {
  if (!message.resources?.length && !message.images?.length) return null;
  return <div className="message-attachments">{message.resources?.map((path) => <span key={path}><FileText />{path}</span>)}{message.images?.map((image) => <span key={image.name}><Paperclip />{image.name}</span>)}</div>;
}

function applyEvent(threads: Thread[], event: StoredEvent): Thread[] {
  return applyEvents(threads, [event]);
}

function applyEvents(threads: Thread[], events: StoredEvent[]): Thread[] {
  let nextThreads = threads;
  const mutable = new Map<string, Thread>();
  for (const event of events) {
    if (event.type === "ThreadCreated") {
      const payload = event.payload as { sessionId: string; cwd: string; kind?: "project" | "chat"; title: string; configOptions: ConfigOption[] };
      const created: Thread = { threadId: event.threadId, ...payload, kind: payload.kind === "chat" ? "chat" : "project", createdAt: event.createdAt, updatedAt: event.createdAt, running: false, activeTurnId: undefined, stopReason: undefined, turns: [], messages: [], activity: [], plan: [], tools: [], approvals: [], commands: [], modeId: undefined, checkpoints: [], usage: {}, queue: [] };
      mutable.set(event.threadId, created);
      nextThreads = [created, ...nextThreads.filter((thread) => thread.threadId !== event.threadId)];
      continue;
    }
    if (event.type === "ThreadDeleted") {
      mutable.delete(event.threadId);
      nextThreads = nextThreads.filter((thread) => thread.threadId !== event.threadId);
      continue;
    }
    let next = mutable.get(event.threadId);
    if (!next) {
      const current = nextThreads.find((thread) => thread.threadId === event.threadId);
      if (!current) continue;
      next = structuredClone(normalizeThread(current));
      mutable.set(event.threadId, next);
      nextThreads = nextThreads.map((thread) => thread.threadId === event.threadId ? next! : thread);
    }
    mutateThread(next, event);
  }
  return nextThreads;
}

function mutateThread(next: Thread, event: StoredEvent): void {
  next.updatedAt = event.createdAt;
  const payload = event.payload;
  if (event.type === "ThreadRenamed") next.title = String(payload.title);
  else if (event.type === "TurnStarted") {
    next.running = true; next.activeTurnId = String(payload.turnId); next.stopReason = undefined;
    if (typeof payload.title === "string" && payload.title) next.title = payload.title;
    next.turns.push({ turnId: String(payload.turnId), startedAt: event.createdAt });
    next.messages.push({
      turnId: String(payload.turnId), role: "user", text: String(payload.text),
      ...(Array.isArray(payload.resources) && payload.resources.length ? { resources: payload.resources as string[] } : {}),
      ...(Array.isArray(payload.images) && payload.images.length ? { images: payload.images as Array<{ name: string; mimeType: string }> } : {}),
    }); next.plan = [];
  } else if (event.type === "MessageAppended") {
    const message = payload as Message;
    if (message.role === "thought") appendRendererThought(next, message, event);
    else next.messages.push(message);
  }
  else if (event.type === "MessageDelta") {
    const delta = payload as Message;
    if (delta.role === "thought") appendRendererThought(next, delta, event);
    else {
      const last = next.messages.at(-1);
      if (last?.turnId === delta.turnId && last.role === delta.role) last.text += delta.text; else next.messages.push(delta);
    }
  } else if (event.type === "PlanReplaced") next.plan = payload.entries as Thread["plan"];
  else if (event.type === "ToolCallCreated") { const tool = payload.tool as Tool; const turnId = tool.turnId ?? next.activeTurnId; next.tools.push({ ...tool, ...(turnId ? { turnId } : {}) }); if (turnId) upsertRendererTool(next, { ...tool, turnId }, event); }
  else if (event.type === "ToolCallPatched") {
    const patch = payload.tool as Tool; const index = next.tools.findIndex((tool) => tool.toolCallId === patch.toolCallId);
    const turnId = patch.turnId ?? next.tools[index]?.turnId ?? next.activeTurnId;
    if (index >= 0) next.tools[index] = { ...next.tools[index], ...patch, ...(turnId ? { turnId } : {}) }; else next.tools.push({ ...patch, ...(turnId ? { turnId } : {}) });
    const tool = next.tools.find((candidate) => candidate.toolCallId === patch.toolCallId);
    if (turnId && tool) upsertRendererTool(next, { ...tool, turnId }, event);
  } else if (event.type === "ConfigOptionsReplaced") next.configOptions = payload.options as ConfigOption[];
  else if (event.type === "CommandsReplaced") next.commands = normalizeAvailableCommands(payload.commands);
  else if (event.type === "ModeChanged") next.modeId = String(payload.modeId);
  else if (event.type === "UsageUpdated") next.usage = { ...next.usage, context: payload.usage as NonNullable<Usage["context"]> };
  else if (event.type === "ApprovalRequested") { const approval = payload as Approval; const turnId = approval.turnId ?? next.activeTurnId; next.approvals.push({ ...approval, ...(turnId ? { turnId } : {}) }); }
  else if (event.type === "ApprovalResolved") next.approvals = next.approvals.filter((approval) => approval.requestId !== payload.requestId);
  else if (event.type === "TurnCompleted") { const turn = next.turns.findLast((item) => item.turnId === payload.turnId); if (turn) Object.assign(turn, { completedAt: event.createdAt, stopReason: String(payload.stopReason), ...(payload.usage ? { usage: payload.usage as NonNullable<Usage["tokens"]> } : {}) }); finishRendererActivity(next, String(payload.turnId), event.createdAt, String(payload.stopReason) === "error"); next.running = false; next.stopReason = String(payload.stopReason); next.activeTurnId = undefined; if (payload.usage) next.usage = { ...next.usage, tokens: payload.usage as NonNullable<Usage["tokens"]> }; }
  else if (event.type === "TurnCancelled") { const turn = next.turns.findLast((item) => item.turnId === payload.turnId); if (turn) Object.assign(turn, { completedAt: event.createdAt, stopReason: "cancelled" }); finishRendererActivity(next, String(payload.turnId), event.createdAt, true); next.running = false; next.stopReason = "cancelled"; next.activeTurnId = undefined; }
  else if (event.type === "CheckpointCaptured") { const checkpoint = { ...(payload.checkpoint as Checkpoint) }; if (typeof payload.diff === "string") checkpoint.diff = payload.diff; next.checkpoints.push(checkpoint); }
  else if (event.type === "CheckpointReverted") next.checkpoints.push(payload.checkpoint as Checkpoint);
}

function appendRendererThought(thread: Thread, message: Message, event: StoredEvent): void {
  const current = thread.activity.at(-1);
  if (current?.kind === "thought" && current.turnId === message.turnId && current.status === "in_progress") {
    current.text = boundedActivityText(current.text + message.text);
    current.updatedAt = event.createdAt;
    return;
  }
  finishRendererThought(thread, message.turnId, event.createdAt);
  thread.activity.push({ id: `thought-${event.seq}`, turnId: message.turnId, kind: "thought", status: "in_progress", text: boundedActivityText(message.text), seq: event.seq, createdAt: event.createdAt, updatedAt: event.createdAt });
}

function boundedActivityText(text: string): string {
  return text.length <= 4_000 ? text : `${text.slice(0, 3_999).trimEnd()}…`;
}

function upsertRendererTool(thread: Thread, tool: Tool & { turnId: string }, event: StoredEvent): void {
  const existing = thread.activity.find((entry) => entry.kind === "tool" && entry.turnId === tool.turnId && entry.toolCallId === tool.toolCallId);
  const status = rendererActivityStatus(tool.status);
  if (existing) {
    existing.text = tool.title ?? existing.text;
    existing.status = status;
    existing.updatedAt = event.createdAt;
    return;
  }
  finishRendererThought(thread, tool.turnId, event.createdAt);
  thread.activity.push({ id: `tool-${tool.toolCallId}`, turnId: tool.turnId, kind: "tool", status, text: tool.title ?? "Tool call", toolCallId: tool.toolCallId, seq: event.seq, createdAt: event.createdAt, updatedAt: event.createdAt });
}

function finishRendererThought(thread: Thread, turnId: string, updatedAt: string): void {
  const current = thread.activity.findLast((entry) => entry.turnId === turnId && entry.kind === "thought" && entry.status === "in_progress");
  if (current) { current.status = "completed"; current.updatedAt = updatedAt; }
}

function finishRendererActivity(thread: Thread, turnId: string, updatedAt: string, failed: boolean): void {
  for (const entry of thread.activity) {
    if (entry.turnId !== turnId || (entry.status !== "pending" && entry.status !== "in_progress")) continue;
    entry.status = failed ? "failed" : "completed";
    entry.updatedAt = updatedAt;
  }
}

function rendererActivityStatus(status?: string): ActivityEntry["status"] {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "error" || status === "cancelled") return "failed";
  if (status === "pending") return "pending";
  return "in_progress";
}

export function normalizeThread(value: Thread): Thread {
  const thread = value as Partial<Thread>;
  const createdAt = typeof thread.createdAt === "string" ? thread.createdAt : new Date(0).toISOString();
  return {
    threadId: String(thread.threadId ?? ""),
    sessionId: String(thread.sessionId ?? ""),
    cwd: String(thread.cwd ?? ""),
    kind: thread.kind === "chat" ? "chat" : "project",
    title: typeof thread.title === "string" && thread.title ? thread.title : "Kimi session",
    createdAt,
    updatedAt: typeof thread.updatedAt === "string" ? thread.updatedAt : createdAt,
    running: Boolean(thread.running),
    activeTurnId: typeof thread.activeTurnId === "string" ? thread.activeTurnId : undefined,
    stopReason: typeof thread.stopReason === "string" ? thread.stopReason : undefined,
    turns: Array.isArray(thread.turns) ? thread.turns : [],
    messages: Array.isArray(thread.messages) ? thread.messages : [],
    activity: Array.isArray(thread.activity) ? thread.activity : [],
    plan: Array.isArray(thread.plan) ? thread.plan : [],
    tools: Array.isArray(thread.tools) ? thread.tools : [],
    approvals: Array.isArray(thread.approvals) ? thread.approvals : [],
    configOptions: Array.isArray(thread.configOptions) ? thread.configOptions : [],
    commands: normalizeAvailableCommands(thread.commands),
    modeId: typeof thread.modeId === "string" ? thread.modeId : undefined,
    checkpoints: Array.isArray(thread.checkpoints) ? thread.checkpoints : [],
    usage: thread.usage && typeof thread.usage === "object" ? thread.usage : {},
    queue: Array.isArray(thread.queue) ? thread.queue : [],
  };
}

function flattenOptions(option: ConfigOption): Array<{ value: string; name: string }> {
  return option.options?.filter((choice): choice is { value: string; name: string } => "value" in choice) ?? [];
}

export function filterByTitle<T extends { title?: string }>(items: T[], query: string): T[] {
  const normalized = query.trim().toLowerCase();
  return normalized ? items.filter((item) => (item.title ?? "Kimi session").toLowerCase().includes(normalized)) : items;
}

function permissionClass(kind: string): string {
  if (kind === "allow_once") return "primary";
  if (kind === "reject_always") return "danger";
  return "secondary";
}

async function readImage(file: File): Promise<PendingImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Could not read image")));
    reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type, data: dataUrl.slice(dataUrl.indexOf(",") + 1) };
}
