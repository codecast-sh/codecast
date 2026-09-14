// The watchdog kills a wedged daemon only on the SECOND consecutive wedged pass,
// and only when the hang marker shows no self recovery in between.
//
// Regression pressure: three days running (2026-09-11 to 09-13) the loop went
// silent for 53s, 138s and 50s and resumed on its own every time. The old rule
// killed on one pass past the 3 min threshold, so a stall that ran a little
// longer would have SIGKILLed a daemon that was about to recover, dropping every
// in-flight delivery. The marker, not the clock, is what says "it came back".
//
// Three layers are tested: the pure verdict both watchdog forms share, the
// marker and stamp files, and the emitted dev shell script run under real sh in
// a sandboxed HOME with fake launchctl and date on PATH.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearWedgedPassStamp,
  describeHangMarker,
  hangMarkerPath,
  HANG_SELF_RECOVERED_AFTER_MS,
  peekHangMarker,
  readWedgedPassStamp,
  wedgedPassStampPath,
  writeHangMarker,
  writeWatchdogKillMarker,
  writeWedgedPassStamp,
} from "./daemonMarkers.js";
import {
  buildWatchdogShellScript,
  daemonTickStale,
  DAEMON_HEARTBEAT_STALE_MS,
  markerRecoveredSince,
  parseWedgedPassStamp,
  watchdogKillVerdict,
  WATCHDOG_AWAKE_GAP_MS,
  WATCHDOG_KILL_RULE_TWO_PASSES,
  WATCHDOG_WEDGED_ARM_TTL_MS,
  WATCHDOG_WEDGED_STAMP_FILENAME,
} from "./supervision.js";

const PID = 4242;
const T0 = 10_000_000;
const PASS = 60_000;
const STALE_TICK = T0 - DAEMON_HEARTBEAT_STALE_MS - 1;

/** One watchdog pass as the compiled form runs it: the sleep guard first, then
 * the two pass rule, with the arm carried from the previous pass. */
function pass(opts: {
  now: number;
  tick: number;
  gapMs: number | null;
  armed: ReturnType<typeof parseWedgedPassStamp>;
  marker?: { pid: number; detected_at: number; self_recovered: boolean } | null;
  logAgeMs?: number | null;
}) {
  const wedged = daemonTickStale(opts.now - opts.tick, opts.gapMs, opts.logAgeMs ?? null);
  return watchdogKillVerdict({
    wedged,
    pid: PID,
    tick: opts.tick,
    now: opts.now,
    armed: opts.armed,
    marker: opts.marker ?? null,
  });
}

