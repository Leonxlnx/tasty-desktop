import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityTimeline, activityPreview, applyDraftConfig, applyEvents, clampPanelWidth, compactToolPreview, ComposerConfig, composerPrimaryAction, composerTrigger, contextPercent, dedupeActivityEntries, draftConfigOverrides, effectiveRailWidth, extractLocalPaths, filterByTitle, filterRuntimeSessions, findLocalPreviewUrl, floatingMenuPosition, groupProjects, hasBlockingWork, isYoloChoice, latestTimelineItemId, modeDescription, normalizeAvailableCommands, normalizeLocalPreviewUrl, normalizeThread, presentDiagnostic, projectTurns, promptShortcutMode, reorderPaths, shouldScheduleRuntimeRecovery, shouldSubmitPrompt, showSidebarUpdate, subagentRuns, summarizeDiff, thinkingEffortLabel, toggleComposerTrigger, turnAssistantMessages, updatePercent, workspaceName, workspaceRelativePath } from "./App";

describe("composer send key", () => {
  it("sends on Enter by default and preserves Shift+Enter newlines", () => {
    const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false };

    expect(shouldSubmitPrompt(enter, "enter")).toBe(true);
    expect(shouldSubmitPrompt({ ...enter, shiftKey: true }, "enter")).toBe(false);
    expect(shouldSubmitPrompt(enter, "ctrl-enter")).toBe(false);
    expect(shouldSubmitPrompt({ ...enter, ctrlKey: true }, "ctrl-enter")).toBe(true);
  });

  it("queues with Enter and steers with Ctrl+Enter while a task is running", () => {
    const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false };
    expect(promptShortcutMode(enter, "ctrl-enter", true)).toBe("queue");
    expect(promptShortcutMode({ ...enter, ctrlKey: true }, "enter", true)).toBe("steer");
    expect(promptShortcutMode({ ...enter, metaKey: true }, "enter", true)).toBe("steer");
    expect(promptShortcutMode({ ...enter, shiftKey: true }, "enter", true)).toBeUndefined();
  });

  it("uses one primary control for send, stop, and queue", () => {
    expect(composerPrimaryAction(false, true)).toBe("send");
    expect(composerPrimaryAction(true, false)).toBe("stop");
    expect(composerPrimaryAction(true, true)).toBe("queue");
  });

  it("turns raw connection errors into a recoverable message", () => {
    expect(presentDiagnostic("ACP connection closed")).toBe("Kimi runtime disconnected. Reconnecting without stopping active work.");
    expect(presentDiagnostic("Workspace path is required")).toBe("Workspace path is required");
  });

  it("recovers only after a reconnect remains unresolved", () => {
    expect(shouldScheduleRuntimeRecovery("reconnecting", false)).toBe(true);
    expect(shouldScheduleRuntimeRecovery("error", false)).toBe(false);
    expect(shouldScheduleRuntimeRecovery("reconnecting", true)).toBe(false);
  });
});

describe("thread filtering", () => {
  it("matches titles case-insensitively and keeps the full list for an empty query", () => {
    const threads = [{ title: "Refine desktop UI" }, { title: "Fix ACP login" }];
    expect(filterByTitle(threads, "DESKTOP")).toEqual([threads[0]]);
    expect(filterByTitle(threads, " ")).toEqual(threads);
  });
});

describe("update progress", () => {
  it("reports bounded progress only when the server supplies a total", () => {
    expect(updatePercent(25, 100)).toBe(25);
    expect(updatePercent(120, 100)).toBe(100);
    expect(updatePercent(25)).toBeUndefined();
  });

  it("blocks installs for work in any thread and only surfaces actionable sidebar phases", () => {
    const idle = { running: false, queue: [], approvals: [] };
    expect(hasBlockingWork([idle])).toBe(false);
    expect(hasBlockingWork([idle, { ...idle, running: true }])).toBe(true);
    expect(hasBlockingWork([idle, { ...idle, queue: [{ queuedId: "q" }] } as never])).toBe(true);
    expect(hasBlockingWork([idle, { ...idle, approvals: [{ requestId: "approval" }] } as never])).toBe(true);
    expect(hasBlockingWork([idle], true)).toBe(true);
    expect(["available", "downloading", "installing"].map((phase) => showSidebarUpdate(phase as never))).toEqual([true, true, true]);
    expect(showSidebarUpdate("current")).toBe(false);
  });
});

