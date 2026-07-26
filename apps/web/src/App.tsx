import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowCounterClockwise, ArrowSquareOut, ArrowsClockwise, ArrowUp, Brain, Browser, Broom, Bug, CaretDown, CaretRight, ChatCircleDots, Check, Circle, Copy, CornersIn, CornersOut, Cpu, DotsThree, DownloadSimple, FileText, FolderOpen, FolderSimple, Gauge, GearSix, GitBranch, GitCommit, Hammer, ImageSquare, Info, MagnifyingGlass, Minus, Palette, PaperPlaneRight, Paperclip, PencilSimple, PlugsConnected, Plus, Robot, ShieldCheck, SidebarSimple, SignIn, SignOut, SlidersHorizontal, Square, Stop, TerminalWindow, Trash, UserCircle, WarningCircle, X } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ConnectionSupervisor, type ConnectionState, type ServerMessage } from "./connection";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Update } from "@tauri-apps/plugin-updater";

type Message = { turnId: string; role: "user" | "assistant" | "thought"; text: string; seq?: number; updatedSeq?: number; resources?: string[]; images?: Array<{ name: string; mimeType: string }> };
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
type KimiMcpServer = { name: string; transport: "http" | "stdio" | "unknown"; target: string; needsAuthorization: boolean; connectable: boolean; projectScoped?: true };
type KimiSkill = { name: string; description: string; scope: "user" | "project"; source: "kimi" | "agents"; path: string; modelInvocable: boolean; hasSubSkills: boolean };
type KimiAgent = { name: "coder" | "explore" | "plan"; description: string; access: string; supportsBackground: boolean };
type KimiCapabilities = { plugins: KimiPlugin[]; mcpServers: KimiMcpServer[]; skills: KimiSkill[]; agents: KimiAgent[]; roots: { plugins: string; mcp: string; skills: string }; warnings: string[]; updatedAt: string };
type CapabilityTab = "skills" | "plugins" | "mcp" | "agents";
type SubagentRun = { id: string; type: string; description: string; status: "running" | "completed" | "failed"; background: boolean; agentId?: string; detail?: string; threadIds?: string[]; output?: string };
type SubagentInspection = { threadId: string; title: string; role?: string; status: string; turns: Array<{ turnId: string; status: string; durationMs?: number; items: Array<{ id: string; kind: "message" | "reasoning" | "action"; title: string; text?: string; status?: string }> }> };
type BackgroundTask = {
  taskId: string; queuedId: string; turnId: string; description: string;
  status: "running" | "completed" | "failed" | "killed" | "lost" | "expired" | "timed_out";
  registeredAt: string; updatedAt: string; endedAt?: number; exitCode?: number | null; reportQueued: boolean;
  reportDeliveredAt?: string; reportCancelledAt?: string;
};
type GitFile = { path: string; originalPath?: string; staged: boolean; unstaged: boolean; untracked: boolean; indexStatus: string; worktreeStatus: string };
type GitStatus = { root: string; branch: string; upstream?: string; ahead: number; behind: number; files: GitFile[] };
type TurnRecord = { turnId: string; startedAt: string; completedAt?: string; stopReason?: string; error?: string; usage?: NonNullable<Usage["tokens"]> };
type ActivityEntry = { id: string; turnId: string; kind: "thought" | "tool"; status: "pending" | "in_progress" | "completed" | "failed"; text: string; toolCallId?: string; seq: number; updatedSeq?: number; createdAt: string; updatedAt: string };
type QueuedPrompt = { queuedId: string; text: string; mode: "queue" | "steer"; createdAt: string; images: Array<{ name: string; mimeType: string }> };
type DesktopPreviewCommand = { action: "open" | "resize"; url?: string; panelWidth?: number; viewportWidth?: number; viewportHeight?: number };
type SkillInstallRequest = { cwd: string; source: string; name: string };
type ProviderId = "kimi" | "codex" | "claude" | "cursor";
type ThreadGoal = { objective: string; updatedAt: string };
type Thread = {
  threadId: string; sessionId: string; provider: ProviderId; parentThreadId?: string; goal?: ThreadGoal; cwd: string; kind: "project" | "chat"; title: string; createdAt: string; updatedAt: string; running: boolean;
  activeTurnId: string | undefined; stopReason: string | undefined; turns: TurnRecord[]; messages: Message[]; plan: Array<{ content: string; status: string }>;
  activity: ActivityEntry[]; tools: Tool[]; approvals: Approval[]; configOptions: ConfigOption[]; commands: AvailableCommand[]; modeId: string | undefined; checkpoints: Checkpoint[]; backgroundTasks: BackgroundTask[]; usage?: Usage; queue: QueuedPrompt[];
};
type StoredEvent = { threadId: string; seq: number; type: string; payload: Record<string, unknown>; createdAt: string };
type RuntimeSession = { sessionId: string; cwd: string; kind?: "project" | "chat"; title?: string; updatedAt?: string };
type AuthState = {
  installed: boolean; authenticated: boolean; loginRunning: boolean; installRunning: boolean; installMode: "manual"; installUrl: string; home: string;
  event?: { type: "progress" | "complete"; operation: "login" | "logout"; message: string; url?: string; code?: string; success?: boolean };
};
type ProviderState = {
  id: ProviderId; provider: ProviderId; name: string; protocol: "acp" | "app-server" | "stream-json"; installed: boolean;
  authenticated: boolean | null; loginRunning: boolean; runtimeReady: boolean; installUrl: string; account?: string; message?: string;
  event?: AuthState["event"];
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
  provider: ProviderId;
};
type ProjectGroup = { cwd: string; name: string; threads: Thread[]; runtimeSessions: RuntimeSession[] };
type DraftChat = { kind: "project" | "chat"; cwd?: string };
type ConfigTarget =
  | { key: string; kind: "thread"; threadId: string }
  | { key: string; kind: "draft"; draft: DraftChat };
type ConfigUpdate = { targetKey: string; configId: string; requestId: number };
type UpdateStatus = { phase: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error"; version?: string; currentVersion?: string; percent?: number; message?: string };
type RailView = "git" | "terminal" | "preview" | "agents";
type AppMenu = "file" | "edit" | "view" | "help";
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
  | { kind: "delete-thread"; threadId: string; sessionId: string; name: string }
  | { kind: "install-skill"; cwd: string; source: string; name: string };
const preferenceKey = "kimi-code-desktop.preferences.v1";
const defaultPreferences: Preferences = {
  density: "comfortable", sendKey: "enter", workspace: "", onboardingDone: false, sidebarCollapsed: false, projects: [], zoom: 1,
  theme: "system", font: "system", fontSize: 15, accent: "neutral", paletteVersion: 4, sidebarSide: "left", railSide: "right", sidebarWidth: 272, railWidth: 420,
  projectAliases: {}, hiddenProjects: [], hiddenSessions: [], composerConfig: {}, yoloAcknowledged: false, provider: "kimi",
};
const collapsedSidebarWidth = 60;
let terminalEntryId = 0;
const fallbackCommands: AvailableCommand[] = [
  { name: "goal", description: "Set, replace, or clear the goal for this chat." },
  { name: "side", description: "Create a side chat with the same provider and workspace." },
  { name: "compact", description: "Compact the current Kimi session context." },
  { name: "status", description: "Show the current session and runtime status." },
  { name: "usage", description: "Show subscription usage reported by Kimi." },
  { name: "mcp", description: "Show MCP servers and tools available to Kimi." },
  { name: "tasks", description: "Show tasks managed by the current session." },
  { name: "help", description: "Show Kimi Code commands and input help." },
  { name: "mcp-config", description: "Configure MCP servers for Kimi Code." },
  { name: "update-config", description: "Review or update Kimi Code configuration." },
  { name: "check-kimi-code-docs", description: "Check the official Kimi Code documentation." },
  { name: "custom-theme", description: "Create or update a Kimi Code theme." },
  { name: "import-from-cc-codex", description: "Import compatible Claude Code or Codex configuration." },
  { name: "sub-skill", description: "Create or work with a reusable Kimi skill." },
  { name: "sub-skill.review", description: "Review a Kimi skill." },
  { name: "sub-skill.consolidate", description: "Consolidate related Kimi skills." },
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
  return promptShortcutMode(event, sendKey, false) !== undefined;
}

export function promptShortcutMode(event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }, sendKey: Preferences["sendKey"], running: boolean): "queue" | "steer" | undefined {
  if (event.key !== "Enter" || event.shiftKey) return undefined;
  if (running) return event.ctrlKey || event.metaKey ? "steer" : "queue";
  return sendKey === "enter" || event.ctrlKey || event.metaKey ? "queue" : undefined;
}

export type ComposerPrimaryAction = "send" | "stop" | "queue";

export function composerPrimaryAction(running: boolean, hasText: boolean): ComposerPrimaryAction {
  if (!running) return "send";
  if (!hasText) return "stop";
  return "queue";
}

function composerPrimaryLabel(action: ComposerPrimaryAction): string {
  if (action === "stop") return "Stop task and clear queue";
  if (action === "queue") return "Queue after active task";
  return "Send task";
}

export function presentDiagnostic(message: string): string {
  return /ACP connection closed|Server disconnected|Server is not connected/i.test(message)
    ? "Kimi runtime disconnected. Reconnecting without stopping active work."
    : message;
}

export function shouldScheduleRuntimeRecovery(connection: ConnectionState, scheduled: boolean): boolean {
  return connection === "reconnecting" && !scheduled;
}

export function hasBlockingWork(
  threads: Array<Pick<Thread, "running" | "queue" | "approvals"> & Partial<Pick<Thread, "backgroundTasks">>>,
  draftSending = false,
): boolean {
  return draftSending || threads.some((thread) => thread.running
    || thread.queue.length > 0
    || thread.approvals.length > 0
    || thread.backgroundTasks?.some((task) => !task.reportDeliveredAt && !task.reportCancelledAt));
}

export function configTargetKey(
  thread: { threadId: string } | undefined,
  draft: { kind: "project" | "chat"; cwd?: string } | undefined,
): string | undefined {
  if (thread) return `thread:${thread.threadId}`;
  if (!draft) return undefined;
  return `draft:${JSON.stringify([draft.kind, draft.cwd ?? ""])}`;
}

export function composerCanSubmit(
  view: "projects" | "chats",
  targetKind: "project" | "chat" | undefined,
  configUpdating: boolean,
): boolean {
  return !configUpdating && targetKind === (view === "chats" ? "chat" : "project");
}

export function workspaceForView(
  view: "projects" | "chats",
  active: Pick<Thread, "kind" | "cwd"> | undefined,
  draft: DraftChat | undefined,
  fallback: string,
): string | undefined {
  if (active) return active.kind === "project" ? active.cwd : undefined;
  if (draft) return draft.kind === "project" ? draft.cwd : undefined;
  return view === "projects" ? fallback || undefined : undefined;
}

export function workspaceRequestMatches(requested: string, current: string | undefined): boolean {
  return Boolean(current && samePath(requested, current));
}

export function skillInstallDialogFromRequest(value: unknown): ({ kind: "install-skill" } & SkillInstallRequest) | undefined {
  if (!isRecordValue(value)
    || typeof value.cwd !== "string"
    || typeof value.source !== "string"
    || typeof value.name !== "string"
    || !value.name.trim()
    || !workspaceRelativePath(value.cwd, value.source)) return undefined;
  return { kind: "install-skill", cwd: value.cwd, source: value.source, name: value.name.trim() };
}

export function railForStandaloneChat(current: RailView | undefined): RailView | undefined {
  return current === "agents" ? current : undefined;
}

export function shouldAcknowledgeYolo(success: boolean, pendingTarget: string, currentTarget: string | undefined): boolean {
  return success && pendingTarget === currentTarget;
}

export function showSidebarUpdate(phase: UpdateStatus["phase"]): boolean {
  return phase === "available" || phase === "downloading" || phase === "installing";
}

