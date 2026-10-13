// The two breadcrumbs the daemon leaves for its next boot and its supervisor.
//
// Regression pressure behind them: a wedged event loop runs no JS, so the only
// record of a stall used to be a daemon.log line the same daemon might never
// live to write (2026-08-15, 49 freezes of 30-210s); and a daemon that stops for
// a config fact looks like a crash to a watchdog, which then revives it every
// minute into the same failure.
//
// Every test drives an isolated CODECAST_DIR so the real ~/.codecast is never
// read or written.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearDaemonExitStamp,
  codecastDir,
  consumeHangMarker,
  createHangRecorder,
  daemonExitStampPath,
  describeHangMarker,
  hangMarkerPath,
  HANG_MARKER_THRESHOLD_MS,
  HANG_REPORT_WINDOW_MS,
  latestHang,
  noRestartReason,
  peekHangMarker,
  readDaemonExitStamp,
  writeDaemonExitStamp,
  writeHangMarker,
  type HangMarker,
} from "./daemonMarkers.js";
import { EXIT_DO_NOT_RESTART } from "./supervision.js";

let dir: string;
let priorDir: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "codecast-markers-"));
  priorDir = process.env.CODECAST_DIR;
  process.env.CODECAST_DIR = dir;
});

afterEach(() => {
  if (priorDir === undefined) delete process.env.CODECAST_DIR;
  else process.env.CODECAST_DIR = priorDir;
  fs.rmSync(dir, { recursive: true, force: true });
});

const marker = (over: Partial<HangMarker> = {}): HangMarker => ({
  detected_at: 1_000_000,
  pid: 4242,
  unresponsive_ms: 61_000,
  hot_stacks: "readFileSync@fs.js:12 80%",
  self_recovered: false,
  ...over,
});

describe("hang marker file", () => {
  test("every default path lands inside CODECAST_DIR", () => {
    expect(codecastDir()).toBe(dir);
    expect(hangMarkerPath()).toBe(path.join(dir, "daemon-hang.json"));
    expect(daemonExitStampPath()).toBe(path.join(dir, "daemon-exit.json"));
  });

  test("round-trips and is deleted on consume", () => {
    writeHangMarker(marker());
    expect(peekHangMarker()).toEqual(marker());
    expect(consumeHangMarker()).toEqual(marker());
    expect(fs.existsSync(hangMarkerPath())).toBe(false);
    expect(consumeHangMarker()).toBeNull();
  });

  test("a missing self_recovered flag reads as an unresolved hang", () => {
    // The detect leg writes no flag until the resolve leg rewrites it, and
    // "never resolved" is the conservative reading of its absence.
    fs.writeFileSync(hangMarkerPath(), JSON.stringify({ detected_at: 1, pid: 2, unresponsive_ms: 45_000 }));
    expect(peekHangMarker()?.self_recovered).toBe(false);
    expect(peekHangMarker()?.hot_stacks).toBe("");
  });

  test("a torn or incomplete file reads as nothing and is still cleared", () => {
    fs.writeFileSync(hangMarkerPath(), '{"detected_at": 17');
    expect(peekHangMarker()).toBeNull();
    expect(consumeHangMarker()).toBeNull();
    // Deleted anyway: an unparseable marker must not be re-reported at every boot.
    expect(fs.existsSync(hangMarkerPath())).toBe(false);
  });
});

describe("hang recorder: detect, then resolve only if the loop stays back", () => {
  const record = () => {
    const written: HangMarker[] = [];
    return {
      written,
      recorder: createHangRecorder({
        write: (m) => { written.push({ ...m }); writeHangMarker(m); },
        pid: 99,
        thresholdMs: HANG_MARKER_THRESHOLD_MS,
        resolveAfterMs: 5_000,
      }),
    };
  };

  test("a freeze under the threshold leaves no marker", () => {
    const { written, recorder } = record();
    recorder.observeFreeze(HANG_MARKER_THRESHOLD_MS - 1, 10_000, "");
    expect(written).toEqual([]);
    expect(peekHangMarker()).toBeNull();
  });

  test("45s of silence writes an unresolved marker with the sampled stack", () => {
    const { written, recorder } = record();
    recorder.observeFreeze(HANG_MARKER_THRESHOLD_MS, 10_000, "sweepProjects@daemon.ts:12 60%");
    expect(written).toHaveLength(1);
    expect(peekHangMarker()).toEqual({
      detected_at: 10_000,
      pid: 99,
      unresponsive_ms: HANG_MARKER_THRESHOLD_MS,
      hot_stacks: "sweepProjects@daemon.ts:12 60%",
      self_recovered: false,
    });
  });

  test("the marker is rewritten self_recovered once the loop has ticked for the grace window", () => {
    const { recorder } = record();
    recorder.observeFreeze(60_000, 10_000, "");
    recorder.observeHealthyTick(12_000); // back, but not for long enough yet
    expect(peekHangMarker()?.self_recovered).toBe(false);
    recorder.observeHealthyTick(15_000);
    expect(peekHangMarker()?.self_recovered).toBe(true);
    // The hang itself is still described exactly as measured.
    expect(peekHangMarker()?.unresponsive_ms).toBe(60_000);
  });

  test("a daemon that resumes for one tick and re-wedges never claims recovery", () => {
    // This is the shape the watchdog kills: the loop stutters, the marker must
    // still say the stall never cleared.
    const { recorder } = record();
    recorder.observeFreeze(60_000, 10_000, "");
    recorder.observeHealthyTick(11_000);
    recorder.observeFreeze(90_000, 12_000, "");
    recorder.observeHealthyTick(13_000);
    expect(peekHangMarker()).toMatchObject({ detected_at: 12_000, unresponsive_ms: 90_000, self_recovered: false });
  });

  test("healthy ticks with no hang outstanding write nothing", () => {
    const { written, recorder } = record();
    recorder.observeHealthyTick(1_000);
    recorder.observeHealthyTick(90_000);
    expect(written).toEqual([]);
  });
});