describe("turn activity", () => {
  it("creates a deterministic one-line preview without markdown noise", () => {
    expect(activityPreview("## Inspecting **the files**\n\nNext line")).toBe("Inspecting the files Next line");
    expect(activityPreview("123456789", 6)).toBe("12345…");
  });

  it("deduplicates adjacent identical visible statuses without changing their details", () => {
    const entry = { id: "thought-1", turnId: "turn-1", kind: "thought", status: "completed", text: "**Inspecting files**", seq: 1, createdAt: "2026-07-18T10:00:00.000Z", updatedAt: "2026-07-18T10:00:01.000Z" } as const;
    const distinct = { ...entry, id: "thought-3", text: "Applying changes", seq: 3 };
    expect(dedupeActivityEntries([entry, { ...entry, id: "thought-2", text: "Inspecting files", seq: 2 }, distinct])).toEqual([entry, distinct]);
    expect(entry.text).toBe("**Inspecting files**");
  });

  it("opens only a running timeline and collapses it to Worked for after completion", () => {
    const activity = [{ id: "thought-1", turnId: "turn-1", kind: "thought", status: "in_progress", text: "Inspecting files", seq: 1, createdAt: "2026-07-18T10:00:00.000Z", updatedAt: "2026-07-18T10:00:01.000Z" }];
    const base = { record: { turnId: "turn-1", startedAt: "2026-07-18T10:00:00.000Z" }, messages: [], activity, tools: [], approvals: [], canRevert: false };
    const callbacks = { onOpenUrl: async () => undefined, onOpenLocation: () => undefined };
    const running = renderToStaticMarkup(createElement(ActivityTimeline, { ...callbacks, turn: { ...base, running: true } as never }));
    const completed = renderToStaticMarkup(createElement(ActivityTimeline, { ...callbacks, turn: { ...base, running: false, record: { ...base.record, completedAt: "2026-07-18T10:00:10.000Z" } } as never }));
    expect(running).toContain('<details class="turn-activity" open="">');
    expect(running).toContain("Working");
    expect(completed).not.toContain('<details class="turn-activity" open="">');
    expect(completed).toContain("Worked for 10s");
  });

  it("keeps activity attached to its original turn", () => {
    const thread = normalizeThread({
      threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-18T10:00:00.000Z",
      turns: [{ turnId: "turn-1", startedAt: "2026-07-18T10:00:00.000Z" }, { turnId: "turn-2", startedAt: "2026-07-18T10:01:00.000Z" }],
      activity: [
        { id: "thought-1", turnId: "turn-1", kind: "thought", status: "completed", text: "First", seq: 1, createdAt: "2026-07-18T10:00:00.000Z", updatedAt: "2026-07-18T10:00:01.000Z" },
        { id: "thought-2", turnId: "turn-2", kind: "thought", status: "completed", text: "Second", seq: 2, createdAt: "2026-07-18T10:01:00.000Z", updatedAt: "2026-07-18T10:01:01.000Z" },
      ],
    } as never);
    expect(projectTurns(thread).map((turn) => turn.activity.map((entry) => entry.text))).toEqual([["First"], ["Second"]]);
  });

  it("keeps progress commentary in work and only promotes trailing text to the final summary", () => {
    const activity = [{ id: "tool-1", turnId: "turn-1", kind: "tool", status: "completed", text: "Run checks", seq: 4, updatedSeq: 4, createdAt: "2026-07-18T10:00:01.000Z", updatedAt: "2026-07-18T10:00:02.000Z" }];
    const messages = [
      { turnId: "turn-1", role: "assistant", text: "I am checking the project.", seq: 3, updatedSeq: 3 },
      { turnId: "turn-1", role: "assistant", text: "The fix is ready.", seq: 5, updatedSeq: 5 },
    ];
    const complete = turnAssistantMessages({ activity, messages, running: false } as never);
    expect(complete.commentary.map((message) => message.text)).toEqual(["I am checking the project."]);
    expect(complete.final?.text).toBe("The fix is ready.");
    expect(turnAssistantMessages({ activity: [{ ...activity[0], updatedSeq: 6 }], messages, running: false } as never).final).toBeUndefined();
    expect(turnAssistantMessages({ activity, messages, running: true } as never).commentary).toHaveLength(2);
  });

  it("uses the latest update for the live spinner without reordering the timeline", () => {
    expect(latestTimelineItemId([
      { id: "older-tool", updatedSeq: 9 },
      { id: "newer-commentary", updatedSeq: 6 },
    ])).toBe("older-tool");
  });

  it("keeps live assistant segments ordered around tool updates", () => {
    const base = normalizeThread({
      threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-18T10:00:00.000Z",
    } as never);
    const events = [
      { threadId: "thread", seq: 1, type: "TurnStarted", payload: { turnId: "turn-1", text: "Go" }, createdAt: "2026-07-18T10:00:00.000Z" },
      { threadId: "thread", seq: 2, type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "Inspecting." }, createdAt: "2026-07-18T10:00:01.000Z" },
      { threadId: "thread", seq: 3, type: "ToolCallCreated", payload: { tool: { toolCallId: "tool-1", title: "Read files", status: "in_progress" } }, createdAt: "2026-07-18T10:00:02.000Z" },
      { threadId: "thread", seq: 4, type: "MessageDelta", payload: { turnId: "turn-1", role: "assistant", text: "Applying." }, createdAt: "2026-07-18T10:00:03.000Z" },
    ];
    const updated = applyEvents([base], events as never)[0]!;
    expect(updated.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual(["Inspecting.", "Applying."]);
  });
});