export function isNearScrollBottom(
  metrics: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  threshold = 72,
): boolean {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function isAppMenuOpenKey(key: string): boolean {
  return key === "ArrowDown" || key === "Enter" || key === " ";
}

export function App() {
  const supervisor = useRef<ConnectionSupervisor | undefined>(undefined);
  const submitMode = useRef<"queue" | "steer">("queue");
  const serverRestarting = useRef(false);
  const automaticRestartTimer = useRef<number | undefined>(undefined);
  const pendingDomainEvents = useRef<StoredEvent[]>([]);
  const domainEventFrame = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const composerInput = useRef<HTMLTextAreaElement | null>(null);
  const composer = useRef<HTMLFormElement | null>(null);
  const composerTools = useRef<HTMLDivElement | null>(null);
  const timeline = useRef<HTMLDivElement | null>(null);
  const conversationStage = useRef<HTMLDivElement | null>(null);
  const timelinePinned = useRef(true);
  const terminalEnd = useRef<HTMLDivElement | null>(null);
  const menuBar = useRef<HTMLElement | null>(null);
  const menuTriggers = useRef<Partial<Record<AppMenu, HTMLButtonElement | null>>>({});
  const pendingUpdate = useRef<Update | undefined>(undefined);
  const updateInstallInFlight = useRef(false);
  const quotaRefreshInFlight = useRef(false);
  const configRequestId = useRef(0);
  const configUpdatesInFlight = useRef(0);
  const currentConfigTargetKey = useRef<string | undefined>(undefined);
  const initializedProjectDetails = useRef(new WeakSet<HTMLDetailsElement>());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [serverLookupAttempt, setServerLookupAttempt] = useState(0);
  const [serverLookupError, setServerLookupError] = useState<string>();
  const [preferences, setPreferences] = useState<Preferences>(loadPreferences);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [showOnboarding, setShowOnboarding] = useState(() => !loadPreferences().onboardingDone);
  const [cwd, setCwd] = useState(() => loadPreferences().workspace);
  const [kimiRuntimeReady, setKimiRuntimeReady] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [startupDelayed, setStartupDelayed] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [runtimeSessions, setRuntimeSessions] = useState<RuntimeSession[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string>();
  const [prompt, setPrompt] = useState("");
  const [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [auth, setAuth] = useState<AuthState>();
  const [providers, setProviders] = useState<ProviderState[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<string[]>([]);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [selectedFile, setSelectedFile] = useState<{ path: string; content: string }>();
  const [threadFilter, setThreadFilter] = useState("");
  const [navView, setNavView] = useState<"projects" | "chats">("projects");
  const [capabilityCenterOpen, setCapabilityCenterOpen] = useState(false);
  const [capabilityTab, setCapabilityTab] = useState<CapabilityTab>("skills");
  const [capabilities, setCapabilities] = useState<KimiCapabilities>();
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [railView, setRailView] = useState<RailView>();
  const [openMenu, setOpenMenu] = useState<AppMenu>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>("general");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [gitStatus, setGitStatus] = useState<GitStatus>();
  const [gitStatusCwd, setGitStatusCwd] = useState<string>();
  const [gitDiff, setGitDiff] = useState<{ path: string; diff: string }>();
  const [commitMessage, setCommitMessage] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const [quota, setQuota] = useState<KimiQuota>();
  const [quotaError, setQuotaError] = useState<string>();
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ phase: "idle" });
  const [updateNotice, setUpdateNotice] = useState<string>();
  const [updatePreparing, setUpdatePreparing] = useState(false);
  const [terminalSession, setTerminalSession] = useState<TerminalSessionInfo>();
  const [terminalEntries, setTerminalEntries] = useState<TerminalEntry[]>([]);
  const [terminalCommand, setTerminalCommand] = useState("");
  const [terminalHistory, setTerminalHistory] = useState<string[]>([]);
  const [terminalHistoryIndex, setTerminalHistoryIndex] = useState(-1);
  const [terminalStarting, setTerminalStarting] = useState(false);
  const [previewDraft, setPreviewDraft] = useState("http://localhost:3000");
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [previewRevision, setPreviewRevision] = useState(0);
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [itemMenu, setItemMenu] = useState<ItemMenu>();
  const [manageDialog, setManageDialog] = useState<ManageDialog>();
  const [draftChat, setDraftChat] = useState<DraftChat>();
  const [draftSending, setDraftSending] = useState(false);
  const [configDefaults, setConfigDefaults] = useState<ConfigOption[]>([]);
  const [draftConfig, setDraftConfig] = useState<Record<string, string>>({});
  const [configUpdating, setConfigUpdating] = useState<Record<string, ConfigUpdate>>({});
  const [yoloConfirm, setYoloConfirm] = useState<{ target: ConfigTarget; configId: string; value: string; busy: boolean }>();
  const [draggingProject, setDraggingProject] = useState<string>();
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [suggestionsDismissed, setSuggestionsDismissed] = useState(false);

  const activeThread = threads.find((thread) => thread.threadId === activeThreadId);
  const providerId = activeThread?.provider ?? preferences.provider;
  const providerState = providers.find((provider) => provider.id === providerId);
  const runtimeReady = providerId === "kimi" ? Boolean(auth?.authenticated && kimiRuntimeReady) : providerUsable(providerState);
  const promptTrigger = useMemo(() => composerTrigger(prompt), [prompt]);
  const composerProjectCwd = activeThread?.kind === "project" ? activeThread.cwd : draftChat?.kind === "project" ? draftChat.cwd : undefined;
  const fileSuggestionQuery = promptTrigger?.kind === "file" ? promptTrigger.query : undefined;
  const configTarget = activeThread
    ? { key: configTargetKey(activeThread, undefined)!, kind: "thread" as const, threadId: activeThread.threadId }
    : draftChat
      ? { key: configTargetKey(undefined, draftChat)!, kind: "draft" as const, draft: draftChat }
      : undefined;
  currentConfigTargetKey.current = configTarget?.key;
  const agentRuns = useMemo(() => subagentRuns(activeThread), [activeThread]);
  const composerOptions = useMemo(() => activeThread ? activeThread.configOptions : applyDraftConfig(configDefaults, draftConfig), [activeThread, configDefaults, draftConfig]);
  const workBlocksUpdate = hasBlockingWork(threads, draftSending);
  const updateBlocked = workBlocksUpdate || Object.keys(configUpdating).length > 0;
  const updateMutationsBlocked = updatePreparing || updateStatus.phase === "downloading" || updateStatus.phase === "installing";
  const configMutationPending = Object.keys(configUpdating).length > 0;
  const configBusyId = configTarget ? configUpdating[configTarget.key]?.configId : undefined;
  const composerTargetKind = activeThread?.kind ?? draftChat?.kind;
  const composerSubmitReady = runtimeReady && composerCanSubmit(navView, composerTargetKind, configMutationPending);
  const primaryComposerAction = composerPrimaryAction(Boolean(activeThread?.running), Boolean(prompt.trim()));
  const layoutSidebarWidth = preferences.sidebarCollapsed ? collapsedSidebarWidth : preferences.sidebarWidth;
  const renderedRailWidth = effectiveRailWidth(preferences.railWidth, viewportWidth, layoutSidebarWidth);
  const previewPanelMode = renderedRailWidth >= 1_080 ? "Wide" : renderedRailWidth >= 760 ? "Desktop" : "Compact";
  const setDiagnostic = useCallback((message: string) => setDiagnostics((current) => [...current, presentDiagnostic(message)].slice(-50)), []);
  const initializeProjectDetails = useCallback((element: HTMLDetailsElement | null) => {
    if (!element || initializedProjectDetails.current.has(element)) return;
    initializedProjectDetails.current.add(element);
    element.open = true;
  }, []);
  const openExternalLink = useCallback(async (url: string) => {
    try {
      await openExternal(url);
    } catch (error) {
      setDiagnostic(`Could not open link: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setDiagnostic]);
  const revealLocalPath = useCallback(async (path: string) => {
    try {
      await revealPath(path);
    } catch (error) {
      setDiagnostic(`Could not reveal path: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setDiagnostic]);
  const openRuntimeLog = useCallback(async () => {
    try {
      const path = await invoke<string>("app_log_path");
      await revealPath(path);
    } catch (error) {
      setDiagnostic(`Could not open runtime log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setDiagnostic]);
  const jumpToLatest = useCallback(() => {
    const target = timeline.current;
    if (!target) return;
    target.scrollTop = target.scrollHeight;
    timelinePinned.current = true;
    setShowJumpToLatest(false);
  }, []);
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
    const resize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

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

  useLayoutEffect(() => {
    timelinePinned.current = true;
    setShowJumpToLatest(false);
    const frame = window.requestAnimationFrame(jumpToLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [activeThreadId, jumpToLatest]);

  useLayoutEffect(() => {
    if (!timelinePinned.current) return;
    const frame = window.requestAnimationFrame(jumpToLatest);
    return () => window.cancelAnimationFrame(frame);
  }, [activeThread?.queue.length, activeThread?.updatedAt, draftSending, jumpToLatest]);

  useLayoutEffect(() => {
    const scrollTarget = timeline.current;
    if (!scrollTarget || typeof ResizeObserver === "undefined") return;
    let frame: number | undefined;
    const keepLatestVisible = () => {
      if (!timelinePinned.current) return;
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        if (timelinePinned.current) jumpToLatest();
      });
    };
    const observer = new ResizeObserver(keepLatestVisible);
    observer.observe(scrollTarget);
    if (conversationStage.current) observer.observe(conversationStage.current);
    if (composer.current) observer.observe(composer.current);
    return () => {
      observer.disconnect();
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [activeThreadId, activeThread?.turns.length, bootstrapping, capabilityCenterOpen, jumpToLatest, showOnboarding]);

  useEffect(() => { if (!updateBlocked) setUpdateNotice(undefined); }, [updateBlocked]);
  useLayoutEffect(() => {
    if (!openMenu) return;
    const frame = window.requestAnimationFrame(() => {
      menuBar.current?.querySelector<HTMLElement>(".app-menu.open [role=\"menuitem\"]:not([disabled])")?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [openMenu]);

  useEffect(() => {
    if (!openMenu) return;
    const closeMenu = (event: PointerEvent) => {
      if (!menuBar.current?.contains(event.target as Node)) setOpenMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const trigger = menuTriggers.current[openMenu];
      setOpenMenu(undefined);
      window.requestAnimationFrame(() => trigger?.focus());
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
    setYoloConfirm((pending) => pending && pending.target.key !== configTarget?.key ? undefined : pending);
  }, [configTarget?.key]);

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
  const refreshProviders = useCallback(async () => {
    const result = await call("providers.list") as { providers: ProviderState[] };
    setProviders(result.providers.map((provider) => ({ ...provider, id: normalizeProvider(provider.id ?? provider.provider), provider: normalizeProvider(provider.provider ?? provider.id) })));
  }, [call]);
  const recoverLocalServer = useCallback(async (force = false) => {
    if (serverRestarting.current) return;
    serverRestarting.current = true;
    const hasClient = Boolean(supervisor.current);
    try {
      const restarted = await invoke<boolean>("recover_server", { force });
      if (restarted && hasClient) {
        supervisor.current?.retry();
        setStartupDelayed(false);
      }
    } catch (error) {
      setDiagnostic(`Local runtime recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!hasClient) {
        setServerLookupError(undefined);
        setServerLookupAttempt((current) => current + 1);
      }
      serverRestarting.current = false;
    }
  }, [setDiagnostic]);
  const workspaceCwd = workspaceForView(navView, activeThread, draftChat, cwd);
  const currentWorkspaceCwd = useRef<string | undefined>(workspaceCwd);
  currentWorkspaceCwd.current = workspaceCwd;
  const capabilityCwd = activeThread
    ? activeThread.kind === "project" ? activeThread.cwd : undefined
    : draftChat
      ? draftChat.kind === "project" ? draftChat.cwd : undefined
      : navView === "projects" ? cwd : undefined;

  useEffect(() => {
    if (activeThread?.kind === "chat" && railView && railView !== "agents") setRailView("agents");
  }, [activeThread?.kind, railView]);

  useEffect(() => {
    setGitStatus(undefined);
    setGitStatusCwd(undefined);
    setGitDiff(undefined);
    setCommitMessage("");
    setGitBusy(false);
  }, [workspaceCwd]);

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
      setCapabilities(await call("capabilities.list", capabilityCwd ? { cwd: capabilityCwd } : {}) as KimiCapabilities);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      setCapabilitiesLoading(false);
    }
  }, [call, capabilityCwd, setDiagnostic]);

  useEffect(() => {
    if (connection === "connected") void refreshCapabilities();
  }, [connection, refreshCapabilities]);

  useEffect(() => {
    if (connection === "connected") void refreshProviders().catch((error: Error) => setDiagnostic(error.message));
  }, [connection, refreshProviders, setDiagnostic]);

  const refreshGit = useCallback(async () => {
    if (!workspaceCwd) return;
    const requestedCwd = workspaceCwd;
    setGitBusy(true);
    try {
      const status = await call("git.status", { cwd: requestedCwd }) as GitStatus;
      if (!workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) return;
      setGitStatus(status);
      setGitStatusCwd(requestedCwd);
    } catch (error) {
      if (!workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) return;
      setGitStatus(undefined);
      setGitStatusCwd(undefined);
      setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) setGitBusy(false);
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
    setServerLookupError(undefined);
    setStartupDelayed(false);
    void localServerUrl().then((url) => {
      if (disposed) return;
      client = new ConnectionSupervisor(url, setConnection, handleMessage);
      supervisor.current = client;
      client.start();
    }).catch((error: unknown) => {
      if (disposed) return;
      const message = error instanceof Error ? error.message : String(error);
      setServerLookupError(message);
      setStartupDelayed(true);
      setConnection("error");
    });
    return () => {
      disposed = true;
      client?.close();
      if (supervisor.current === client) supervisor.current = undefined;
      if (automaticRestartTimer.current !== undefined) window.clearTimeout(automaticRestartTimer.current);
      if (domainEventFrame.current !== undefined) window.cancelAnimationFrame(domainEventFrame.current);
    };

    function handleMessage(message: ServerMessage) {
      if (message.channel === "server.welcome") {
        const payload = message.payload as { defaultCwd?: string; threads?: Thread[] };
        if (payload.defaultCwd) setCwd((value) => value || payload.defaultCwd!);
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
      } else if (message.channel === "skill.installRequested") {
        const dialog = skillInstallDialogFromRequest(message.payload);
        if (dialog) setManageDialog(dialog);
      } else if (message.channel === "server.diagnostics") {
        setDiagnostic(String((message.payload as { message?: string }).message ?? "Runtime error"));
      } else if (message.channel === "auth.status") {
        const status = message.payload as AuthState;
        setAuth(status);
        if (status.event?.message) setDiagnostic(status.event.message);
        if (status.event?.type === "complete" && status.event.operation === "logout") {
          setKimiRuntimeReady(false);
          setQuota(undefined);
          return;
        }
        if (status.authenticated && status.event?.type === "complete") {
          void call("env.bootstrap").then((result) => {
            const environment = result as { initialize?: unknown; runtimeError?: string };
            setKimiRuntimeReady(Boolean(environment.initialize));
            if (environment.runtimeError) setDiagnostic(`Kimi runtime unavailable: ${environment.runtimeError}`);
          }).catch((error: Error) => setDiagnostic(error.message));
        }
        void refreshProviders().catch(() => undefined);
      } else if (message.channel === "provider.authStatus") {
        const status = message.payload as ProviderState & { event?: AuthState["event"] };
        setProviders((current) => current.map((provider) => provider.id === status.provider ? { ...provider, ...status, id: status.provider } : provider));
        if (status.event?.message) setDiagnostic(status.event.message);
      } else if (message.channel === "terminal.output") {
        const event = message.payload as TerminalEvent;
        const text = event.type === "exit" ? `Process exited${event.code == null ? "" : ` with code ${event.code}`}\n` : cleanTerminalOutput(event.text ?? "");
        if (text) setTerminalEntries((current) => [...current, terminalEntry(event.type === "exit" ? "system" : event.type, text)].slice(-1_000));
        if (event.type === "exit") setTerminalSession((current) => current?.sessionId === event.sessionId ? undefined : current);
      }
    }
  }, [refreshProviders, serverLookupAttempt]);

  useEffect(() => {
    if (connection === "connected") {
      if (automaticRestartTimer.current !== undefined) window.clearTimeout(automaticRestartTimer.current);
      automaticRestartTimer.current = undefined;
      setStartupDelayed(false);
      return;
    }
    if (connection === "offline" && automaticRestartTimer.current !== undefined) {
      window.clearTimeout(automaticRestartTimer.current);
      automaticRestartTimer.current = undefined;
    }
    if (!bootstrapping) return;
    const timer = window.setTimeout(() => setStartupDelayed(true), 12_000);
    return () => window.clearTimeout(timer);
  }, [bootstrapping, connection]);

  useEffect(() => {
    if (!shouldScheduleRuntimeRecovery(connection, automaticRestartTimer.current !== undefined)) return;
    automaticRestartTimer.current = window.setTimeout(() => {
      automaticRestartTimer.current = undefined;
      void recoverLocalServer(false);
    }, 12_000);
  }, [connection, recoverLocalServer]);

  useEffect(() => {
    if (connection !== "connected") return;
    setBootstrapping(true);
    void call("env.bootstrap").then((result) => {
      const environment = result as { initialize?: unknown; auth: AuthState; runtimeError?: string };
      setAuth(environment.auth);
      setKimiRuntimeReady(Boolean(environment.initialize));
      if (environment.runtimeError) setDiagnostic(`Kimi runtime unavailable: ${environment.runtimeError}`);
      if (environment.auth.authenticated) void refreshQuota();
      return call("threads.list", { provider: preferences.provider });
    }).then((result) => {
      const listed = result as { threads: Thread[]; runtimeSessions: RuntimeSession[] };
      const incoming = listed.threads.map(normalizeThread);
      setThreads(incoming);
      setRuntimeSessions(listed.runtimeSessions);
      setActiveThreadId((current) => current ?? incoming[0]?.threadId);
    }).catch((error: Error) => setDiagnostic(error.message)).finally(() => setBootstrapping(false));
  }, [call, connection, preferences.provider, refreshQuota]);

  useEffect(() => {
    if (providerId !== "kimi" || connection !== "connected" || bootstrapping || runtimeReady || !auth?.authenticated) return;
    const timer = window.setInterval(() => {
      void call("env.bootstrap").then((result) => {
        if ((result as { initialize?: unknown }).initialize) setKimiRuntimeReady(true);
      }).catch(() => undefined);
    }, 12_000);
    return () => window.clearInterval(timer);
  }, [auth?.authenticated, bootstrapping, call, connection, providerId, runtimeReady]);

  useEffect(() => {
    if (fileSuggestionQuery === undefined || !composerProjectCwd) {
      setFileSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void call("files.tree", { cwd: composerProjectCwd, query: fileSuggestionQuery })
        .then((result) => { if (!cancelled) setFileSuggestions((result as { files: string[] }).files.slice(0, 8)); })
        .catch(() => { if (!cancelled) setFileSuggestions([]); });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [call, composerProjectCwd, fileSuggestionQuery]);

  useEffect(() => {
    setConfigDefaults([]);
    setDraftConfig({});
  }, [providerId]);

  useEffect(() => {
    if (!runtimeReady || configDefaults.length) return;
    let cancelled = false;
    void call("runtime.configDefaults", { provider: providerId }).then((result) => {
      if (cancelled) return;
      const options = (result as { configOptions?: unknown }).configOptions;
      if (Array.isArray(options)) setConfigDefaults(options as ConfigOption[]);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [call, configDefaults.length, providerId, runtimeReady]);

  useEffect(() => {
    if (!draftChat || activeThread) return;
    setDraftConfig(draftConfigOverrides(configDefaults, preferences.composerConfig));
  }, [activeThread, configDefaults, draftChat, preferences.composerConfig]);

  useEffect(() => {
    if (!runtimeReady || !activeThread || activeThread.running) return;
    let cancelled = false;
    void call("threads.resume", { threadId: activeThread.threadId, sessionId: activeThread.sessionId, cwd: activeThread.cwd, provider: activeThread.provider, replay: false })
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

  function selectProvider(provider: ProviderId) {
    if (activeThread || provider === preferences.provider) return;
    setPreferences((current) => ({ ...current, provider }));
    setDiagnostics([]);
  }

  function clearProjectPanels() {
    setRailView(railForStandaloneChat);
    setSelectedFile(undefined);
    setGitStatus(undefined);
    setGitStatusCwd(undefined);
    setGitDiff(undefined);
    setCommitMessage("");
    setGitBusy(false);
    setPreviewUrl(undefined);
    setPreviewDraft("http://localhost:3000");
    setTerminalEntries([]);
    setTerminalCommand("");
    setTerminalStarting(false);
    if (terminalSession) {
      void call("terminal.stop", { sessionId: terminalSession.sessionId }).catch((error: Error) => setDiagnostic(error.message));
      setTerminalSession(undefined);
    }
  }

  function createStandaloneChat() {
    clearProjectPanels();
    setNavView("chats");
    setCapabilityCenterOpen(false);
    setActiveThreadId(undefined);
    setDraftChat({ kind: "chat" });
    setDiagnostics([]);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function changeNavView(next: "projects" | "chats") {
    if (next === "chats") clearProjectPanels();
    setCapabilityCenterOpen(false);
    setNavView(next);
    if (activeThread && !composerCanSubmit(next, activeThread.kind, false)) setActiveThreadId(undefined);
    if (draftChat && !composerCanSubmit(next, draftChat.kind, false)) setDraftChat(undefined);
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
    if (thread.kind === "chat") clearProjectPanels();
    setCapabilityCenterOpen(false);
    setDraftChat(undefined);
    setActiveThreadId(thread.threadId);
    setPreferences((current) => current.provider === thread.provider ? current : { ...current, provider: thread.provider });
    setNavView(thread.kind === "chat" ? "chats" : "projects");
  }

  async function resumeSession(session: RuntimeSession): Promise<Thread | undefined> {
    try {
      if (session.kind !== "chat") {
        setCwd(session.cwd);
        rememberWorkspace(session.cwd);
      }
      const result = await call("threads.resume", { threadId: session.sessionId, sessionId: session.sessionId, cwd: session.cwd, provider: preferences.provider, replay: false }) as { thread: Thread };
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
    const requestedMode = submitMode.current;
    submitMode.current = "queue";
    const text = prompt.trim();
    if (!runtimeReady || !text || !composerCanSubmit(navView, activeThread?.kind ?? draftChat?.kind, configUpdatesInFlight.current > 0) || draftSending || updateMutationsBlocked) return;
    const harness = parseHarnessCommand(text);
    if (harness?.name === "goal" && !harness.objective) {
      setPrompt("/goal ");
      setDiagnostic("Add the objective after /goal, or use /goal clear.");
      return;
    }
    if (harness?.name === "side" && !activeThread) {
      setDiagnostic("Open a chat before creating a side chat.");
      return;
    }
    const mentions = [...text.matchAll(/@\{([^}]+)\}/g)].map((match) => match[1]!);
    const mode = activeThread?.running ? requestedMode : "queue";
    timelinePinned.current = true;
    setShowJumpToLatest(false);
    setPrompt("");
    setFileSuggestions([]);
    setComposerMenuOpen(false);
    const attachedImages = images;
    setImages([]);
    setDraftSending(Boolean(draftChat));
    try {
      const created = activeThread ? undefined : await call("threads.create", {
        ...(draftChat?.kind === "chat" ? { standalone: true } : { cwd: draftChat?.cwd }),
        provider: preferences.provider,
        ...(Object.keys(draftConfig).length ? { config: draftConfig } : {}),
      }) as { thread: Thread };
      const thread = activeThread ?? normalizeThread(created!.thread);
      if (draftChat) {
        setDraftChat(undefined);
        setActiveThreadId(thread.threadId);
      }
      if (harness?.name === "goal") {
        const result = await call(harness.clear ? "threads.clearGoal" : "threads.setGoal", harness.clear
          ? { threadId: thread.threadId }
          : { threadId: thread.threadId, objective: harness.objective }) as { thread: Thread };
        const updated = normalizeThread(result.thread);
        setThreads((current) => [updated, ...current.filter((item) => item.threadId !== updated.threadId)]);
        return;
      }
      if (harness?.name === "side") {
        const result = await call("threads.createSide", { threadId: thread.threadId, ...(harness.title ? { title: harness.title } : {}) }) as { thread: Thread };
        const side = normalizeThread(result.thread);
        setThreads((current) => [side, ...current.filter((item) => item.threadId !== side.threadId)]);
        selectThread(side);
        return;
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

  async function createSideThread(title?: string) {
    if (!activeThread) return;
    try {
      const result = await call("threads.createSide", { threadId: activeThread.threadId, ...(title?.trim() ? { title: title.trim() } : {}) }) as { thread: Thread };
      const side = normalizeThread(result.thread);
      setThreads((current) => [side, ...current.filter((item) => item.threadId !== side.threadId)]);
      selectThread(side);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function clearGoal(threadId: string) {
    try {
      const result = await call("threads.clearGoal", { threadId }) as { thread: Thread };
      const updated = normalizeThread(result.thread);
      setThreads((current) => current.map((item) => item.threadId === threadId ? updated : item));
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function editTurnPrompt(text: string) {
    if (activeThread?.running) {
      try {
        await call("threads.interruptTurn", { threadId: activeThread.threadId, clearQueue: true });
      } catch (error) {
        setDiagnostic(error instanceof Error ? error.message : String(error));
      }
    }
    setPrompt(text);
    window.setTimeout(() => composerInput.current?.focus(), 0);
  }

  function removeQueuedPrompt(threadId: string, queuedId: string) {
    void call("threads.removeQueuedTurn", { threadId, queuedId }).catch((error: Error) => setDiagnostic(error.message));
  }

  function updateQueuedPrompt(threadId: string, queuedId: string, text: string) {
    void call("threads.updateQueuedTurn", { threadId, queuedId, text }).catch((error: Error) => setDiagnostic(error.message));
  }

  function steerQueuedPrompt(threadId: string, queuedId: string) {
    if (configUpdatesInFlight.current > 0) return;
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
      } else if (dialog.kind === "install-skill") {
        const installed = await call("skills.install", { cwd: dialog.cwd, source: dialog.source }) as { skill?: { name?: string }; restartRequired?: boolean };
        await refreshCapabilities();
        setDiagnostic(`Installed ${installed.skill?.name ?? dialog.name}. Start a new chat to load the skill.`);
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

  async function setConfig(configId: string, value: string, target = configTarget): Promise<boolean> {
    if (!target || target.key !== currentConfigTargetKey.current || updateMutationsBlocked || configUpdatesInFlight.current > 0) return false;
    if (target.kind === "thread") {
      const threadId = target.threadId;
      const update = { targetKey: target.key, configId, requestId: ++configRequestId.current };
      configUpdatesInFlight.current += 1;
      setConfigUpdating((current) => ({ ...current, [target.key]: update }));
      try {
        const result = await call("threads.setConfigOption", { threadId, configId, value }) as { configOptions?: ConfigOption[] };
        if (result.configOptions) {
          setThreads((current) => current.map((thread) => thread.threadId === threadId ? { ...thread, configOptions: result.configOptions! } : thread));
        }
        setPreferences((current) => ({ ...current, composerConfig: { ...current.composerConfig, [configId]: value } }));
        return true;
      } catch (error) {
        setDiagnostic(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        configUpdatesInFlight.current = Math.max(0, configUpdatesInFlight.current - 1);
        setConfigUpdating((current) => {
          if (current[target.key]?.requestId !== update.requestId) return current;
          const next = { ...current };
          delete next[target.key];
          return next;
        });
      }
    } else {
      setPreferences((current) => ({ ...current, composerConfig: { ...current.composerConfig, [configId]: value } }));
      setDraftConfig((current) => {
        const option = configDefaults.find((candidate) => candidate.id === configId);
        const next = { ...current };
        if (option && String(option.currentValue) === value) delete next[configId];
        else next[configId] = value;
        return next;
      });
      return true;
    }
  }

  function changeConfig(configId: string, value: string) {
    if (!configTarget || updateMutationsBlocked || configUpdatesInFlight.current > 0) return;
    const option = composerOptions.find((candidate) => candidate.id === configId);
    if (isYoloChoice(option, value) && !preferences.yoloAcknowledged) {
      setYoloConfirm({ target: configTarget, configId, value, busy: false });
      return;
    }
    void setConfig(configId, value, configTarget);
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

  function insertSkill(skill: KimiSkill) {
    setPrompt((value) => replaceComposerTrigger(value, skillComposerInsertion(skill.name, runtimeCommands ?? [])));
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
      await revealLocalPath(path);
    }
  }

  async function chooseSkillToInstall(kind: "folder" | "file" = "folder") {
    if (!capabilityProjectCwd) {
      setDiagnostic("Open a project before installing a local skill.");
      return;
    }
    setComposerMenuOpen(false);
    try {
      if (!isTauri()) throw new Error("Local skill installation is available in the desktop app");
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: kind === "folder",
        multiple: false,
        defaultPath: capabilityProjectCwd,
        title: `Choose a skill ${kind} from this project`,
        ...(kind === "file" ? { filters: [{ name: "Markdown skill", extensions: ["md"] }] } : {}),
      });
      if (typeof selected !== "string") return;
      if (!workspaceRelativePath(capabilityProjectCwd, selected)) {
        throw new Error("Choose a skill folder inside the active project");
      }
      const selectedName = selected.split(/[\\/]/).filter(Boolean).at(-1) ?? "local skill";
      const name = kind === "file" ? selectedName.replace(/\.md$/i, "") : selectedName;
      setManageDialog({ kind: "install-skill", cwd: capabilityProjectCwd, source: selected, name });
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function openGitDiff(path: string, targetCwd = workspaceCwd) {
    if (!targetCwd || !gitStatusCwd || !workspaceRequestMatches(targetCwd, gitStatusCwd)) return;
    try {
      const diff = await call("git.diff", { cwd: targetCwd, path }) as { path: string; diff: string };
      if (workspaceRequestMatches(targetCwd, currentWorkspaceCwd.current)) setGitDiff(diff);
    } catch (error) {
      if (workspaceRequestMatches(targetCwd, currentWorkspaceCwd.current)) setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function changeGitStage(file: GitFile) {
    if (!workspaceCwd || !gitStatusCwd || !workspaceRequestMatches(workspaceCwd, gitStatusCwd)) return;
    const requestedCwd = workspaceCwd;
    setGitBusy(true);
    try {
      const method = file.staged ? "git.unstage" : "git.stage";
      const status = await call(method, { cwd: requestedCwd, paths: [file.path] }) as GitStatus;
      if (!workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) return;
      setGitStatus(status);
      setGitStatusCwd(requestedCwd);
      if (gitDiff?.path === file.path) await openGitDiff(file.path, requestedCwd);
    } catch (error) {
      if (workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) setGitBusy(false);
    }
  }

  async function commitGit() {
    if (!workspaceCwd || !gitStatusCwd || !workspaceRequestMatches(workspaceCwd, gitStatusCwd) || !commitMessage.trim()) return;
    const requestedCwd = workspaceCwd;
    const message = commitMessage.trim();
    setGitBusy(true);
    try {
      const result = await call("git.commit", { cwd: requestedCwd, message }) as { commit: string; status: GitStatus };
      if (!workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) return;
      setGitStatus(result.status);
      setGitStatusCwd(requestedCwd);
      setGitDiff(undefined);
      setCommitMessage("");
      setDiagnostic(`Committed ${result.commit}`);
    } catch (error) {
      if (workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) setDiagnostic(error instanceof Error ? error.message : String(error));
    } finally {
      if (workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) setGitBusy(false);
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
      setPreferences((current) => ({
        ...current,
        sidebarCollapsed: current.sidebarCollapsed || command.panelWidth! >= 760,
        railWidth: clampPanelWidth("rail", command.panelWidth!),
      }));
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

  async function beginLogin(provider: ProviderId = preferences.provider) {
    try {
      if (provider === "kimi") {
        setAuth((current) => current ? { ...current, loginRunning: true } : current);
        setAuth(await call("auth.beginLogin", { provider }) as AuthState);
      } else {
        const status = await call("auth.beginLogin", { provider }) as ProviderState;
        setProviders((current) => current.map((item) => item.id === provider ? { ...item, ...status, id: provider } : item));
      }
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function installCli(provider: ProviderId = preferences.provider) {
    try {
      if (provider === "kimi") {
        const status = await call("env.installCli") as AuthState;
        setAuth(status);
        await openExternalLink(status.installUrl);
      } else {
        const target = providers.find((item) => item.id === provider)?.installUrl;
        if (!target) throw new Error("Provider install guide is unavailable");
        await openExternalLink(target);
      }
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function logout(provider: ProviderId = preferences.provider) {
    try {
      if (provider === "kimi") {
        setAuth(await call("auth.logout", { provider }) as AuthState);
        setKimiRuntimeReady(false);
        setQuota(undefined);
      } else {
        const status = await call("auth.logout", { provider }) as ProviderState;
        setProviders((current) => current.map((item) => item.id === provider ? { ...item, ...status, id: provider } : item));
      }
      setSettingsCategory("account");
      setSettingsOpen(true);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : String(error));
    }
  }

  async function installUpdate() {
    const update = pendingUpdate.current;
    if (!update || updateInstallInFlight.current) return;
    if (updateBlocked) {
      setUpdateNotice("Finish or stop active work before updating.");
      return;
    }
    updateInstallInFlight.current = true;
    setUpdatePreparing(true);
    setUpdateNotice(undefined);
    let downloaded = 0;
    let total: number | undefined;
    let prepared = false;
    let nativeStopAttempted = false;
    const currentVersion = updateStatus.currentVersion;
    try {
      await call("env.prepareUpdate");
      prepared = true;
      setUpdateStatus({ phase: "downloading", version: update.version, ...(currentVersion ? { currentVersion } : {}), percent: 0 });
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (event.event !== "Finished") {
          const percent = updatePercent(downloaded, total);
          setUpdateStatus({ phase: "downloading", version: update.version, ...(currentVersion ? { currentVersion } : {}), ...(percent === undefined ? {} : { percent }) });
        }
      });
      await call("env.confirmUpdate");
      setUpdateStatus({ phase: "installing", version: update.version, ...(currentVersion ? { currentVersion } : {}), percent: 100 });
      nativeStopAttempted = true;
      await invoke<boolean>("stop_server_for_update");
      await update.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      if (nativeStopAttempted) {
        try {
          const restarted = await invoke<boolean>("recover_server", { force: false });
          if (restarted) supervisor.current?.retry();
          else if (prepared) await call("env.cancelUpdate");
        } catch (recoveryError) {
          setDiagnostic(`Could not resume work after the update failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`);
        }
      } else if (prepared) {
        try {
          await call("env.cancelUpdate");
        } catch (cancelError) {
          setDiagnostic(`Could not resume work after the update failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`);
        }
      }
      setUpdateStatus({ phase: "error", version: update.version, message: error instanceof Error ? error.message : String(error) });
    } finally {
      setUpdatePreparing(false);
      updateInstallInFlight.current = false;
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
    const startWidth = panel === "sidebar" ? preferences.sidebarWidth : renderedRailWidth;
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
      : { ...current, railWidth: clampPanelWidth(panel, effectiveRailWidth(current.railWidth, viewportWidth, current.sidebarCollapsed ? collapsedSidebarWidth : current.sidebarWidth) + direction * 12) });
  }

  function cyclePreviewWidth() {
    setPreferences((current) => {
      const currentWidth = effectiveRailWidth(current.railWidth, viewportWidth, current.sidebarCollapsed ? collapsedSidebarWidth : current.sidebarWidth);
      const widths = [...new Set([420, 960, 1_200].map((width) => effectiveRailWidth(width, viewportWidth, collapsedSidebarWidth)))];
      return { ...current, sidebarCollapsed: true, railWidth: widths.find((width) => width > currentWidth) ?? widths[0]! };
    });
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
  const commandSuggestions = useMemo(() => {
    if (promptTrigger?.kind !== "command") return [];
    const query = promptTrigger.query.toLowerCase();
    return commandCatalog
      .filter((command) => !query || command.name.toLowerCase().includes(query) || command.description.toLowerCase().includes(query))
      .slice(0, 10);
  }, [commandCatalog, promptTrigger]);
  const skillSuggestions = useMemo(() => promptTrigger?.kind === "skill"
    ? filterKimiSkills(capabilities?.skills ?? [], promptTrigger.query)
    : [], [capabilities?.skills, promptTrigger]);
  const visibleFileSuggestions = promptTrigger?.kind === "file" ? fileSuggestions : [];
  const suggestionCount = commandSuggestions.length + skillSuggestions.length + visibleFileSuggestions.length;
  const suggestionsOpen = suggestionCount > 0 && !suggestionsDismissed;
  const activeSuggestionIndex = Math.min(suggestionIndex, Math.max(0, suggestionCount - 1));
  const activeSuggestionId = suggestionsOpen ? `composer-suggestion-${activeSuggestionIndex}` : undefined;
  const suggestionQueryKey = promptTrigger ? `${promptTrigger.prefix}:${promptTrigger.query}` : "";
  const sidebarIconOnly = preferences.sidebarCollapsed || preferences.sidebarWidth < 168;
  const workspaceTools = activeThread ? activeThread.kind === "project" : draftChat ? draftChat.kind === "project" : navView === "projects" && Boolean(cwd);
  const railAvailable = Boolean(activeThread) || workspaceTools;
  const capabilityProjectCwd = capabilityCwd;
  const quotaLeft = quotaPercent(quota);
  const context = activeThread?.usage?.context;
  const contextUsed = contextPercent(activeThread?.usage);
  const shellStyle = {
    "--sidebar-current-width": `${layoutSidebarWidth}px`,
    "--rail-current-width": `${renderedRailWidth}px`,
  } as CSSProperties;
  const railResizeHandle = railView ? <div className="panel-resizer rail-resizer" role="separator" aria-label="Resize side panel" aria-orientation="vertical" aria-valuemin={Math.min(260, effectiveRailWidth(1_200, viewportWidth, layoutSidebarWidth))} aria-valuemax={effectiveRailWidth(1_200, viewportWidth, layoutSidebarWidth)} aria-valuenow={renderedRailWidth} tabIndex={0} onPointerDown={(event) => beginPanelResize("rail", event)} onKeyDown={(event) => resizePanelWithKeyboard("rail", event)} /> : null;
  const railTabs = railView ? <RailTabs current={railView} workspace={workspaceTools} activeAgents={agentRuns.filter((run) => run.status === "running").length} onSelect={setRailView} onClose={() => setRailView(undefined)} /> : null;

  useEffect(() => {
    setSuggestionIndex(0);
    setSuggestionsDismissed(false);
  }, [suggestionQueryKey]);

  useEffect(() => {
    if (!activeSuggestionId) return;
    document.getElementById(activeSuggestionId)?.scrollIntoView({ block: "nearest" });
  }, [activeSuggestionId]);

  function chooseComposerSuggestion(index: number) {
    if (promptTrigger?.kind === "command") {
      const command = commandSuggestions[index];
      if (command) insertCommand(command);
      return;
    }
    if (promptTrigger?.kind === "skill") {
      const skill = skillSuggestions[index];
      if (skill) insertSkill(skill);
      return;
    }
    const file = visibleFileSuggestions[index];
    if (file) insertMention(file);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (suggestionsOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const key = event.key === "ArrowDown" ? "ArrowDown" : "ArrowUp";
        setSuggestionIndex((current) => moveSuggestionIndex(current, suggestionCount, key));
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSuggestionsDismissed(true);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        chooseComposerSuggestion(activeSuggestionIndex);
        return;
      }
    }
    const mode = promptShortcutMode(event, preferences.sendKey, Boolean(activeThread?.running));
    if (mode) {
      submitMode.current = mode;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function handleAppMenuTriggerKeyDown(menu: AppMenu, event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!isAppMenuOpenKey(event.key)) return;
    event.preventDefault();
    if (openMenu === menu) {
      menuBar.current?.querySelector<HTMLElement>(".app-menu.open [role=\"menuitem\"]:not([disabled])")?.focus();
      return;
    }
    setOpenMenu(menu);
  }

  return (
    <main style={shellStyle} className={`shell ${railView ? "rail-open" : ""} ${preferences.sidebarCollapsed ? "sidebar-collapsed" : ""} ${sidebarIconOnly ? "sidebar-icon-only" : ""} sidebar-${preferences.sidebarSide} rail-${preferences.railSide} density-${preferences.density}`}>
      <header className="app-titlebar">
        <div className="titlebar-logo" title="Kimi Code"><img src="/kimi-logo.png" alt="" aria-hidden="true" /></div>
        <nav ref={menuBar} className="menu-bar" aria-label="Application menu">
          <div className={`app-menu ${openMenu === "file" ? "open" : ""}`} onPointerEnter={() => { if (openMenu) setOpenMenu("file"); }}>
            <button ref={(element) => { menuTriggers.current.file = element; }} className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "file"} onClick={() => setOpenMenu((current) => current === "file" ? undefined : "file")} onKeyDown={(event) => handleAppMenuTriggerKeyDown("file", event)}>File</button>
            {openMenu === "file" && <div className="menu-popover" role="menu" onKeyDown={moveMenuFocus}>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void createAppWindow(); }}><span>New Window</span><kbd>Ctrl Shift N</kbd></button>
              <button type="button" role="menuitem" disabled={!runtimeReady || (navView === "projects" && !cwd)} onClick={() => { setOpenMenu(undefined); navView === "chats" ? createStandaloneChat() : createThread(cwd); }}><span>New Chat</span><kbd>Ctrl N</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void chooseWorkspace(); }}><span>Open Folder…</span><kbd>Ctrl O</kbd></button>
              <span className="menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void runWindowAction("close"); }}><span>Close Window</span><kbd>Ctrl W</kbd></button>
              <button type="button" role="menuitem" disabled={!providerState?.installed} onClick={() => { setOpenMenu(undefined); void logout(providerId); }}>Log Out of {providerName(providerId)}</button>
              <button type="button" role="menuitem" onClick={() => { setOpenMenu(undefined); void exitApp(); }}>Exit</button>
            </div>}
          </div>
          <div className={`app-menu ${openMenu === "edit" ? "open" : ""}`} onPointerEnter={() => { if (openMenu) setOpenMenu("edit"); }}>
            <button ref={(element) => { menuTriggers.current.edit = element; }} className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "edit"} onPointerDown={(event) => event.preventDefault()} onClick={() => setOpenMenu((current) => current === "edit" ? undefined : "edit")} onKeyDown={(event) => handleAppMenuTriggerKeyDown("edit", event)}>Edit</button>
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
            <button ref={(element) => { menuTriggers.current.view = element; }} className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "view"} onClick={() => setOpenMenu((current) => current === "view" ? undefined : "view")} onKeyDown={(event) => handleAppMenuTriggerKeyDown("view", event)}>View</button>
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
            <button ref={(element) => { menuTriggers.current.help = element; }} className="menu-trigger" type="button" aria-haspopup="menu" aria-expanded={openMenu === "help"} onClick={() => setOpenMenu((current) => current === "help" ? undefined : "help")} onKeyDown={(event) => handleAppMenuTriggerKeyDown("help", event)}>Help</button>
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
            <button className={!capabilityCenterOpen && navView === "projects" ? "active" : ""} type="button" aria-current={!capabilityCenterOpen && navView === "projects" ? "page" : undefined} title="Projects" onClick={() => changeNavView("projects")}><FolderSimple /><span>Projects</span></button>
            <button className={!capabilityCenterOpen && navView === "chats" ? "active" : ""} type="button" aria-current={!capabilityCenterOpen && navView === "chats" ? "page" : undefined} title="Chats" onClick={() => changeNavView("chats")}><ChatCircleDots /><span>Chats</span></button>
          </nav>
          <button className="toolbar-icon" type="button" aria-label="Search projects and chats" title="Search (Ctrl+K)" onClick={() => setSearchOpen(true)}><MagnifyingGlass /></button>
        </div>

        <button className={`capability-link ${capabilityCenterOpen ? "active" : ""}`} type="button" aria-current={capabilityCenterOpen ? "page" : undefined} title="Skills, MCP, plugins, and subagents" onClick={() => { setRailView(undefined); setCapabilityCenterOpen(true); void refreshCapabilities(); }}><PlugsConnected /><span><strong>Capabilities</strong><small>{capabilities ? `${capabilities.skills.length} skills · ${capabilities.mcpServers.length} MCP` : "Skills, MCP, agents"}</small></span><CaretRight /></button>

        <div className="sidebar-body">
          <div className="sidebar-heading"><span>{navView === "projects" ? "Projects" : "Chats"}</span><button type="button" title={navView === "projects" ? "Open folder" : "New chat"} aria-label={navView === "projects" ? "Open folder" : "New chat"} disabled={navView === "chats" && !runtimeReady} onClick={() => navView === "projects" ? void chooseWorkspace() : createStandaloneChat()}>{navView === "projects" ? <FolderOpen /> : <Plus />}</button></div>
          <div className="sidebar-list">
            {bootstrapping ? <SidebarSkeleton /> : navView === "projects" ? visibleProjects.map((project) => <details ref={initializeProjectDetails} className={`project-group ${draggingProject && samePath(draggingProject, project.cwd) ? "dragging" : ""}`} key={project.cwd}>
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
                {threadTreeOrder(project.threads).map((thread) => <ThreadNavItem thread={thread} active={thread.threadId === activeThread?.threadId} side={Boolean(thread.parentThreadId)} key={thread.threadId} menuOpen={itemMenu?.kind === "thread" && itemMenu.id === thread.threadId} onSelect={() => selectThread(thread)} onMenu={(forceOpen) => changeThreadMenu(thread.threadId, forceOpen)} onStop={() => stopThread(thread.threadId)} onRename={() => setManageDialog({ kind: "rename-thread", threadId: thread.threadId, name: thread.title })} onDelete={() => setManageDialog({ kind: "delete-thread", threadId: thread.threadId, sessionId: thread.sessionId, name: thread.title })} />)}
                {project.runtimeSessions.map((session) => <RuntimeSessionNavItem session={session} key={session.sessionId} menuOpen={itemMenu?.kind === "session" && itemMenu.id === session.sessionId} onSelect={() => void resumeSession(session)} onMenu={(forceOpen) => changeRuntimeSessionMenu(session.sessionId, forceOpen)} onRename={() => void renameRuntimeSession(session)} onRemove={() => setManageDialog({ kind: "remove-runtime-session", sessionId: session.sessionId, name: session.title ?? "Kimi session" })} />)}
              </div>
            </details>) : <>
              {threadTreeOrder(visibleThreads).map((thread) => <ThreadNavItem thread={thread} active={thread.threadId === activeThread?.threadId} chat side={Boolean(thread.parentThreadId)} key={thread.threadId} menuOpen={itemMenu?.kind === "thread" && itemMenu.id === thread.threadId} onSelect={() => selectThread(thread)} onMenu={(forceOpen) => changeThreadMenu(thread.threadId, forceOpen)} onStop={() => stopThread(thread.threadId)} onRename={() => setManageDialog({ kind: "rename-thread", threadId: thread.threadId, name: thread.title })} onDelete={() => setManageDialog({ kind: "delete-thread", threadId: thread.threadId, sessionId: thread.sessionId, name: thread.title })} />)}
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
            {showSidebarUpdate(updateStatus.phase) && <button className={`sidebar-update ${updateStatus.phase}`} type="button" aria-label={updateStatus.phase === "available" ? `Install Kimi Code Desktop ${updateStatus.version ?? "update"} and restart` : `${updateStatus.phase === "downloading" ? "Downloading" : "Installing"} Kimi Code Desktop update`} title={updateStatus.phase === "available" ? "Install update & restart" : `${updateStatus.phase === "downloading" ? "Downloading" : "Installing"} update`} disabled={updatePreparing || updateStatus.phase !== "available"} onClick={() => void installUpdate()}>{updateStatus.phase === "available" ? <DownloadSimple /> : <ArrowsClockwise />}<span>{updatePreparing ? "Preparing" : updateStatus.phase === "available" ? "Update" : updateStatus.phase === "downloading" && updateStatus.percent !== undefined ? `${updateStatus.percent}%` : "Updating"}</span></button>}
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

        {activeThread && !capabilityCenterOpen && <div className={`thread-contextbar ${activeThread.goal ? "has-goal" : ""}`}>
          <button className="thread-goal" type="button" title={activeThread.goal ? "Edit this goal" : "Define a goal for this chat"} onClick={() => { setPrompt(activeThread.goal ? `/goal ${activeThread.goal.objective}` : "/goal "); window.setTimeout(() => composerInput.current?.focus(), 0); }}>
            <Hammer /><span><small>Goal</small><strong>{activeThread.goal?.objective ?? "Define what done means"}</strong></span>
          </button>
          <div className="thread-context-actions">
            {activeThread.goal && <button type="button" title="Clear goal" aria-label="Clear goal" onClick={() => void clearGoal(activeThread.threadId)}><X /></button>}
            <button type="button" title="Create a side chat" onClick={() => void createSideThread()}><GitBranch /><span>Side chat</span></button>
          </div>
        </div>}

        <div className="timeline-shell">
          <div ref={timeline} className={`timeline ${capabilityCenterOpen ? "capability-timeline" : ""}`} onScroll={(event) => {
            const pinned = isNearScrollBottom(event.currentTarget);
            timelinePinned.current = pinned;
            setShowJumpToLatest(!pinned && Boolean(activeThread && turnViews.length));
          }}>
            {bootstrapping ? <StartupScreen delayed={startupDelayed} {...(serverLookupError ? { error: serverLookupError } : {})} onRetry={() => void recoverLocalServer(true)} /> : capabilityCenterOpen ? <CapabilitiesCenter data={capabilities} loading={capabilitiesLoading} tab={capabilityTab} nativePlugins={nativeCapabilityCommands.has("plugins")} nativeMcp={nativeCapabilityCommands.has("mcp-config") || nativeCapabilityCommands.has("mcp")} canInstallSkill={Boolean(capabilityProjectCwd)} onTab={setCapabilityTab} onRefresh={refreshCapabilities} onInstallSkill={chooseSkillToInstall} onUseSkill={(name) => useCapabilityPrompt(skillComposerInsertion(name, runtimeCommands ?? []))} onUsePrompt={useCapabilityPrompt} onCopyPath={(path) => void navigator.clipboard.writeText(path)} /> : showOnboarding ? <Onboarding providers={providers} selected={preferences.provider} cwd={cwd} onProvider={selectProvider} onInstall={installCli} onLogin={beginLogin} onOpenUrl={openExternalLink} onChooseWorkspace={chooseWorkspace} onCancel={(provider) => void call("auth.cancel", { provider })} onFinish={finishOnboarding} onSkip={finishOnboarding} /> : !runtimeReady && (!activeThread || !turnViews.length) ? <ProviderGate provider={providerState} onInstall={() => installCli(providerId)} onLogin={() => beginLogin(providerId)} onOpenUrl={openExternalLink} onCancel={() => void call("auth.cancel", { provider: providerId })} /> : !activeThread || !turnViews.length ? <EmptyConversation kind={activeThread?.kind ?? draftChat?.kind ?? (navView === "chats" ? "chat" : "project")} workspace={activeThread?.kind === "project" ? activeThread.cwd : draftChat?.kind === "project" ? draftChat.cwd : cwd} canPrompt={runtimeReady && Boolean(activeThread || draftChat || navView === "chats" || cwd)} onPrompt={useStarterPrompt} onOpenFolder={() => void chooseWorkspace()} /> : null}
            {!bootstrapping && !capabilityCenterOpen && !showOnboarding && <div ref={conversationStage} className="conversation-stage" key={activeThread?.threadId ?? `${draftChat?.kind ?? "empty"}-${navView}`}>{turnViews.map((turn) => <TurnBlock key={turn.record.turnId} turn={turn} onOpenUrl={openExternalLink} onOpenPreview={showPreview} onOpenLocation={openLocation} onRevealPath={revealLocalPath} onEdit={editTurnPrompt} onRespond={respond} onRevert={revertTurn} onReview={() => { setRailView("git"); void refreshGit(); }} />)}</div>}
          </div>
          {showJumpToLatest && <button className="jump-to-latest" type="button" onClick={jumpToLatest}><CaretDown /> Jump to latest</button>}
        </div>

        {!bootstrapping && !capabilityCenterOpen && !showOnboarding && <form ref={composer} className={`composer ${draftSending ? "sending" : activeThread?.running ? "working" : ""}`} onSubmit={send}>
          {activeThread?.queue.length ? <PromptQueue
            queue={activeThread.queue}
            onClear={() => clearQueuedPrompts(activeThread.threadId)}
            onRemove={(queuedId) => removeQueuedPrompt(activeThread.threadId, queuedId)}
            onUpdate={(queuedId, text) => updateQueuedPrompt(activeThread.threadId, queuedId, text)}
            steerDisabled={configMutationPending}
            onSteer={(queuedId) => steerQueuedPrompt(activeThread.threadId, queuedId)}
          /> : null}
          <textarea ref={composerInput} role="combobox" aria-autocomplete="list" aria-controls={suggestionsOpen ? "composer-suggestions" : undefined} aria-expanded={suggestionsOpen} aria-activedescendant={activeSuggestionId} aria-label={activeThread?.running ? "Task prompt. Enter queues. Control Enter steers." : "Task prompt"} title={activeThread?.running ? "Enter to queue · Ctrl+Enter to steer" : undefined} value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={handleComposerKeyDown} placeholder={updateMutationsBlocked ? "Updating Tasty…" : !runtimeReady ? `Connect ${providerName(providerId)} to continue…` : activeThread?.running ? "Queue the next instruction (Ctrl+Enter to steer)" : activeThread?.kind === "chat" || draftChat?.kind === "chat" ? `Message ${providerName(providerId)}` : activeThread || draftChat ? `Ask ${providerName(providerId)} to work in this project` : "Start a chat first"} disabled={!runtimeReady || (!activeThread && !draftChat) || showOnboarding || draftSending || updateMutationsBlocked} />
          {suggestionsOpen && (commandSuggestions.length > 0 || skillSuggestions.length > 0) && <div className="mention-menu command-mention-menu" id="composer-suggestions" role="listbox" aria-label={promptTrigger?.kind === "skill" ? "Installed Kimi skills" : "Kimi commands"}>
            <small>{promptTrigger?.kind === "skill" ? "Installed skills" : "Commands from Kimi Code"}</small>
            {promptTrigger?.kind === "skill"
              ? skillSuggestions.map((skill, index) => <button id={`composer-suggestion-${index}`} type="button" role="option" tabIndex={-1} aria-selected={activeSuggestionIndex === index} key={`${skill.scope}-${skill.source}-${skill.name}`} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => insertSkill(skill)}><SlidersHorizontal /><span><strong>${skill.name}</strong><small>{skill.description || `${skill.scope} skill`}</small></span><em>{skill.scope}</em></button>)
              : commandSuggestions.map((command, index) => <button id={`composer-suggestion-${index}`} type="button" role="option" tabIndex={-1} aria-selected={activeSuggestionIndex === index} key={command.name} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => insertCommand(command)}><TerminalWindow /><span><strong>/{command.name}</strong><small>{command.description}</small></span></button>)}
          </div>}
          {suggestionsOpen && visibleFileSuggestions.length > 0 && <div className="mention-menu" id="composer-suggestions" role="listbox" aria-label="Project files">{visibleFileSuggestions.map((file, index) => <button id={`composer-suggestion-${index}`} type="button" role="option" tabIndex={-1} aria-selected={activeSuggestionIndex === index} key={file} onMouseDown={(event) => event.preventDefault()} onMouseEnter={() => setSuggestionIndex(index)} onClick={() => insertMention(file)}><FileText />{file}</button>)}</div>}
          {images.length > 0 && <div className="pending-images">{images.map((image) => <span key={image.name}>{image.name}<button type="button" aria-label={`Remove ${image.name}`} onClick={() => setImages((current) => current.filter((item) => item !== image))}><X /></button></span>)}</div>}
          <div className="composer-footer">
            <div ref={composerTools} className="composer-tools">
              <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={(event) => void attachImages(event.target.files)} />
              <button className={`composer-action ${composerMenuOpen ? "active" : ""}`} type="button" title="Add context and capabilities" aria-label="Add context and capabilities" aria-haspopup="menu" aria-expanded={composerMenuOpen} disabled={!runtimeReady || (!activeThread && !draftChat) || showOnboarding || draftSending || updateMutationsBlocked} onClick={() => setComposerMenuOpen((current) => !current)}><Plus /></button>
              <button className={`composer-action composer-skill-action ${promptTrigger?.prefix === "/" ? "active" : ""}`} type="button" title="Use a command (/)" aria-label="Toggle commands" aria-pressed={promptTrigger?.prefix === "/"} disabled={!runtimeReady || (!activeThread && !draftChat) || showOnboarding || draftSending || updateMutationsBlocked} onClick={toggleComposerCommandPicker}>/</button>
              {composerMenuOpen && <div className="composer-tools-menu" role="menu" onKeyDown={moveMenuFocus}>
                <button type="button" role="menuitem" disabled={!composerProjectCwd} onClick={() => void attachWorkspaceFiles()}><Paperclip /><span><strong>Add files…</strong><small>{composerProjectCwd ? "Attach files from this project" : "Available inside a project"}</small></span></button>
                <button type="button" role="menuitem" onClick={() => { setComposerMenuOpen(false); fileInput.current?.click(); }}><ImageSquare /><span><strong>Add images…</strong><small>Attach up to five images</small></span></button>
                <span className="composer-menu-separator" role="separator" />
                <button type="button" role="menuitem" onClick={() => startComposerTrigger("/")}><TerminalWindow /><span><strong>Commands</strong><small>Type / to use Kimi commands</small></span><kbd>/</kbd></button>
                <button type="button" role="menuitem" onClick={() => startComposerTrigger("$")}><SlidersHorizontal /><span><strong>Skills</strong><small>Type $ to invoke a Kimi skill</small></span><kbd>$</kbd></button>
                <button type="button" role="menuitem" disabled={!composerProjectCwd} onClick={() => void chooseSkillToInstall("folder")}><DownloadSimple /><span><strong>Install skill folder…</strong><small>{composerProjectCwd ? "Copy a skill bundle from this project" : "Available inside a project"}</small></span></button>
                <button type="button" role="menuitem" disabled={!composerProjectCwd} onClick={() => void chooseSkillToInstall("file")}><FileText /><span><strong>Install skill file…</strong><small>{composerProjectCwd ? "Copy a flat Markdown skill from this project" : "Available inside a project"}</small></span></button>
                {nativeCapabilityCommands.has("plugins") && <button type="button" role="menuitem" onClick={() => startComposerCommand("plugins")}><PlugsConnected /><span><strong>Plugin manager…</strong><small>Open the manager exposed by this Kimi runtime</small></span><kbd>/plugins</kbd></button>}
                <button type="button" role="menuitem" onClick={() => startComposerCommand("goal")}><Hammer /><span><strong>Set chat goal…</strong><small>Keep the objective attached to this chat</small></span><kbd>/goal</kbd></button>
                <button type="button" role="menuitem" disabled={!activeThread} onClick={() => startComposerCommand("side")}><GitBranch /><span><strong>Create side chat…</strong><small>Branch without losing this chat</small></span><kbd>/side</kbd></button>
                <button type="button" role="menuitem" disabled={!composerProjectCwd} onClick={() => startComposerTrigger("#")}><FileText /><span><strong>Project files</strong><small>Type # to mention workspace context</small></span><kbd>#</kbd></button>
              </div>}
              <div className="composer-context-wrap">
                <button className="composer-context" type="button" aria-label={context ? `Context: ${formatTokens(context.used)} of ${formatTokens(context.size)} used` : "Context usage unavailable"} aria-describedby="composer-context-details"><Gauge /><span>{contextUsed === undefined ? "n/a" : `${contextUsed}%`}</span></button>
                <div className="composer-context-popover" id="composer-context-details" role="tooltip"><div><span>Context window</span><strong>{contextUsed === undefined ? "n/a" : `${contextUsed}%`}</strong></div>{context ? <><i><b style={{ transform: `scaleX(${contextUsed! / 100})` }} /></i><small><span>{formatTokens(context.used)} used</span><span>{formatTokens(context.size)} limit</span></small></> : <p>Available after the first model update.</p>}</div>
              </div>
            </div>
            <div className="composer-controls">
              {(activeThread || draftChat) && <ProviderPicker providers={providers} selected={providerId} locked={Boolean(activeThread)} disabled={updateMutationsBlocked || configMutationPending} onSelect={selectProvider} />}
              {(activeThread || draftChat) && <ComposerConfig options={composerOptions} busyId={configBusyId} disabled={!runtimeReady || updateMutationsBlocked || configMutationPending} onChange={changeConfig} />}
              <button className={`icon-button primary composer-submit ${primaryComposerAction === "stop" ? "composer-stop" : ""}`} type={primaryComposerAction === "stop" ? "button" : "submit"} aria-label={composerPrimaryLabel(primaryComposerAction)} title={composerPrimaryLabel(primaryComposerAction)} disabled={!runtimeReady || (!activeThread && !draftChat) || showOnboarding || draftSending || updateMutationsBlocked || (primaryComposerAction !== "stop" && (!composerSubmitReady || !prompt.trim()))} onClick={primaryComposerAction === "stop" && activeThread ? () => stopThread(activeThread.threadId) : undefined}>{primaryComposerAction === "stop" ? <Stop weight="fill" /> : <ArrowUp weight="bold" />}</button>
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
              <div className="preview-actions"><button className="rail-icon" type="button" aria-label="Reload preview" title="Reload preview" onClick={() => setPreviewRevision((value) => value + 1)}><ArrowsClockwise /></button><button className="rail-icon" type="button" aria-label="Open preview in default browser" title="Open in browser" disabled={!previewUrl} onClick={() => { if (previewUrl) void openExternalLink(previewUrl); }}><ArrowSquareOut /></button><button className="preview-size" type="button" aria-label={`Cycle preview width; current ${previewPanelMode.toLowerCase()}`} title="Cycle preview width" onClick={cyclePreviewWidth}>{previewPanelMode === "Wide" ? <CornersIn /> : <CornersOut />}<span>{previewPanelMode}</span></button></div>
            </form>
            <div className="preview-frame">
              {previewUrl ? <iframe key={`${previewUrl}-${previewRevision}`} src={previewUrl} title={`Preview of ${previewUrl}`} sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" referrerPolicy="no-referrer" /> : <div className="preview-empty"><Browser /><strong>No local app open</strong><span>Enter a localhost URL above.</span></div>}
            </div>
          </>}

          {railView === "agents" && <SubagentsRail provider={activeThread?.provider ?? providerId} runs={agentRuns} onInspect={async (run) => {
            const agentThreadId = run.threadIds?.[0];
            if (!activeThread || !agentThreadId) return undefined;
            const result = await call("subagents.inspect", { threadId: activeThread.threadId, agentThreadId }) as { inspection: SubagentInspection };
            return result.inspection;
          }} onUseAgent={(agent) => useCapabilityPrompt(`Use the ${agent} subagent for this task: `)} onOpenCenter={() => { setCapabilityTab("agents"); setCapabilityCenterOpen(true); setRailView(undefined); }} />}
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
        turnRunning={updateBlocked || updatePreparing}
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
      {yoloConfirm && <YoloConfirmDialog busy={yoloConfirm.busy} onCancel={() => setYoloConfirm((pending) => pending?.busy ? pending : undefined)} onConfirm={async () => {
        const pending = yoloConfirm;
        if (pending.target.key !== currentConfigTargetKey.current || pending.busy) {
          setYoloConfirm(undefined);
          return;
        }
        setYoloConfirm({ ...pending, busy: true });
        const success = await setConfig(pending.configId, pending.value, pending.target);
        if (shouldAcknowledgeYolo(success, pending.target.key, currentConfigTargetKey.current)) {
          setPreferences((current) => ({ ...current, yoloAcknowledged: true }));
        }
        setYoloConfirm(undefined);
      }} />}
      {diagnostics.length > 0 && <div className="app-notice" role="status" aria-live="polite"><WarningCircle /><span>{diagnostics[diagnostics.length - 1]}</span><button type="button" aria-label="Reveal runtime log" title="Reveal runtime log" onClick={() => void openRuntimeLog()}><Bug /></button><button type="button" aria-label="Copy error details" title="Copy error details" onClick={() => void navigator.clipboard.writeText(diagnostics.join("\n"))}><Copy /></button><button type="button" aria-label="Dismiss notification" onClick={() => setDiagnostics([])}><X /></button></div>}
    </main>
  );
}

function PromptQueue({ queue, steerDisabled = false, onClear, onRemove, onUpdate, onSteer }: {
  queue: QueuedPrompt[];
  steerDisabled?: boolean;
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
          <button type="button" disabled={steerDisabled} onClick={() => onSteer(queued.queuedId)}>Steer</button>
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

function ThreadNavItem({ thread, active, chat = false, side = false, menuOpen, onSelect, onMenu, onStop, onRename, onDelete }: { thread: Thread; active: boolean; chat?: boolean; side?: boolean; menuOpen: boolean; onSelect: () => void; onMenu: (forceOpen?: boolean) => void; onStop: () => void; onRename: () => void; onDelete: () => void }) {
  const items = [
    ...(thread.running ? [{ label: "Stop task", icon: <Stop weight="fill" />, onSelect: onStop }] : []),
    { label: "Rename chat", icon: <PencilSimple />, onSelect: onRename },
    { label: "Delete chat", icon: <Trash />, danger: true, onSelect: onDelete },
  ];
  return <div className={`thread-row-wrap ${side ? "side-thread-row" : ""} ${active ? "active" : ""}`} onContextMenu={(event) => { event.preventDefault(); onMenu(true); }}>
    <button className={`thread ${chat ? "chat-thread" : ""} ${active ? "active" : ""}`} type="button" aria-current={active ? "page" : undefined} onClick={onSelect}>
      {side && <GitBranch className="side-thread-icon" />}{chat ? <span className="thread-copy"><strong>{thread.title}</strong></span> : <span>{thread.title}</span>}
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
        : dialog.kind === "install-skill"
          ? { title: `Install “${dialog.name}”?`, description: "Kimi Code Desktop will copy this project-local skill into your user Kimi skills folder. Existing skills are never overwritten.", action: "Install skill" }
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
      <footer><button className="secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className={renaming || dialog.kind === "remove-project" || dialog.kind === "remove-runtime-session" || dialog.kind === "install-skill" ? "primary" : "danger"} type="submit" disabled={busy || (renaming && !value.trim())}>{busy ? "Working…" : copy.action}</button></footer>
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

function ProviderPicker({ providers, selected, locked, disabled, onSelect }: { providers: ProviderState[]; selected: ProviderId; locked: boolean; disabled: boolean; onSelect: (provider: ProviderId) => void }) {
  const [open, setOpen] = useState(false);
  const provider = providers.find((item) => item.id === selected);
  const choices = providers.map((item) => ({
    value: item.id,
    name: item.name,
    description: !item.installed ? "CLI not installed" : item.authenticated === false ? "Sign in required" : item.account ?? `${item.protocol} runtime`,
  }));
  const control: ComposerControl = {
    id: "provider",
    label: "Provider",
    icon: <Robot />,
    tooltip: locked ? "Provider is fixed for this chat" : "AI provider for the new chat",
    current: provider?.name ?? providerName(selected),
    value: selected,
    choices,
    disabled: locked || disabled || !choices.length,
  };
  return <div className="provider-picker"><ConfigControl control={control} open={open} onToggle={() => setOpen((current) => !current)} onClose={() => setOpen(false)} onPick={(value) => { onSelect(normalizeProvider(value)); setOpen(false); }} /></div>;
}

export function ComposerConfig({ options, busyId, disabled = false, onChange }: { options: ConfigOption[]; busyId?: string | undefined; disabled?: boolean; onChange: (configId: string, value: string) => void }) {
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
    {controls.map((control) => <ConfigControl control={{ ...control, disabled: control.disabled || disabled || Boolean(busyId) }} key={control.id} open={openId === control.id} onToggle={() => setOpenId((current) => current === control.id ? undefined : control.id)} onClose={() => setOpenId(undefined)} onPick={(value) => { onChange(control.id, value); setOpenId(undefined); }} />)}
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

function YoloConfirmDialog({ busy, onConfirm, onCancel }: { busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onCancel]);
  return <div className="manage-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div className="manage-dialog" role="alertdialog" aria-modal="true" aria-labelledby="yolo-title" aria-describedby="yolo-description" onKeyDown={trapDialogFocus}>
      <header><span><strong id="yolo-title">Enable YOLO mode?</strong><small id="yolo-description">Kimi will run every tool and command without asking first. Enable this only for workspaces you fully trust. You will not be asked again.</small></span><button type="button" aria-label="Close" disabled={busy} onClick={onCancel}><X /></button></header>
      <footer><button className="secondary" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="danger" type="button" autoFocus disabled={busy} onClick={onConfirm}>{busy ? "Enabling…" : "Enable YOLO"}</button></footer>
    </div>
  </div>;
}

export function thinkingEffortLabel(_model?: ConfigOption, thinking?: ConfigOption): string {
  const current = thinking ? currentChoiceName(thinking) : "";
  if (current && !/^(?:thinking[ -]?)?(?:on|off|enabled|disabled|true|false|1|0)$/i.test(current)) return current;
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

            {category === "account" && <section className="settings-group"><h2>Kimi account</h2><div className="account-card"><UserCircle /><div><strong>{auth?.authenticated ? "Kimi account connected" : "Not signed in"}</strong><small>{auth?.installed ? "Official Kimi Code CLI detected" : "Kimi Code CLI is not installed"}</small></div></div><code className="account-home">{auth?.home ?? "Loading local Kimi home…"}</code><p className="settings-note">The app uses each person's own local Kimi login and subscription. Credentials never enter this repository.</p>{auth?.authenticated ? <button className="secondary danger-text" type="button" disabled={auth.loginRunning || auth.installRunning} onClick={() => void onLogout()}><SignOut /> Log out</button> : auth?.installed ? <button className="primary" type="button" disabled={auth.loginRunning} onClick={() => void onLogin()}><SignIn /> Sign in</button> : <button className="primary" type="button" onClick={() => void onInstallCli()}><DownloadSimple /> Open guide / check again</button>}</section>}

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
      {workspace && <button className={current === "git" ? "active" : ""} type="button" title="Changes" aria-label="Changes" aria-current={current === "git" ? "page" : undefined} onClick={() => onSelect("git")}><GitBranch /><span>Changes</span></button>}
      {workspace && <button className={current === "terminal" ? "active" : ""} type="button" title="Terminal" aria-label="Terminal" aria-current={current === "terminal" ? "page" : undefined} onClick={() => onSelect("terminal")}><TerminalWindow /><span>Terminal</span></button>}
      {workspace && <button className={current === "preview" ? "active" : ""} type="button" title="Preview" aria-label="Preview" aria-current={current === "preview" ? "page" : undefined} onClick={() => onSelect("preview")}><Browser /><span>Preview</span></button>}
      <button className={current === "agents" ? "active" : ""} type="button" title="Agents" aria-label={activeAgents > 0 ? `Agents, ${activeAgents} active` : "Agents"} aria-current={current === "agents" ? "page" : undefined} onClick={() => onSelect("agents")}><Robot /><span>Agents</span>{activeAgents > 0 && <small className="rail-agent-count">{activeAgents}</small>}</button>
    </div>
    <button className="rail-tabs-close" type="button" aria-label="Close side panel" onClick={onClose}><X /></button>
  </nav>;
}

function CapabilitiesCenter({ data, loading, tab, nativePlugins, nativeMcp, canInstallSkill, onTab, onRefresh, onInstallSkill, onUseSkill, onUsePrompt, onCopyPath }: {
  data: KimiCapabilities | undefined;
  loading: boolean;
  tab: CapabilityTab;
  nativePlugins: boolean;
  nativeMcp: boolean;
  canInstallSkill: boolean;
  onTab: (tab: CapabilityTab) => void;
  onRefresh: () => Promise<void>;
  onInstallSkill: (kind?: "folder" | "file") => Promise<void>;
  onUseSkill: (name: string) => void;
  onUsePrompt: (text: string) => void;
  onCopyPath: (path: string) => void;
}) {
  const count = tab === "skills" ? data?.skills.length : tab === "plugins" ? data?.plugins.length : tab === "mcp" ? data?.mcpServers.length : data?.agents.length;
  const path = tab === "skills" ? data?.roots.skills : tab === "mcp" ? data?.roots.mcp : tab === "plugins" ? data?.roots.plugins : undefined;
  return <section className="capabilities-center" aria-label="Kimi capabilities">
    <header className="capabilities-hero">
      <div className="capabilities-mark"><PlugsConnected /></div>
      <div><span>Extend Kimi</span><h1>Skills, tools, and focused agents.</h1><p>Everything here is read from your local Kimi installation and active project. The desktop app never copies credentials or invents a second capability runtime.</p></div>
      <button className="capabilities-refresh" type="button" disabled={loading} onClick={() => void onRefresh()}><ArrowsClockwise className={loading ? "rotating" : ""} /><span>{loading ? "Refreshing" : "Refresh"}</span></button>
    </header>
    <nav className="capabilities-tabs" aria-label="Capability categories">
      <button className={tab === "skills" ? "active" : ""} type="button" onClick={() => onTab("skills")}><SlidersHorizontal /><span>Skills</span><small>{data?.skills.length ?? 0}</small></button>
      <button className={tab === "mcp" ? "active" : ""} type="button" onClick={() => onTab("mcp")}><Cpu /><span>MCP servers</span><small>{data?.mcpServers.length ?? 0}</small></button>
      <button className={tab === "agents" ? "active" : ""} type="button" onClick={() => onTab("agents")}><Robot /><span>Subagents</span><small>{data?.agents.length ?? 3}</small></button>
      <button className={tab === "plugins" ? "active" : ""} type="button" onClick={() => onTab("plugins")}><PlugsConnected /><span>Plugins</span><small>{data?.plugins.length ?? 0}</small></button>
    </nav>
    <div className="capabilities-content" key={tab}>
      <div className="capabilities-section-title"><div><strong>{tab === "skills" ? "Available skills" : tab === "plugins" ? "Detected plugins" : tab === "mcp" ? "Configured tool servers" : "Kimi-native agent shortcuts"}</strong><span>{count ?? 0} {tab === "agents" ? "shortcuts" : tab === "skills" ? "available" : "configured"}</span></div>{tab === "skills" ? <span className="capabilities-title-actions"><button type="button" disabled={!canInstallSkill} title={canInstallSkill ? "Install a skill bundle from this project" : "Open a project to install a skill"} onClick={() => void onInstallSkill("folder")}><Plus /> Skill folder</button><button type="button" disabled={!canInstallSkill} title={canInstallSkill ? "Install a flat Markdown skill from this project" : "Open a project to install a skill"} onClick={() => void onInstallSkill("file")}><FileText /> Skill file</button></span> : tab === "plugins" && nativePlugins ? <button type="button" onClick={() => onUsePrompt("/plugins ")}><Plus /> Open plugin manager</button> : tab === "mcp" ? <button type="button" onClick={() => onUsePrompt(nativeMcp ? "/mcp-config " : "Help me configure an MCP server for Kimi Code using the capabilities available in this Kimi version. ")}><Plus /> Configure MCP</button> : null}</div>
      {loading && !data ? <CapabilitySkeleton /> : tab === "skills" ? <div className="capability-grid">
        {data?.skills.map((skill) => <article className="capability-card" key={`${skill.scope}-${skill.source}-${skill.name}`}><span className="capability-icon"><SlidersHorizontal /></span><div><strong>{skill.name}</strong><small>{skill.scope} · {skill.source === "kimi" ? "Kimi" : "Agents"}{skill.hasSubSkills ? " · sub-skills" : ""}</small><p>{skill.description || "Local Kimi skill"}</p></div><button type="button" onClick={() => onUseSkill(skill.name)}>Use</button></article>)}
        {!data?.skills.length && <CapabilityEmpty icon={<SlidersHorizontal />} title="No skills found" text="Kimi discovers skills from your user folders and the active project's .kimi-code or .agents directory." {...(canInstallSkill ? { action: "Install skill folder", onAction: () => onInstallSkill("folder") } : {})} />}
      </div> : tab === "plugins" ? <div className="capability-grid">
        {data?.plugins.map((plugin) => <article className="capability-card" key={plugin.name}><span className="capability-icon"><PlugsConnected /></span><div><strong>{plugin.name}</strong><small>v{plugin.version} · {plugin.toolCount} {plugin.toolCount === 1 ? "tool" : "tools"}</small><p>{plugin.description || "Local Kimi plugin"}</p></div>{nativePlugins ? <button type="button" onClick={() => onUsePrompt(`/plugins ${plugin.name} `)}>Manage</button> : <span className="capability-badge">Detected locally</span>}</article>)}
        {!data?.plugins.length && <CapabilityEmpty icon={<PlugsConnected />} title="No plugins detected" text={nativePlugins ? "This Kimi runtime exposes its plugin manager, but no local plugin manifests were found." : "Your current Kimi runtime does not advertise a plugin command. The desktop app will not create a fake plugin flow."} {...(nativePlugins ? { action: "Open plugin manager", onAction: () => onUsePrompt("/plugins ") } : {})} />}
      </div> : tab === "mcp" ? <div className="capability-list">
        {data?.mcpServers.map((server) => <article className="mcp-row" key={server.name}><span className={`mcp-status ${server.connectable ? "ready" : "attention"}`} /><div><strong>{server.name}</strong><small>{server.transport.toUpperCase()} · {server.target}</small></div>{!server.connectable && <span className="capability-badge">{server.projectScoped ? "Review only" : server.needsAuthorization ? "OAuth" : "Unsupported"}</span>}{!server.projectScoped && <button type="button" onClick={() => onUsePrompt(nativeMcp ? "/mcp " : `Check the configured MCP server ${server.name} and report its available tools. `)}>Check</button>}</article>)}
        {!data?.mcpServers.length && <CapabilityEmpty icon={<Cpu />} title="No MCP servers configured" text={nativeMcp ? "Connect Kimi to APIs, databases, and local tools using its standard MCP configuration." : "This Kimi runtime has not exposed MCP configuration commands in the current session. Ask Kimi to use the configuration supported by your installed version."} action={nativeMcp ? "Configure MCP" : "Ask Kimi"} onAction={() => onUsePrompt(nativeMcp ? "/mcp-config " : "Check my installed Kimi Code version and help me configure a compatible MCP server. ")} />}
      </div> : <div className="agent-grid">
        {(data?.agents ?? defaultAgentCapabilities()).map((agent) => <article className={`agent-card agent-${agent.name}`} key={agent.name}><div className="agent-card-top"><span><Robot /></span><small>{agent.supportsBackground ? "Foreground or background" : "Foreground"}</small></div><h2>{agent.name}</h2><p>{agent.description}</p><footer><span>{agent.access}</span><button type="button" onClick={() => onUsePrompt(`Use the ${agent.name} subagent for this task: `)}>Use agent <CaretRight /></button></footer></article>)}
      </div>}
      {data?.warnings.length ? <div className="capability-warning"><WarningCircle /><span>{data.warnings.join(" ")}</span></div> : null}
      {path && <footer className="capabilities-paths"><span>Local Kimi data</span><button type="button" title={path} onClick={() => onCopyPath(path)}><Copy /> Copy {tab === "mcp" ? "config" : `${tab.slice(0, -1)} folder`} path</button></footer>}
    </div>
  </section>;
}

function CapabilitySkeleton() {
  return <div className="capability-skeleton" aria-label="Loading Kimi capabilities" aria-busy="true"><span /><span /><span /></div>;
}

function CapabilityEmpty({ icon, title, text, action, onAction }: { icon: React.ReactNode; title: string; text: string; action?: string; onAction?: () => void | Promise<void> }) {
  return <div className="capability-empty"><span>{icon}</span><strong>{title}</strong><p>{text}</p>{action && onAction && <button type="button" onClick={() => void onAction()}>{action}</button>}</div>;
}

function SubagentsRail({ provider, runs, onInspect, onUseAgent, onOpenCenter }: { provider: ProviderId; runs: SubagentRun[]; onInspect: (run: SubagentRun) => Promise<SubagentInspection | undefined>; onUseAgent: (agent: string) => void; onOpenCenter: () => void }) {
  const active = runs.filter((run) => run.status === "running").length;
  const [selectedId, setSelectedId] = useState<string>();
  const [inspection, setInspection] = useState<SubagentInspection>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const selected = runs.find((run) => run.id === selectedId);
  useEffect(() => {
    if (selectedId && !runs.some((run) => run.id === selectedId)) { setSelectedId(undefined); setInspection(undefined); }
  }, [runs, selectedId]);

  async function inspect(run: SubagentRun) {
    setSelectedId(run.id);
    setInspection(undefined);
    setError(undefined);
    if (!run.threadIds?.length) return;
    setLoading(true);
    try { setInspection(await onInspect(run)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setLoading(false); }
  }

  if (selected) return <section className="agents-rail-content agent-inspection">
    <header><button className="agent-back" type="button" onClick={() => { setSelectedId(undefined); setInspection(undefined); setError(undefined); }}><CaretRight /> All agents</button><span className={`agent-status ${selected.status}`}>{selected.status}</span></header>
    <div className="agent-inspection-body">
      <div className="agent-inspection-title"><ProviderMark provider={provider} /><div><small>{selected.type}{selected.background ? " · background" : ""}</small><h2>{inspection?.title ?? selected.description}</h2><p>{selected.agentId ?? inspection?.role ?? selected.detail}</p></div></div>
      {loading && <div className="agent-inspection-loading"><i /><span>Loading subagent transcript…</span></div>}
      {error && <div className="agent-inspection-error"><WarningCircle /><span>{error}</span></div>}
      {inspection?.turns.flatMap((turn) => turn.items.map((item) => <article className={`agent-inspection-item ${item.kind}`} key={`${turn.turnId}-${item.id}`}><header><strong>{item.title}</strong><span>{item.status ?? turn.status}</span></header>{item.text && <pre>{compactToolPreview(item.text, item.kind === "message" ? 8 : 4, 1_200)}</pre>}</article>))}
      {!loading && !error && !inspection && <div className="agent-local-detail"><p>{selected.description}</p>{selected.output && <pre>{compactToolPreview(selected.output, 8, 1_200)}</pre>}<small>{selected.threadIds?.length ? "Transcript is available when this provider runtime is connected." : "This provider reported status only for this agent run."}</small></div>}
    </div>
  </section>;
  return <section className="agents-rail-content">
    <header><div><span>{active ? `${active} active` : "Subagents"}</span><strong>Focused work, separate context.</strong></div><button type="button" onClick={onOpenCenter}>Browse agents</button></header>
    {runs.length ? <div className="agent-run-list">{runs.map((run) => <button className={`agent-run ${run.status}`} type="button" key={run.id} onClick={() => void inspect(run)}><span className="agent-run-state">{run.status === "running" ? <i /> : run.status === "completed" ? <Check /> : <WarningCircle />}</span><span className="agent-run-copy"><strong>{run.description}</strong><small><b>{run.type}</b>{run.background ? " · background" : " · foreground"}{run.agentId ? ` · ${run.agentId}` : ""}</small></span><span>{run.detail ?? run.status}</span><CaretRight /></button>)}</div> : <div className="agents-empty"><Robot /><strong>No subagents in this chat</strong><p>Ask the active provider to delegate exploration, planning, or implementation without filling the main context.</p><div><button type="button" onClick={() => onUseAgent("explore")}>Explore</button><button type="button" onClick={() => onUseAgent("plan")}>Plan</button><button type="button" onClick={() => onUseAgent("coder")}>Code</button></div></div>}
  </section>;
}

function Onboarding({ providers, selected, cwd, onProvider, onInstall, onLogin, onOpenUrl, onChooseWorkspace, onCancel, onFinish, onSkip }: {
  providers: ProviderState[]; selected: ProviderId; cwd: string; onProvider: (provider: ProviderId) => void; onInstall: (provider: ProviderId) => Promise<void>; onLogin: (provider: ProviderId) => Promise<void>; onOpenUrl: (url: string) => Promise<void>;
  onChooseWorkspace: () => Promise<void>; onCancel: (provider: ProviderId) => void; onFinish: () => void; onSkip: () => void;
}) {
  const provider = providers.find((item) => item.id === selected);
  const connected = providerUsable(provider);
  return <section className="onboarding">
    <header><div className="onboarding-mark"><img src="/kimi-logo.png" alt="" aria-hidden="true" /></div><div><span>Welcome to Tasty</span><h1>Your coding agents, one focused workspace.</h1><p>Connect an official provider CLI. Tasty keeps credentials with that provider and stores its own thread metadata locally.</p></div></header>
    <div className="provider-grid" role="radiogroup" aria-label="AI provider">
      {providers.length ? providers.map((item) => <button className={item.id === selected ? "active" : ""} type="button" role="radio" aria-checked={item.id === selected} key={item.id} onClick={() => onProvider(item.id)}><ProviderMark provider={item.id} /><span><strong>{item.name}</strong><small>{!item.installed ? "Install CLI" : item.authenticated === false ? "Sign in" : item.account ?? "Ready"}</small></span>{item.id === selected && <Check />}</button>) : <ProviderSkeleton />}
    </div>
    <ol className="setup-steps">
      <li className={provider?.installed ? "complete" : ""}><span>{provider?.installed ? <Check /> : "1"}</span><div><strong>Install {provider?.name ?? "a provider"}</strong><p>{provider?.installed ? `Found the ${provider.name} CLI.` : "Open the provider's official installation guide, then return here."}</p>{provider && !provider.installed && <button className="primary" type="button" onClick={() => void onInstall(provider.id)}><DownloadSimple />Open install guide</button>}</div></li>
      <li className={connected ? "complete" : ""}><span>{connected ? <Check /> : "2"}</span><div><strong>Connect your account</strong><p>{connected ? provider?.account ?? `${provider?.name ?? "Provider"} is ready.` : "Use the provider's official sign-in flow. Tasty never receives your password."}</p>{provider?.installed && !connected && <div className="auth-actions"><button className="primary" type="button" disabled={provider.loginRunning} onClick={() => void onLogin(provider.id)}><SignIn />{provider.loginRunning ? "Waiting for sign-in…" : "Begin sign-in"}</button>{provider.loginRunning && <button className="secondary" type="button" onClick={() => onCancel(provider.id)}>Cancel</button>}</div>}{provider?.event?.operation === "login" && provider.event.url && <button className="verification-link" type="button" onClick={() => void onOpenUrl(provider.event!.url!)}>Open verification</button>}{provider?.event?.operation === "login" && provider.event.code && <button className="pairing-code" type="button" onClick={() => void navigator.clipboard.writeText(provider.event?.code ?? "")}><Copy />{provider.event.code}</button>}</div></li>
      <li className={cwd ? "complete" : ""}><span>{cwd ? <Check /> : "3"}</span><div><strong>Choose a workspace</strong><p>{cwd || "Pick the folder your agent can work in."}</p><button className="secondary" type="button" onClick={() => void onChooseWorkspace()}><FolderOpen />{cwd ? "Change folder" : "Choose folder"}</button></div></li>
    </ol>
    <footer><button className="text-button" type="button" onClick={onSkip}>Skip for now</button><button className="primary" type="button" disabled={!connected || !cwd} onClick={onFinish}>Start coding</button></footer>
  </section>;
}

function ProviderGate({ provider, onInstall, onLogin, onOpenUrl, onCancel }: {
  provider: ProviderState | undefined; onInstall: () => Promise<void>; onLogin: () => Promise<void>; onOpenUrl: (url: string) => Promise<void>; onCancel: () => void;
}) {
  if (!provider) return <section className="auth-card" aria-live="polite"><ArrowsClockwise size={24} /><div><h1>Checking providers</h1><p>Reading the locally installed agent CLIs…</p></div></section>;
  return <section className="auth-card"><ProviderMark provider={provider.id} /><div><h1>{provider.installed ? `Connect ${provider.name}` : `Install ${provider.name}`}</h1><p>{provider.installed ? "Sign in through the provider's official CLI. Credentials remain in its local account store." : "Tasty could not find this provider CLI. Open its official install guide, then return here."}</p>{provider.event?.operation === "login" && provider.event.url && <button className="verification-link" type="button" onClick={() => void onOpenUrl(provider.event!.url!)}>Open verification</button>}{provider.event?.operation === "login" && provider.event.code && <button className="pairing-code" type="button" onClick={() => void navigator.clipboard.writeText(provider.event?.code ?? "")}><Copy />{provider.event.code}</button>}<div className="auth-actions">{provider.installed ? <button className="primary" type="button" disabled={provider.loginRunning} onClick={() => void onLogin()}>{provider.loginRunning ? "Waiting for sign-in…" : "Begin sign-in"}</button> : <button className="primary" type="button" onClick={() => void onInstall()}>Open install guide</button>}{provider.loginRunning && <button className="secondary" type="button" onClick={onCancel}>Cancel</button>}</div></div></section>;
}

function ProviderMark({ provider }: { provider: ProviderId }) {
  return <span className={`provider-mark provider-${provider}`} aria-hidden="true">{provider === "kimi" ? "K" : provider === "codex" ? "O" : provider === "claude" ? "A" : "C"}</span>;
}

function ProviderSkeleton() {
  return <div className="provider-skeleton" aria-label="Loading providers" aria-busy="true"><span /><span /><span /><span /></div>;
}

function SidebarSkeleton() {
  return <div className="sidebar-skeleton" aria-label="Loading projects" aria-busy="true">{[72, 54, 80, 62, 46, 76].map((width, index) => <span style={{ width: `${width}%` }} key={`${width}-${index}`} />)}</div>;
}

function StartupScreen({ delayed, error, onRetry }: { delayed: boolean; error?: string; onRetry: () => void }) {
  const needsAttention = delayed || Boolean(error);
  return <div className="startup-screen" aria-label="Starting Kimi Code" aria-busy={!needsAttention}><div className="startup-intro"><img src="/kimi-logo.png" alt="" aria-hidden="true" /><span>Kimi Code Desktop</span><strong>{needsAttention ? "The local runtime needs attention" : "Opening your workspace"}</strong><small>{error ?? (delayed ? "Kimi Code did not become ready in time. Restart it safely without closing the app." : "Connecting to your local Kimi runtime and restoring sessions")}</small>{needsAttention ? <button type="button" onClick={onRetry}><ArrowsClockwise /> Restart local runtime</button> : <div className="startup-progress" aria-hidden="true"><i /></div>}</div></div>;
}

export function serverWebSocketUrl(connection: unknown): string {
  if (!connection || typeof connection !== "object") throw new Error("The desktop runtime returned no server connection.");
  const { port, token } = connection as { port?: unknown; token?: unknown };
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535 || typeof token !== "string" || token.length > 4_096) {
    throw new Error("The desktop runtime returned an invalid server connection.");
  }
  return `ws://127.0.0.1:${port}${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

export async function localServerUrl(
  native = isTauri(),
  lookup: () => Promise<unknown> = () => invoke("server_connection"),
  attempts = 4,
  retryDelayMs = 100,
): Promise<string> {
  if (!native) return "ws://127.0.0.1:4317";
  let failure: unknown;
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt += 1) {
    try {
      return serverWebSocketUrl(await lookup());
    } catch (error) {
      failure = error;
      if (attempt + 1 < attempts && retryDelayMs > 0) await new Promise((resolve) => window.setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(`Could not locate the local Kimi runtime: ${failure instanceof Error ? failure.message : String(failure)}`);
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
      provider: normalizeProvider(value.provider),
    };
  } catch {
    return { ...defaultPreferences };
  }
}

export function clampPanelWidth(panel: "sidebar" | "rail", width: number): number {
  return Math.round(Math.min(panel === "sidebar" ? 420 : 1200, Math.max(panel === "sidebar" ? 84 : 260, width)));
}

export function effectiveRailWidth(requestedWidth: number, viewportWidth: number, sidebarWidth: number, minimumConversationWidth = 400): number {
  return Math.min(clampPanelWidth("rail", requestedWidth), Math.max(0, Math.round(viewportWidth - sidebarWidth - minimumConversationWidth)));
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

export function filterKimiSkills(skills: KimiSkill[], query: string, limit = 10): KimiSkill[] {
  const needle = query.trim().toLowerCase();
  return skills
    .filter((skill) => !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))
    .slice(0, Math.max(0, limit));
}

export function skillComposerInsertion(skillName: string, runtimeCommands: Array<{ name: string }>): string {
  const normalizedName = skillName.trim();
  const advertised = runtimeCommands
    .map((command) => command.name.trim().replace(/^\/+/, ""))
    .find((name) => name.toLowerCase() === normalizedName.toLowerCase() || name.toLowerCase() === `skill:${normalizedName.toLowerCase()}`);
  return advertised ? `/${advertised} ` : `$${normalizedName} `;
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

export function parseHarnessCommand(value: string):
  | { name: "goal"; objective?: string; clear: boolean }
  | { name: "side"; title?: string }
  | undefined {
  const match = /^\/(goal|side)(?:\s+([\s\S]*))?$/i.exec(value.trim());
  if (!match) return undefined;
  const argument = match[2]?.trim();
  if (match[1]?.toLowerCase() === "side") return { name: "side", ...(argument ? { title: argument } : {}) };
  const clear = /^(?:clear|remove|off)$/i.test(argument ?? "");
  return { name: "goal", clear, ...(!clear && argument ? { objective: argument } : {}) };
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

export function moveSuggestionIndex(current: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
  if (count <= 0) return 0;
  return key === "ArrowDown" ? (current + 1) % count : (current - 1 + count) % count;
}

async function revealPath(path: string): Promise<void> {
  if (!isTauri()) throw new Error("Explorer integration is available in the desktop app");
  const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
  await revealItemInDir(path);
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

export function subagentRuns(thread: Pick<Thread, "tools"> & Partial<Pick<Thread, "backgroundTasks">> | undefined): SubagentRun[] {
  if (!thread) return [];
  const backgroundTasks = thread.backgroundTasks ?? [];
  const matchedTasks = new Set<string>();
  const runs = thread.tools.filter(isSubagentTool).map<SubagentRun>((tool) => {
    const input = isRecordValue(tool.rawInput) ? tool.rawInput : {};
    const output = `${safeStringify(tool.rawOutput)} ${tool.content?.map((item) => safeStringify(item)).join(" ") ?? ""}`;
    const threadIds = Array.isArray(input.receiverThreadIds) ? input.receiverThreadIds.filter((value): value is string => typeof value === "string" && Boolean(value)) : [];
    const visibleOutput = agentVisibleOutput(tool.content?.flatMap((item) => item.type === "content" && item.content?.type === "text" && item.content.text ? [item.content.text] : []).join("\n")
      || (typeof tool.rawOutput === "string" ? tool.rawOutput : undefined));
    const agentId = /\bagent_id:\s*([\w-]+)/i.exec(output)?.[1];
    const taskId = /\btask_id:\s*((?:agent|bash)-[a-z0-9]+)\b/i.exec(output)?.[1];
    const task = taskId ? backgroundTasks.find((candidate) => candidate.taskId === taskId) : undefined;
    if (task) matchedTasks.add(task.taskId);
    const type = typeof input.subagent_type === "string" ? input.subagent_type : /actual_subagent_type:\s*([\w-]+)/i.exec(output)?.[1] ?? "coder";
    const description = typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : (tool.title ?? "Agent task").replace(/^Agent\s*:\s*/i, "");
    const background = input.run_in_background === true || /\bautomatic_notification:\s*true\b/i.test(output) || /\bkind:\s*agent\b/i.test(output);
    const status = task
      ? backgroundTaskRunStatus(task.status)
      : background && /\bstatus:\s*running\b/i.test(output)
        ? "running"
        : tool.status === "in_progress" || tool.status === "pending" ? "running" : tool.status === "failed" ? "failed" : "completed";
    return {
      id: tool.toolCallId,
      type,
      description,
      status,
      background,
      ...(agentId ? { agentId } : {}),
      ...(task ? { detail: backgroundTaskDetail(task) } : {}),
      ...(threadIds.length ? { threadIds } : {}),
      ...(visibleOutput ? { output: visibleOutput } : {}),
    };
  });
  for (const task of backgroundTasks) {
    if (matchedTasks.has(task.taskId) || !task.taskId.startsWith("agent-")) continue;
    runs.push({
      id: task.taskId,
      type: "agent",
      description: task.description,
      status: backgroundTaskRunStatus(task.status),
      background: true,
      agentId: task.taskId,
      detail: backgroundTaskDetail(task),
    });
  }
  return runs.reverse();
}

function backgroundTaskRunStatus(status: BackgroundTask["status"]): SubagentRun["status"] {
  return status === "running" ? "running" : status === "completed" ? "completed" : "failed";
}

function agentVisibleOutput(value: string | undefined): string | undefined {
  const text = value?.split(/\r?\n/).filter((line) => !/^\s*(?:agent_id|task_id|status|automatic_notification|actual_subagent_type)\s*:/i.test(line)).join("\n").trim();
  return text || undefined;
}

function backgroundTaskDetail(task: BackgroundTask): string {
  if (task.status === "running") return "running";
  if (task.status === "completed") return task.reportQueued ? "report queued" : "completed";
  const status = task.status === "timed_out" ? "timed out" : task.status;
  return task.exitCode === undefined || task.exitCode === null ? status : `${status} · exit ${task.exitCode}`;
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

function TurnBlock({ turn, onOpenUrl, onOpenPreview, onOpenLocation, onRevealPath, onEdit, onRespond, onRevert, onReview }: {
  turn: TurnView;
  onOpenUrl: (url: string) => Promise<void>;
  onOpenPreview: (url: string) => void;
  onOpenLocation: (path: string) => void;
  onRevealPath: (path: string) => Promise<void>;
  onEdit: (text: string) => Promise<void>;
  onRespond: (approval: Approval, optionId?: string) => void;
  onRevert: (turnId: string) => Promise<void>;
  onReview: () => void;
}) {
  const user = turn.messages.filter((message) => message.role === "user");
  const { commentary, final } = turnAssistantMessages(turn);
  const report = final?.text ?? "";
  const failure = turn.record.error
    ?? (turn.record.stopReason === "error" ? "Kimi stopped before finishing this turn. You can edit the prompt and try again." : undefined);
  const previewLink = findLocalPreviewUrl([
    ...turn.messages.map((message) => message.text),
    ...turn.tools.flatMap((tool) => [tool.title ?? "", ...tool.content?.map((item) => item.content?.text ?? "") ?? [], safeStringify(tool.rawOutput)]),
  ].join("\n"));
  return <section className={`turn-block ${turn.running ? "running" : "complete"}`}>
    {user.map((message, index) => <article className="user-message" key={`${message.turnId}-user-${index}`}>
      <MarkdownText text={message.text} onOpenUrl={onOpenUrl} />
      <PathLinks text={message.text} onReveal={onRevealPath} />
      <AttachmentSummary message={message} />
      <div className="message-actions"><button type="button" aria-label="Edit task" title="Edit task" onClick={() => void onEdit(message.text)}><PencilSimple /></button><button type="button" aria-label="Copy task" title="Copy task" onClick={() => void navigator.clipboard.writeText(message.text)}><Copy /></button></div>
    </article>)}
    <div className="turn-output">
      {(turn.running || turn.activity.length > 0 || commentary.length > 0) && <ActivityTimeline turn={turn} commentary={commentary} onOpenUrl={onOpenUrl} onOpenLocation={onOpenLocation} />}
      {final && <article className="assistant-message markdown"><MarkdownText text={final.text} onOpenUrl={onOpenUrl} /><PathLinks text={final.text} onReveal={onRevealPath} /></article>}
      {turn.approvals.map((approval) => <article className="approval" key={approval.requestId}>
        <div><strong>{approval.kind === "question" ? "Question" : approval.kind === "plan_review" ? "Review plan" : "Permission required"}</strong><p>{approval.title}</p></div>
        <div className="approval-actions">{approval.options.map((option) => <button className={permissionClass(option.kind)} type="button" key={option.optionId} onClick={() => onRespond(approval, option.optionId)}>{option.name}</button>)}</div>
      </article>)}
      {turn.record.completedAt && failure && <div className="turn-failure" role="alert"><WarningCircle /><div><strong>Stopped with an error</strong><span>{failure}</span></div></div>}
      {turn.record.completedAt && (report || turn.canRevert || turn.record.usage?.totalTokens != null || turn.record.stopReason === "cancelled" || failure) && <footer className="turn-report">
        <div className="turn-report-meta">{turn.record.usage?.totalTokens != null && <span>{formatTokens(turn.record.usage.totalTokens)} tokens</span>}{turn.record.stopReason === "cancelled" && <span>Stopped</span>}{failure && <span>Failed</span>}</div>
        <div className="turn-report-actions">{report && <button type="button" onClick={() => void navigator.clipboard.writeText(report)}><Copy /> Copy summary</button>}{turn.canRevert && <button type="button" onClick={() => void onRevert(turn.record.turnId)}><ArrowCounterClockwise /> Undo changes</button>}</div>
      </footer>}
      {turn.record.completedAt && previewLink && <div className="turn-preview-link"><span><i />{previewLink}</span><div><button type="button" onClick={() => onOpenPreview(previewLink)}><Browser /> Preview</button><button type="button" onClick={() => void onOpenUrl(previewLink)}><ArrowSquareOut /> Browser</button></div></div>}
      {turn.record.completedAt && turn.checkpoint?.diff && <ChangesCard diff={turn.checkpoint.diff} onReview={onReview} />}
    </div>
  </section>;
}

export function turnAssistantMessages(turn: Pick<TurnView, "activity" | "messages" | "running">): { commentary: Message[]; final?: Message } {
  const assistant = turn.messages.filter((message) => message.role === "assistant");
  if (turn.running || !assistant.length) return { commentary: assistant };
  const latestActivity = turn.activity.reduce((latest, entry) => Math.max(latest, entry.updatedSeq ?? entry.seq), -1);
  const candidate = assistant.at(-1)!;
  const candidateSeq = candidate.updatedSeq ?? candidate.seq;
  if (candidateSeq !== undefined && candidateSeq <= latestActivity) return { commentary: assistant };
  return { commentary: assistant.slice(0, -1), final: candidate };
}

type TimelineItem =
  | { id: string; seq: number; updatedSeq: number; kind: "activity"; entry: ActivityEntry }
  | { id: string; seq: number; updatedSeq: number; kind: "commentary"; message: Message };

export function latestTimelineItemId(items: ReadonlyArray<{ id: string; updatedSeq: number }>): string | undefined {
  let latest: { id: string; updatedSeq: number } | undefined;
  for (const item of items) if (!latest || item.updatedSeq > latest.updatedSeq) latest = item;
  return latest?.id;
}

export function ActivityTimeline({ turn, commentary = turnAssistantMessages(turn).commentary, onOpenUrl, onOpenLocation }: { turn: TurnView; commentary?: Message[]; onOpenUrl: (url: string) => Promise<void>; onOpenLocation: (path: string) => void }) {
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
  const timeline: TimelineItem[] = [
    ...activity.map((entry) => ({ id: entry.id, seq: entry.seq, updatedSeq: entry.updatedSeq ?? entry.seq, kind: "activity" as const, entry })),
    ...commentary.filter((message) => message.text.trim()).map((message, index) => ({ id: `commentary-${message.seq ?? index}`, seq: message.seq ?? index, updatedSeq: message.updatedSeq ?? message.seq ?? index, kind: "commentary" as const, message })),
  ].sort((a, b) => a.seq - b.seq);
  const hidden = Math.max(0, timeline.length - 8);
  const entries = showEarlier ? timeline : timeline.slice(-8);
  const currentEntryId = turn.running ? latestTimelineItemId(timeline) : undefined;
  return <details className="turn-activity" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><span className={`activity-state ${turn.running ? "active" : ""}`}>{turn.running ? <i className="activity-spinner" aria-hidden="true" /> : <Check />}</span><strong>{turn.running ? "Working" : `Worked for ${duration}`}</strong><small>{turn.running ? duration : `${timeline.length} ${timeline.length === 1 ? "step" : "steps"}`}</small><CaretDown /></summary>
    <div className="activity-content">
      {hidden > 0 && !showEarlier && <button className="activity-earlier" type="button" onClick={() => setShowEarlier(true)}>Show {hidden} earlier {hidden === 1 ? "step" : "steps"}</button>}
      {entries.map((item) => item.kind === "activity"
        ? <ActivityStep key={item.id} entry={item.entry} current={item.id === currentEntryId} tool={item.entry.toolCallId ? turn.tools.find((tool) => tool.toolCallId === item.entry.toolCallId) : undefined} onOpenUrl={onOpenUrl} onOpenLocation={onOpenLocation} />
        : <CommentaryStep key={item.id} message={item.message} current={item.id === currentEntryId} onOpenUrl={onOpenUrl} />)}
    </div>
  </details>;
}

function CommentaryStep({ message, current, onOpenUrl }: { message: Message; current: boolean; onOpenUrl: (url: string) => Promise<void> }) {
  return <details className="activity-step commentary-step">
    <summary><span className="activity-step-state">{current ? <i className="activity-spinner" aria-label="Current update" /> : <Check />}</span><span>{activityPreview(message.text)}</span><CaretRight /></summary>
    <div className="activity-detail"><div className="markdown"><MarkdownText text={message.text} onOpenUrl={onOpenUrl} /></div></div>
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

export function extractLocalPaths(text: string): string[] {
  const codePaths = [...text.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1] ?? "");
  const plainText = text.replace(/`[^`\r\n]+`/g, " ");
  const candidates = [
    ...codePaths,
    ...[...plainText.matchAll(/\b[A-Za-z]:[\\/][^\s`<>"|?*]+/g)].map((match) => match[0]),
  ];
  const seen = new Set<string>();
  return candidates
    .map((path) => path.trim().replace(/[),.;!?]+$/g, ""))
    .filter((path) => /^[A-Za-z]:[\\/]/.test(path))
    .filter((path) => {
      const key = path.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 6);
}

function PathLinks({ text, onReveal }: { text: string; onReveal: (path: string) => Promise<void> }) {
  const paths = extractLocalPaths(text);
  if (!paths.length) return null;
  return <div className="message-paths">{paths.map((path) => <button type="button" title={`Reveal ${path} in Explorer`} key={path} onClick={() => void onReveal(path)}><FolderOpen /><span>{path}</span><ArrowSquareOut /></button>)}</div>;
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

export function applyEvents(threads: Thread[], events: StoredEvent[]): Thread[] {
  let nextThreads = threads;
  const mutable = new Map<string, Thread>();
  for (const event of events) {
    if (event.type === "ThreadCreated") {
      const payload = event.payload as { sessionId: string; provider?: ProviderId; parentThreadId?: string; cwd: string; kind?: "project" | "chat"; title: string; configOptions: ConfigOption[] };
      const created: Thread = { threadId: event.threadId, ...payload, provider: normalizeProvider(payload.provider), kind: payload.kind === "chat" ? "chat" : "project", createdAt: event.createdAt, updatedAt: event.createdAt, running: false, activeTurnId: undefined, stopReason: undefined, turns: [], messages: [], activity: [], plan: [], tools: [], approvals: [], commands: [], modeId: undefined, checkpoints: [], backgroundTasks: [], usage: {}, queue: [] };
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
  else if (event.type === "ThreadGoalSet") next.goal = { objective: String(payload.objective), updatedAt: event.createdAt };
  else if (event.type === "ThreadGoalCleared") delete next.goal;
  else if (event.type === "TurnStarted") {
    next.running = true; next.activeTurnId = String(payload.turnId); next.stopReason = undefined;
    if (typeof payload.title === "string" && payload.title) next.title = payload.title;
    next.turns.push({ turnId: String(payload.turnId), startedAt: event.createdAt });
    next.messages.push({
      turnId: String(payload.turnId), role: "user", text: String(payload.text),
      seq: event.seq, updatedSeq: event.seq,
      ...(Array.isArray(payload.resources) && payload.resources.length ? { resources: payload.resources as string[] } : {}),
      ...(Array.isArray(payload.images) && payload.images.length ? { images: payload.images as Array<{ name: string; mimeType: string }> } : {}),
    }); next.plan = [];
  } else if (event.type === "MessageAppended") {
    const message = payload as Message;
    if (message.role === "thought") appendRendererThought(next, message, event);
    else appendRendererMessage(next, message, event);
  }
  else if (event.type === "MessageDelta") {
    const delta = payload as Message;
    if (delta.role === "thought") appendRendererThought(next, delta, event);
    else appendRendererMessage(next, delta, event);
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
  else if (event.type === "BackgroundTaskRegistered") {
    if (!next.backgroundTasks.some((task) => task.taskId === payload.taskId)) {
      next.backgroundTasks.push({
        taskId: String(payload.taskId),
        queuedId: String(payload.queuedId),
        turnId: String(payload.turnId),
        description: String(payload.description),
        status: "running",
        registeredAt: event.createdAt,
        updatedAt: event.createdAt,
        reportQueued: false,
      });
    }
  }
  else if (event.type === "BackgroundTaskFinished") {
    const task = next.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
    if (task) {
      const status = String(payload.status);
      task.status = status === "completed" || status === "failed" || status === "killed" || status === "lost" || status === "expired" || status === "timed_out" ? status : "failed";
      task.updatedAt = event.createdAt;
      if (typeof payload.endedAt === "number") task.endedAt = payload.endedAt;
      if (typeof payload.exitCode === "number" || payload.exitCode === null) task.exitCode = payload.exitCode as number | null;
    }
  }
  else if (event.type === "BackgroundTaskReportQueued") {
    const task = next.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
    if (task) { task.reportQueued = true; task.updatedAt = event.createdAt; }
  }
  else if (event.type === "BackgroundTaskReportDelivered") {
    const task = next.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
    if (task && !task.reportCancelledAt) { task.reportDeliveredAt = event.createdAt; task.updatedAt = event.createdAt; }
  }
  else if (event.type === "BackgroundTaskReportCancelled") {
    const task = next.backgroundTasks.find((candidate) => candidate.taskId === payload.taskId);
    if (task && !task.reportDeliveredAt) { task.reportCancelledAt = event.createdAt; task.updatedAt = event.createdAt; }
  }
  else if (event.type === "TurnCompleted") { const turn = next.turns.findLast((item) => item.turnId === payload.turnId); if (turn) Object.assign(turn, { completedAt: event.createdAt, stopReason: String(payload.stopReason), ...(typeof payload.error === "string" && payload.error ? { error: payload.error } : {}), ...(payload.usage ? { usage: payload.usage as NonNullable<Usage["tokens"]> } : {}) }); finishRendererActivity(next, String(payload.turnId), event.createdAt, String(payload.stopReason) === "error"); next.running = false; next.stopReason = String(payload.stopReason); next.activeTurnId = undefined; if (payload.usage) next.usage = { ...next.usage, tokens: payload.usage as NonNullable<Usage["tokens"]> }; }
  else if (event.type === "TurnCancelled") { const turn = next.turns.findLast((item) => item.turnId === payload.turnId); if (turn) Object.assign(turn, { completedAt: event.createdAt, stopReason: "cancelled" }); finishRendererActivity(next, String(payload.turnId), event.createdAt, true); next.running = false; next.stopReason = "cancelled"; next.activeTurnId = undefined; }
  else if (event.type === "CheckpointCaptured") { const checkpoint = { ...(payload.checkpoint as Checkpoint) }; if (typeof payload.diff === "string") checkpoint.diff = payload.diff; next.checkpoints.push(checkpoint); }
  else if (event.type === "CheckpointReverted") next.checkpoints.push(payload.checkpoint as Checkpoint);
}

function appendRendererThought(thread: Thread, message: Message, event: StoredEvent): void {
  const current = thread.activity.at(-1);
  if (current?.kind === "thought" && current.turnId === message.turnId && current.status === "in_progress") {
    current.text = boundedActivityText(current.text + message.text);
    current.updatedSeq = event.seq;
    current.updatedAt = event.createdAt;
    return;
  }
  finishRendererThought(thread, message.turnId, event.createdAt);
  thread.activity.push({ id: `thought-${event.seq}`, turnId: message.turnId, kind: "thought", status: "in_progress", text: boundedActivityText(message.text), seq: event.seq, updatedSeq: event.seq, createdAt: event.createdAt, updatedAt: event.createdAt });
}

function appendRendererMessage(thread: Thread, message: Message, event: StoredEvent): void {
  const last = thread.messages.at(-1);
  const latestActivitySeq = thread.activity.reduce((latest, entry) => entry.turnId === message.turnId
    ? Math.max(latest, entry.updatedSeq ?? entry.seq)
    : latest, -1);
  if (last?.turnId === message.turnId && last.role === message.role
    && (last.updatedSeq ?? last.seq ?? -1) > latestActivitySeq) {
    last.text += message.text;
    last.updatedSeq = event.seq;
    return;
  }
  thread.messages.push({ ...message, seq: event.seq, updatedSeq: event.seq });
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
    existing.updatedSeq = event.seq;
    existing.updatedAt = event.createdAt;
    return;
  }
  finishRendererThought(thread, tool.turnId, event.createdAt);
  thread.activity.push({ id: `tool-${tool.toolCallId}`, turnId: tool.turnId, kind: "tool", status, text: tool.title ?? "Tool call", toolCallId: tool.toolCallId, seq: event.seq, updatedSeq: event.seq, createdAt: event.createdAt, updatedAt: event.createdAt });
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
    provider: normalizeProvider(thread.provider),
    ...(typeof thread.parentThreadId === "string" && thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
    ...(thread.goal && typeof thread.goal.objective === "string" && thread.goal.objective ? { goal: {
      objective: thread.goal.objective,
      updatedAt: typeof thread.goal.updatedAt === "string" ? thread.goal.updatedAt : createdAt,
    } } : {}),
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
    backgroundTasks: Array.isArray(thread.backgroundTasks) ? thread.backgroundTasks : [],
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

function normalizeProvider(value: unknown): ProviderId {
  return value === "codex" || value === "claude" || value === "cursor" ? value : "kimi";
}

function providerName(provider: ProviderId): string {
  return provider === "codex" ? "OpenAI Codex" : provider === "claude" ? "Anthropic Claude" : provider === "cursor" ? "Cursor" : "Kimi";
}

export function providerUsable(provider: ProviderState | undefined): boolean {
  return Boolean(provider?.installed && provider.authenticated !== false);
}

export function threadTreeOrder(items: Thread[]): Thread[] {
  const ids = new Set(items.map((thread) => thread.threadId));
  const children = new Map<string, Thread[]>();
  for (const thread of items) {
    if (!thread.parentThreadId || !ids.has(thread.parentThreadId)) continue;
    children.set(thread.parentThreadId, [...(children.get(thread.parentThreadId) ?? []), thread]);
  }
  const ordered: Thread[] = [];
  const visit = (thread: Thread) => {
    ordered.push(thread);
    for (const child of children.get(thread.threadId) ?? []) visit(child);
  };
  for (const thread of items) if (!thread.parentThreadId || !ids.has(thread.parentThreadId)) visit(thread);
  return ordered;
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
