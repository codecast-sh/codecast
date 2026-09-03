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

// The same monotonic cross check the freeze probe uses. Without it a freeze
// that straddles a wake reads as hours of wall time with a couple of percent of
// CPU, which the CPU rule alone calls sleep and answers with the recovery sweep
// that feeds the freeze.
test("the loop clock decides the gap when both clocks are available", () => {
  // A 40s freeze inside a 37 minute wall gap: the loop really was blocked 40s.
  expect(classifyTickGap(2_234_000, 40_000, 40_000)).toBe("stall");
  // A hibernate: the loop was late by almost nothing, however the CPU counter
  // reads against that tiny window.
  expect(classifyTickGap(2_234_000, 6, 400)).toBe("sleep");
  expect(classifyTickGap(2_234_000, 5_000, 2_000)).toBe("sleep");
  // A stall both clocks saw is still a stall.
  expect(classifyTickGap(189_000, 150_000, 189_000)).toBe("stall");
});

// The sleep shortcut needs the two clocks to disagree, not just a small loop
// gap. A caller that passes only the wall clock passes the same number twice,
// and every short busy window there has to keep the CPU verdict: a sub-30s pin
// answered with "sleep" would fire the recovery sweep that pins the loop again.
test("a short busy gap with no monotonic signal is still a stall", () => {
  expect(classifyTickGap(29_000, 28_000)).toBe("stall");
  expect(classifyTickGap(10_000, 10_000)).toBe("stall");
  expect(classifyTickGap(29_000, 100)).toBe("sleep"); // short and idle, as before
  expect(classifyTickWindow(10_000, 9_000, 10_000)).toEqual({ stalled: true, recover: false });
});

// "Was the loop pinned" and "did the machine sleep" are separate questions, and
// one tick window can answer yes to both. Folding them into one verdict cost
// the wake its recovery: a window holding a hibernate AND 40s of blocked loop
// took the stall branch, so the watcher was never restarted and the backend
// outage clock never cleared.
import { sawSuspend, classifyTickWindow } from "./daemon.js";

test("a sleep is seen by the gap between the two clocks, not by the CPU counter", () => {
  expect(sawSuspend(2_234_000, 40_000)).toBe(true);
  expect(sawSuspend(189_000, 189_000)).toBe(false);   // a pure stall, clocks agree
  expect(sawSuspend(60_000, 45_000)).toBe(false);     // 15s apart is timer drift, not sleep
});