describe("watchdogKillVerdict: two consecutive wedged passes, marker as evidence", () => {
  test("one wedged pass only arms; a fresh tick on the next pass clears it (no kill)", () => {
    const first = pass({ now: T0, tick: STALE_TICK, gapMs: PASS, armed: null });
    expect(first.action).toBe("arm");
    if (first.action !== "arm") throw new Error("unreachable");
    expect(first.stamp).toEqual({ pid: PID, tick: STALE_TICK, at: T0 });

    // The daemon resumed and re-stamped its heartbeat 20s before the next pass.
    const second = pass({ now: T0 + PASS, tick: T0 + PASS - 20_000, gapMs: PASS, armed: first.stamp });
    expect(second.action).toBe("spare");
  });

  test("two consecutive wedged passes with the tick unmoved kill, naming the rule", () => {
    const first = pass({ now: T0, tick: STALE_TICK, gapMs: PASS, armed: null });
    if (first.action !== "arm") throw new Error("first pass must arm");
    const second = pass({ now: T0 + PASS, tick: STALE_TICK, gapMs: PASS, armed: first.stamp });
    expect(second.action).toBe("kill");
    if (second.action !== "kill") throw new Error("unreachable");
    expect(second.rule).toBe(WATCHDOG_KILL_RULE_TWO_PASSES);
    expect(second.reason).toContain("60s ago");
  });

  test("a sleep wake is not a pass: the stale guard spares it and the arm is dropped, so the count restarts", () => {
    const first = pass({ now: T0, tick: STALE_TICK, gapMs: PASS, armed: null });
    if (first.action !== "arm") throw new Error("first pass must arm");
    // The machine slept 15 min; the watchdog's own gap says so.
    const nap = 15 * 60 * 1000;
    const wake = pass({ now: T0 + nap, tick: STALE_TICK, gapMs: nap, armed: first.stamp });
    expect(wake.action).toBe("spare");
    // The compiled pass clears the arm on spare, so the next awake pass starts over.
    const afterWake = pass({ now: T0 + nap + PASS, tick: STALE_TICK, gapMs: PASS, armed: null });
    expect(afterWake.action).toBe("arm");
    // Only the pass after THAT may kill.
    if (afterWake.action !== "arm") throw new Error("unreachable");
    expect(pass({ now: T0 + nap + 2 * PASS, tick: STALE_TICK, gapMs: PASS, armed: afterWake.stamp }).action).toBe("kill");
  });

  test("a marker that says the loop resumed after the first wedged pass prevents the kill and restarts the count", () => {
    const first = pass({ now: T0, tick: STALE_TICK, gapMs: PASS, armed: null });
    if (first.action !== "arm") throw new Error("first pass must arm");
    // The probe saw the silence end 10s after the arming pass and, 5s later,
    // rewrote the marker as recovered: JS ran, so the loop was not wedged.
    const marker = { pid: PID, detected_at: T0 + 10_000, self_recovered: true };
    const second = pass({ now: T0 + PASS, tick: STALE_TICK, gapMs: PASS, armed: first.stamp, marker });
    expect(second.action).toBe("arm");
    if (second.action !== "arm") throw new Error("unreachable");
    expect(second.reason).toContain("resumed on its own");
    expect(second.stamp.at).toBe(T0 + PASS);
  });

  test("a recovered marker from BEFORE the arm is no evidence about this stall", () => {
    const first = pass({ now: T0, tick: STALE_TICK, gapMs: PASS, armed: null });
    if (first.action !== "arm") throw new Error("first pass must arm");
    const old = { pid: PID, detected_at: T0 - 60 * 60 * 1000, self_recovered: true };
    expect(pass({ now: T0 + PASS, tick: STALE_TICK, gapMs: PASS, armed: first.stamp, marker: old }).action).toBe("kill");
  });

  test("an unresolved marker (self_recovered false) does not spare: the stall never cleared", () => {
    const first = pass({ now: T0, tick: STALE_TICK, gapMs: PASS, armed: null });
    if (first.action !== "arm") throw new Error("first pass must arm");
    const unresolved = { pid: PID, detected_at: T0 + 10_000, self_recovered: false };
    expect(pass({ now: T0 + PASS, tick: STALE_TICK, gapMs: PASS, armed: first.stamp, marker: unresolved }).action).toBe("kill");
  });

  test("markerRecoveredSince: the recovery rewrite lands HANG_SELF_RECOVERED_AFTER_MS after detected_at", () => {
    const armedAt = T0;
    expect(markerRecoveredSince({ pid: PID, detected_at: armedAt - HANG_SELF_RECOVERED_AFTER_MS, self_recovered: true }, PID, armedAt)).toBe(true);
    expect(markerRecoveredSince({ pid: PID, detected_at: armedAt - HANG_SELF_RECOVERED_AFTER_MS - 1, self_recovered: true }, PID, armedAt)).toBe(false);
    expect(markerRecoveredSince({ pid: PID + 1, detected_at: armedAt, self_recovered: true }, PID, armedAt)).toBe(false);
    expect(markerRecoveredSince(null, PID, armedAt)).toBe(false);
  });

  test("an arm for another pid, or one older than the TTL, is not consecutive", () => {
    const foreign = { pid: PID + 1, tick: STALE_TICK, at: T0 };
    expect(pass({ now: T0 + PASS, tick: STALE_TICK, gapMs: PASS, armed: foreign }).action).toBe("arm");
    const stale = { pid: PID, tick: STALE_TICK, at: T0 - WATCHDOG_WEDGED_ARM_TTL_MS - 1 };
    expect(pass({ now: T0 + PASS, tick: STALE_TICK, gapMs: PASS, armed: stale }).action).toBe("arm");
    const fromTheFuture = { pid: PID, tick: STALE_TICK, at: T0 + PASS + 1 };
    expect(pass({ now: T0 + PASS, tick: STALE_TICK, gapMs: PASS, armed: fromTheFuture }).action).toBe("arm");
  });

  test("a busy daemon (fresh daemon.log) is spared on every pass and never accumulates arms", () => {
    const first = pass({ now: T0, tick: STALE_TICK, gapMs: PASS, armed: null, logAgeMs: 5_000 });
    expect(first.action).toBe("spare");
  });
});

