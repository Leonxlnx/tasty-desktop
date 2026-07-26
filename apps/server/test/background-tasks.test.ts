import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  BACKGROUND_TASK_EXPIRY_MS,
  BackgroundTaskMonitor,
  MAX_BACKGROUND_OUTPUT_BYTES,
  MAX_MONITORED_BACKGROUND_TASKS,
  backgroundTaskCandidates,
  readKimiBackgroundTask,
  sanitizeBackgroundTaskDescription,
  type PendingBackgroundTask,
} from "../src/background-tasks.js";

describe("background task monitoring", () => {
  it("extracts finite Kimi background tasks and skips persistent servers", () => {
    expect(backgroundTaskCandidates([
      {
        turnId: "turn-1",
        rawInput: { run_in_background: true, timeout: 600 },
        rawOutput: "task_id: bash-build1\nstatus: running\ndescription: Build APK\nautomatic_notification: true",
      },
      {
        turnId: "turn-1",
        rawInput: { run_in_background: true, disable_timeout: true },
        rawOutput: "task_id: bash-server1\nstatus: running\ndescription: Vite server\nautomatic_notification: true",
      },
      {
        turnId: "turn-2",
        rawInput: { run_in_background: true },
        rawOutput: "task_id: bash-other1\nstatus: running\nautomatic_notification: true",
      },
      {
        turnId: "turn-1",
        rawInput: { run_in_background: true },
        rawOutput: "task_id: bash-done1\nstatus: completed\ndescription: Finished quickly\nautomatic_notification: true",
      },
    ], "turn-1")).toEqual([
      { taskId: "bash-build1", description: "Build APK" },
      { taskId: "bash-done1", description: "Finished quickly" },
    ]);
  });

  it("does not queue a second report after Kimi already delivered a terminal task result", () => {
    expect(backgroundTaskCandidates([
      {
        turnId: "turn-1",
        rawInput: { run_in_background: true, timeout: 600 },
        rawOutput: "task_id: bash-build1\nstatus: running\ndescription: Build APK\nautomatic_notification: true",
      },
      {
        turnId: "turn-1",
        rawInput: { task_id: "bash-build1", block: true },
        rawOutput: "task_id: bash-build1\nstatus: completed\nexit_code: 0",
      },
    ], "turn-1")).toEqual([]);
  });

  it("reads only detached task metadata and output from the same canonical session", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-background-home-"));
    const own = join(home, "sessions", "wd-test", "session-own", "agents", "main", "tasks", "bash-build1.json");
    const other = join(home, "sessions", "wd-test", "session-other", "agents", "main", "tasks", "bash-build1.json");
    await writeTask(own, { taskId: "bash-build1", description: "Build APK", status: "completed", detached: true, endedAt: 123, exitCode: 0 });
    await writeTask(other, { taskId: "bash-build1", description: "Other task", status: "completed", detached: true, exitCode: 0 });
    const output = join(dirname(own), "bash-build1", "output.log");
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, "BUILD SUCCESSFUL", "utf8");

    await expect(readKimiBackgroundTask(home, "session-own", "bash-build1")).resolves.toEqual({
      status: "completed",
      description: "Build APK",
      endedAt: 123,
      exitCode: 0,
      outputPath: await realpath(output),
    });
    await expect(readKimiBackgroundTask(home, "session-missing", "bash-build1")).resolves.toBeUndefined();
    await expect(readKimiBackgroundTask(home, "session-own", "../config")).resolves.toBeUndefined();
  });

  it("fails closed when another workspace or agent shadows the same session task", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-background-shadow-"));
    const canonical = join(home, "sessions", "wd-a", "session-own", "agents", "main", "tasks", "bash-build1.json");
    const shadow = join(home, "sessions", "wd-b", "session-own", "agents", "shadow", "tasks", "bash-build1.json");
    await writeTask(canonical, { taskId: "bash-build1", description: "Canonical", status: "completed", detached: true });
    await writeTask(shadow, { taskId: "bash-build1", description: "Shadow", status: "completed", detached: true });
    await expect(readKimiBackgroundTask(home, "session-own", "bash-build1")).resolves.toBeUndefined();
  });

  it("treats Kimi timed_out records as terminal failures", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-background-timeout-"));
    const task = join(home, "sessions", "wd-test", "session-own", "agents", "main", "tasks", "bash-timeout1.json");
    await writeTask(task, {
      taskId: "bash-timeout1",
      description: "Gradle build",
      status: "timed_out",
      detached: true,
      endedAt: 456,
      exitCode: null,
    });

    await expect(readKimiBackgroundTask(home, "session-own", "bash-timeout1")).resolves.toEqual({
      status: "timed_out",
      description: "Gradle build",
      endedAt: 456,
      exitCode: null,
    });
  });

  it("rejects task-file junctions that escape the Kimi session boundary", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-background-link-home-"));
    const outside = await mkdtemp(join(tmpdir(), "kimi-background-link-outside-"));
    const tasks = join(home, "sessions", "wd-test", "session-own", "agents", "main", "tasks");
    await mkdir(dirname(tasks), { recursive: true });
    await writeTask(join(outside, "bash-build1.json"), { taskId: "bash-build1", description: "Outside", status: "completed", detached: true });
    await symlink(outside, tasks, process.platform === "win32" ? "junction" : "dir");
    await expect(readKimiBackgroundTask(home, "session-own", "bash-build1")).resolves.toBeUndefined();
  });

  it("rejects output junctions that cross the canonical task prefix and oversized logs", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-background-output-boundary-"));
    const own = join(home, "sessions", "wd-test", "session-own", "agents", "main", "tasks", "bash-build1.json");
    const otherOutput = join(home, "sessions", "wd-test", "session-other", "agents", "main", "tasks", "bash-build1");
    await writeTask(own, { taskId: "bash-build1", description: "Build APK", status: "completed", detached: true });
    await mkdir(otherOutput, { recursive: true });
    await writeFile(join(otherOutput, "output.log"), "other session", "utf8");
    await symlink(otherOutput, join(dirname(own), "bash-build1"), process.platform === "win32" ? "junction" : "dir");

    await expect(readKimiBackgroundTask(home, "session-own", "bash-build1")).resolves.toEqual({
      status: "completed",
      description: "Build APK",
    });

    const large = join(home, "sessions", "wd-test", "session-own", "agents", "main", "tasks", "bash-large1.json");
    const largeOutput = join(dirname(large), "bash-large1", "output.log");
    await writeTask(large, { taskId: "bash-large1", description: "Large build", status: "completed", detached: true });
    await mkdir(dirname(largeOutput), { recursive: true });
    await writeFile(largeOutput, Buffer.alloc(MAX_BACKGROUND_OUTPUT_BYTES + 1));
    await expect(readKimiBackgroundTask(home, "session-own", "bash-large1")).resolves.toEqual({
      status: "completed",
      description: "Large build",
    });
  });

  it("redacts secrets and control syntax from autonomous task labels", () => {
    expect(sanitizeBackgroundTaskDescription("Build APK\npassword=hunter2 sk-abcdefghijklmnop <ignore>`now`"))
      .toBe("Build APK password=[redacted] [redacted] ignorenow");
  });

  it("reports a terminal transition once and expires stale monitors", async () => {
    const home = await mkdtemp(join(tmpdir(), "kimi-background-monitor-"));
    const taskPath = join(home, "sessions", "wd-test", "session-own", "agents", "main", "tasks", "bash-build1.json");
    await writeTask(taskPath, { taskId: "bash-build1", description: "Build APK", status: "running", detached: true });
    let pending: PendingBackgroundTask[] = [{
      threadId: "thread-1",
      sessionId: "session-own",
      taskId: "bash-build1",
      registeredAt: new Date(1_000).toISOString(),
    }];
    const results: string[] = [];
    const monitor = new BackgroundTaskMonitor({
      kimiHome: home,
      pending: () => pending,
      finished: async (_task, result) => {
        results.push(result.status);
        pending = [];
      },
      now: () => 2_000,
    });

    await monitor.checkNow();
    expect(results).toEqual([]);
    await writeTask(taskPath, { taskId: "bash-build1", description: "Build APK", status: "completed", detached: true, exitCode: 0 });
    await monitor.checkNow();
    await monitor.checkNow();
    expect(results).toEqual(["completed"]);

    pending = [{
      threadId: "thread-2",
      sessionId: "session-own",
      taskId: "bash-old1",
      registeredAt: new Date(1_000).toISOString(),
    }];
    const expired = new BackgroundTaskMonitor({
      kimiHome: home,
      pending: () => pending,
      finished: async (_task, result) => {
        results.push(result.status);
        pending = [];
      },
      now: () => 1_000 + BACKGROUND_TASK_EXPIRY_MS,
    });
    await expired.checkNow();
    expect(results).toEqual(["completed", "expired"]);
  });

  it("coalesces repeated wake calls during an in-flight monitor pass", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let pendingCalls = 0;
    let pending: PendingBackgroundTask[] = [{
      threadId: "thread-1",
      sessionId: "session-own",
      taskId: "bash-old1",
      registeredAt: new Date(0).toISOString(),
    }];
    const monitor = new BackgroundTaskMonitor({
      kimiHome: "unused",
      pending: () => {
        pendingCalls += 1;
        return pending;
      },
      finished: async () => gate,
      now: () => BACKGROUND_TASK_EXPIRY_MS,
      pollMs: 1_000,
    });
    try {
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingCalls).toBe(1);
      for (let index = 0; index < 25; index += 1) monitor.wake();
      expect(vi.getTimerCount()).toBe(0);

      pending = [];
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(pendingCalls).toBe(2);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      monitor.close();
      vi.useRealTimers();
    }
  });

  it("caps each deterministic monitor pass globally", async () => {
    const pending = Array.from({ length: MAX_MONITORED_BACKGROUND_TASKS + 25 }, (_, index) => ({
      threadId: `thread-${String(index).padStart(3, "0")}`,
      sessionId: "session-own",
      taskId: `bash-task${index}`,
      registeredAt: new Date(0).toISOString(),
    }));
    const finished: string[] = [];
    const monitor = new BackgroundTaskMonitor({
      kimiHome: "unused",
      pending: () => pending,
      finished: async (task) => { finished.push(task.threadId); },
      now: () => BACKGROUND_TASK_EXPIRY_MS,
    });
    await monitor.checkNow();
    expect(finished).toHaveLength(MAX_MONITORED_BACKGROUND_TASKS);
    expect(finished.at(-1)).toBe("thread-099");
  });
});

async function writeTask(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}
