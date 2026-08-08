import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityTimeline, activityPreview, appendTerminalEntries, applyDraftConfig, applyEvents, applyTerminalOutputBatch, attachmentRequestMatches, boundedDiffPreview, cacheComposerDraft, cachedComposerDraft, capabilityRequestMatches, capabilityTargetMatches, claimTerminalStart, classifyGitError, clampPanelWidth, compactToolPreview, ComposerConfig, composerCanSubmit, composerDraftTargetKey, composerPrimaryAction, composerTargetRequestMatches, composerTrigger, configDefaultsAreSettled, configTargetKey, configTargetsMatch, contextPercent, createFrameBatcher, createLatestFrameBatcher, createTerminalOutputBatcher, dedupeActivityEntries, draftConfigOverrides, draftRecoveryKey, editorUrl, effectiveRailWidth, effectiveSidebarWidth, extractLocalPaths, filterByTitle, filterKimiRuntimes, filterKimiSkills, filterRuntimeSessions, findLocalPreviewUrl, floatingMenuPosition, forgetRestoredTurnSubmission, forgetThreadTurnSubmissions, gitBranchPageSize, gitChangedFilePageSize, gitDetailRequestMatches, gitDiffLineKind, gitFileActions, gitFileGroup, gitPathBatches, groupProjects, hasBlockingWork, isAppMenuOpenKey, isNearScrollBottom, isYoloChoice, joinLocalPath, keybindingConflicts, latestMatchingRestoredTurnSubmission, latestRestoredTurnSubmission, latestTimelineItemId, loadDraftCreationRecovery, loadSideCreationRecovery, localServerUrl, matchesShortcut, mcpServerRowKey, modeDescription, moveSuggestionIndex, nextProgressiveLimit, normalizeAvailableCommands, normalizeLocalPreviewUrl, normalizeThread, onceForPointer, panelResizeWidth, parseHarnessCommand, parseProjectScripts, preferredGitRemote, preferredInitialThreadId, presentDiagnostic, profileConfigUpdates, progressiveGroups, progressiveRows, projectMcpAction, projectMcpDialogFromSnapshot, projectTurns, promptShortcutMode, providerUsable, railForStandaloneChat, railTabAfter, reasoningStrength, rebaseThreadListSnapshot, recentTurns, releaseUpdateResources, rememberLocallyRecoveredThread, rememberTurnSubmission, reorderPathByOffset, reorderPaths, repositoryNameFromUrl, responsiveConversationMinimum, restoredTurnDraftMatches, reviewCommentKey, reviewFeedbackPrompt, saveDraftCreationRecovery, saveSideCreationRecovery, scopedProgressiveLimit, serverWebSocketUrl, shortcutFromEvent, shouldAcknowledgeYolo, shouldScheduleRuntimeRecovery, shouldShowRuntimePicker, showSidebarUpdate, shouldSubmitPrompt, sidebarToggleState, sideThreadFromCreationResult, skillComposerInsertion, skillInstallDialogFromRequest, subagentCanInspect, subagentRuns, summarizeDiff, terminalCanAutoStart, terminalCommandMayMutateGit, terminalContext, thinkingEffortLabel, threadCanRun, threadCreationAfterFailure, threadCreationAttempt, threadCreationSlotAvailable, threadFromCreationResult, threadListSnapshotIsStable, threadTreeOrder, toggleComposerTrigger, turnAssistantMessages, turnSubmissionAfterFailure, turnSubmissionAttempt, updateCanCancel, updatePercent, updateTerminalGitMutationTracking, visibleQueuedPrompts, workspaceForView, workspaceHasBlockingWork, workspaceName, workspaceRelativePath, workspaceRequestMatches } from "./App";
import { DeliveryUncertainError, RequestNotSentError } from "./connection";
import { composerTargetMatchesAttempt, createTurnProjectionCache, latestCallbackProxy, projectRecentTurns, projectedTurnCount, reconcileTurnProjectionCache } from "./App";

const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

function domainEvent(seq: number, type: string, payload: Record<string, unknown>, threadId = "thread") {
  return { threadId, seq, type, payload, createdAt: new Date(Date.UTC(2026, 6, 30, 0, 0, seq)).toISOString() } as never;
}

function projectionHistory(completedCount: number) {
  const createdAt = "2026-07-30T00:00:00.000Z";
  const turns: Array<{ turnId: string; startedAt: string; completedAt?: string; stopReason?: string }> = Array.from({ length: completedCount }, (_, index) => ({
    turnId: `turn-${index}`,
    startedAt: createdAt,
    completedAt: createdAt,
    stopReason: "end_turn",
  }));
  const messages: Array<{ turnId: string; role: "user" | "assistant"; text: string; seq: number; updatedSeq: number }> = Array.from({ length: completedCount }, (_, index) => ({
    turnId: `turn-${index}`,
    role: "assistant",
    text: `Completed ${index}`,
    seq: index + 1,
    updatedSeq: index + 1,
  }));
  turns.push({ turnId: "turn-live", startedAt: createdAt });
  messages.push({ turnId: "turn-live", role: "user", text: "Continue", seq: completedCount + 1, updatedSeq: completedCount + 1 });
  return normalizeThread({
    threadId: "thread",
    sessionId: "session",
    cwd: "E:/work",
    title: "Work",
    createdAt,
    updatedAt: createdAt,
    running: true,
    activeTurnId: "turn-live",
    lifecycle: { phase: "running", updatedAt: createdAt, turnId: "turn-live" },
    turns,
    messages,
  } as never);
}