describe("the wedged pass stamp and the kill marker on disk", () => {
  let dir: string;
  let priorDir: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-watchdog-kill-"));
    priorDir = process.env.CODECAST_DIR;
    process.env.CODECAST_DIR = dir;
  });
  afterEach(() => {
    if (priorDir === undefined) delete process.env.CODECAST_DIR;
    else process.env.CODECAST_DIR = priorDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("the stamp round-trips inside CODECAST_DIR and clears", () => {
    expect(wedgedPassStampPath()).toBe(path.join(dir, WATCHDOG_WEDGED_STAMP_FILENAME));
    writeWedgedPassStamp({ pid: PID, tick: STALE_TICK, at: T0 });
    expect(readWedgedPassStamp()).toEqual({ pid: PID, tick: STALE_TICK, at: T0 });
    clearWedgedPassStamp();
    expect(readWedgedPassStamp()).toBeNull();
  });

  test("a torn stamp reads as not armed, which delays a kill rather than hastening one", () => {
    fs.writeFileSync(wedgedPassStampPath(), '{"pid":4242,"tick":');
    expect(readWedgedPassStamp()).toBeNull();
    expect(parseWedgedPassStamp('{"pid":"4242","tick":1,"at":2}')).toBeNull();
  });

  test("the kill marker keeps the daemon's sampled stacks for the same stall and names the rule", () => {
    writeHangMarker({ detected_at: T0 - 30_000, pid: PID, unresponsive_ms: 50_000, hot_stacks: "autoResumeSessionInner 94%", self_recovered: false });
    const written = writeWatchdogKillMarker({ pid: PID, unresponsiveMs: 200_000, rule: WATCHDOG_KILL_RULE_TWO_PASSES, now: T0 });
    const onDisk = peekHangMarker();
    expect(onDisk).toEqual(written);
    expect(onDisk?.hot_stacks).toBe("autoResumeSessionInner 94%");
    expect(onDisk?.self_recovered).toBe(false);
    expect(onDisk?.watchdog_rule).toBe(WATCHDOG_KILL_RULE_TWO_PASSES);
    expect(describeHangMarker(onDisk!, T0)).toContain("the watchdog killed it (two consecutive wedged passes");
  });

  test("a prior marker from another pid or a recovered stall is replaced, not inherited", () => {
    writeHangMarker({ detected_at: T0 - 30_000, pid: PID + 1, unresponsive_ms: 50_000, hot_stacks: "other daemon", self_recovered: true });
    const written = writeWatchdogKillMarker({ pid: PID, unresponsiveMs: 200_000, rule: WATCHDOG_KILL_RULE_TWO_PASSES, now: T0 });
    expect(written.hot_stacks).toBe("");
    expect(fs.existsSync(hangMarkerPath())).toBe(true);
  });

  test("a marker with no watchdog_rule still reads as the daemon dying on its own", () => {
    writeHangMarker({ detected_at: T0, pid: PID, unresponsive_ms: 50_000, hot_stacks: "", self_recovered: false });
    const onDisk = peekHangMarker()!;
    expect("watchdog_rule" in onDisk).toBe(false);
    expect(describeHangMarker(onDisk, T0)).toContain("the daemon died in it");
  });
});

