import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TaskScheduler } from "./taskScheduler.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tasksched-heartbeat-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeScheduler(renew: () => Promise<boolean | null>) {
  const scheduler = new TaskScheduler({
    syncService: { renewTaskLease: renew } as any,
    config: {},
    log: () => {},
    runsFile: path.join(dir, "trigger-runs.json"),
  }) as any;
  scheduler.track({ taskId: "t1", tmuxSession: "ct-claude-renew", startedAt: Date.now(), maxRuntimeMs: 600_000 });
  // The tmux probe is not under test: a beat here is only about the renewal.
  scheduler.checkTaskCompletion = async () => {};
  return scheduler;
}

describe("a run's lease renewal", () => {
  it("keeps watching the run when the backend cannot be reached, and renews on the next beat", async () => {
    const answers: Array<boolean | null> = [null, true];
    const scheduler = makeScheduler(async () => answers.shift() as boolean | null);
    try {
      await scheduler.heartbeat("t1");
      expect(scheduler.running.has("t1")).toBe(true);
      await scheduler.heartbeat("t1");
      expect(answers).toEqual([]);
      expect(scheduler.running.has("t1")).toBe(true);
    } finally {
      scheduler.stop();
    }
  });

  it("stops watching the run when the backend answers that the lease is no longer held", async () => {
    const scheduler = makeScheduler(async () => false);
    try {
      await scheduler.heartbeat("t1");
      expect(scheduler.running.has("t1")).toBe(false);
    } finally {
      scheduler.stop();
    }
  });
});