test("a window holding both a sleep and a stall reports the stall AND still recovers", () => {
  // The 2026-09-02 15:40Z shape: 37 minutes of wall gap around 40s of real
  // freeze that burned 20s of CPU.
  expect(classifyTickWindow(2_234_000, 20_000, 40_000)).toEqual({ stalled: true, recover: true });
  // A pure stall gets no recovery: the sweep it fires is what pins the loop.
  expect(classifyTickWindow(189_000, 150_000, 189_000)).toEqual({ stalled: true, recover: false });
  // A plain hibernate recovers, as it always did.
  expect(classifyTickWindow(2_234_000, 400, 6)).toEqual({ stalled: false, recover: true });
  // A platform whose monotonic clock runs through suspend keeps the CPU rule
  // and still recovers.
  expect(classifyTickWindow(2_234_000, 400, 2_234_000)).toEqual({ stalled: false, recover: true });
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

// The monotonic clock stops while the machine is suspended, so the time the
// loop truly failed to run is the smaller of the wall gap and the loop gap.
// That is what separates a hibernate from a freeze, and what measures a freeze
// that straddles a wake at its real length.
import { classifyLoopGap } from "./daemon.js";

test("the loop clock separates a freeze from a suspend and measures it honestly", () => {
  // A real freeze: both clocks agree, CPU churned.
  expect(classifyLoopGap(42_000, 42_000, 928)).toEqual({ kind: "freeze", freezeMs: 42_000 });
  // A lid closed for 37 minutes: the loop was late by nothing.
  expect(classifyLoopGap(2_234_000, 400, 6)).toEqual({ kind: "suspend", freezeMs: 0 });
  // A suspend whose CPU was NOT tiny, which the CPU rule alone calls a freeze.
  expect(isSuspendGap(100_000, 5_000)).toBe(false);
  expect(classifyLoopGap(100_000, 2_000, 5_000)).toEqual({ kind: "suspend", freezeMs: 0 });
  // A freeze straddling a wake: 40s of real blocking inside a 37 minute wall gap.
  expect(classifyLoopGap(2_234_000, 40_000, 800)).toEqual({ kind: "freeze", freezeMs: 40_000 });
});

test("once the clocks disagree the CPU counter no longer overrules them", () => {
  // A minute blocked on a slow disk read next to a 37 minute sleep. The loop
  // clock saw the whole minute, so it is a freeze even though the process burned
  // 100ms of CPU across the window and the CPU rule alone calls that a suspend.
  expect(isSuspendGap(60_000, 100)).toBe(true);
  expect(classifyLoopGap(2_234_000, 60_000, 100)).toEqual({ kind: "freeze", freezeMs: 60_000 });
  // The sleep itself is still a sleep: the loop clock barely moved.
  expect(classifyLoopGap(2_234_000, 900, 100)).toEqual({ kind: "suspend", freezeMs: 0 });
});

test("with no monotonic signal the verdict matches the CPU rule exactly", () => {
  // A platform whose monotonic clock DOES advance across suspend degrades to
  // today's behavior rather than misclassifying anything.
  for (const [late, cpu] of [[937_000, 6], [42_000, 928], [6_000, 0], [29_999, 0]] as const) {
    const verdict = classifyLoopGap(late, late, cpu);
    expect(verdict.kind === "suspend").toBe(isSuspendGap(late, cpu) || late < 5_000);
  }
});

test("the ledger keeps a rolling hour, since-boot totals and the worst cause", () => {
  const ledger = new LoopFreezeLedger(60_000, 3_600_000);
  ledger.record(6_000, 10_000, "walk@recursiveWatcher.ts:138 60%");
  ledger.record(48_000, 40_000, "scanDir@daemon.ts:900 80%");
  ledger.record(9_000, 3_000_000, "psSnapshot@daemon.ts:8950 40%");

  const s = ledger.summary(3_010_000);
  expect(s.recentMs).toBe(9_000);           // only the newest is inside the minute
  expect(s.hourMs).toBe(63_000);            // all three are inside the hour
  expect(s.hourCount).toBe(3);
  expect(s.hourMaxMs).toBe(48_000);
  expect(s.top).toBe("scanDir@daemon.ts:900 80%"); // the worst, not the newest
  expect(s.bootMs).toBe(63_000);
  expect(s.bootCount).toBe(3);

  // Past the hour the window empties but the since-boot totals keep counting.
  const later = ledger.summary(7_300_000);
  expect(later.hourMs).toBe(0);
  expect(later.hourCount).toBe(0);
  expect(later.top).toBe("");
  expect(later.bootMs).toBe(63_000);
  expect(later.bootCount).toBe(3);
});

test("the attribution string is capped and stripped of the roster separators", () => {
  const ledger = new LoopFreezeLedger();
  ledger.record(9_000, 1_000, `pipe|here\nand a newline ${"x".repeat(200)}`);
  const top = ledger.summary(1_000).top;
  expect(top.length).toBe(120);
  expect(top).not.toContain("|");
  expect(top).not.toContain("\n");
});


// The heartbeat's freeze fields are rounded HERE, not only in the server's
// projection: the server rewrites the device row whenever any heartbeat field
// changed, and every viewer's roster re-renders with it. A raw millisecond hour
// total would therefore churn the roster on every 30s beat while the number a
// person reads never moved.
import { freezeBeatFields } from "./daemon.js";

test("a drifting hour total sends the same number until it moves a whole step", () => {
  const ledger = new LoopFreezeLedger(60_000);
  ledger.record(41_800, 1_000, "walk@recursiveWatcher.ts:138 60%");
  const beat = freezeBeatFields(ledger.summary(2_000));
  expect(beat.loop_freeze_1h_ms).toBe(40_000);
  expect(beat.loop_freeze_max_ms).toBe(42_000);

  // A few hundred more ms of freeze: the same numbers ride the next beat.
  ledger.record(300, 3_000);
  const next = freezeBeatFields(ledger.summary(4_000));
  expect(next.loop_freeze_1h_ms).toBe(beat.loop_freeze_1h_ms);
  expect(next.loop_freeze_max_ms).toBe(beat.loop_freeze_max_ms);

  // A whole 5s step does move it.
  ledger.record(5_000, 5_000);
  expect(freezeBeatFields(ledger.summary(6_000)).loop_freeze_1h_ms).toBe(45_000);
});
