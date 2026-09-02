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

// classifyTickGap is the guard that keeps wake recovery from firing on event-loop
// stalls. Root-caused 2026-08-14: a backlogged transcript sweep pinned the loop for
// minutes, the gap was logged as "Sleep detected", and the fake wake triggered
// ANOTHER sweep — a self-sustaining freeze loop. A truly suspended process accrues
// ~zero CPU during the gap; a pinned one burns CPU the whole time. That asymmetry
// is the whole classifier.
import { classifyTickGap } from "./daemon.js";

test("a gap with ~no CPU consumed is a real sleep", () => {
  expect(classifyTickGap(300_000, 0)).toBe("sleep");
  expect(classifyTickGap(300_000, 1_500)).toBe("sleep"); // stray timer wakeups stay under threshold
});

test("a gap where the process burned CPU is a stall, not a sleep", () => {
  expect(classifyTickGap(189_000, 150_000)).toBe("stall"); // the observed 189s freeze
  expect(classifyTickGap(60_000, 60_000)).toBe("stall");
});

test("threshold sits at 20% of wall time", () => {
  expect(classifyTickGap(100_000, 20_000)).toBe("stall");
  expect(classifyTickGap(100_000, 19_999)).toBe("sleep");
});

// BackendOutageClock feeds the self-heal restart ("backend recovered after Ns
// down"). Root-caused 2026-08-16: a closed lid on battery produced several short
// maintenance wakes with no network. Each failed the heartbeat and started the
// clock; the first real wake then read "recovered after 1701s" and restarted a
// healthy daemon in the middle of deliveries. Only time unreachable while AWAKE
// may count, so a detected suspend clears the clock.
import { BackendOutageClock } from "./daemon.js";

test("an outage spanning a suspend does not count the sleep", () => {
  const clock = new BackendOutageClock();
  clock.markFailure(1_000);         // maintenance wake, no network
  clock.noteSuspend();              // lid closed
  expect(clock.markSuccess(1_701_000)).toBe(0); // first heartbeat after the real wake
});

test("a backend still dead after wake is timed from the wake, not from before it", () => {
  const clock = new BackendOutageClock();
  clock.markFailure(1_000);
  clock.noteSuspend();
  clock.markFailure(1_000_000);     // still failing after wake
  expect(clock.markSuccess(1_200_000)).toBe(200_000);
});

test("an awake outage is measured from its first failure", () => {
  const clock = new BackendOutageClock();
  expect(clock.markSuccess(5_000)).toBe(0);
  clock.markFailure(10_000);
  clock.markFailure(20_000);        // repeated failures keep the original start
  expect(clock.markSuccess(250_000)).toBe(240_000);
  expect(clock.markSuccess(260_000)).toBe(0); // clock is cleared by success
});

// LoopFreezeLedger feeds the heartbeat's loop_freeze_ms: how much of the last
// minute the daemon was blocked. The web shows "under load" from it and stops
// blaming the session for a late message.
import { LoopFreezeLedger } from "./daemon.js";

test("freeze ledger sums freezes inside the trailing window and drops older ones", () => {
  const ledger = new LoopFreezeLedger(60_000);
  ledger.record(6_000, 10_000);
  ledger.record(48_000, 40_000);
  expect(ledger.recentMs(50_000)).toBe(54_000);
  expect(ledger.recentMs(70_001)).toBe(48_000); // the 10s freeze aged out
  expect(ledger.recentMs(200_000)).toBe(0);
});

// A probe tick that lands minutes late with ~no CPU burned is a suspend, not
// load. Counting it lit "daemon under load" for a minute after every wake.
import { isSuspendGap } from "./daemon.js";

test("a long gap with almost no CPU is a suspend; a busy or short gap is a freeze", () => {
  // Lid closed for 15 minutes: 6ms of CPU.
  expect(isSuspendGap(937_000, 6)).toBe(true);
  expect(isSuspendGap(81_000, 21)).toBe(true);
  // A 42s walk blocked on a busy disk still churned 928ms between syscalls.
  expect(isSuspendGap(42_000, 928)).toBe(false);
  // Short gaps always count: a 5s blocked spawn is real, a 5s sleep is not a thing.
  expect(isSuspendGap(6_000, 0)).toBe(false);
  expect(isSuspendGap(29_999, 0)).toBe(false);
});