describe("local path links", () => {
  it("extracts deduplicated Windows paths without swallowing punctuation", () => {
    expect(extractLocalPaths("Open `E:\\projects\\android app` or E:\\projects\\android\\app,.")).toEqual([
      "E:\\projects\\android app",
      "E:\\projects\\android\\app",
    ]);
  });
});

describe("project navigation", () => {
  it("groups local and resumable chats under one normalized workspace", () => {
    const threads = [{ cwd: "e:\\work\\KimiDesktop\\", title: "Polish navigation" }] as unknown as Parameters<typeof groupProjects>[1];
    const sessions = [{ cwd: "E:/work/KimiDesktop", title: "Resume auth work" }] as Parameters<typeof groupProjects>[2];
    const projects = groupProjects(["E:\\work\\KimiDesktop"], threads, sessions);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "KimiDesktop" });
    expect(projects[0]?.threads).toHaveLength(1);
    expect(projects[0]?.runtimeSessions).toHaveLength(1);
    expect(workspaceName("C:\\Users\\User\\Project\\")).toBe("Project");
  });

  it("uses a saved project display name without changing its path", () => {
    const projects = groupProjects(["E:\\work\\KimiDesktop"], [], [], { "e:/work/kimidesktop": "Kimi client" });
    expect(projects[0]).toMatchObject({ cwd: "E:\\work\\KimiDesktop", name: "Kimi client" });
  });

  it("never exposes current or legacy internal quota workspaces", () => {
    const paths = [
      "C:/Users/User/AppData/Roaming/KimiCodeDesktop/runtime/quota-probe",
      "C:/Users/User/AppData/Roaming/com.kimicode.desktop/runtime/quota-probe",
      "E:/work/real-project",
    ];
    expect(groupProjects(paths, [], []).map((project) => project.cwd)).toEqual(["E:/work/real-project"]);
  });

  it("keeps managed and removed runtime sessions out of the sidebar", () => {
    const sessions = [{ sessionId: "managed", cwd: "E:\\work" }, { sessionId: "removed", cwd: "E:\\work" }, { sessionId: "visible", cwd: "E:\\work" }];
    const threads = [{ sessionId: "managed" }] as Parameters<typeof filterRuntimeSessions>[1];

    expect(filterRuntimeSessions(sessions, threads, ["removed"]).map((session) => session.sessionId)).toEqual(["visible"]);
  });

  it("keeps standalone chats out of project groups and preserves manual project order", () => {
    const threads = [{ cwd: "C:/Users/User/AppData/Roaming/KimiCodeDesktop/runtime/chats", kind: "chat", title: "Personal chat" }] as unknown as Parameters<typeof groupProjects>[1];
    expect(groupProjects([], threads, [])).toEqual([]);
    expect(reorderPaths(["E:/one", "E:/two", "E:/three"], "E:/three", "E:/one")).toEqual(["E:/three", "E:/one", "E:/two"]);
  });
});