describe("what a reader reports", () => {
  test("an unconsumed file outranks the state record — the daemon died before it could consume it", () => {
    writeHangMarker(marker({ detected_at: 2_000, unresponsive_ms: 50_000 }));
    const fromState = marker({ detected_at: 1_000, self_recovered: true });
    expect(latestHang(fromState, dir, { now: 2_000 })?.unresponsive_ms).toBe(50_000);
  });

  test("with no file the consumed state record is the answer", () => {
    const fromState = marker({ detected_at: 1_000, self_recovered: true });
    expect(latestHang(fromState, dir, { now: 1_500 })).toEqual(fromState);
  });

  test("a hang older than the report window stops being a health signal", () => {
    const fromState = marker({ detected_at: 1_000 });
    expect(latestHang(fromState, dir, { now: 1_000 + HANG_REPORT_WINDOW_MS + 1 })).toBeNull();
    expect(latestHang(undefined, dir, { now: 1_000 })).toBeNull();
  });

  test("the one-line description separates a survivable stall from a fatal one", () => {
    const now = 1_000_000 + 5 * 60_000;
    expect(describeHangMarker(marker({ self_recovered: true }), now))
      .toBe("61s of loop silence 5m ago (pid 4242), loop resumed on its own; hot stacks: readFileSync@fs.js:12 80%");
    expect(describeHangMarker(marker({ hot_stacks: "" }), now))
      .toBe("61s of loop silence 5m ago (pid 4242), loop never resumed — the daemon died in it");
  });
});

describe("exit 78: the daemon tells its supervisor not to restart it", () => {
  test("the stamp records the code and the reason, and clears on a successful boot", () => {
    expect(noRestartReason()).toBeNull();
    writeDaemonExitStamp("HOME is not set");
    expect(readDaemonExitStamp()?.code).toBe(EXIT_DO_NOT_RESTART);
    expect(noRestartReason()).toBe("HOME is not set");
    clearDaemonExitStamp();
    expect(noRestartReason()).toBeNull();
  });

  test("an ordinary crash exit is not a no-restart stamp", () => {
    fs.writeFileSync(daemonExitStampPath(), JSON.stringify({ code: 1, at: 5, reason: "crashed" }));
    expect(noRestartReason()).toBeNull();
  });

  test("the compiled pass and the shell script read the same file the same way", () => {
    // The compiled `_watchdog` pass calls noRestartReason; the dev shell script
    // greps the file. Prove the shell pattern matches what the writer produces
    // rather than trusting a parser and a grep to agree by inspection.
    writeDaemonExitStamp("Cannot create or write /x/.codecast: EACCES");
    expect(noRestartReason()).toBe("Cannot create or write /x/.codecast: EACCES");
    const grep = Bun.spawnSync(["grep", "-q", `"code"[[:space:]]*:[[:space:]]*${EXIT_DO_NOT_RESTART}`, daemonExitStampPath()]);
    expect(grep.exitCode).toBe(0);
    const sed = Bun.spawnSync(["sed", "-n", 's/.*"reason"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p', daemonExitStampPath()]);
    expect(sed.stdout.toString().trim()).toBe("Cannot create or write /x/.codecast: EACCES");
  });

  test("a corrupt stamp does not block supervision — a broken file must not keep the daemon down", () => {
    fs.writeFileSync(daemonExitStampPath(), "not json");
    expect(noRestartReason()).toBeNull();
  });
});