// The dev shell watchdog carries the same rule in sh. Run its check_once under a
// real shell: fake launchctl reports a running job and records every kickstart,
// fake date returns a clock the test controls, and the daemon files live in a
// sandboxed HOME.
describe("dev shell watchdog: the two pass rule in sh", () => {
  let home: string;
  let bin: string;
  let script: string;
  let kicks: string;

  const nowS = () => String(Math.floor(clock / 1000));
  let clock = T0;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-watchdog-sh-"));
    fs.mkdirSync(path.join(home, ".codecast"), { recursive: true });
    fs.mkdirSync(path.join(home, "Library", "LaunchAgents"), { recursive: true });
    fs.writeFileSync(path.join(home, "Library", "LaunchAgents", "sh.codecast.daemon.plist"), "<plist/>");
    bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    kicks = path.join(home, "kicks.log");
    fs.writeFileSync(path.join(bin, "launchctl"), `#!/bin/sh
printf '%s\\n' "$*" >> "${kicks}"
case "$1" in print) printf 'state = running\\n';; esac
exit 0
`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "date"), `#!/bin/sh
case "$1" in +%s) printf '%s\\n' "$FAKE_NOW_S";; *) printf '2026-01-01 00:00:00\\n';; esac
`, { mode: 0o755 });
    const full = buildWatchdogShellScript({ isBinary: false, watchdogCommand: "unused" });
    const loopAt = full.indexOf("while :; do");
    if (loopAt < 0) throw new Error("script has no resident loop");
    script = path.join(home, "watchdog.sh");
    fs.writeFileSync(script, full.slice(0, loopAt) + "\ncheck_once\n");
    fs.writeFileSync(path.join(home, ".codecast", "daemon.pid"), String(PID));
    clock = T0;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  const cdir = () => path.join(home, ".codecast");

  /** Seed the daemon's own files: a heartbeat tick, a daemon.log whose mtime is
   * as old as the tick (so the busy grace cannot excuse it), and the watchdog's
   * previous heartbeat so LOOP_GAP is what the case needs. */
  function seed(opts: { tick: number; prevBeat: number }) {
    fs.writeFileSync(path.join(cdir(), "daemon.state"), JSON.stringify({ lastHeartbeatTick: opts.tick }));
    const log = path.join(cdir(), "daemon.log");
    fs.writeFileSync(log, "");
    fs.utimesSync(log, opts.tick / 1000, opts.tick / 1000);
    fs.writeFileSync(path.join(cdir(), "watchdog.heartbeat"), String(opts.prevBeat));
  }

  function run(): string {
    fs.writeFileSync(path.join(cdir(), "watchdog-shell.log"), "");
    execFileSync("sh", [script], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_NOW_S: nowS() },
      stdio: ["ignore", "ignore", "inherit"],
    });
    return fs.readFileSync(path.join(cdir(), "watchdog-shell.log"), "utf-8");
  }

  const kickCount = () => (fs.existsSync(kicks) ? fs.readFileSync(kicks, "utf-8").split("\n").filter((l) => l.startsWith("kickstart")).length : 0);
  const armed = () => readWedgedPassStamp(cdir());

  test("one wedged pass arms and does not kickstart; a fresh tick next pass clears the arm", () => {
    seed({ tick: STALE_TICK, prevBeat: T0 - PASS });
    const log1 = run();
    expect(log1).toContain("first wedged pass");
    expect(kickCount()).toBe(0);
    expect(armed()).toEqual({ pid: PID, tick: STALE_TICK, at: T0 });

    clock = T0 + PASS;
    seed({ tick: clock - 20_000, prevBeat: T0 });
    run();
    expect(kickCount()).toBe(0);
    expect(armed()).toBeNull();
  });

  test("two consecutive wedged passes kickstart and leave a marker naming the rule", () => {
    seed({ tick: STALE_TICK, prevBeat: T0 - PASS });
    run();
    clock = T0 + PASS;
    seed({ tick: STALE_TICK, prevBeat: T0 });
    const log2 = run();
    expect(log2).toContain(WATCHDOG_KILL_RULE_TWO_PASSES);
    expect(kickCount()).toBe(1);
    expect(armed()).toBeNull();
    const marker = peekHangMarker(cdir());
    expect(marker?.pid).toBe(PID);
    expect(marker?.watchdog_rule).toBe(WATCHDOG_KILL_RULE_TWO_PASSES);
    expect(marker?.self_recovered).toBe(false);
    expect(marker?.unresponsive_ms).toBe(T0 + PASS - STALE_TICK);
  });

  test("a sleep wake is deferred and drops the arm: the count restarts after wake", () => {
    seed({ tick: STALE_TICK, prevBeat: T0 - PASS });
    run();
    expect(armed()).not.toBeNull();
    const nap = WATCHDOG_AWAKE_GAP_MS + 60_000;
    clock = T0 + nap;
    seed({ tick: STALE_TICK, prevBeat: T0 });
    const wakeLog = run();
    expect(wakeLog).toContain("implies system sleep");
    expect(kickCount()).toBe(0);
    expect(armed()).toBeNull();
  });

  test("a marker that says the loop resumed after the arm prevents the kickstart", () => {
    seed({ tick: STALE_TICK, prevBeat: T0 - PASS });
    run();
    writeHangMarker({ detected_at: T0 + 10_000, pid: PID, unresponsive_ms: 50_000, hot_stacks: "", self_recovered: true }, cdir());
    clock = T0 + PASS;
    seed({ tick: STALE_TICK, prevBeat: T0 });
    const log2 = run();
    expect(log2).toContain("resumed after the first wedged pass");
    expect(kickCount()).toBe(0);
    expect(armed()?.at).toBe(T0 + PASS);
  });
});