describe("global commands", () => {
  it("routes every side-chat action through the durable idempotent helper", () => {
    expect(appSource).not.toContain('call("threads.createSide"');
    expect(appSource.match(/requestSideThread\(/g)).toHaveLength(3);
    expect(appSource).toContain('callIdempotent("threads.createSide", creation.params)');
  });

  it("captures configurable shortcuts and disables conflicts", () => {
    const event = { key: "k", ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
    expect(shortcutFromEvent(event)).toBe("Ctrl+Shift+K");
    expect(matchesShortcut(event, "ctrl+shift+k")).toBe(true);
    expect(shortcutFromEvent({ ...event, key: "Control" })).toBeUndefined();
    const bindings = { palette: "Ctrl+K", newChat: "Ctrl+N", openFolder: "Ctrl+O", toggleSidebar: "Ctrl+B", terminal: "Ctrl+K", settings: "Ctrl+," } as const;
    expect([...keybindingConflicts(bindings as never)].sort()).toEqual(["palette", "terminal"]);
  });

  it("discovers safe package scripts and creates editor handoff URLs", () => {
    expect(parseProjectScripts('{"scripts":{"dev":"vite","test:unit":"vitest","bad name":"nope"}}')).toEqual([
      { name: "dev", command: "vite" }, { name: "test:unit", command: "vitest" },
    ]);
    expect(parseProjectScripts("not json")).toEqual([]);
    expect(editorUrl("vscode", "E:\\hello world")).toBe("vscode://file/E:/hello%20world");
  });

  it("derives safe clone destinations from HTTPS and SSH URLs", () => {
    expect(repositoryNameFromUrl("https://github.com/example/tasty.git")).toBe("tasty");
    expect(repositoryNameFromUrl("git@github.com:example/tasty.git")).toBe("tasty");
    expect(repositoryNameFromUrl("C:\\private\\repo")).toBeUndefined();
    expect(joinLocalPath("E:\\code\\", "tasty")).toBe("E:\\code\\tasty");
  });
});

describe("turn submission", () => {
  it("reuses the exact original steer params for an unchanged manual retry", () => {
    let calls = 0;
    const randomUUID = () => {
      calls += 1;
      return `submission-${calls}`;
    };
    const images = [{ name: "screen.png", mimeType: "image/png", data: "large-image" }];
    const payload = { threadId: "thread-1", text: "ship @{src/app.ts}", mentions: ["src/app.ts"], images, mode: "steer" as const };
    const first = turnSubmissionAttempt(payload, undefined, randomUUID);
    const restored = turnSubmissionAfterFailure(new DeliveryUncertainError("timed out"), first.receipt);
    const retry = turnSubmissionAttempt({ ...payload, mentions: [...payload.mentions], images: [...images], mode: "queue" }, restored, randomUUID);

    expect(first.params.submissionId).toBe("submission-1");
    expect(retry.params).toBe(first.params);
    expect(retry.params.submissionId).toBe("submission-1");
    expect(retry.params.mode).toBe("steer");
    expect(retry.params.images).toBe(images);
    expect(calls).toBe(1);
    expect(turnSubmissionAfterFailure(new Error("rejected"), retry.receipt)).toBeUndefined();
  });

  it("regenerates the ID after the restored prompt or image draft is edited", () => {
    const image = { name: "screen.png", mimeType: "image/png", data: "abc" };
    const payload = { threadId: "thread-1", text: "ship it", mentions: [], images: [image], mode: "queue" as const };
    const first = turnSubmissionAttempt(payload, undefined, () => "submission-1");
    const edited = turnSubmissionAttempt({ ...payload, text: "ship it safely" }, first.receipt, () => "submission-2");

    expect(edited.params.submissionId).toBe("submission-2");
    expect(restoredTurnDraftMatches({ text: payload.text, images: payload.images }, payload.text, payload.images)).toBe(true);
    expect(restoredTurnDraftMatches({ text: payload.text, images: payload.images }, "ship it safely", payload.images)).toBe(false);
    expect(restoredTurnDraftMatches({ text: payload.text, images: payload.images }, payload.text, [{ ...image, data: "changed" }])).toBe(false);
  });

  it("keeps multiple ambiguous receipts bounded without copying image data", () => {
    const receipts = new Map<string, ReturnType<typeof turnSubmissionAttempt>["receipt"]>();
    const image = { name: "screen.png", mimeType: "image/png", data: "large-image" };
    for (let index = 1; index <= 10; index += 1) {
      const attempt = turnSubmissionAttempt({ threadId: `thread-${index}`, text: `task ${index}`, mentions: [], images: [image], mode: "queue" }, undefined, () => `submission-${index}`);
      rememberTurnSubmission(receipts, attempt.receipt);
    }

    expect([...receipts.keys()]).toEqual(["submission-3", "submission-4", "submission-5", "submission-6", "submission-7", "submission-8", "submission-9", "submission-10"]);
    const restored = latestRestoredTurnSubmission(receipts, "thread-10");
    expect(restored?.params.images[0]).toBe(image);
  });

  it("keeps submission order when an older ambiguous failure arrives last", () => {
    const receipts = new Map<string, ReturnType<typeof turnSubmissionAttempt>["receipt"]>();
    const older = turnSubmissionAttempt({ threadId: "thread-1", text: "same", mentions: [], images: [], mode: "queue" }, undefined, () => "older", 1).receipt;
    const newer = turnSubmissionAttempt({ threadId: "thread-1", text: "same", mentions: [], images: [], mode: "steer" }, undefined, () => "newer", 2).receipt;
    rememberTurnSubmission(receipts, newer);
    rememberTurnSubmission(receipts, older);

    expect(latestRestoredTurnSubmission(receipts, "thread-1")).toBe(newer);
  });

  it("evicts the oldest submission order when more than eight failures arrive in reverse", () => {
    const receipts = new Map<string, ReturnType<typeof turnSubmissionAttempt>["receipt"]>();
    const attempts = Array.from({ length: 10 }, (_, index) => {
      const order = index + 1;
      return turnSubmissionAttempt({ threadId: "thread-1", text: `task ${order}`, mentions: [], images: [], mode: "queue" }, undefined, () => `submission-${order}`, order).receipt;
    });

    for (const receipt of [...attempts].reverse()) rememberTurnSubmission(receipts, receipt);

    expect([...receipts.values()].map((receipt) => receipt.order).sort((left, right) => left - right)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
    expect(latestRestoredTurnSubmission(receipts, "thread-1")?.params.submissionId).toBe("submission-10");
  });

  it("keeps an edited in-flight retry hidden but reuses its exact ID for the original draft", () => {
    const receipts = new Map<string, ReturnType<typeof turnSubmissionAttempt>["receipt"]>();
    const original = turnSubmissionAttempt({ threadId: "thread-1", text: "ship it", mentions: [], images: [], mode: "steer" }, undefined, () => "submission-1", 1).receipt;
    rememberTurnSubmission(receipts, original);
    receipts.delete(original.params.submissionId);

    const retained = turnSubmissionAfterFailure(new DeliveryUncertainError("lost retry ACK"), original, original)!;
    rememberTurnSubmission(receipts, retained);
    const matching = latestMatchingRestoredTurnSubmission(receipts, "thread-1", "ship it", []);
    const retry = turnSubmissionAttempt({ threadId: "thread-1", text: "ship it", mentions: [], images: [], mode: "queue" }, matching, () => "wrong-new-id", 2);

    expect(matching).toBe(original);
    expect(retry.params).toBe(original.params);
    expect(retry.params.submissionId).toBe("submission-1");
    expect(retry.params.mode).toBe("steer");
  });

  it("matches the final composer identity after navigating A to B to A", () => {
    const draftA = { kind: "project" as const, cwd: "E:/a" };
    const draftB = { kind: "project" as const, cwd: "E:/b" };

    expect(composerTargetMatchesAttempt(draftB, draftA)).toBe(false);
    expect(composerTargetMatchesAttempt(draftA, draftA)).toBe(true);
    expect(composerTargetMatchesAttempt("created-thread", draftA, "created-thread")).toBe(true);
  });

  it("invalidates only the edited restored draft on one thread", () => {
    const receipts = new Map<string, ReturnType<typeof turnSubmissionAttempt>["receipt"]>();
    for (const [submissionId, text] of [["submission-1", "first"], ["submission-2", "second"]] as const) {
      rememberTurnSubmission(receipts, turnSubmissionAttempt({ threadId: "thread-1", text, mentions: [], images: [], mode: "queue" }, undefined, () => submissionId).receipt);
    }

    forgetRestoredTurnSubmission(receipts, "submission-2");

    expect([...receipts.keys()]).toEqual(["submission-1"]);
    expect(latestRestoredTurnSubmission(receipts, "thread-1")?.params.text).toBe("first");
  });

  it("invalidates every ambiguous receipt for a thread before a config mutation", () => {
    const receipts = new Map<string, ReturnType<typeof turnSubmissionAttempt>["receipt"]>();
    for (const [threadId, submissionId] of [["thread-1", "one"], ["thread-1", "two"], ["thread-2", "other"]] as const) {
      const receipt = turnSubmissionAttempt({ threadId, text: submissionId, mentions: [], images: [], mode: "queue" }, undefined, () => submissionId).receipt;
      rememberTurnSubmission(receipts, receipt);
    }

    forgetThreadTurnSubmissions(receipts, "thread-1");

    expect([...receipts.keys()]).toEqual(["other"]);
  });

  it("never evicts the visible ambiguous draft at the receipt bound", () => {
    const receipts = new Map<string, ReturnType<typeof turnSubmissionAttempt>["receipt"]>();
    const visible = turnSubmissionAttempt({ threadId: "thread-1", text: "visible", mentions: [], images: [], mode: "queue" }, undefined, () => "visible-id").receipt;
    rememberTurnSubmission(receipts, visible);
    for (let index = 1; index <= 8; index += 1) {
      const receipt = turnSubmissionAttempt({ threadId: "thread-1", text: `task ${index}`, mentions: [], images: [], mode: "queue" }, undefined, () => `submission-${index}`).receipt;
      rememberTurnSubmission(receipts, receipt, 8, "visible-id");
    }

    expect(receipts.size).toBe(8);
    expect(receipts.get("visible-id")).toBe(visible);
  });

  it("reuses one creation ID only for unchanged semantic create params", () => {
    const params = { cwd: "E:/work", provider: "kimi", config: { model: "k3" } };
    const first = threadCreationAttempt(params, undefined, () => "creation-1");
    const ambiguous = threadCreationAfterFailure(new DeliveryUncertainError("lost ack"), first);
    const retry = threadCreationAttempt({ provider: "kimi", config: { model: "k3" }, cwd: "E:/work" }, ambiguous, () => "unused");

    expect(retry).toBe(first);
    expect(retry.params.creationId).toBe("creation-1");
    expect(threadCreationAfterFailure(new RequestNotSentError("offline"), retry, ambiguous)).toBe(ambiguous);
    expect(threadCreationAttempt({ ...params, cwd: "E:/other" }, ambiguous, () => "creation-2").params.creationId).toBe("creation-2");
  });

  it("retains each ambiguous creation ID when draft config changes A to B to A", () => {
    const receipts = new Map<string, ReturnType<typeof threadCreationAttempt>>();
    const attempt = (model: string, creationId: string) => {
      const params = { cwd: "E:/work", provider: "kimi", config: { reasoning: "high", model } };
      const probe = threadCreationAttempt(params, undefined, () => creationId);
      const restored = receipts.get(probe.fingerprint);
      const result = threadCreationAttempt(params, restored, () => creationId);
      receipts.set(result.fingerprint, result);
      return result;
    };

    const firstA = attempt("k3", "creation-a");
    const firstB = attempt("k3-fast", "creation-b");
    const secondA = attempt("k3", "unused-a");

    expect(firstA.params.creationId).toBe("creation-a");
    expect(firstB.params.creationId).toBe("creation-b");
    expect(secondA).toBe(firstA);
  });

  it("persists ambiguous creation IDs across reload and clears them after resolution", () => {
    let serialized: string | null = null;
    const storage = {
      getItem: (_key: string) => serialized,
      setItem: (_key: string, value: string) => { serialized = value; },
    };
    const draft = { kind: "project" as const, cwd: "E:/work", isolate: true };
    const receipt = threadCreationAttempt({ cwd: draft.cwd, config: { model: "k3" } }, undefined, () => "creation-1");
    const drafts = new Map([[draftRecoveryKey(draft), draft]]);
    const receipts = new WeakMap([[draft, new Map([[receipt.fingerprint, receipt]])]]);

    expect(saveDraftCreationRecovery(drafts, receipts, storage)).toBe(true);
    const restored = loadDraftCreationRecovery(storage);
    const restoredDraft = restored.drafts.get(draftRecoveryKey(draft));
    const restoredReceipt = restoredDraft ? restored.receipts.get(restoredDraft)?.get(receipt.fingerprint) : undefined;

    expect(restoredDraft).toEqual(draft);
    expect(restoredReceipt?.params.creationId).toBe("creation-1");
    expect(threadCreationAttempt({ cwd: draft.cwd, config: { model: "k3" } }, restoredReceipt, () => "wrong-new-id").params.creationId).toBe("creation-1");

    expect(saveDraftCreationRecovery(new Map(), new WeakMap(), storage)).toBe(true);
    expect(loadDraftCreationRecovery(storage).drafts.size).toBe(0);
  });

  it("persists and reuses ambiguous side-chat creation IDs only for the same parent and title", () => {
    let serialized: string | null = null;
    const storage = {
      getItem: (_key: string) => serialized,
      setItem: (_key: string, value: string) => { serialized = value; },
    };
    const original = threadCreationAttempt({ threadId: "parent-1", title: "Explore" }, undefined, () => "11111111-1111-4111-8111-111111111111");
    const receipts = new Map([[original.fingerprint, original]]);
    expect(saveSideCreationRecovery(receipts, storage)).toBe(true);

    const restored = loadSideCreationRecovery(storage);
    const same = threadCreationAttempt({ title: "Explore", threadId: "parent-1" }, restored.get(original.fingerprint), () => "unused");
    const changedTitle = threadCreationAttempt({ threadId: "parent-1", title: "Changed" }, restored.get(original.fingerprint), () => "side-creation-2");
    const changedParent = threadCreationAttempt({ threadId: "parent-2", title: "Explore" }, restored.get(original.fingerprint), () => "side-creation-3");

    expect(same.params.creationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(changedTitle.params.creationId).toBe("side-creation-2");
    expect(changedParent.params.creationId).toBe("side-creation-3");
    expect(threadCreationAfterFailure(new DeliveryUncertainError("lost ack"), same)?.params.creationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(threadCreationAfterFailure(new RequestNotSentError("offline"), same, original)).toBe(original);
    expect(saveSideCreationRecovery(new Map(), storage)).toBe(true);
    expect(loadSideCreationRecovery(storage).size).toBe(0);
  });

  it("ignores corrupt or semantically altered side-chat recovery receipts", () => {
    const valid = threadCreationAttempt({ threadId: "parent-1" }, undefined, () => "11111111-1111-4111-8111-111111111111");
    const storage = {
      getItem: (_key: string) => JSON.stringify({ version: 1, receipts: [
        valid,
        { ...valid, params: { ...valid.params, threadId: "other-parent" } },
        { fingerprint: "bad", params: { threadId: "parent-1" } },
      ] }),
      setItem: (_key: string, _value: string) => undefined,
    };

    const restored = loadSideCreationRecovery(storage);
    expect([...restored.values()]).toEqual([valid]);
  });

  it("refuses to report a creation receipt durable when storage rejects it", () => {
    const draft = { kind: "chat" as const };
    const receipt = threadCreationAttempt({ standalone: true }, undefined, () => "creation-1");
    const storage = {
      getItem: (_key: string) => null,
      setItem: (_key: string, _value: string) => { throw new Error("quota exceeded"); },
    };

    expect(saveDraftCreationRecovery(new Map([[draftRecoveryKey(draft), draft]]), new WeakMap([[draft, new Map([[receipt.fingerprint, receipt]])]]), storage)).toBe(false);
    expect(saveDraftCreationRecovery(new Map(), new WeakMap(), undefined)).toBe(false);
  });

  it("treats malformed create results as uncertain before a receipt can be cleared", () => {
    for (const result of [undefined, {}, { thread: null }, { thread: {} }, { thread: { threadId: "thread-1" } }, { thread: { threadId: "thread-1", sessionId: "session-1", queue: [null] } }]) {
      expect(() => threadFromCreationResult(result)).toThrowError(DeliveryUncertainError);
    }

    const normalized = threadFromCreationResult({ thread: { threadId: "thread-1", sessionId: "session-1" } });
    expect(normalized.threadId).toBe("thread-1");
    expect(normalized.sessionId).toBe("session-1");
  });

  it("treats a side-chat response for another parent or provider as uncertain", () => {
    const parent = { threadId: "parent-1", provider: "kimi" as const, kind: "project" as const };
    const valid = { thread: { threadId: "side-1", sessionId: "session-1", parentThreadId: parent.threadId, provider: "kimi", kind: "project" } };
    expect(sideThreadFromCreationResult(valid, parent).threadId).toBe("side-1");
    expect(() => sideThreadFromCreationResult({ thread: { ...valid.thread, parentThreadId: "parent-2" } }, parent)).toThrowError(DeliveryUncertainError);
    expect(() => sideThreadFromCreationResult({ thread: { ...valid.thread, provider: "claude" } }, parent)).toThrowError(DeliveryUncertainError);
    expect(() => sideThreadFromCreationResult({ thread: { ...valid.thread, kind: "chat" } }, parent)).toThrowError(DeliveryUncertainError);
  });

  it("recovers the same draft identity after navigation without evicting exact creation IDs", () => {
    const draft = { kind: "project" as const, cwd: "E:\\Work\\", isolate: true };
    const recoverable = new Map([[draftRecoveryKey(draft), draft]]);
    const reopened = recoverable.get(draftRecoveryKey({ kind: "project", cwd: "e:/work", isolate: true }));
    const receipts = new Map<string, ReturnType<typeof threadCreationAttempt>>();
    for (let index = 0; index < 8; index += 1) {
      const receipt = threadCreationAttempt({ cwd: draft.cwd, config: { model: `k3-${index}` } }, undefined, () => `creation-${index}`);
      receipts.set(receipt.fingerprint, receipt);
    }

    expect(reopened).toBe(draft);
    expect(threadCreationSlotAvailable(receipts, [...receipts.keys()][0]!)).toBe(true);
    expect(threadCreationSlotAvailable(receipts, "new-fingerprint")).toBe(false);
    expect(receipts.size).toBe(8);
  });

  it("gates draft submission on the selected runtime defaults and async target", () => {
    expect(configDefaultsAreSettled(false, { target: "kimi:a", settled: true }, "kimi:b")).toBe(false);
    expect(configDefaultsAreSettled(false, { target: "kimi:b", settled: false }, "kimi:b")).toBe(false);
    expect(configDefaultsAreSettled(false, { target: "kimi:b", settled: true }, "kimi:b")).toBe(true);
    expect(configDefaultsAreSettled(true, { target: "", settled: false }, "kimi:b")).toBe(true);
    expect(composerTargetRequestMatches(3, 4)).toBe(false);
    expect(attachmentRequestMatches(2, 2, 3, 4)).toBe(false);
    expect(attachmentRequestMatches(2, 2, 3, 3)).toBe(true);
  });

  it("isolates text and image drafts by thread and unsent draft target", () => {
    const drafts = new Map();
    const image = { name: "a.png", mimeType: "image/png", data: "base64-a" };
    const isolatedProject = { kind: "project" as const, cwd: "E:/work", isolate: true };
    const regularProject = { kind: "project" as const, cwd: "e:\\work", isolate: false };

    cacheComposerDraft(drafts, "thread-a", { text: "Draft A", images: [image] });
    expect(cachedComposerDraft(drafts, "thread-b")).toBeUndefined();
    cacheComposerDraft(drafts, "thread-b", { text: "Draft B", images: [] });

    expect(cachedComposerDraft(drafts, "thread-a")).toEqual({ text: "Draft A", images: [image] });
    expect(cachedComposerDraft(drafts, "thread-b")).toEqual({ text: "Draft B", images: [] });
    expect(cachedComposerDraft(drafts, "thread-a")?.images).not.toBe(cachedComposerDraft(drafts, "thread-a")?.images);
    expect(composerDraftTargetKey(isolatedProject)).not.toBe(composerDraftTargetKey(regularProject));
    expect(composerDraftTargetKey({ kind: "chat" })).not.toBe(composerDraftTargetKey("chat"));

    cacheComposerDraft(drafts, "thread-a", { text: "", images: [] });
    expect(cachedComposerDraft(drafts, "thread-a")).toBeUndefined();
    expect(cachedComposerDraft(drafts, "thread-b")?.text).toBe("Draft B");
  });
});

describe("thread snapshot recovery", () => {
  it("rejects a list captured across mutations and overlays bounded recovered threads", () => {
    const listed = normalizeThread({ threadId: "listed", sessionId: "listed", cwd: "E:/work", title: "Listed" } as never);
    const recovered = new Map<string, ReturnType<typeof normalizeThread>>();
    for (const id of ["old", "created", "side"]) {
      rememberLocallyRecoveredThread(recovered, normalizeThread({ threadId: id, sessionId: id, cwd: "E:/work", title: id } as never), 2);
    }

    expect(threadListSnapshotIsStable(4, 5)).toBe(false);
    expect(threadListSnapshotIsStable(5, 5)).toBe(true);
    expect([...recovered.keys()]).toEqual(["created", "side"]);
    expect(rebaseThreadListSnapshot([listed], recovered.values()).map((thread) => thread.threadId)).toEqual(["created", "side", "listed"]);
    expect(rebaseThreadListSnapshot([listed, recovered.get("created")!], recovered.values()).map((thread) => thread.threadId)).toEqual(["side", "listed", "created"]);
  });
});

describe("Git workspace rail", () => {
  it("keeps both actions for files with staged and unstaged changes", () => {
    expect(gitFileActions({ staged: true, unstaged: true })).toEqual(["stage", "unstage"]);
    expect(gitPathBatches(Array.from({ length: 501 }, (_, index) => String(index))).map((batch) => batch.length)).toEqual([500, 1]);
    expect(["DD", "AU", "UD", "UA", "DU", "AA", "UU"].map((status) => gitFileGroup({ staged: true, indexStatus: status[0]!, worktreeStatus: status[1]! }))).toEqual(Array(7).fill("conflicts"));
    expect(gitFileGroup({ staged: true, indexStatus: "M", worktreeStatus: "." })).toBe("staged");
  });

  it("keeps a valid remote selection and otherwise prefers origin", () => {
    const remotes = [{ name: "backup" }, { name: "origin" }];
    expect(preferredGitRemote(remotes, "backup")).toBe("backup");
    expect(preferredGitRemote(remotes, "missing")).toBe("origin");
    expect(preferredGitRemote(remotes, "missing", "backup/main")).toBe("backup");
    expect(preferredGitRemote([{ name: "upstream" }], "")).toBe("upstream");
  });

  it("classifies inline failures and unified diff lines", () => {
    expect(classifyGitError(new Error("fatal: Authentication failed")).kind).toBe("authentication");
    expect(classifyGitError(new Error("branch is not fully merged")).kind).toBe("conflict");
    expect(["+++ b/a.ts", "+added", "-removed", "@@ -1 +1 @@", " same"].map(gitDiffLineKind)).toEqual(["meta", "added", "removed", "hunk", "context"]);
  });

  it("keeps workspace tool tabs ordered and keyboard reachable", () => {
    expect(railTabAfter("preview", "ArrowRight", true)).toBe("terminal");
    expect(railTabAfter("changes", "ArrowRight", true)).toBe("git");
    expect(railTabAfter("preview", "ArrowLeft", true)).toBe("agents");
    expect(railTabAfter("git", "Home", true)).toBe("preview");
    expect(railTabAfter("git", "End", true)).toBe("agents");
    expect(railTabAfter("agents", "ArrowRight", false)).toBe("agents");
    expect(railTabAfter("changes", "Escape", true)).toBe("changes");
  });

  it("bounds rendered diffs and rejects stale detail requests", () => {
    expect(boundedDiffPreview("a\nb\nc", 2, 100)).toEqual({ lines: ["a", "b"], omittedLines: 1 });
    expect(boundedDiffPreview("long\nnext", 10, 4)).toEqual({ lines: ["long"], omittedLines: 1 });
    expect(gitDetailRequestMatches(2, 2, "E:\\work", "e:/work/")).toBe(true);
    expect(gitDetailRequestMatches(1, 2, "E:/work", "E:/work")).toBe(false);
    expect(gitDetailRequestMatches(2, 2, "E:/work-a", "E:/work-b")).toBe(false);
  });

  it("progressively reveals large file and branch inventories without losing truthful totals", () => {
    const rows = Array.from({ length: 5_000 }, (_, index) => `row-${index}`);
    expect(progressiveRows(rows, gitChangedFilePageSize)).toEqual(rows.slice(0, 60));
    expect(nextProgressiveLimit(gitChangedFilePageSize, rows.length, gitChangedFilePageSize)).toBe(120);
    expect(nextProgressiveLimit(4_980, rows.length, gitChangedFilePageSize)).toBe(5_000);

    const groups = progressiveGroups([
      { id: "conflicts", items: rows.slice(0, 2) },
      { id: "staged", items: rows.slice(2, 42) },
      { id: "changes", items: rows.slice(42, 142) },
    ], gitChangedFilePageSize);
    expect(groups.map(({ id, items, total }) => ({ id, visible: items.length, total }))).toEqual([
      { id: "conflicts", visible: 2, total: 2 },
      { id: "staged", visible: 40, total: 40 },
      { id: "changes", visible: 18, total: 100 },
    ]);
    expect(groups.reduce((total, group) => total + group.items.length, 0)).toBe(gitChangedFilePageSize);
    expect(progressiveRows(rows, gitBranchPageSize)).toHaveLength(60);
    expect(scopedProgressiveLimit({ scope: "", limit: 4_000 }, "needle", gitBranchPageSize)).toBe(60);
    expect(scopedProgressiveLimit({ scope: "needle", limit: 120 }, "needle", gitBranchPageSize)).toBe(120);
  });

  it("filters the complete branch inventory before applying the DOM limit", () => {
    const branches = Array.from({ length: 2_000 }, (_, index) => ({ name: `branch-${index}` }));
    const filtered = branches.filter((branch) => branch.name.includes("branch-1999"));
    expect(progressiveRows(filtered, gitBranchPageSize)).toEqual([{ name: "branch-1999" }]);
  });

  it("recognizes mutating terminal Git commands without refreshing for read-only lookups", () => {
    for (const command of [
      "git add .",
      "git -C E:\\work switch feature",
      "npm test; git commit -m test",
      "git status && git push",
      "& git.exe branch -D stale",
      "git --no-pager -C E:\\work remote add upstream https://example.com/repo.git",
      "git config user.name Tasty",
      "git config set user.name Tasty",
      "git stash pop",
      "git worktree add ..\\feature feature",
    ]) expect(terminalCommandMayMutateGit(command)).toBe(true);
    for (const command of [
      "git status",
      "git diff branch",
      "git show stash",
      "git log --grep branch",
      "git branch",
      "git branch --show-current",
      "git remote -v",
      "git config --get user.name",
      "git config get user.name",
      "git config get --all user.name",
      "git config get-urlmatch https://example.com",
      "git stash list",
      "git worktree list",
      "git tag --list release-*",
      "echo git add",
      "npm test",
    ]) {
      expect(terminalCommandMayMutateGit(command)).toBe(false);
    }
  });

  it("tracks terminal Git mutations per session until a later command or shell exit", () => {
    const sessions = new Set(["other-session"]);
    expect(updateTerminalGitMutationTracking(sessions, "git-session", "git commit -m test")).toBe(true);
    expect([...sessions].sort()).toEqual(["git-session", "other-session"]);
    expect(updateTerminalGitMutationTracking(sessions, "git-session", "git status")).toBe(false);
    expect([...sessions]).toEqual(["other-session"]);
  });
});

describe("terminal prompt context", () => {
  it("attaches only a bounded explicit output tail", () => {
    expect(terminalContext([])).toBe("");
    expect(terminalContext([{ id: 1, kind: "stdout", text: "before\n" }, { id: 2, kind: "stdout", text: "latest\n" }], 8)).toBe("<terminal_context>\ne\nlatest\n</terminal_context>\n");
  });

  it("batches adjacent output while bounding entries and total characters", () => {
    const merged = appendTerminalEntries(
      [{ id: 1, kind: "stdout", text: "abcdef" }],
      [{ id: 2, kind: "stdout", text: "gh" }, { id: 3, kind: "stderr", text: "WXYZ" }],
      3,
      8,
    );
    expect(merged.map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: "stdout", text: "efgh" }, { kind: "stderr", text: "WXYZ" }]);
    expect(appendTerminalEntries([], [
      { id: 1, kind: "command", text: "1" }, { id: 2, kind: "system", text: "2" }, { id: 3, kind: "command", text: "3" },
    ], 2, 100).map((entry) => entry.id)).toEqual([2, 3]);
  });

  it("applies a frame of terminal output and closes an exited session once", () => {
    const tabs = [{ tabId: "tab", cwd: "E:/work", name: "Terminal", session: { sessionId: "session", cwd: "E:/work", shell: "pwsh" }, entries: [], command: "", starting: false }];
    const [tab] = applyTerminalOutputBatch(tabs, [
      { sessionId: "session", type: "stdout", text: "one" },
      { sessionId: "session", type: "stdout", text: " two" },
      { sessionId: "session", type: "exit", code: 0 },
    ]);
    expect(tab?.session).toBeUndefined();
    expect(tab?.startError).toBe("Terminal exited. Restart to open a new shell.");
    expect(tab?.entries.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "stdout", text: "one two" },
      { kind: "system", text: "Process exited with code 0\n" },
    ]);
  });

  it("flushes terminal output once through the fallback or cleanup path", () => {
    let frame: FrameRequestCallback | undefined;
    let fallback: (() => void) | undefined;
    const applied: string[][] = [];
    const batcher = createTerminalOutputBatcher(
      (events) => applied.push(events.map((event) => event.text ?? event.type)),
      (callback) => { frame = callback; return 1; },
      () => undefined,
      (callback) => { fallback = callback; return 2; },
      () => undefined,
    );
    batcher.push({ sessionId: "session", type: "stdout", text: "one" });
    batcher.push({ sessionId: "session", type: "stdout", text: "two" });
    fallback?.();
    frame?.(0);
    batcher.flush();
    expect(applied).toEqual([["one", "two"]]);

    batcher.push({ sessionId: "session", type: "stderr", text: "cleanup" });
    batcher.flush();
    expect(applied).toEqual([["one", "two"], ["cleanup"]]);
  });

  it("batches stored domain events through fallback and resets after cleanup", () => {
    let frame: FrameRequestCallback | undefined;
    let fallback: (() => void) | undefined;
    let cancelledFrames = 0;
    let clearedFallbacks = 0;
    const applied: number[][] = [];
    const batcher = createFrameBatcher(
      (events: Array<{ seq: number }>) => applied.push(events.map((event) => event.seq)),
      (callback) => { frame = callback; return 1; },
      () => { cancelledFrames += 1; },
      (callback) => { fallback = callback; return 2; },
      () => { clearedFallbacks += 1; },
    );
    batcher.push({ seq: 1 });
    batcher.push({ seq: 2 });
    fallback?.();
    frame?.(0);
    expect(applied).toEqual([[1, 2]]);
    expect([cancelledFrames, clearedFallbacks]).toEqual([1, 1]);
    batcher.push({ seq: 3 });
    batcher.flush();
    expect(applied).toEqual([[1, 2], [3]]);
    expect([cancelledFrames, clearedFallbacks]).toEqual([2, 2]);
  });

  it("requires an explicit retry after a terminal start rejection", () => {
    expect(terminalCanAutoStart({ session: undefined, starting: false })).toBe(true);
    expect(terminalCanAutoStart({ session: undefined, starting: true })).toBe(false);
    expect(terminalCanAutoStart({ session: { sessionId: "session", cwd: "E:/work", shell: "pwsh" }, starting: false })).toBe(false);
    expect(terminalCanAutoStart({ session: undefined, starting: false, startError: "spawn failed" })).toBe(false);
    const starts = new Set<string>();
    expect(claimTerminalStart(starts, "tab", { session: undefined, starting: false })).toBe(true);
    expect(claimTerminalStart(starts, "tab", { session: undefined, starting: false })).toBe(false);
  });
});

describe("panel resize lifecycle", () => {
  it("coalesces pointer samples and flushes the latest width", () => {
    let frame: FrameRequestCallback | undefined;
    let cancelled = 0;
    const applied: number[] = [];
    const batcher = createLatestFrameBatcher<number>(
      (width) => applied.push(width),
      (callback) => { frame = callback; return 7; },
      () => { cancelled += 1; },
    );
    batcher.push(220);
    batcher.push(260);
    frame?.(0);
    expect(applied).toEqual([260]);

    batcher.push(300);
    batcher.push(340);
    batcher.flush();
    frame?.(0);
    expect(applied).toEqual([260, 340]);
    expect(cancelled).toBe(1);
  });

  it("commits only once when pointer completion signals overlap", () => {
    let commits = 0;
    const finish = onceForPointer(7, () => { commits += 1; });
    finish({ pointerId: 6 });
    finish({ pointerId: 7 });
    finish({ pointerId: 7 });
    expect(commits).toBe(1);
  });
});

describe("agent skill install requests", () => {
  it("opens confirmation only for a source inside the requested workspace", () => {
    expect(skillInstallDialogFromRequest({ cwd: "C:\\work", source: "C:\\work\\skill", name: "Example" })).toEqual({
      kind: "install-skill",
      cwd: "C:\\work",
      source: "C:\\work\\skill",
      name: "Example",
    });
    expect(skillInstallDialogFromRequest({ cwd: "C:\\work", source: "C:\\other\\skill", name: "Example" })).toBeUndefined();
    expect(skillInstallDialogFromRequest({ cwd: "C:\\work", source: "C:\\work\\skill", name: "" })).toBeUndefined();
  });
});

describe("agent profiles", () => {
  it("applies only values the active runtime still supports", () => {
    const options = [
      { id: "model", name: "Model", category: "model", currentValue: "k3", options: [{ value: "k3", name: "K3" }, { value: "k3-max", name: "K3 Max" }] },
      { id: "thinking", name: "Reasoning", category: "thinking", currentValue: "high", options: [{ value: "high", name: "High" }] },
      { id: "mode", name: "Permission", category: "mode", currentValue: "default", options: [{ value: "default", name: "Default" }] },
    ];
    expect(profileConfigUpdates(options, { model: "k3-max", reasoning: "removed", permission: "default" })).toEqual([{ id: "model", value: "k3-max" }]);
  });
});

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

  it("keeps one primary control as send while idle and stop for all running states", () => {
    expect(composerPrimaryAction(false)).toBe("send");
    expect(composerPrimaryAction(true)).toBe("stop");
  });

  it("never submits to a hidden view or while configuration is still applying", () => {
    expect(composerCanSubmit("projects", "project", false)).toBe(true);
    expect(composerCanSubmit("chats", "chat", false)).toBe(true);
    expect(composerCanSubmit("chats", "project", false)).toBe(false);
    expect(composerCanSubmit("projects", "chat", false)).toBe(false);
    expect(composerCanSubmit("projects", "project", true)).toBe(false);
  });

  it("turns raw connection errors into a recoverable message", () => {
    expect(presentDiagnostic("ACP connection closed")).toBe("Agent runtime disconnected. Reconnecting without stopping active work.");
    expect(presentDiagnostic("Workspace path is required")).toBe("Workspace path is required");
    expect(presentDiagnostic("spawn EPERM")).toBeUndefined();
    expect(presentDiagnostic("spawn ENOENT")).toBe("A required local tool was not found. Check the Kimi CLI in Settings.");
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
    expect(hasBlockingWork([idle, { ...idle, lifecycle: { phase: "preparing", updatedAt: "2026-07-27T00:00:00.000Z" } } as never])).toBe(true);
    expect(hasBlockingWork([idle, { ...idle, queue: [{ queuedId: "q" }] } as never])).toBe(true);
    expect(hasBlockingWork([idle, { ...idle, approvals: [{ requestId: "approval" }] } as never])).toBe(true);
    expect(hasBlockingWork([idle, { ...idle, backgroundTasks: [{ status: "running" }] } as never])).toBe(true);
    expect(hasBlockingWork([idle, { ...idle, backgroundTasks: [{ status: "completed", reportQueued: true }] } as never])).toBe(false);
    expect(hasBlockingWork([idle, { ...idle, backgroundTasks: [{ status: "failed" }] } as never])).toBe(false);
    expect(hasBlockingWork([idle, { ...idle, backgroundTasks: [{ status: "killed" }] } as never])).toBe(false);
    expect(hasBlockingWork([idle, { ...idle, backgroundTasks: [{ status: "completed", reportDeliveredAt: "2026-07-25T10:00:00Z" }] } as never])).toBe(false);
    expect(hasBlockingWork([idle, { ...idle, backgroundTasks: [{ status: "failed", reportCancelledAt: "2026-07-25T10:00:00Z" }] } as never])).toBe(false);
    expect(hasBlockingWork([idle], true)).toBe(true);
    expect(["available", "downloading", "installing"].map((phase) => showSidebarUpdate(phase as never))).toEqual([true, true, true]);
    expect(showSidebarUpdate("current")).toBe(false);
    expect(updateCanCancel("downloading", true)).toBe(true);
    expect(updateCanCancel("downloading", false)).toBe(false);
    expect(updateCanCancel("installing", true)).toBe(false);
  });

  it("blocks Git mutations only for active project work in the current workspace", () => {
    const thread = { cwd: "E:\\work", kind: "project" as const, running: true, queue: [], approvals: [] };
    expect(workspaceHasBlockingWork([thread], "e:\\work")).toBe(true);
    expect(workspaceHasBlockingWork([thread], "E:\\other")).toBe(false);
    expect(workspaceHasBlockingWork([{ ...thread, kind: "chat" }], "E:\\work")).toBe(false);
  });

  it("closes an update resource and releases its lease once, retrying only failures", async () => {
    const attempt = { prepared: true, resourceClosed: false, cleanup: undefined as Promise<void> | undefined };
    let closes = 0;
    let cancels = 0;
    const close = async () => { closes += 1; };
    const cancel = async () => { cancels += 1; };
    await Promise.all([releaseUpdateResources(attempt, close, cancel), releaseUpdateResources(attempt, close, cancel)]);
    expect({ closes, cancels, prepared: attempt.prepared, resourceClosed: attempt.resourceClosed, cleanup: attempt.cleanup }).toEqual({ closes: 1, cancels: 1, prepared: false, resourceClosed: true, cleanup: undefined });

    const retry = { prepared: true, resourceClosed: false, cleanup: undefined as Promise<void> | undefined };
    let retryCloses = 0;
    let retryCancels = 0;
    await expect(releaseUpdateResources(retry, async () => { retryCloses += 1; }, async () => { retryCancels += 1; throw new Error("lease busy"); })).rejects.toThrow("lease busy");
    expect(retry).toMatchObject({ prepared: true, resourceClosed: true, cleanup: undefined });
    await releaseUpdateResources(retry, async () => { retryCloses += 1; }, async () => { retryCancels += 1; });
    expect({ retryCloses, retryCancels, prepared: retry.prepared }).toEqual({ retryCloses: 1, retryCancels: 2, prepared: false });
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
    expect(running).toContain("Inspecting files");
    expect(completed).not.toContain('<details class="turn-activity" open="">');
    expect(completed).toContain("Worked for 10s");
    expect(completed).not.toContain("Inspecting files");
  });

  it("does not render collapsed tool output until its step is expanded", () => {
    const activity = [{ id: "tool-1", turnId: "turn-1", kind: "tool", status: "in_progress", text: "Run the focused check", toolCallId: "call-1", seq: 1, createdAt: "2026-07-18T10:00:00.000Z", updatedAt: "2026-07-18T10:00:01.000Z" }];
    const tools = [{ toolCallId: "call-1", turnId: "turn-1", title: "Focused check", status: "in_progress", rawOutput: "SECRET_RAW_OUTPUT" }];
    const markup = renderToStaticMarkup(createElement(ActivityTimeline, {
      turn: { record: { turnId: "turn-1", startedAt: "2026-07-18T10:00:00.000Z" }, messages: [], activity, tools, approvals: [], canRevert: false, running: true } as never,
      onOpenUrl: async () => undefined,
      onOpenLocation: () => undefined,
    }));
    expect(markup).toContain("Run the focused check");
    expect(markup).not.toContain("SECRET_RAW_OUTPUT");
  });

  it("shows only the latest four activity entries until earlier work is requested", () => {
    const activity = Array.from({ length: 6 }, (_, index) => ({
      id: `thought-${index + 1}`,
      turnId: "turn-1",
      kind: "thought",
      status: "completed",
      text: `Step ${index + 1}`,
      seq: index + 1,
      createdAt: `2026-07-18T10:00:0${index}.000Z`,
      updatedAt: `2026-07-18T10:00:0${index}.000Z`,
    }));
    const markup = renderToStaticMarkup(createElement(ActivityTimeline, {
      turn: { record: { turnId: "turn-1", startedAt: "2026-07-18T10:00:00.000Z" }, messages: [], activity, tools: [], approvals: [], canRevert: false, running: true } as never,
      onOpenUrl: async () => undefined,
      onOpenLocation: () => undefined,
    }));
    expect(markup).toContain("Show 2 earlier steps");
    expect(markup).not.toContain("Step 1");
    expect(markup).not.toContain("Step 2");
    for (const step of [3, 4, 5, 6]) expect(markup).toContain(`Step ${step}`);
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

  it("disables whole-turn undo after a partial hunk revert", () => {
    const thread = normalizeThread({
      threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-18T10:00:00.000Z",
      turns: [{ turnId: "turn-1", startedAt: "2026-07-18T10:00:00.000Z", completedAt: "2026-07-18T10:00:10.000Z" }],
      checkpoints: [{ turnId: "turn-1", phase: "before", ref: "before", commit: "a", root: "E:/work" }, { turnId: "turn-1", phase: "after", ref: "after", commit: "b", root: "E:/work", diff: "patch" }],
      revertedParts: [{ turnId: "turn-1", path: "src/a.ts", hunkIndex: 0, revertedAt: "2026-07-18T10:00:11.000Z" }],
    } as never);
    expect(projectTurns(thread)[0]).toMatchObject({ canRevert: false });
  });

  it("disables whole-turn undo after the reverted checkpoint is recorded", () => {
    const thread = normalizeThread({
      threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-18T10:00:00.000Z",
      turns: [{ turnId: "turn-1", startedAt: "2026-07-18T10:00:00.000Z", completedAt: "2026-07-18T10:00:10.000Z" }],
      checkpoints: [
        { turnId: "turn-1", phase: "before", ref: "before", commit: "a", root: "E:/work" },
        { turnId: "turn-1", phase: "after", ref: "after", commit: "b", root: "E:/work", diff: "patch" },
        { turnId: "turn-1", phase: "reverted", ref: "reverted", commit: "c", root: "E:/work" },
      ],
    } as never);
    expect(projectTurns(thread)[0]).toMatchObject({ canRevert: false });
  });

  it("renders a bounded recent window while preserving access to older turns", () => {
    const turns = Array.from({ length: 120 }, (_, index) => `turn-${index + 1}`);
    expect(recentTurns(turns, 60)).toEqual(turns.slice(60));
    expect(recentTurns(turns, 180)).toBe(turns);
    expect(recentTurns(turns, 0)).toEqual([]);
  });

  it("keeps interleaved live commentary in work until completion", () => {
    const activity = [{ id: "tool-1", turnId: "turn-1", kind: "tool", status: "completed", text: "Run checks", seq: 4, updatedSeq: 4, createdAt: "2026-07-18T10:00:01.000Z", updatedAt: "2026-07-18T10:00:02.000Z" }];
    const messages = [
      { turnId: "turn-1", role: "assistant", text: "I am checking the project.", seq: 3, updatedSeq: 3 },
      { turnId: "turn-1", role: "assistant", text: "The fix is ready.", seq: 5, updatedSeq: 5 },
    ];
    const running = turnAssistantMessages({ activity, messages, running: true } as never);
    const complete = turnAssistantMessages({ activity, messages, running: false } as never);
    expect(running.commentary.map((message) => message.text)).toEqual(["I am checking the project.", "The fix is ready."]);
    expect(running.final).toBeUndefined();
    expect(complete.commentary.map((message) => message.text)).toEqual(["I am checking the project."]);
    expect(complete.final?.text).toBe("The fix is ready.");
    expect([...complete.commentary, complete.final].filter((message) => message?.text === "The fix is ready.")).toHaveLength(1);
    expect(turnAssistantMessages({ activity: [{ ...activity[0], updatedSeq: 6 }], messages, running: false } as never).final).toBeUndefined();
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

  it("projects lifecycle phases and does not let stale completions stop current work", () => {
    const base = normalizeThread({ threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-27T00:00:00.000Z" } as never);
    const updated = applyEvents([base], [
      { threadId: "thread", seq: 1, type: "TurnPhaseChanged", payload: { phase: "preparing", turnId: "turn-1", queuedId: "queue-1" }, createdAt: "2026-07-27T00:00:01.000Z" },
      { threadId: "thread", seq: 2, type: "TurnStarted", payload: { turnId: "turn-1", text: "Go" }, createdAt: "2026-07-27T00:00:02.000Z" },
      { threadId: "thread", seq: 3, type: "TurnCompleted", payload: { turnId: "stale-turn", stopReason: "end_turn" }, createdAt: "2026-07-27T00:00:03.000Z" },
      { threadId: "thread", seq: 4, type: "TurnPhaseChanged", payload: { phase: "checkpointing", turnId: "turn-1", queuedId: "queue-1" }, createdAt: "2026-07-27T00:00:04.000Z" },
    ] as never)[0]!;
    expect(updated).toMatchObject({ running: true, activeTurnId: "turn-1", lifecycle: { phase: "checkpointing", turnId: "turn-1", queuedId: "queue-1" } });
    expect(projectTurns(updated)[0]).toMatchObject({ running: true, phase: "checkpointing" });
  });
});

describe("incremental turn projection", () => {
  it("preserves 1,000 completed turn views and renders only the recent window for a live delta", () => {
    const base = projectionHistory(1_000);
    const cache = createTurnProjectionCache();
    const primed = applyEvents([base], [domainEvent(2_001, "UsageUpdated", { usage: { used: 12, size: 100 } })], cache)[0]!;
    const before = [...projectRecentTurns(primed, 2_000, cache)];

    expect(projectedTurnCount(primed, cache)).toBe(1_001);
    const updated = applyEvents([primed], [domainEvent(2_002, "MessageDelta", { turnId: "turn-live", role: "assistant", text: "Live output" })], cache)[0]!;
    const after = projectRecentTurns(updated, 2_000, cache);

    for (let index = 0; index < 1_000; index += 1) {
      expect(after[index]).toBe(before[index]);
      expect(after[index]!.messages).toBe(before[index]!.messages);
    }
    expect(after[1_000]).not.toBe(before[1_000]);
    expect(after).toEqual(projectTurns(updated));
    expect(updated.turns[0]).toBe(primed.turns[0]);
    expect(updated.messages[0]).toBe(primed.messages[0]);
    expect(primed.messages.at(-1)?.text).toBe("Continue");

    const recent = projectRecentTurns(updated, 60, cache);
    expect(recent).toHaveLength(60);
    expect(recent.map((turn) => turn.record.turnId)).toEqual(projectTurns(updated).slice(-60).map((turn) => turn.record.turnId));
    expect(projectedTurnCount(updated, cache) - recent.length).toBe(941);
  });

  it("keeps every view reference stable for projection-neutral metadata events", () => {
    const cache = createTurnProjectionCache();
    const primed = applyEvents([projectionHistory(3)], [domainEvent(10, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const before = [...projectRecentTurns(primed, 10, cache)];
    const events = [
      domainEvent(11, "ThreadRenamed", { title: "Renamed" }),
      domainEvent(12, "ThreadGoalSet", { objective: "Ship it" }),
      domainEvent(13, "ThreadGoalCleared", {}),
      domainEvent(14, "ThreadArchived", { archived: true }),
      domainEvent(15, "ThreadArchived", { archived: false }),
      domainEvent(16, "PlanReplaced", { entries: [{ content: "Verify", status: "pending" }] }),
      domainEvent(17, "ConfigOptionsReplaced", { options: [{ id: "mode", name: "Mode", currentValue: "safe" }] }),
      domainEvent(18, "CommandsReplaced", { commands: [{ name: "help", description: "Help" }] }),
      domainEvent(19, "ModeChanged", { modeId: "safe" }),
      domainEvent(20, "UsageUpdated", { usage: { used: 2, size: 100 } }),
      domainEvent(21, "BackgroundTaskRegistered", { taskId: "task-1", queuedId: "queue-1", turnId: "turn-live", description: "Build" }),
      domainEvent(22, "BackgroundTaskFinished", { taskId: "task-1", status: "completed", endedAt: 22, exitCode: 0 }),
      domainEvent(23, "BackgroundTaskReportQueued", { taskId: "task-1" }),
      domainEvent(24, "BackgroundTaskReportDelivered", { taskId: "task-1" }),
      domainEvent(25, "BackgroundTaskReportCancelled", { taskId: "task-1" }),
      domainEvent(26, "BackgroundTaskReportAttempted", { taskId: "task-1", attempt: 1, nextAttemptAt: "2026-07-30T00:01:00.000Z" }),
      domainEvent(27, "TurnSubmissionAccepted", { submissionId: "submission-1", fingerprint: "fingerprint", queuedId: "queue-1" }),
      domainEvent(28, "TurnSubmissionsRemoved", { submissionIds: ["submission-1"] }),
      domainEvent(29, "TurnSubmissionsPayloadLost", { submissionIds: ["submission-2"] }),
    ];
    const updated = applyEvents([primed], events, cache)[0]!;
    const after = projectRecentTurns(updated, 10, cache);

    expect(after).toHaveLength(before.length);
    after.forEach((turn, index) => expect(turn).toBe(before[index]));
    expect(after).toEqual(projectTurns(updated));
    expect(updated).toMatchObject({ title: "Renamed", modeId: "safe" });
    expect("goal" in updated).toBe(false);
    expect("archivedAt" in updated).toBe(false);
  });

  it("is equivalent for one batch and single-event partitions across every domain event", () => {
    const base = normalizeThread({ threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-30T00:00:00.000Z" } as never);
    const before = { turnId: "turn-1", phase: "before", ref: "before", commit: "a", root: "E:/work" };
    const after = { turnId: "turn-1", phase: "after", ref: "after", commit: "b", root: "E:/work" };
    const events = [
      domainEvent(1, "ThreadCreated", { sessionId: "aux-session", provider: "kimi", cwd: "E:/aux", title: "Aux", configOptions: [] }, "aux"),
      domainEvent(2, "ThreadDeleted", {}, "aux"),
      domainEvent(3, "ThreadRenamed", { title: "Renamed" }),
      domainEvent(4, "ThreadGoalSet", { objective: "Finish" }),
      domainEvent(5, "ThreadGoalCleared", {}),
      domainEvent(6, "ThreadArchived", { archived: true }),
      domainEvent(7, "ThreadArchived", { archived: false }),
      domainEvent(8, "CheckpointCaptured", { checkpoint: before }),
      domainEvent(9, "TurnPhaseChanged", { phase: "preparing", turnId: "turn-1", queuedId: "queue-1" }),
      domainEvent(10, "TurnStarted", { turnId: "turn-1", text: "Go", sourceQueuedId: "queue-1" }),
      domainEvent(11, "MessageAppended", { turnId: "turn-1", role: "thought", text: "Inspect" }),
      domainEvent(12, "MessageDelta", { turnId: "turn-1", role: "thought", text: " files" }),
      domainEvent(13, "MessageAppended", { turnId: "turn-1", role: "assistant", text: "Working" }),
      domainEvent(14, "ToolCallCreated", { tool: { toolCallId: "tool-1", title: "Read files", status: "in_progress" } }),
      domainEvent(15, "ToolCallPatched", { tool: { toolCallId: "tool-1", title: "Read files", status: "completed", rawOutput: "ok" } }),
      domainEvent(16, "MessageDelta", { turnId: "turn-1", role: "assistant", text: "Done" }),
      domainEvent(17, "ApprovalRequested", { requestId: "approval-1", title: "Allow", options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }] }),
      domainEvent(18, "ApprovalResolved", { requestId: "approval-1", optionId: "yes" }),
      domainEvent(19, "PlanReplaced", { entries: [{ content: "Test", status: "in_progress" }] }),
      domainEvent(20, "ConfigOptionsReplaced", { options: [{ id: "permission", name: "Permission", currentValue: "default" }] }),
      domainEvent(21, "CommandsReplaced", { commands: [{ name: "usage", description: "Usage" }] }),
      domainEvent(22, "ModeChanged", { modeId: "default" }),
      domainEvent(23, "UsageUpdated", { usage: { used: 20, size: 100 } }),
      domainEvent(24, "BackgroundTaskRegistered", { taskId: "task-1", queuedId: "queue-1", turnId: "turn-1", description: "Compile" }),
      domainEvent(25, "BackgroundTaskFinished", { taskId: "task-1", status: "completed", endedAt: 25, exitCode: 0 }),
      domainEvent(26, "BackgroundTaskReportQueued", { taskId: "task-1" }),
      domainEvent(27, "BackgroundTaskReportDelivered", { taskId: "task-1" }),
      domainEvent(28, "BackgroundTaskReportCancelled", { taskId: "task-1" }),
      domainEvent(29, "TurnPhaseChanged", { phase: "checkpointing", turnId: "turn-1", queuedId: "queue-1" }),
      domainEvent(30, "CheckpointCaptured", { checkpoint: after, diff: "patch" }),
      domainEvent(31, "TurnCompleted", { turnId: "turn-1", stopReason: "end_turn", usage: { totalTokens: 10, inputTokens: 6, outputTokens: 4 } }),
      domainEvent(32, "CheckpointPartReverted", { turnId: "turn-1", path: "src/a.ts", hunkIndex: 0, checkpoint: { turnId: "turn-1", phase: "partial", ref: "partial", commit: "c", root: "E:/work" } }),
      domainEvent(33, "CheckpointReverted", { checkpoint: { turnId: "turn-1", phase: "reverted", ref: "reverted", commit: "d", root: "E:/work" } }),
      domainEvent(34, "TurnStarted", { turnId: "turn-2", text: "Cancel me" }),
      domainEvent(35, "TurnCancelled", { turnId: "turn-2" }),
      domainEvent(36, "TurnSubmissionAccepted", { submissionId: "submission-1", fingerprint: "fingerprint", queuedId: "queue-1" }),
      domainEvent(37, "TurnSubmissionsRemoved", { submissionIds: ["submission-1"] }),
      domainEvent(38, "TurnSubmissionsPayloadLost", { submissionIds: ["submission-2"] }),
      domainEvent(39, "BackgroundTaskReportAttempted", { taskId: "task-1", attempt: 2, nextAttemptAt: "2026-07-30T00:02:00.000Z" }),
    ];
    const wholeCache = createTurnProjectionCache();
    const partitionedCache = createTurnProjectionCache();
    const whole = applyEvents([base], events, wholeCache);
    let partitioned = [base];
    for (const event of events) {
      partitioned = applyEvents(partitioned, [event], partitionedCache);
      for (const thread of partitioned) expect(projectRecentTurns(thread, 100, partitionedCache)).toEqual(projectTurns(thread));
    }

    expect(partitioned).toEqual(whole);
    expect(projectRecentTurns(whole[0], 100, wholeCache)).toEqual(projectTurns(whole[0]!));
    expect(projectRecentTurns(partitioned[0], 100, partitionedCache)).toEqual(projectTurns(partitioned[0]!));
    expect(partitionedCache.has("aux")).toBe(false);
    expect(whole[0]).toMatchObject({ running: false, activeTurnId: undefined, title: "Renamed" });
  });

  it("updates only a late-checkpoint target and disables undo after partial or full revert", () => {
    const cache = createTurnProjectionCache();
    let thread = applyEvents([projectionHistory(3)], [domainEvent(10, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const initial = [...projectRecentTurns(thread, 10, cache)];

    thread = applyEvents([thread], [domainEvent(11, "CheckpointCaptured", { checkpoint: { turnId: "turn-0", phase: "before", ref: "before", commit: "a", root: "E:/work" } })], cache)[0]!;
    const withBefore = [...projectRecentTurns(thread, 10, cache)];
    thread = applyEvents([thread], [domainEvent(12, "CheckpointCaptured", { checkpoint: { turnId: "turn-0", phase: "after", ref: "after", commit: "b", root: "E:/work" }, diff: "patch" })], cache)[0]!;
    const withAfter = [...projectRecentTurns(thread, 10, cache)];

    expect(withBefore[0]).not.toBe(initial[0]);
    expect(withAfter[0]).not.toBe(withBefore[0]);
    expect(withAfter[0]).toMatchObject({ canRevert: true, checkpoint: { diff: "patch" } });
    for (let index = 1; index < initial.length; index += 1) expect(withAfter[index]).toBe(initial[index]);

    thread = applyEvents([thread], [domainEvent(13, "CheckpointPartReverted", { turnId: "turn-0", path: "src/a.ts", hunkIndex: 0, checkpoint: { turnId: "turn-0", phase: "partial", ref: "partial", commit: "c", root: "E:/work" } })], cache)[0]!;
    const partial = [...projectRecentTurns(thread, 10, cache)];
    expect(partial[0]).toMatchObject({ canRevert: false });
    for (let index = 1; index < initial.length; index += 1) expect(partial[index]).toBe(initial[index]);

    thread = applyEvents([thread], [domainEvent(14, "CheckpointReverted", { checkpoint: { turnId: "turn-0", phase: "reverted", ref: "reverted", commit: "d", root: "E:/work" } })], cache)[0]!;
    expect(projectRecentTurns(thread, 10, cache)).toEqual(projectTurns(thread));
    expect(projectRecentTurns(thread, 10, cache)[0]).toMatchObject({ canRevert: false });
  });

  it("reuses a projection for queue-only state and invalidates it for an authoritative replacement", () => {
    const cache = createTurnProjectionCache();
    const primed = applyEvents([projectionHistory(2)], [domainEvent(10, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const originalView = projectRecentTurns(primed, 10, cache)[0]!;
    const queueOnly = { ...primed, queue: [{ queuedId: "queue-1", text: "Next", mode: "queue" as const, createdAt: primed.createdAt, images: [] }] };
    reconcileTurnProjectionCache(cache, [primed], [queueOnly]);
    expect(projectRecentTurns(queueOnly, 10, cache)[0]).toBe(originalView);

    const replacement = normalizeThread({
      ...queueOnly,
      turns: [{ turnId: "replacement", startedAt: queueOnly.createdAt, completedAt: queueOnly.createdAt, stopReason: "end_turn" }],
      messages: [{ turnId: "replacement", role: "assistant", text: "Authoritative history", seq: 1, updatedSeq: 1 }],
      activity: [], tools: [], approvals: [], checkpoints: [], revertedParts: [],
      running: false, activeTurnId: undefined, lifecycle: { phase: "idle", updatedAt: queueOnly.createdAt },
    } as never);
    reconcileTurnProjectionCache(cache, [queueOnly], [replacement]);

    expect(cache.has("thread")).toBe(false);
    expect(projectRecentTurns(replacement, 10, cache)).toEqual(projectTurns(replacement));
    expect(projectRecentTurns(replacement, 10, cache)[0]).not.toBe(originalView);
    expect(projectRecentTurns(replacement, 10, cache)[0]?.messages[0]?.text).toBe("Authoritative history");
  });

  it("treats a domain snapshot as an authoritative per-thread projection epoch", () => {
    const cache = createTurnProjectionCache();
    const primed = applyEvents([projectionHistory(2)], [domainEvent(10, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const previous = projectRecentTurns(primed, 10, cache)[0]!;
    const snapshot = normalizeThread({
      ...primed,
      title: "Snapshot",
      turns: [{ turnId: "snapshot-turn", startedAt: primed.createdAt, completedAt: primed.createdAt, stopReason: "end_turn" }],
      messages: [{ turnId: "snapshot-turn", role: "assistant", text: "Snapshot history", seq: 1, updatedSeq: 1 }],
      activity: [], tools: [], approvals: [], checkpoints: [], revertedParts: [],
      running: false, activeTurnId: undefined, lifecycle: { phase: "idle", updatedAt: primed.createdAt },
    } as never);
    const replaced = applyEvents([primed], [domainEvent(11, "ThreadSnapshot", { thread: snapshot })], cache)[0]!;
    const projected = projectRecentTurns(replaced, 10, cache);

    expect(projected).toEqual(projectTurns(replaced));
    expect(projected[0]).not.toBe(previous);
    expect(projected[0]?.record.turnId).toBe("snapshot-turn");
    expect(replaced.title).toBe("Snapshot");
  });

  it("resolves tool patches without a turn id and cold-rebuilds ambiguous approval resolution", () => {
    const cache = createTurnProjectionCache();
    let thread = applyEvents([projectionHistory(1)], [domainEvent(10, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const completed = projectRecentTurns(thread, 10, cache)[0]!;
    thread = applyEvents([thread], [
      domainEvent(11, "ToolCallCreated", { tool: { toolCallId: "tool-1", title: "Run", status: "in_progress" } }),
      domainEvent(12, "ToolCallPatched", { tool: { toolCallId: "tool-1", status: "completed", rawOutput: "ok" } }),
      domainEvent(13, "ApprovalRequested", { requestId: "approval-1", title: "Allow", options: [] }),
      domainEvent(14, "ApprovalResolved", { requestId: "approval-1" }),
    ], cache)[0]!;
    const projected = projectRecentTurns(thread, 10, cache);
    expect(projected[0]).toBe(completed);
    expect(projected.at(-1)?.tools[0]).toMatchObject({ toolCallId: "tool-1", turnId: "turn-live", status: "completed" });
    expect(projected.at(-1)?.approvals).toEqual([]);
    expect(projected).toEqual(projectTurns(thread));

    const beforeFallback = projected;
    thread = applyEvents([thread], [domainEvent(15, "ApprovalResolved", { requestId: "missing" })], cache)[0]!;
    const afterFallback = projectRecentTurns(thread, 10, cache);
    expect(afterFallback).toEqual(projectTurns(thread));
    expect(afterFallback[0]).not.toBe(beforeFallback[0]);
  });

  it("cold-rebuilds an out-of-order activity event so canonical sequence ordering wins", () => {
    const cache = createTurnProjectionCache();
    const base = normalizeThread({
      ...projectionHistory(0),
      activity: [{ id: "tool-existing", turnId: "turn-live", kind: "tool", status: "completed", text: "Later", toolCallId: "tool-existing", seq: 10, updatedSeq: 10, createdAt: "2026-07-30T00:00:10.000Z", updatedAt: "2026-07-30T00:00:10.000Z" }],
      tools: [{ toolCallId: "tool-existing", turnId: "turn-live", title: "Later", status: "completed" }],
    } as never);
    let thread = applyEvents([base], [domainEvent(20, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const before = projectRecentTurns(thread, 10, cache)[0]!;
    thread = applyEvents([thread], [domainEvent(5, "MessageDelta", { turnId: "turn-live", role: "thought", text: "Earlier" })], cache)[0]!;
    const projected = projectRecentTurns(thread, 10, cache);

    expect(projected).toEqual(projectTurns(thread));
    expect(projected[0]).not.toBe(before);
    expect(projected[0]?.activity.map((entry) => entry.seq)).toEqual([5, 10]);
  });

  it("recomputes the exact latest activity sequence after an out-of-order tool patch", () => {
    const cache = createTurnProjectionCache();
    const history = projectionHistory(0);
    const base = normalizeThread({
      ...history,
      messages: [...history.messages, { turnId: "turn-live", role: "assistant", text: "Before", seq: 8, updatedSeq: 8 }],
      activity: [{ id: "tool-tool-1", turnId: "turn-live", kind: "tool", status: "in_progress", text: "Run", toolCallId: "tool-1", seq: 4, updatedSeq: 10, createdAt: history.createdAt, updatedAt: history.createdAt }],
      tools: [{ toolCallId: "tool-1", turnId: "turn-live", title: "Run", status: "in_progress" }],
    } as never);
    let thread = applyEvents([base], [domainEvent(20, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    thread = applyEvents([thread], [
      domainEvent(5, "ToolCallPatched", { tool: { toolCallId: "tool-1", status: "completed" } }),
      domainEvent(6, "MessageDelta", { turnId: "turn-live", role: "assistant", text: "After" }),
    ], cache)[0]!;
    const projected = projectRecentTurns(thread, 10, cache);

    expect(projected).toEqual(projectTurns(thread));
    expect(projected[0]?.messages.filter((message) => message.role === "assistant").map((message) => message.text)).toEqual(["BeforeAfter"]);
  });

  it("clears the previously active view when a new turn starts before the old one completes", () => {
    const cache = createTurnProjectionCache();
    let thread = applyEvents([projectionHistory(0)], [domainEvent(10, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const previous = projectRecentTurns(thread, 10, cache)[0]!;
    thread = applyEvents([thread], [
      domainEvent(11, "TurnPhaseChanged", { phase: "preparing", turnId: "turn-next", queuedId: "queue-next" }),
      domainEvent(12, "TurnStarted", { turnId: "turn-next", text: "Next", sourceQueuedId: "queue-next" }),
    ], cache)[0]!;
    const projected = projectRecentTurns(thread, 10, cache);

    expect(projected).toEqual(projectTurns(thread));
    expect(projected[0]).not.toBe(previous);
    expect(projected[0]).toMatchObject({ running: false, phase: "idle" });
    expect(projected[1]).toMatchObject({ running: true, phase: "running" });
  });

  it("attaches an approval that arrives before its turn view exists", () => {
    const cache = createTurnProjectionCache();
    let thread = applyEvents([normalizeThread({ threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-30T00:00:00.000Z" } as never)], [
      domainEvent(1, "UsageUpdated", { usage: { used: 1, size: 100 } }),
      domainEvent(2, "ApprovalRequested", { requestId: "approval-future", turnId: "turn-future", title: "Allow", options: [] }),
    ], cache)[0]!;
    expect(projectRecentTurns(thread, 10, cache)).toEqual([]);
    thread = applyEvents([thread], [domainEvent(3, "TurnStarted", { turnId: "turn-future", text: "Continue" })], cache)[0]!;
    const projected = projectRecentTurns(thread, 10, cache);

    expect(projected).toEqual(projectTurns(thread));
    expect(projected[0]?.approvals.map((approval) => approval.requestId)).toEqual(["approval-future"]);
  });

  it("attaches an after-checkpoint captured before its turn view exists", () => {
    const cache = createTurnProjectionCache();
    let thread = applyEvents([normalizeThread({ threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-30T00:00:00.000Z" } as never)], [
      domainEvent(1, "CheckpointCaptured", { checkpoint: { turnId: "turn-future", phase: "before", ref: "before", commit: "a", root: "E:/work" } }),
      domainEvent(2, "CheckpointCaptured", { checkpoint: { turnId: "turn-future", phase: "after", ref: "after", commit: "b", root: "E:/work" }, diff: "future patch" }),
    ], cache)[0]!;
    expect(projectRecentTurns(thread, 10, cache)).toEqual([]);
    thread = applyEvents([thread], [domainEvent(3, "TurnStarted", { turnId: "turn-future", text: "Continue" })], cache)[0]!;
    const projected = projectRecentTurns(thread, 10, cache);

    expect(projected).toEqual(projectTurns(thread));
    expect(projected[0]).toMatchObject({ canRevert: true, checkpoint: { phase: "after", diff: "future patch" } });
  });

  it("cold-rebuilds completion of a synthetic view without inventing a turn record", () => {
    const cache = createTurnProjectionCache();
    let thread = applyEvents([normalizeThread({ threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-30T00:00:00.000Z" } as never)], [
      domainEvent(1, "MessageDelta", { turnId: "turn-orphan", role: "assistant", text: "Orphan output" }),
    ], cache)[0]!;
    const synthetic = projectRecentTurns(thread, 10, cache)[0]!;
    thread = applyEvents([thread], [domainEvent(2, "TurnCompleted", { turnId: "turn-orphan", stopReason: "end_turn" })], cache)[0]!;
    const projected = projectRecentTurns(thread, 10, cache);

    expect(projected).toEqual(projectTurns(thread));
    expect(projected[0]).not.toBe(synthetic);
    expect(projected[0]?.record).toEqual({ turnId: "turn-orphan", startedAt: "2026-07-30T00:00:00.000Z" });
  });

  it("keeps a live turn running after stale completion and calls the latest memoized callback", () => {
    const cache = createTurnProjectionCache();
    let thread = applyEvents([normalizeThread({ threadId: "thread", sessionId: "session", cwd: "E:/work", title: "Work", createdAt: "2026-07-30T00:00:00.000Z" } as never)], [
      domainEvent(1, "TurnPhaseChanged", { phase: "preparing", turnId: "turn-1", queuedId: "queue-1" }),
      domainEvent(2, "TurnStarted", { turnId: "turn-1", text: "Go" }),
    ], cache)[0]!;
    const running = projectRecentTurns(thread, 10, cache)[0]!;
    thread = applyEvents([thread], [domainEvent(3, "TurnCompleted", { turnId: "stale", stopReason: "end_turn" })], cache)[0]!;
    expect(projectRecentTurns(thread, 10, cache)[0]).toBe(running);
    expect(thread).toMatchObject({ running: true, activeTurnId: "turn-1" });
    thread = applyEvents([thread], [domainEvent(4, "TurnPhaseChanged", { phase: "checkpointing", turnId: "turn-1", queuedId: "queue-1" })], cache)[0]!;
    expect(projectRecentTurns(thread, 10, cache)[0]).toMatchObject({ running: true, phase: "checkpointing" });
    thread = applyEvents([thread], [domainEvent(5, "TurnPhaseChanged", { phase: "blocked", error: "Approval required" })], cache)[0]!;
    expect(projectRecentTurns(thread, 10, cache)[0]).toMatchObject({ running: true, phase: "blocked" });
    expect(projectRecentTurns(thread, 10, cache)).toEqual(projectTurns(thread));

    const calls: string[] = [];
    const holder = { current: (value: string) => calls.push(`old:${value}`) };
    const callback = latestCallbackProxy(holder);
    holder.current = (value: string) => calls.push(`new:${value}`);
    const sameCallback = callback;
    callback("edit");
    expect(callback).toBe(sameCallback);
    expect(calls).toEqual(["new:edit"]);
    expect(appSource).toContain("const TurnBlock = memo(function TurnBlock");
  });
});

describe("background task follow-ups", () => {
  it("keeps internal report prompts out of the visible user queue", () => {
    const prompt = { queuedId: "queue-1", text: "User follow-up", mode: "queue" as const, createdAt: "2026-07-26T00:00:00.000Z", images: [] };
    expect(visibleQueuedPrompts([
      prompt,
      { ...prompt, queuedId: "internal-1", text: "Internal report", origin: "background_task" },
    ])).toEqual([prompt]);
  });
});

describe("reasoning effort presentation", () => {
  it("maps provider-specific labels to a stable four-step meter", () => {
    expect(reasoningStrength("off")).toBe(0);
    expect(reasoningStrength("low")).toBe(1);
    expect(reasoningStrength("medium")).toBe(2);
    expect(reasoningStrength("high")).toBe(3);
    expect(reasoningStrength("xhigh")).toBe(4);
    expect(reasoningStrength("max")).toBe(4);
    expect(reasoningStrength("ultra")).toBe(4);
  });
});

describe("harness commands", () => {
  it("parses persistent goals and side chats without forwarding them to a provider", () => {
    expect(parseHarnessCommand("/goal Ship a safe release")).toEqual({ name: "goal", objective: "Ship a safe release", clear: false });
    expect(parseHarnessCommand("/goal clear")).toEqual({ name: "goal", clear: true });
    expect(parseHarnessCommand("/side Explore auth")).toEqual({ name: "side", title: "Explore auth" });
    expect(parseHarnessCommand("explain /goal syntax")).toBeUndefined();
  });
});

describe("Kimi runtime boundary", () => {
  it("allows the installed Kimi CLI with unknown status but rejects a known signed-out account", () => {
    expect(providerUsable({ installed: true, authenticated: null } as never)).toBe(true);
    expect(providerUsable({ installed: true, authenticated: true } as never)).toBe(true);
    expect(providerUsable({ installed: true, authenticated: false } as never)).toBe(false);
    expect(providerUsable({ installed: false, authenticated: true } as never)).toBe(false);
  });

  it("keeps only Kimi runtimes active while foreign threads remain historical", () => {
    expect(filterKimiRuntimes([
      { id: "kimi", provider: "kimi", name: "Kimi" },
      { id: "codex", provider: "codex", name: "Codex" },
      { id: "work", provider: "kimi", name: "Kimi in WSL" },
    ] as never)).toEqual([
      { id: "kimi", provider: "kimi", name: "Kimi" },
      { id: "work", provider: "kimi", name: "Kimi in WSL" },
    ]);
    expect(threadCanRun(undefined)).toBe(true);
    expect(threadCanRun({ provider: "kimi" } as never)).toBe(true);
    expect(threadCanRun({ provider: "codex" } as never)).toBe(false);
    expect(preferredInitialThreadId([{ threadId: "old", provider: "codex" }, { threadId: "kimi", provider: "kimi" }])).toBe("kimi");
    expect(shouldShowRuntimePicker([], undefined)).toBe(false);
    expect(shouldShowRuntimePicker([], "removed")).toBe(true);
    expect(shouldShowRuntimePicker(["default"], "default")).toBe(true);
  });
});

describe("native server lookup", () => {
  it("uses the native dynamic port and safely encodes its token", () => {
    expect(serverWebSocketUrl({ port: 61_429, token: "a+b /?" })).toBe("ws://127.0.0.1:61429?token=a%2Bb%20%2F%3F");
    expect(serverWebSocketUrl({ port: 4_317, token: "" })).toBe("ws://127.0.0.1:4317");
  });

  it("rejects malformed native responses and never falls back to the development port", async () => {
    expect(() => serverWebSocketUrl({ port: 0, token: "secret" })).toThrow(/invalid server connection/i);
    expect(() => serverWebSocketUrl({ port: 61_429 })).toThrow(/invalid server connection/i);
    let attempts = 0;
    await expect(localServerUrl(true, async () => {
      attempts += 1;
      throw new Error("native lookup failed");
    }, 2, 0)).rejects.toThrow(/could not locate/i);
    expect(attempts).toBe(2);
    await expect(localServerUrl(false)).resolves.toBe("ws://127.0.0.1:4317");
  });
});

describe("conversation scroll anchoring", () => {
  it("pins only while the viewport remains close to the latest content", () => {
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 628, clientHeight: 300 })).toBe(true);
    expect(isNearScrollBottom({ scrollHeight: 1_000, scrollTop: 627, clientHeight: 300 })).toBe(false);
    expect(isNearScrollBottom({ scrollHeight: 300, scrollTop: 0, clientHeight: 300 })).toBe(true);
  });
});

describe("application menus", () => {
  it("opens from standard keyboard activation keys", () => {
    expect(["ArrowDown", "Enter", " "].every(isAppMenuOpenKey)).toBe(true);
    expect(isAppMenuOpenKey("Escape")).toBe(false);
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
  it("places side chats directly after their parent", () => {
    const parent = { threadId: "parent", title: "Main" };
    const unrelated = { threadId: "other", title: "Other" };
    const side = { threadId: "side", parentThreadId: "parent", title: "Explore" };
    expect(threadTreeOrder([parent, unrelated, side] as never).map((thread) => thread.threadId)).toEqual(["parent", "side", "other"]);
  });

  it("never exposes a project workspace while the standalone chat view is active", () => {
    expect(workspaceForView("chats", { kind: "chat", cwd: "C:/runtime/chats" } as never, undefined, "E:/project")).toBeUndefined();
    expect(workspaceForView("chats", undefined, { kind: "chat" }, "E:/project")).toBeUndefined();
    expect(workspaceForView("chats", undefined, undefined, "E:/project")).toBeUndefined();
    expect(workspaceForView("projects", { kind: "project", cwd: "E:/project" } as never, undefined, "E:/other")).toBe("E:/project");
    expect(workspaceForView("projects", undefined, undefined, "E:/project")).toBe("E:/project");
    expect(["changes", "git", "terminal", "preview"].map((view) => railForStandaloneChat(view as never))).toEqual([undefined, undefined, undefined, undefined]);
    expect(railForStandaloneChat("agents")).toBe("agents");
  });

  it("accepts Git results only for the workspace that requested them", () => {
    expect(workspaceRequestMatches("E:\\project", "e:/project/")).toBe(true);
    expect(workspaceRequestMatches("E:/project-a", "E:/project-b")).toBe(false);
    expect(workspaceRequestMatches("E:/project", undefined)).toBe(false);
  });

  it("groups local and resumable chats under one normalized workspace", () => {
    const threads = [{ cwd: "e:\\work\\KimiDesktop\\", title: "Polish navigation" }] as unknown as Parameters<typeof groupProjects>[1];
    const sessions = [{ cwd: "E:/work/KimiDesktop", title: "Resume auth work" }] as Parameters<typeof groupProjects>[2];
    const projects = groupProjects(["E:\\work\\KimiDesktop"], threads, sessions);

    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ name: "KimiDesktop" });
    expect(projects[0]?.threads).toHaveLength(1);
    expect(projects[0]?.runtimeSessions).toHaveLength(1);
    expect(workspaceName("C:\\FixtureProfiles\\ExampleUser\\Project\\")).toBe("Project");
  });

  it("uses a saved project display name without changing its path", () => {
    const projects = groupProjects(["E:\\work\\KimiDesktop"], [], [], { "e:/work/kimidesktop": "Kimi client" });
    expect(projects[0]).toMatchObject({ cwd: "E:\\work\\KimiDesktop", name: "Kimi client" });
  });

  it("never exposes current or legacy internal quota workspaces", () => {
    const paths = [
      "C:/Profile/AppData/Roaming/KimiCodeDesktop/runtime/quota-probe",
      "C:/Profile/AppData/Roaming/com.kimicode.desktop/runtime/quota-probe",
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
    const threads = [{ cwd: "C:/Profile/AppData/Roaming/KimiCodeDesktop/runtime/chats", kind: "chat", title: "Personal chat" }] as unknown as Parameters<typeof groupProjects>[1];
    expect(groupProjects([], threads, [])).toEqual([]);
    expect(reorderPaths(["E:/one", "E:/two", "E:/three"], "E:/three", "E:/one")).toEqual(["E:/three", "E:/one", "E:/two"]);
    expect(reorderPathByOffset(["E:/one", "E:/two", "E:/three"], "e:\\two", -1)).toEqual(["E:/two", "E:/one", "E:/three"]);
    expect(reorderPathByOffset(["E:/one", "E:/two", "E:/three"], "E:/three", 1)).toEqual(["E:/one", "E:/two", "E:/three"]);
  });

  it("groups isolated worktree chats under their source project", () => {
    const thread = normalizeThread({ threadId: "isolated", sessionId: "session", cwd: "D:/tasty/worktrees/isolated", worktree: { sourceCwd: "E:/project", branch: "tasty/isolated" }, title: "Isolated" } as never);
    const projects = groupProjects(["E:/project"], [thread], []);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ cwd: "E:/project", threads: [{ threadId: "isolated", cwd: "D:/tasty/worktrees/isolated" }] });
  });
});

describe("workspace panel sizing", () => {
  it("keeps draggable panels inside usable bounds", () => {
    expect(clampPanelWidth("sidebar", 80)).toBe(84);
    expect(clampPanelWidth("sidebar", 900)).toBe(420);
    expect(clampPanelWidth("rail", 120)).toBe(260);
    expect(clampPanelWidth("rail", 1600)).toBe(1200);
    expect(panelResizeWidth("sidebar", 272, 40, "left")).toBe(312);
    expect(panelResizeWidth("sidebar", 272, 40, "right")).toBe(232);
  });

  it("gives the conversation space before rendering a requested rail width", () => {
    expect(effectiveRailWidth(1_200, 1_280, 272)).toBe(608);
    expect(effectiveRailWidth(1_200, 1_280, 60)).toBe(820);
    expect(effectiveRailWidth(420, 900, 272)).toBe(0);
    expect(effectiveSidebarWidth(false, 272, 900, true)).toBe(60);
    expect(effectiveRailWidth(420, 900, 60)).toBe(420);
    for (const width of [
      effectiveRailWidth(420, 900, 272),
      effectiveRailWidth(420, 900, 60),
      effectiveRailWidth(420, 600, 60, responsiveConversationMinimum(600)),
    ]) expect(width === 0 || width >= 260).toBe(true);
  });

  it("uses one responsive sidebar width at the 680px boundary", () => {
    expect(effectiveSidebarWidth(false, 272, 680)).toBe(60);
    expect(effectiveSidebarWidth(false, 272, 681)).toBe(272);
    expect(effectiveSidebarWidth(true, 420, 1_200)).toBe(60);
    expect(sidebarToggleState(false, 272, 680)).toEqual({ collapsed: true, disabled: false, label: "Open sidebar" });
    expect(sidebarToggleState(false, 272, 680, true)).toEqual({ collapsed: false, disabled: false, label: "Close sidebar" });
    expect(sidebarToggleState(true, 272, 681)).toEqual({ collapsed: true, disabled: false, label: "Expand sidebar" });
    expect(sidebarToggleState(false, 272, 681)).toEqual({ collapsed: false, disabled: false, label: "Collapse sidebar" });
    expect(sidebarToggleState(false, 272, 681, false, true)).toEqual({ collapsed: true, disabled: true, label: "Sidebar stays compact while the work panel is open" });
  });

  it("keeps the work panel reachable at maximum zoom in the narrowest window", () => {
    const viewportWidth = Math.round(900 / 1.4);
    const minimumConversationWidth = responsiveConversationMinimum(viewportWidth);
    const sidebarWidth = effectiveSidebarWidth(false, 272, viewportWidth, true, minimumConversationWidth);
    const railWidth = effectiveRailWidth(420, viewportWidth, sidebarWidth, minimumConversationWidth);
    expect({ viewportWidth, minimumConversationWidth, sidebarWidth, railWidth }).toEqual({ viewportWidth: 643, minimumConversationWidth: 323, sidebarWidth: 60, railWidth: 260 });
    expect(sidebarWidth + minimumConversationWidth + railWidth).toBe(viewportWidth);
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

  it("wraps keyboard suggestion selection in both directions", () => {
    expect(moveSuggestionIndex(0, 3, "ArrowDown")).toBe(1);
    expect(moveSuggestionIndex(2, 3, "ArrowDown")).toBe(0);
    expect(moveSuggestionIndex(0, 3, "ArrowUp")).toBe(2);
    expect(moveSuggestionIndex(4, 0, "ArrowUp")).toBe(0);
  });

  it("normalizes the real ACP command catalog and keeps files inside the workspace", () => {
    expect(normalizeAvailableCommands([{ name: "/mcp-config", description: " Configure MCP " }, { name: "", description: "bad" }, { name: "mcp-config", description: "duplicate" }])).toEqual([
      { name: "mcp-config", description: "Configure MCP" },
    ]);
    expect(workspaceRelativePath("E:\\work\\project", "e:\\work\\project\\src\\App.tsx")).toBe("src/App.tsx");
    expect(workspaceRelativePath("E:\\work\\project", "E:\\work\\project-other\\secret.txt")).toBeUndefined();
  });
});

describe("project MCP approvals", () => {
  it("maps every server-reported state to one bounded action", () => {
    expect(projectMcpAction("required", true)).toEqual({ badge: "Approval required", kind: "approve", label: "Approve" });
    expect(projectMcpAction("required", false)).toEqual({ badge: "Approval required" });
    expect(projectMcpAction("approved", true)).toEqual({ badge: "Approved", kind: "revoke", label: "Revoke" });
    expect(projectMcpAction("changed", true)).toEqual({ badge: "Config changed", kind: "approve", label: "Reapprove" });
    expect(projectMcpAction("changed", false)).toEqual({ badge: "Config changed" });
    expect(projectMcpAction("invalid", false)).toEqual({ badge: "Invalid config" });
    expect(projectMcpAction("unsupported", false)).toEqual({ badge: "Unsupported" });
    expect(mcpServerRowKey({ name: "shared" })).toBe("user:shared");
    expect(mcpServerRowKey({ name: "shared", projectScoped: true })).toBe("project:shared");
  });

  it("keeps approval instance-aware without rendering private approval metadata", () => {
    const refreshStart = appSource.indexOf("const refreshCapabilities");
    const refresh = appSource.slice(refreshStart, appSource.indexOf("useEffect", refreshStart));
    const center = appSource.slice(appSource.indexOf("function CapabilitiesCenter"), appSource.indexOf("function CapabilitySkeleton"));
    expect(refresh).toContain('call("capabilities.list", { provider: "kimi"');
    expect(refresh).toContain('...(instanceId ? { instanceId } : {})');
    expect(appSource).toContain('call("mcp.approveProject", { cwd: dialog.cwd, fingerprint: dialog.fingerprint');
    expect(appSource).toContain('call("mcp.revokeProject", { cwd: dialog.cwd');
    expect(appSource).toContain("Approved MCP servers may start programs and access the network as your Windows user. Any configuration change requires approval again.");
    expect(center).toContain("key={mcpServerRowKey(server)}");
    expect(center).not.toContain("projectMcp.root");
    expect(center).not.toContain('tab === "mcp" ? data?.roots.mcp');
  });

  it("rejects stale capability responses and mismatched action targets", () => {
    const requested = { cwd: "E:\\project-a", instanceId: "work" };
    const fingerprint = "a".repeat(64);
    expect(capabilityTargetMatches(requested, { cwd: "e:/project-a/", instanceId: "work" })).toBe(true);
    expect(capabilityTargetMatches(requested, { cwd: "E:\\project-b", instanceId: "work" })).toBe(false);
    expect(capabilityTargetMatches(requested, { cwd: "E:\\project-a", instanceId: "personal" })).toBe(false);
    expect(capabilityRequestMatches(1, 2, requested, requested)).toBe(false);
    expect(capabilityRequestMatches(2, 2, requested, requested)).toBe(true);
    expect(projectMcpDialogFromSnapshot("approve", fingerprint, { ...requested, fingerprint }, requested)).toEqual({ kind: "approve-project-mcp", ...requested, fingerprint, name: "project MCP servers" });
    expect(projectMcpDialogFromSnapshot("approve", "b".repeat(64), { ...requested, fingerprint }, requested)).toBeUndefined();
    expect(projectMcpDialogFromSnapshot("revoke", undefined, { ...requested, fingerprint }, requested)).toEqual({ kind: "revoke-project-mcp", ...requested, name: "project MCP servers" });
    expect(projectMcpDialogFromSnapshot("revoke", undefined, { ...requested, fingerprint }, { cwd: "E:\\project-b", instanceId: "work" })).toBeUndefined();
  });
});

describe("instance-scoped quota refresh", () => {
  it("requests the active Kimi instance and ignores superseded replies", () => {
    const start = appSource.indexOf("const refreshQuota");
    const refresh = appSource.slice(start, appSource.indexOf("const refreshCapabilities", start));
    expect(refresh).toContain('call("usage.quota", instanceId ? { instanceId } : {})');
    expect(refresh).toContain("quotaRefreshInFlight.current === request");
    expect(refresh).toContain("setQuota(undefined)");
    expect(refresh).toContain("[auth?.authenticated, connection, instanceId, refreshQuota]");
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

describe("Kimi skill composer integration", () => {
  const skills = [
    { name: "review", description: "Review a change", scope: "project" as const, source: "kimi" as const, path: "E:\\work\\.kimi-code\\skills\\review", modelInvocable: true, hasSubSkills: false },
    { name: "release", description: "Prepare release notes", scope: "user" as const, source: "agents" as const, path: "C:\\FixtureProfiles\\ExampleUser\\.agents\\skills\\release.md", modelInvocable: false, hasSubSkills: false },
  ];

  it("filters the real discovered skill inventory", () => {
    expect(filterKimiSkills(skills, "notes")).toEqual([skills[1]]);
    expect(filterKimiSkills(skills, "", 1)).toEqual([skills[0]]);
  });

  it("only rewrites a skill to slash syntax when the runtime advertises it", () => {
    expect(skillComposerInsertion("review", [{ name: "review" }])).toBe("/review ");
    expect(skillComposerInsertion("review", [{ name: "/skill:review" }])).toBe("/skill:review ");
    expect(skillComposerInsertion("review", [{ name: "help" }])).toBe("$review ");
  });
});

describe("subagent projection", () => {
  it("only inspects a recorded child when the runtime advertises inspection", () => {
    const linked = { threadIds: ["child-thread"] };
    expect(subagentCanInspect(true, linked)).toBe(true);
    expect(subagentCanInspect(false, linked)).toBe(false);
    expect(subagentCanInspect(true, {})).toBe(false);
  });

  it("derives real agent runs from preserved Kimi Agent tool calls", () => {
    expect(subagentRuns({ tools: [{
      toolCallId: "agent-1",
      title: "Agent: inspect performance",
      status: "in_progress",
      rawInput: { subagent_type: "explore", description: "Inspect performance", run_in_background: true },
      content: [{ type: "content", content: { type: "text", text: "agent_id: a1234" } }],
    }] })).toEqual([{ id: "agent-1", type: "explore", description: "Inspect performance", status: "running", background: true, agentId: "a1234" }]);
  });

  it("uses persisted background status instead of treating a detached agent as completed", () => {
    expect(subagentRuns({
      tools: [{
        toolCallId: "agent-call",
        title: "Agent: build APK",
        status: "completed",
        rawInput: { subagent_type: "coder", description: "Build APK", run_in_background: true },
        rawOutput: "task_id: agent-build1\nstatus: running\nautomatic_notification: true",
      }],
      backgroundTasks: [{
        taskId: "agent-build1",
        queuedId: "queued-1",
        turnId: "turn-1",
        description: "Build APK",
        status: "running",
        registeredAt: "2026-07-25T10:00:00.000Z",
        updatedAt: "2026-07-25T10:00:00.000Z",
        reportQueued: false,
      }],
    })).toEqual([{
      id: "agent-call",
      type: "coder",
      description: "Build APK",
      status: "running",
      background: true,
      detail: "running",
    }]);
  });

  it("keeps Codex receiver threads inspectable", () => {
    expect(subagentRuns({ tools: [{
      toolCallId: "collab-1",
      title: "Agent: spawnAgent",
      status: "completed",
      rawInput: { subagent_type: "spawnAgent", description: "Inspect tests", receiverThreadIds: ["child-thread"] },
    }] })).toMatchObject([{ id: "collab-1", threadIds: ["child-thread"], description: "Inspect tests" }]);
  });
});

describe("runtime thinking effort", () => {
  it("does not mislabel a legacy binary K3 thinking toggle as a specific effort", () => {
    const model = { id: "model", name: "Model", currentValue: "kimi-for-coding/k3", options: [{ value: "kimi-for-coding/k3", name: "K3" }] };
    const thinking = { id: "thinking", name: "Thinking", currentValue: "on", options: [{ value: "on", name: "On" }] };
    expect(thinkingEffortLabel(model, thinking)).toBe("Default");
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
    expect(markup).toContain('aria-label="Reasoning: Default"');
    expect(markup).toContain('aria-label="Permissions: Default"');
    expect(markup.match(/config-trigger/g)).toHaveLength(3);
  });

  it("renders an explicit Max effort supplied by the runtime", () => {
    const effortOptions = draftDefaults.map((option) => option.id === "thinking" ? {
      ...option,
      currentValue: "high",
      options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }, { value: "max", name: "Max" }],
    } : option);
    const overrides = draftConfigOverrides(effortOptions, { thinking: "max" });
    const markup = renderToStaticMarkup(createElement(ComposerConfig, { options: applyDraftConfig(effortOptions, overrides), onChange: () => undefined }));

    expect(markup).toContain('aria-label="Reasoning: Max"');
    expect(overrides).toEqual({ thinking: "max" });
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

  it("keeps YOLO confirmation bound to the chat or draft that requested it", () => {
    const first = configTargetKey({ threadId: "thread-1" }, undefined)!;
    const second = configTargetKey({ threadId: "thread-2" }, undefined)!;
    const draftOne = { kind: "project" as const, cwd: "C:\\work" };
    const draftTwo = { kind: "project" as const, cwd: "C:\\work" };
    const projectDraft = configTargetKey(undefined, draftOne)!;
    const chatDraft = configTargetKey(undefined, { kind: "chat" })!;

    expect(first).not.toBe(second);
    expect(projectDraft).not.toBe(chatDraft);
    expect(shouldAcknowledgeYolo(true, first, first)).toBe(true);
    expect(shouldAcknowledgeYolo(false, first, first)).toBe(false);
    expect(shouldAcknowledgeYolo(true, first, second)).toBe(false);
    expect(shouldAcknowledgeYolo(true, projectDraft, chatDraft)).toBe(false);
    expect(configTargetsMatch({ key: projectDraft, kind: "draft", draft: draftOne }, { key: projectDraft, kind: "draft", draft: draftOne })).toBe(true);
    expect(configTargetsMatch({ key: projectDraft, kind: "draft", draft: draftOne }, { key: projectDraft, kind: "draft", draft: draftTwo })).toBe(false);
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
    expect(thread.provider).toBe("kimi");
  });

  it("preserves provider instance, parent, and goal metadata", () => {
    const historical = normalizeThread({
      threadId: "side", sessionId: "session", provider: "codex", instanceId: "work", parentThreadId: "main", cwd: "C:\\work", title: "Investigate",
      goal: { objective: "Find the regression", updatedAt: "2026-07-26T00:00:00.000Z" },
      turns: [{ turnId: "turn", startedAt: "2026-07-26T00:00:00.000Z", completedAt: "2026-07-26T00:01:00.000Z" }],
      messages: [{ turnId: "turn", role: "assistant", text: "Preserved answer" }],
      activity: [{ id: "step", turnId: "turn", kind: "thought", status: "completed", text: "Preserved step", seq: 1, createdAt: "2026-07-26T00:00:00.000Z", updatedAt: "2026-07-26T00:00:30.000Z" }],
    } as never);
    expect(historical).toMatchObject({ provider: "codex", instanceId: "work", parentThreadId: "main", goal: { objective: "Find the regression" } });
    expect(historical.messages[0]?.text).toBe("Preserved answer");
    expect(historical.activity[0]?.text).toBe("Preserved step");
    expect(threadCanRun(historical)).toBe(false);
  });

  it("preserves isolated worktree and archive metadata", () => {
    expect(normalizeThread({
      threadId: "archived", sessionId: "session", cwd: "D:/worktree", title: "Archived",
      worktree: { sourceCwd: "E:/project", branch: "tasty/archived" }, archivedAt: "2026-07-27T00:00:00.000Z",
    } as never)).toMatchObject({ worktree: { sourceCwd: "E:/project", branch: "tasty/archived" }, archivedAt: "2026-07-27T00:00:00.000Z" });
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

  it("turns only non-empty hunk comments into a follow-up prompt", () => {
    const review = { turnId: "turn-1", files: [{ path: "src/a.ts", binary: false, canRevertHunks: true, hunks: [{ index: 0, header: "@@ -1 +1 @@", lines: ["-old", "+new"] }] }] };
    expect(reviewFeedbackPrompt(review, { [reviewCommentKey("src/a.ts", 0)]: "Keep the old fallback." })).toBe("Review the following feedback for turn turn-1:\n\n- src/a.ts (@@ -1 +1 @@)\n  Keep the old fallback.");
    expect(reviewFeedbackPrompt(review, {})).toBe("");
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