describe("workspace panel sizing", () => {
  it("keeps draggable panels inside usable bounds", () => {
    expect(clampPanelWidth("sidebar", 80)).toBe(84);
    expect(clampPanelWidth("sidebar", 900)).toBe(420);
    expect(clampPanelWidth("rail", 120)).toBe(260);
    expect(clampPanelWidth("rail", 1600)).toBe(1200);
  });

  it("gives the conversation space before rendering a requested rail width", () => {
    expect(effectiveRailWidth(1_200, 1_280, 272)).toBe(608);
    expect(effectiveRailWidth(1_200, 1_280, 60)).toBe(820);
    expect(effectiveRailWidth(420, 900, 272)).toBe(228);
    expect(272 + 400 + effectiveRailWidth(1_200, 900, 272)).toBeLessThanOrEqual(900);
  });
});

describe("sidebar action menus", () => {
  it("keeps the portal inside the viewport and flips it above low rows", () => {
    expect(floatingMenuPosition({ top: 760, right: 250, bottom: 786 }, { width: 200, height: 180 }, { width: 1_000, height: 800 })).toEqual({ top: 576, left: 50 });
    expect(floatingMenuPosition({ top: 100, right: 100, bottom: 120 }, { width: 220, height: 100 }, { width: 1_000, height: 800 })).toEqual({ top: 124, left: 8 });
  });
});

describe("composer context", () => {
  it("shows a compact bounded percentage", () => {
    expect(contextPercent({ context: { used: 26_000, size: 262_000 } })).toBe(10);
    expect(contextPercent({ context: { used: 300_000, size: 262_000 } })).toBe(100);
    expect(contextPercent()).toBeUndefined();
  });
});

describe("Kimi composer capabilities", () => {
  it("recognizes commands, skills, and project-file triggers", () => {
    expect(composerTrigger("please /mcp")).toMatchObject({ kind: "command", prefix: "/", query: "mcp" });
    expect(composerTrigger("$sub")).toMatchObject({ kind: "skill", prefix: "$", query: "sub" });
    expect(composerTrigger("include #src/App")).toMatchObject({ kind: "file", prefix: "#", query: "src/App" });
    expect(composerTrigger("plain prompt")).toBeUndefined();
  });

  it("uses the slash button as a command-picker toggle", () => {
    expect(toggleComposerTrigger("", "/")).toBe("/");
    expect(toggleComposerTrigger("/", "/")).toBe("");
    expect(toggleComposerTrigger("fix this /mcp", "/")).toBe("fix this");
    expect(toggleComposerTrigger("fix this", "/")).toBe("fix this /");
  });

  it("normalizes the real ACP command catalog and keeps files inside the workspace", () => {
    expect(normalizeAvailableCommands([{ name: "/mcp-config", description: " Configure MCP " }, { name: "", description: "bad" }, { name: "mcp-config", description: "duplicate" }])).toEqual([
      { name: "mcp-config", description: "Configure MCP" },
    ]);
    expect(workspaceRelativePath("E:\\work\\project", "e:\\work\\project\\src\\App.tsx")).toBe("src/App.tsx");
    expect(workspaceRelativePath("E:\\work\\project", "E:\\work\\project-other\\secret.txt")).toBeUndefined();
  });
});

