import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const appCss = readFileSync(new URL("./styles/app.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("./styles/tokens.css", import.meta.url), "utf8");

function cssRule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return appCss.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
}

describe("desktop accessibility contracts", () => {
  it("uses the soft graphite foundation without weakening light or accent themes", () => {
    for (const token of [
      "--color-canvas: #141414",
      "--color-chrome: #181818",
      "--color-surface-1: #1b1b1b",
      "--color-surface-2: #212121",
      "--color-surface-3: #282828",
      "--color-hover: #2d2d2d",
      "--color-border: rgb(255 255 255 / 7%)",
      "--color-border-strong: rgb(255 255 255 / 12%)",
      "--color-text: #efefef",
      "--color-text-secondary: #c1c1c1",
      "--color-text-tertiary: #929292",
      "--header-height: 48px",
    ]) expect(tokensCss).toContain(token);
    expect(tokensCss).toContain(':root[data-theme="light"]');
    expect(tokensCss).toContain(':root[data-accent="blue"]');
    expect(appCss).toContain(".view-switch button.active { background: color-mix(in srgb, var(--color-text) 9%, transparent)");
  });

  it("keeps one conversation landmark and labels only historical providers", () => {
    const fallbackCommandCatalog = appSource.slice(appSource.indexOf("const fallbackCommands"), appSource.indexOf("function terminalEntry"));
    expect(appSource).toContain('<div style={shellStyle} className={`shell');
    expect(appSource).toContain('<main id="conversation-content" className="conversation"');
    expect(appSource.match(/<main\b/g)).toHaveLength(1);
    expect(appSource).not.toContain('<main className="settings-main">');
    expect(appSource).toContain("!capabilityCenterOpen && historicalThread && <span className=\"topbar-provider\"");
    expect(appSource).toContain('disabled={sidebarToggle.disabled} aria-label={sidebarToggle.label}');
    expect(fallbackCommandCatalog).not.toMatch(/Claude|Codex|Cursor|OpenCode/i);
  });

  it("keeps sidebar scrolling stable and transcript text aligned and readable", () => {
    const sidebar = appCss.match(/\.sidebar-list\s*\{([^}]*)\}/s)?.[1] ?? "";
    const turn = appCss.match(/\.conversation-stage > \.turn-block\s*\{([^}]*)\}/s)?.[1] ?? "";
    const assistant = appCss.match(/\.assistant-message\s*\{([^}]*)\}/s)?.[1] ?? "";
    const composer = appCss.match(/\.composer\s*\{([^}]*)\}/s)?.[1] ?? "";
    expect(sidebar).toContain("scrollbar-gutter: stable");
    expect(sidebar).toContain("scrollbar-width: thin");
    expect(sidebar).not.toContain("scrollbar-width: none");
    expect(appCss).not.toContain(".sidebar-list::-webkit-scrollbar { display: none; }");
    expect(turn).toContain("max-width: var(--composer-max-width)");
    expect(assistant).toContain("max-width: 68ch");
    expect(composer).toContain("width: min(calc(100% - var(--space-6) - var(--space-6)), var(--composer-max-width))");
    expect(appCss).toContain(".timeline { padding-inline: var(--space-4); }");
    expect(appCss).toContain(".composer { width: calc(100% - var(--space-8)); }");
    expect(tokensCss).toContain("--text-micro: max(9px, calc(var(--base-font-size) - 6px));");
    expect(tokensCss).toContain("--text-code-sm: clamp(10px, calc(var(--base-font-size) - 4px), 13px);");
    expect(appCss).not.toMatch(/(?:font-size|font)\s*:[^;]*\b(?:9|10|11)px\b/);
  });

  it("exposes the workspace rail as one keyboard tab interface", () => {
    const tabs = appSource.slice(appSource.indexOf("function RailTabs"), appSource.indexOf("function CapabilitiesCenter"));
    expect(tabs).toContain('role="tablist" aria-label="Workspace tools"');
    expect(tabs).toContain('role="tab"');
    expect(tabs).toContain("aria-selected={current === view}");
    expect(tabs).toContain('aria-controls={current === view ? `rail-panel-${view}` : undefined}');
    expect(tabs).toContain("tabIndex={current === view ? 0 : -1}");
    expect(tabs).toContain("railTabAfter(current, event.key, workspace)");
    expect(tabs).toContain('scrollIntoView({ block: "nearest", inline: "nearest" })');
    expect(tabs).not.toContain("aria-current");
    const order = [tabs.indexOf('tab("preview"'), tabs.indexOf('tab("terminal"'), tabs.indexOf('tab("changes"'), tabs.indexOf('tab("git"'), tabs.indexOf('tab("agents"')];
    expect(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]!))).toBe(true);
    expect(appSource).toContain('role="tabpanel" aria-labelledby={`rail-tab-${railView}`}');
    expect(appSource).toContain('aria-label="Workspace tools"');
    expect(appCss).toContain("overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none;");
  });

  it("keeps Git loading, detail, and narrow panel states truthful", () => {
    expect(appSource).toContain('visibleGitLoadState === "not-repository" ? <div className="git-clone"');
    expect(appSource).toContain("const gitLoadCurrent = Boolean(workspaceCwd && gitLoadCwd");
    expect(appSource).toContain("<strong>Reading repository…</strong>");
    expect(appSource).toContain("boundedDiffPreview(gitDiff.diff");
    expect(appSource).not.toContain('(gitDiff.diff || "No textual diff available.").split("\\n")');
    expect(appSource).toContain('visibleGitStatus || selectedFile || gitDetailLoading ? <div className={`git-changes-layout');
    expect(appSource).toContain('${visibleGitStatus ? "" : "file-only"}`}');
    expect(appCss).toContain(".git-changes-layout { display: grid");
    expect(appCss).toContain(".git-changes-layout.file-only { grid-template-columns: minmax(0, 1fr); }");
    expect(appCss).toContain(".git-changes-layout.detail-open .git-changes-master { display: none; }");
    expect(appCss).toContain(".git-changes-layout.detail-open .git-changes-detail { display: flex; }");
    expect(appCss).toContain(".git-diff pre span { display: block; min-width: max-content; padding-inline: 4px; content-visibility: auto");
    expect(appCss).toContain('.panel-resizer[aria-disabled="true"] { pointer-events: none; opacity: 0; }');
    expect(appSource).toContain("tabIndex={railResizable ? 0 : -1}");
    expect(appSource).toContain('preferences.sidebarSide === "left" && <div className="sidebar-slot" ref={setSidebarHost} />');
    expect(appSource).toContain('preferences.railSide === "left" && <div className="rail-slot" ref={setRailHost} />');
    expect(appSource).toContain('preferences.sidebarSide === "right" && <div className="sidebar-slot" ref={setSidebarHost} />');
    expect(appSource).toContain('sidebarHost && createPortal(<aside className="sidebar"');
    expect(appSource).toContain('railView && railRendered && railHost && createPortal(<aside className={`rail');
    expect(appSource).toContain('disabled={!terminalSplitAvailable}');
    expect(appCss).toContain(".preview-actions { grid-column: 1 / -1; justify-content: flex-end; }");
  });

  it("bounds Git inventories and exposes truthful progressive disclosure", () => {
    expect(appSource).toContain("export const gitChangedFilePageSize = 60");
    expect(appSource).toContain("export const gitBranchPageSize = 60");
    expect(appSource).toContain("const visibleGitFileSections = useMemo(() => progressiveGroups(");
    expect(appSource).toContain("scopedProgressiveLimit(gitLocalBranchLimit, localGitBranchScope, gitBranchPageSize)");
    expect(appSource).toContain("scopedProgressiveLimit(gitRemoteBranchLimit, remoteGitBranchScope, gitBranchPageSize)");
    expect(appSource).toContain("visibleGitFileSections.map((section)");
    expect(appSource).toContain("visibleLocalBranches.map((branch)");
    expect(appSource).toContain("visibleRemoteBranches.map((branch)");
    expect(appSource).toContain("<span>Show more changed files</span>");
    expect(appSource).toContain("<span>Show more local branches</span>");
    expect(appSource).toContain("<span>Show more remote branches</span>");
    expect(appSource).toContain("`${visibleLocalBranches.length} of ${filteredLocalBranches.length}`");
    expect(appSource).toContain("`${visibleRemoteBranches.length} of ${filteredRemoteBranches.length}`");
    expect(appCss).toContain(".git-show-more { display: flex; width: 100%; min-height: 34px;");
  });

  it("keeps Git freshness local, debounced, and workspace safe", () => {
    const scheduler = appSource.slice(appSource.indexOf("const scheduleGitRefresh"), appSource.indexOf("gitRefreshScheduler.current = scheduleGitRefresh"));
    expect(appSource).toContain('visibleGitLoadState === "ready" ? "Local snapshot"');
    expect(appSource).not.toContain('? "Up to date"');
    expect(appSource).toContain("const scheduleGitRefresh = useCallback((delay = 180, targetCwd?: string)");
    expect(appSource).toContain("if (requestedCwd && !workspaceRequestMatches(requestedCwd, currentWorkspaceCwd.current)) return;");
    expect(appSource).toContain('window.addEventListener("focus", refreshVisibleSnapshot)');
    expect(appSource).toContain('document.addEventListener("visibilitychange", refreshVisibleSnapshot)');
    expect(appSource).toContain("updateTerminalGitMutationTracking(terminalGitMutationSessions.current");
    expect(appSource).toContain("terminalGitMutationSessions.current.has(event.sessionId)");
    expect(scheduler).not.toContain("terminalGitMutationSessions.current.clear()");
  });

  it("keeps branch confirmations adjacent and keyboard accessible", () => {
    const panel = appSource.slice(appSource.indexOf("function GitBranchActionPanel"), appSource.indexOf("function RailTabs"));
    expect(appSource).toContain('className="git-branch-entry"');
    expect(appSource).toContain("<GitBranchActionPanel action={gitBranchAction}");
    expect(panel).toContain('role="group" aria-labelledby={titleId}');
    expect(panel).toContain('if (event.key !== "Escape") return;');
    expect(panel).toContain("focusTarget.current?.focus()");
    expect(panel).toContain("onSubmit={(event) =>");
    expect(panel).toContain('<button ref={(element) => { if (action.kind === "delete") focusTarget.current = element; }} className="secondary"');
    expect(panel).not.toContain('<button ref={(element) => { if (action.kind === "delete") focusTarget.current = element; }} className={action.kind === "delete" ? "danger" : "primary"}');
    expect(appSource).toContain("gitBranchActionTrigger.current = trigger");
    expect(appSource).toContain("gitBranchesSummary.current?.focus()");
    expect(appCss).toContain(".git-branch-entry:focus-within > .git-branch-row");
    expect(appCss).toContain("margin: 0 5px 6px 27px;");
  });

  it("keeps project navigation explicit and sidebar actions stable", () => {
    const disclosure = appSource.slice(appSource.indexOf('className="project-disclosure"'), appSource.indexOf('className={`project-select'));
    const projectSelect = appSource.slice(appSource.indexOf('className={`project-select'), appSource.indexOf('<span className="row-actions">'));
    const touchActions = appCss.slice(appCss.indexOf("@media (hover: none)"), appCss.indexOf(".checkpoint-review"));
    expect(appSource).not.toContain('<summary className={`project-row');
    expect(disclosure).toContain("aria-expanded={expanded}");
    expect(disclosure).toContain("aria-controls={panelId}");
    expect(disclosure).not.toContain("createThread");
    expect(appSource).toContain('className="project-threads" id={panelId} hidden={!expanded}');
    expect(projectSelect).toContain('if (!samePath(project.cwd, cwd)) createThread(project.cwd)');
    expect(projectSelect).toContain('aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"');
    expect(appCss).toContain(".project-disclosure:focus-visible, .project-select:focus-visible { outline: none; box-shadow: var(--focus-ring); }");
    expect(appCss).not.toContain("project-reveal");
    expect(appCss).toContain(".thread-row-wrap .thread { padding-right: 40px; }");
    expect(appCss).toContain(".thread-row-wrap:has(.thread-running) .thread { padding-right: 52px; }");
    for (const selector of [".project-new", ".item-menu-trigger", ".project-caret"]) expect(touchActions).toContain(selector);
    expect(touchActions).toContain(".project-new, .item-menu-trigger, .queued-prompt-actions { pointer-events: auto; }");
  });

  it("keeps compact interactive targets at least 32px tall", () => {
    for (const selector of [
      ".toolbar-icon",
      ".view-switch button",
      ".project-disclosure",
      ".project-select",
      ".thread",
      ".item-menu-trigger",
      ".message-actions button",
      ".prompt-queue button",
      '.terminal-tabs [role="tab"]',
      ".terminal-input button",
      ".settings-search button",
      ".rail-icon",
      ".git-branch-row-actions button",
      ".git-branch-action button",
      ".git-file-actions button",
    ]) {
      expect(cssRule(selector), selector).toMatch(/(?:min-height|height): 32px/);
    }
    expect(cssRule(".density-compact")).toContain("--control-height: 32px");
    expect(cssRule(".rail-tabs-close")).toContain("width: 32px");
    expect(cssRule(".preview-address .preview-actions .rail-icon")).toContain("width: 32px");
    expect(cssRule(".settings-range input")).toContain("min-height: 32px");
  });

  it("exposes row actions to hoverless pointers without horizontal queue overflow", () => {
    const hoverless = appCss.slice(appCss.indexOf("@media (hover: none), (pointer: coarse)"), appCss.indexOf(".checkpoint-review"));
    const queueList = cssRule(".prompt-queue-list");
    expect(hoverless).toContain(".message-actions, .queued-prompt-actions { opacity: 1; }");
    expect(hoverless).toContain(".project-new, .item-menu-trigger, .queued-prompt-actions { pointer-events: auto; }");
    expect(hoverless).toContain(".queued-prompt { grid-template-columns: minmax(0, 1fr); }");
    expect(hoverless).toContain(".queued-prompt-actions { grid-column: 1; flex-wrap: wrap; justify-content: flex-end; }");
    expect(queueList).toContain("overflow-x: hidden");
  });

  it("keeps terminal output navigable without announcing every streamed chunk", () => {
    expect(appSource).toContain('className="terminal-screen" role="region" aria-label={`${tab.name} output`}');
    expect(appSource).not.toContain('className="terminal-screen" role="log"');
    expect(appSource).not.toContain('className="terminal-screen" role="region" aria-live=');
  });

  it("keeps narrow navigation operable and never docks an undersized work rail", () => {
    const narrow = appCss.slice(appCss.indexOf("@media (max-width: 680px)"), appCss.indexOf("@media (hover: hover)"));
    expect(appSource).toContain('className="sidebar-drawer-backdrop"');
    expect(appSource).toContain('narrowLayout && narrowSidebarOpen ? "sidebar-drawer-open"');
    expect(appCss).toContain(".sidebar-drawer-open .sidebar { position: fixed;");
    expect(narrow).not.toContain(".sidebar .sidebar-body");
    expect(appSource).toContain("const railRendered = Boolean(railView && renderedRailWidth >= 260)");
    expect(appSource).toContain("const available = Math.max(0, Math.round(viewportWidth - sidebarWidth - minimumConversationWidth))");
    expect(appSource).toContain("return available < 260 ? 0");
  });

  it("opens the truthful Kimi extensions inventory", () => {
    const extensions = appSource.slice(appSource.indexOf('title="Kimi skills and plugins"'), appSource.indexOf("<button className={`capability-link ${settingsOpen"));
    expect(extensions).toContain("<strong>Extensions</strong>");
    expect(extensions).toContain("capabilities.skills.length");
    expect(extensions).toContain("capabilities.plugins.length");
    expect(extensions).toContain('setCapabilityTab("plugins")');
    expect(appCss).toContain(".capability-link small { margin-left: auto; color: var(--color-text-tertiary); font-size: var(--text-xs); }");
  });

  it("keeps keyboard focus visible in Windows forced colors", () => {
    const forcedColors = appCss.slice(appCss.indexOf("@media (forced-colors: active)"), appCss.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(forcedColors).toContain("*:focus-visible");
    expect(forcedColors).toContain("outline: 2px solid Highlight !important");
    expect(forcedColors).toContain(".settings-switch input:focus-visible + span");
  });

  it("keeps keyboard focus, composer focus, and markdown links visible without costly pulses", () => {
    const focusRule = appCss.match(/([^{}]*:focus-visible[^{}]*)\{\s*outline: none; box-shadow: var\(--focus-ring\);\s*\}/s)?.[1] ?? "";
    const composerFocus = appCss.match(/\.composer textarea:focus-visible\s*\{([^}]*)\}/s)?.[1] ?? "";
    const markdownLink = appCss.match(/\.markdown a\s*\{([^}]*)\}/s)?.[1] ?? "";
    const statusPulse = appCss.slice(appCss.indexOf("@keyframes status-pulse"), appCss.indexOf("@keyframes spin"));

    expect(focusRule).toContain("a:focus-visible");
    expect(focusRule).toContain("summary:focus-visible");
    expect(composerFocus).toContain("box-shadow: none");
    expect(appCss).toContain(".composer:focus-within { border-color: var(--color-border-strong); box-shadow: var(--shadow-composer-focus); }");
    expect(markdownLink).toContain("text-decoration: underline");
    expect(markdownLink).not.toContain("text-decoration: none");
    expect(statusPulse).not.toContain("transform:");
    expect(statusPulse).not.toContain("filter:");
  });

  it("keeps shortcut-heavy overlays static", () => {
    for (const selector of ["command-backdrop", "command-palette", "rail", "rail-view"]) {
      expect(appCss).not.toMatch(new RegExp(`\\.${selector}\\s*\\{[^}]*animation:`, "s"));
    }
  });

  it("does not replay high-frequency message, submit, menu, or autocomplete motion", () => {
    const rule = (selector: string) => appCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";

    expect(rule("\\.user-message")).not.toContain("animation:");
    expect(rule("\\.composer-submit svg")).not.toContain("animation:");
    expect(appCss).not.toContain("@keyframes message-in");
    expect(appCss).not.toContain("@keyframes send-icon-in");
    expect(rule("\\.menu-popover")).not.toContain("animation:");
    expect(rule("\\.mention-menu")).not.toContain("animation:");
    expect(rule("\\.mention-menu button")).toContain("transition: none");

    expect(rule("\\.prompt-queue")).toContain("animation: queue-in");
    expect(rule("\\.manage-dialog")).toContain("animation: dialog-in");
  });

  it("keeps the jump-to-latest control centered in every interaction state", () => {
    const rule = (selector: string) => appCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "s"))?.[1] ?? "";
    expect(rule("\\.jump-to-latest")).toContain("transform: translateX(-50%)");
    expect(rule("\\.jump-to-latest")).not.toContain("animation:");
    expect(rule("\\.jump-to-latest:active:not\\(:disabled\\)")).toContain("transform: translateX(-50%) scale(.98)");
  });

  it("uses only short opacity feedback and a static startup bar with reduced motion", () => {
    const reducedMotion = appCss.slice(appCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    const allowlist = reducedMotion.slice(reducedMotion.indexOf(".settings-backdrop"), reducedMotion.indexOf("{", reducedMotion.indexOf(".settings-backdrop")));
    for (const selector of [".settings-backdrop", ".manage-backdrop", ".manage-dialog", ".settings-dialog", ".app-notice", ".sidebar-update-note", ".prompt-queue", ".queued-prompt", ".composer", ".capabilities-center", ".capabilities-content"]) {
      expect(allowlist).toContain(selector);
    }
    expect(reducedMotion).toContain("animation: none !important");
    expect(reducedMotion).toContain("animation: reduced-motion-fade-in var(--duration-fast) linear both !important");
    expect(reducedMotion).toContain(".startup-progress i { width: 100%; transform: none; animation: none !important; will-change: auto; }");
    expect(appCss).toContain("@keyframes reduced-motion-fade-in { from { opacity: 0; } }");
    expect(appCss).toMatch(/\.startup-progress i\s*\{[^}]*animation: startup-progress 1\.35s linear infinite;/s);
    expect(tokensCss.slice(tokensCss.lastIndexOf("@media (prefers-reduced-motion: reduce)"))).toContain("--duration-fast: 60ms");
  });

  it("promotes summaries only after completion without replaying activity motion", () => {
    const activity = appSource.indexOf("<ActivityTimeline turn={turn}");
    const summary = appSource.indexOf('{final && <article className="assistant-message markdown">');
    expect(activity).toBeGreaterThan(-1);
    expect(summary).toBeGreaterThan(activity);
    expect(appSource).toContain('if (turn.running || !assistant.length) return { commentary: assistant };');
    expect(appCss).not.toMatch(/\.activity-content\s*\{[^}]*animation:/s);
    expect(appCss).not.toContain("@keyframes activity-in");
  });

  it("keeps prompt submission, queue controls, and the transcript stable", () => {
    const send = appSource.slice(appSource.indexOf("async function send("), appSource.indexOf("function stopThread("));
    const composerTextarea = appCss.match(/\.composer textarea\s*\{([^}]*)\}/s)?.[1] ?? "";
    const queue = appCss.match(/\.prompt-queue\s*\{([^}]*)\}/s)?.[1] ?? "";
    const queued = appCss.match(/\.queued-prompt\s*\{([^}]*)\}/s)?.[1] ?? "";
    const actions = appCss.match(/\.queued-prompt-actions\s*\{([^}]*)\}/s)?.[1] ?? "";
    const compactConfig = appCss.slice(appCss.indexOf("@container conversation (max-width: 460px)"), appCss.indexOf("@container conversation (max-width: 420px)"));

    expect(send).not.toContain("timelinePinned.current = true");
    expect(send).not.toContain("setShowJumpToLatest(false)");
    expect(appSource).toContain('event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey');
    expect(composerTextarea).toContain("width: 100%");
    expect(composerTextarea).toContain("background: transparent");
    expect(composerTextarea).toContain("box-shadow: none");
    expect(queue).toContain("border-bottom: 1px solid var(--color-border)");
    expect(queue).toContain("background: transparent");
    expect(queue).not.toContain("border-radius");
    expect(queued).toContain("grid-template-columns: minmax(0, 1fr) auto");
    expect(actions).not.toContain("position: absolute");
    expect(actions).toContain("opacity: 0");
    expect(compactConfig).toContain(".config-trigger > span");
    expect(appCss.slice(appCss.indexOf("@container conversation (max-width: 620px)"), appCss.indexOf("@container conversation (max-width: 460px)"))).not.toContain(".config-trigger");
    expect(appSource).toContain("timeline.length - 4");
    expect(appSource).toContain("timeline.slice(-4)");
    expect(appSource).toContain('(turn.record.usage?.totalTokens != null || turn.record.stopReason === "cancelled" || failure) && <div className="turn-report-meta">');
  });

  it("applies the shared focus lifecycle to every management modal", () => {
    expect(appSource).toContain("useModalFocus<HTMLFormElement>()");
    expect(appSource).toContain("useModalFocus<HTMLDivElement>()");
    expect(appSource).toContain('useModalFocus<HTMLElement>(".settings-link")');
    expect(appSource.match(/ref=\{dialogRef\}/g)).toHaveLength(3);
    expect(appSource).toContain("autoFocus={!renaming}");
    expect(appSource).toContain("target?.focus({ preventScroll: true })");
  });

  it("derives native Settings control names from their row copy", () => {
    expect(appSource).toContain("type SettingsRowLabels = { labelledBy: string; describedBy: string }");
    expect(appSource).toContain("<strong id={labels.labelledBy}>{title}</strong>");
    expect(appSource).toContain("<small id={labels.describedBy}>{description}</small>");
    expect(appSource.match(/aria-labelledby=\{labelledBy\}/g)?.length).toBeGreaterThanOrEqual(6);
    expect(appSource.match(/aria-describedby=\{describedBy\}/g)?.length).toBeGreaterThanOrEqual(6);
  });
});
