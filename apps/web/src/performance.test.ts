import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendTerminalEntries,
  applyEvents,
  boundedDiffPreview,
  createTurnProjectionCache,
  gitChangedFilePageSize,
  normalizeThread,
  progressiveGroups,
  projectRecentTurns,
  projectedTurnCount,
} from "./App";

const completedTurnCount = 5_000;
const liveDeltaCount = 250;
const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
const initialTurnWindowMatch = appSource.match(/const initialTurnWindow = (\d+);/);
if (!initialTurnWindowMatch) throw new Error("App.tsx must declare initialTurnWindow");
const productionInitialTurnWindow = Number(initialTurnWindowMatch[1]);

function largeSession() {
  const createdAt = "2026-08-08T00:00:00.000Z";
  const turns: Array<{ turnId: string; startedAt: string; completedAt?: string; stopReason?: string }> = Array.from({ length: completedTurnCount }, (_, index) => ({
    turnId: `turn-${index}`,
    startedAt: createdAt,
    completedAt: createdAt,
    stopReason: "end_turn",
  }));
  const messages: Array<{ turnId: string; role: "user" | "assistant"; text: string; seq: number; updatedSeq: number }> = Array.from({ length: completedTurnCount }, (_, index) => ({
    turnId: `turn-${index}`,
    role: "assistant",
    text: `Completed turn ${index}`,
    seq: index + 1,
    updatedSeq: index + 1,
  }));
  turns.push({ turnId: "turn-live", startedAt: createdAt });
  messages.push({
    turnId: "turn-live",
    role: "user",
    text: "Continue",
    seq: completedTurnCount + 1,
    updatedSeq: completedTurnCount + 1,
  });

  return normalizeThread({
    threadId: "performance-thread",
    sessionId: "performance-session",
    provider: "kimi",
    cwd: "E:/performance-workspace",
    kind: "project",
    title: "Large session",
    createdAt,
    updatedAt: createdAt,
    running: true,
    activeTurnId: "turn-live",
    lifecycle: { phase: "running", updatedAt: createdAt, turnId: "turn-live" },
    turns,
    messages,
  } as Parameters<typeof normalizeThread>[0]);
}

function event(seq: number, type: string, payload: Record<string, unknown>) {
  return {
    threadId: "performance-thread",
    seq,
    type,
    payload,
    createdAt: "2026-08-08T00:00:01.000Z",
  } as Parameters<typeof applyEvents>[1][number];
}