describe("tool output previews", () => {
  it("never renders more than four compact lines", () => {
    const preview = compactToolPreview("one\ntwo\nthree\nfour\nfive\nsix");
    expect(preview.split("\n")).toHaveLength(4);
    expect(preview).toContain("3 more lines");
    expect(compactToolPreview("x".repeat(700))).toHaveLength(560);
  });
});

describe("subagent projection", () => {
  it("derives real agent runs from preserved Kimi Agent tool calls", () => {
    expect(subagentRuns({ tools: [{
      toolCallId: "agent-1",
      title: "Agent: inspect performance",
      status: "in_progress",
      rawInput: { subagent_type: "explore", description: "Inspect performance", run_in_background: true },
      content: [{ type: "content", content: { type: "text", text: "agent_id: a1234" } }],
    }] })).toEqual([{ id: "agent-1", type: "explore", description: "Inspect performance", status: "running", background: true, agentId: "a1234" }]);
  });
});

describe("runtime thinking effort", () => {
  it("reports K3's real CLI-managed Max effort without inventing a local toggle", () => {
    const model = { id: "model", name: "Model", currentValue: "kimi-for-coding/k3", options: [{ value: "kimi-for-coding/k3", name: "K3" }] };
    const thinking = { id: "thinking", name: "Thinking", currentValue: "on", options: [{ value: "on", name: "On" }] };
    expect(thinkingEffortLabel(model, thinking)).toBe("Max");
    expect(thinkingEffortLabel(model, { ...thinking, currentValue: "off" })).toBe("Off");
  });

  it("surfaces explicit effort levels only when the runtime offers them", () => {
    const thinking = { id: "thinking", name: "Thinking", currentValue: "standard", options: [{ value: "standard", name: "Standard" }, { value: "high", name: "High" }, { value: "max", name: "Max" }] };
    expect(thinkingEffortLabel(undefined, thinking)).toBe("Standard");
    expect(thinkingEffortLabel(undefined, { ...thinking, currentValue: "high" })).toBe("High");
    expect(thinkingEffortLabel(undefined, { ...thinking, currentValue: "max" })).toBe("Max");
  });
});

