import { test, expect } from "bun:test";
import { runWakeRecovery } from "./daemon.js";

// Regression test for the "stuck sync after idle" bug (root-caused 2026-06-27,
// session jx761m4 / ct-37696). After a macOS sleep the file watcher's FSEvents
// stream can go silent WITHOUT erroring: the daemon stays "running, connected"
// yet stops seeing file changes, so `cast status` shows an empty queue while a
// transcript sits unsynced for hours. The old fallback (60-min idle watcher
// restart) never fired because the wake handler kept re-arming the idle clock.
//
// runWakeRecovery is the fix's orchestrator: on a detected wake, restart the
// watcher AND sweep for unsynced files. The sweep is the real safety net, so it
// must run even when the restart fails or hangs — that's what these tests pin.

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type Recorder = {
  order: string[];
  restarted: boolean;
  errors: string[];
};

function makeDeps(over: Partial<Parameters<typeof runWakeRecovery>[0]>, rec: Recorder) {
  return {
    restartWatcher: async () => { rec.order.push("restart"); },
    sweep: async () => { rec.order.push("sweep"); },
    onWatcherRestarted: () => { rec.restarted = true; },
    log: () => {},
    logError: (msg: string, err: Error) => { rec.errors.push(`${msg}: ${err?.message ?? ""}`); },
    ...over,
  };
}

test("restarts the watcher, then sweeps, in order", async () => {
  const rec: Recorder = { order: [], restarted: false, errors: [] };
  await runWakeRecovery(makeDeps({}, rec));
  expect(rec.order).toEqual(["restart", "sweep"]);
  expect(rec.restarted).toBe(true);
  expect(rec.errors).toEqual([]);
});

test("the sweep waits for the restart to finish (no overlap)", async () => {
  const rec: Recorder = { order: [], restarted: false, errors: [] };
  const gate = deferred();
  const done = runWakeRecovery(makeDeps({
    restartWatcher: async () => { rec.order.push("restart:start"); await gate.promise; rec.order.push("restart:end"); },
    sweep: async () => { rec.order.push("sweep"); },
  }, rec));
  // Let the restart begin and park on the gate; the sweep must not have run yet.
  await Promise.resolve();
  expect(rec.order).toEqual(["restart:start"]);
  gate.resolve();
  await done;
  expect(rec.order).toEqual(["restart:start", "restart:end", "sweep"]);
});

test("a failing restart still proceeds to the sweep", async () => {
  const rec: Recorder = { order: [], restarted: false, errors: [] };
  await runWakeRecovery(makeDeps({
    restartWatcher: async () => { rec.order.push("restart"); throw new Error("close→open deadlock"); },
  }, rec));
  expect(rec.order).toEqual(["restart", "sweep"]);
  expect(rec.restarted).toBe(false); // restart never succeeded
  expect(rec.errors.some(e => e.includes("watcher restart failed"))).toBe(true);
});

test("a hanging restart times out and the sweep still ships the bytes", async () => {
  const rec: Recorder = { order: [], restarted: false, errors: [] };
  const start = Date.now();
  await runWakeRecovery(makeDeps({
    // Never resolves — simulates restart() deadlocked on bun's File Watcher thread.
    restartWatcher: () => new Promise<void>(() => { rec.order.push("restart"); }),
    restartTimeoutMs: 30,
  }, rec));
  expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  expect(rec.order).toEqual(["restart", "sweep"]);
  expect(rec.restarted).toBe(false);
  expect(rec.errors.some(e => e.includes("timeout"))).toBe(true);
});

test("a failing sweep is logged but does not throw", async () => {
  const rec: Recorder = { order: [], restarted: false, errors: [] };
  await runWakeRecovery(makeDeps({
    sweep: async () => { rec.order.push("sweep"); throw new Error("disk gone"); },
  }, rec));
  expect(rec.order).toEqual(["restart", "sweep"]);
  expect(rec.errors.some(e => e.includes("unsynced sweep failed"))).toBe(true);
});