describe("renderer performance evidence", () => {
  it("updates one live projection while keeping 5,000 completed turns referentially stable", () => {
    const cache = createTurnProjectionCache();
    const session = largeSession();

    const primeStarted = performance.now();
    const primed = applyEvents([session], [event(10_000, "UsageUpdated", { usage: { used: 1, size: 100 } })], cache)[0]!;
    const before = [...projectRecentTurns(primed, completedTurnCount + 1, cache)];
    const primeMilliseconds = performance.now() - primeStarted;

    const deltas = Array.from({ length: liveDeltaCount }, (_, index) => event(
      10_001 + index,
      "MessageDelta",
      { turnId: "turn-live", role: "assistant", text: ` chunk-${index}` },
    ));
    const updateStarted = performance.now();
    let updated = primed;
    let completedReferenceMismatches = 0;
    let liveViewReferenceChanges = 0;
    let previousLiveView = before.at(-1);
    for (const delta of deltas) {
      updated = applyEvents([updated], [delta], cache)[0]!;
      const streamedViews = projectRecentTurns(updated, completedTurnCount + 1, cache);
      for (let index = 0; index < completedTurnCount; index += 1) {
        const view = streamedViews[index];
        if (view !== before[index] || view?.messages !== before[index]?.messages) completedReferenceMismatches += 1;
      }
      if (streamedViews.at(-1) !== previousLiveView) liveViewReferenceChanges += 1;
      previousLiveView = streamedViews.at(-1);
    }
    const after = projectRecentTurns(updated, completedTurnCount + 1, cache);
    const recent = projectRecentTurns(updated, productionInitialTurnWindow, cache);
    const updateMilliseconds = performance.now() - updateStarted;

    const changedViewReferences = after.reduce(
      (count, view, index) => count + Number(view !== before[index]),
      0,
    );

    expect(projectedTurnCount(updated, cache)).toBe(completedTurnCount + 1);
    expect(changedViewReferences).toBe(1);
    expect(completedReferenceMismatches).toBe(0);
    expect(liveViewReferenceChanges).toBe(liveDeltaCount);
    expect(after.at(-1)).not.toBe(before.at(-1));
    expect(after.at(-1)?.messages).not.toBe(before.at(-1)?.messages);
    expect(after.slice(0, completedTurnCount).every((view, index) => (
      view === before[index] && view.messages === before[index]?.messages
    ))).toBe(true);
    expect(updated.turns).toBe(primed.turns);
    expect(updated.messages).not.toBe(primed.messages);
    expect(updated.messages[0]).toBe(primed.messages[0]);
    expect(productionInitialTurnWindow).toBe(30);
    expect(recent).toHaveLength(productionInitialTurnWindow);
    expect(recent.at(-1)?.record.turnId).toBe("turn-live");
    expect(projectedTurnCount(updated, cache) - recent.length).toBe(4_971);

    // These are deliberately broad regression sentinels, not microbenchmark targets.
    expect(primeMilliseconds).toBeLessThan(15_000);
    expect(updateMilliseconds).toBeLessThan(5_000);
    console.info("large-session-reference", {
      turns: projectedTurnCount(updated, cache),
      streamedDeltas: liveDeltaCount,
      changedViewReferences,
      completedReferenceMismatches,
      liveViewReferenceChanges,
      visibleTurns: recent.length,
      hiddenTurns: projectedTurnCount(updated, cache) - recent.length,
      primeMilliseconds: Math.round(primeMilliseconds),
      updateMilliseconds: Math.round(updateMilliseconds),
    });
  });

  it("keeps terminal and diff inputs within hard bounds and Git on its initial page", () => {
    const started = performance.now();
    const shortTerminalChunks = Array.from({ length: 2_000 }, (_, index) => ({
      id: index,
      kind: index % 2 ? "stdout" as const : "stderr" as const,
      text: "12345678",
    }));
    const largeTerminalChunks = Array.from({ length: 2_000 }, (_, index) => ({
      id: index,
      kind: index % 2 ? "stdout" as const : "stderr" as const,
      text: "x".repeat(2_000),
    }));
    let entryBounded = [] as Parameters<typeof appendTerminalEntries>[0];
    let characterBounded = [] as Parameters<typeof appendTerminalEntries>[0];
    for (let offset = 0; offset < shortTerminalChunks.length; offset += 100) {
      entryBounded = appendTerminalEntries(entryBounded, shortTerminalChunks.slice(offset, offset + 100));
      expect(entryBounded.length).toBeLessThanOrEqual(500);
      expect(entryBounded.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(500_000);
    }
    for (let offset = 0; offset < largeTerminalChunks.length; offset += 100) {
      characterBounded = appendTerminalEntries(characterBounded, largeTerminalChunks.slice(offset, offset + 100));
      expect(characterBounded.length).toBeLessThanOrEqual(500);
      expect(characterBounded.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(500_000);
    }

    const shortDiff = Array.from({ length: 50_000 }, (_, index) => `+line-${index}`).join("\n");
    const largeDiff = Array.from({ length: 50_000 }, (_, index) => `+${index}-${"x".repeat(180)}`).join("\n");
    const lineBoundedDiff = boundedDiffPreview(shortDiff);
    const characterBoundedDiff = boundedDiffPreview(largeDiff);
    const allGitRows = Array.from({ length: 50_000 }, (_, index) => `src/file-${index}.ts`);
    const gitGroups = progressiveGroups([
      { id: "conflicts", items: allGitRows.slice(0, 10) },
      { id: "staged", items: allGitRows.slice(10, 25) },
      { id: "changes", items: allGitRows.slice(25) },
    ], gitChangedFilePageSize);
    const gitRows = gitGroups.flatMap((group) => group.items);
    const elapsedMilliseconds = performance.now() - started;

    expect(entryBounded).toHaveLength(500);
    expect(entryBounded.reduce((total, entry) => total + entry.text.length, 0)).toBeLessThanOrEqual(500_000);
    expect(characterBounded.length).toBeLessThanOrEqual(500);
    expect(characterBounded.reduce((total, entry) => total + entry.text.length, 0)).toBe(500_000);
    expect(lineBoundedDiff.lines).toHaveLength(1_200);
    expect(lineBoundedDiff.omittedLines).toBeGreaterThan(0);
    expect(characterBoundedDiff.lines.join("\n").length).toBeLessThanOrEqual(160_000);
    expect(characterBoundedDiff.omittedLines).toBeGreaterThan(0);
    expect(gitRows).toHaveLength(60);
    expect(gitGroups.map((group) => group.items.length)).toEqual([10, 15, 35]);
    expect(gitGroups.map((group) => group.total)).toEqual([10, 15, 49_975]);

    // Large synthetic inputs should remain comfortably below this non-flaky ceiling.
    expect(elapsedMilliseconds).toBeLessThan(10_000);
    console.info("bounded-render-inputs", {
      terminalEntryLimit: entryBounded.length,
      terminalCharacterLimit: characterBounded.reduce((total, entry) => total + entry.text.length, 0),
      diffLineLimit: lineBoundedDiff.lines.length,
      diffCharacterLimit: characterBoundedDiff.lines.join("\n").length,
      gitRowLimit: gitRows.length,
      elapsedMilliseconds: Math.round(elapsedMilliseconds),
    });
  });

  it("keeps production render call sites wired to the qualified bounds", () => {
    expect(appSource).toMatch(/const \[visibleTurnLimit, setVisibleTurnLimit\] = useState\(initialTurnWindow\)[\s\S]*?const turnWindow = useMemo\(\(\) => \{[\s\S]*?visible: recentTurns\(views, visibleTurnLimit\)[\s\S]*?const visibleTurnViews = turnWindow\.visible;[\s\S]*?<div ref=\{conversationStage\} className="conversation-stage">[\s\S]*?visibleTurnViews\.map\(\(turn\) => <TurnBlock/);

    expect(appSource).toMatch(/export function applyTerminalOutputBatch[\s\S]*?entries: appendTerminalEntries\(tab\.entries, additions\)[\s\S]*?\{tab\.entries\.map\(\(entry\) => <pre/);

    expect(appSource).toMatch(/const renderedGitDiff = useMemo\(\(\) => gitDiff \? boundedDiffPreview\([\s\S]*?renderedGitDiff\.lines\.map\(\(line, index\) => <span/);

    expect(appSource).toMatch(/const \[gitFileRowLimit, setGitFileRowLimit\] = useState\(gitChangedFilePageSize\)[\s\S]*?progressiveGroups\(gitFileSections\.map\(\(section\) => \(\{ id: section\.id, items: section\.files \}\)\), gitFileRowLimit\)[\s\S]*?section\.items\.map\(\(file\) => <div/);
  });
});