describe("draft composer configuration", () => {
  const draftDefaults = [
    { id: "model", name: "Model", type: "select", category: "model", currentValue: "kimi-k3", options: [{ value: "kimi-k3", name: "Kimi K3" }, { value: "kimi-k3-fast", name: "Kimi K3 Fast" }] },
    { id: "thinking", name: "Thinking", type: "select", category: "thought_level", currentValue: "on", options: [{ value: "off", name: "Off" }, { value: "on", name: "On" }] },
    { id: "mode", name: "Mode", type: "select", category: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "plan", name: "Plan" }, { value: "auto", name: "Auto" }, { value: "yolo", name: "YOLO" }] },
  ];

  it("renders model, reasoning, and permission controls before a thread exists", () => {
    const markup = renderToStaticMarkup(createElement(ComposerConfig, { options: draftDefaults, onChange: () => undefined }));
    expect(markup).toContain('aria-label="Model: Kimi K3"');
    expect(markup).toContain('aria-label="Reasoning: Max"');
    expect(markup).toContain('aria-label="Permissions: Default"');
    expect(markup.match(/config-trigger/g)).toHaveLength(3);
  });

  it("renders nothing instead of placeholder controls when the runtime offers no options", () => {
    expect(renderToStaticMarkup(createElement(ComposerConfig, { options: [], onChange: () => undefined }))).toBe("");
  });

  it("hides the reasoning control when the selected model offers no thinking option", () => {
    const options = draftDefaults.filter((option) => option.id !== "thinking");
    const markup = renderToStaticMarkup(createElement(ComposerConfig, { options, onChange: () => undefined }));
    expect(markup).not.toContain("Reasoning");
    expect(markup).toContain('aria-label="Model: Kimi K3"');
  });

  it("keeps validated draft overrides and drops stale persisted values", () => {
    const overrides = draftConfigOverrides(draftDefaults, { model: "kimi-k3-fast", mode: "yolo", thinking: "off" });
    expect(overrides).toEqual({ model: "kimi-k3-fast", mode: "yolo", thinking: "off" });
    const markup = renderToStaticMarkup(createElement(ComposerConfig, { options: applyDraftConfig(draftDefaults, overrides), onChange: () => undefined }));
    expect(markup).toContain('aria-label="Model: Kimi K3 Fast"');
    expect(markup).toContain('aria-label="Reasoning: Off"');
    expect(markup).toContain('aria-label="Permissions: YOLO"');
    expect(draftConfigOverrides(draftDefaults, { model: "kimi-k9", unknown: "x", mode: "default" })).toEqual({});
  });

  it("flags only real yolo choices for the first-use warning", () => {
    const mode = draftDefaults.find((option) => option.id === "mode");
    expect(isYoloChoice(mode, "yolo")).toBe(true);
    expect(isYoloChoice(mode, "default")).toBe(false);
    expect(isYoloChoice(draftDefaults.find((option) => option.id === "model"), "yolo")).toBe(false);
    expect(isYoloChoice(undefined, "yolo")).toBe(false);
    expect(isYoloChoice({ id: "mode", name: "Mode", currentValue: "default", options: [{ value: "full", name: "Full access" }] }, "full")).toBe(true);
  });

  it("describes permission modes honestly", () => {
    expect(modeDescription("yolo", "YOLO")).toMatch(/full access/i);
    expect(modeDescription("plan", "Plan")).toMatch(/plans first/i);
    expect(modeDescription("auto", "Auto")).toMatch(/without asking/i);
    expect(modeDescription("default", "Default")).toMatch(/asks before/i);
  });
});

describe("legacy thread ingress", () => {
  it("fills missing projection collections instead of crashing the desktop shell", () => {
    const thread = normalizeThread({ threadId: "old", sessionId: "session", cwd: "C:\\work", title: "Old chat" } as never);
    expect(thread.turns).toEqual([]);
    expect(thread.messages).toEqual([]);
    expect(thread.activity).toEqual([]);
    expect(thread.configOptions).toEqual([]);
    expect(thread.usage).toEqual({});
    expect(thread.queue).toEqual([]);
    expect(thread.kind).toBe("project");
  });
});

describe("turn change summaries", () => {
  it("counts per-file additions and deletions from a unified diff", () => {
    const diff = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n+next\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n-gone";
    expect(summarizeDiff(diff)).toEqual({
      files: [
        { path: "src/a.ts", additions: 2, deletions: 1 },
        { path: "src/b.ts", additions: 0, deletions: 1 },
      ],
      additions: 2,
      deletions: 2,
    });
  });
});

describe("local app previews", () => {
  it("detects localhost links while refusing remote pages", () => {
    expect(findLocalPreviewUrl("Started the app at **http://localhost:4173/dashboard**.")).toBe("http://localhost:4173/dashboard");
    expect(findLocalPreviewUrl("Preview: 127.0.0.1:3000")).toBe("http://127.0.0.1:3000/");
    expect(normalizeLocalPreviewUrl("5173")).toBe("http://localhost:5173/");
    expect(normalizeLocalPreviewUrl("https://example.com")).toBeUndefined();
  });
});
