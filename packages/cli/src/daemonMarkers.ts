// Two small files the daemon leaves in ~/.codecast for the next boot and for its
// supervisor. Both exist because the interesting failures erase their own
// evidence: a wedged event loop runs no JS and logs nothing, and a daemon that
// exits for a reason a restart cannot fix looks exactly like a crashed one to a
// watchdog that only sees "the process is gone".
//
//  - the HANG MARKER records a window of loop silence the freeze probe measured
//    (daemon.ts startLoopFreezeProbe), so `cast health` and `cast doctor` can
//    report it after the fact — including the case where the process died inside
//    the stall and never got to say so.
//  - the NO-RESTART STAMP records an exit the daemon declared terminal (exit
//    code EXIT_DO_NOT_RESTART), so both watchdog forms stop reviving it every
//    minute into the same failure.
//
// Reads never throw: a missing, truncated or half-written file reads as "nothing
// recorded". Neither file is authority for anything — they are breadcrumbs.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DAEMON_EXIT_STAMP_FILE, EXIT_DO_NOT_RESTART } from "./supervision.js";

export const HANG_MARKER_FILENAME = "daemon-hang.json";

/** Loop silence at or beyond this is a hang worth a marker, not just a freeze
 * worth a log line. 45s is well past the 5s the probe already reports and well
 * inside the watchdog's 3 min kill threshold, so a marker exists before the
 * kill decision is ever made. */
export const HANG_MARKER_THRESHOLD_MS = 45_000;

/** How long the loop must tick normally before a recorded hang is rewritten as
 * self-recovered. A daemon that resumes for one tick and re-wedges (or is killed
 * by the watchdog) has not recovered, and the marker must not claim it did. */
export const HANG_SELF_RECOVERED_AFTER_MS = 5_000;

/** How long a recorded hang stays worth reporting. Past this it is history, not
 * a health signal, and `cast doctor` should stop flagging it. */
export const HANG_REPORT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface HangMarker {
  /** When the probe observed the end of the silent window (epoch ms). */
  detected_at: number;
  /** The daemon that was silent — a marker consumed at boot names a dead pid. */
  pid: number;
  /** Length of the silence in ms. */
  unresponsive_ms: number;
  /** Hot JS stacks sampled DURING the silence (darwin only; "" elsewhere). */
  hot_stacks: string;
  /** True once the loop ticked normally again for HANG_SELF_RECOVERED_AFTER_MS.
   * False on a marker that was written and never rewritten: the daemon died
   * inside the stall, which is the case a kill would have been called for. */
  self_recovered: boolean;
}

export interface DaemonExitStamp {
  code: number;
  at: number;
  reason: string;
}

export function codecastDir(): string {
  return process.env.CODECAST_DIR || path.join(os.homedir(), ".codecast");
}

export function hangMarkerPath(dir: string = codecastDir()): string {
  return path.join(dir, HANG_MARKER_FILENAME);
}

export function daemonExitStampPath(dir: string = codecastDir()): string {
  return path.join(dir, DAEMON_EXIT_STAMP_FILE);
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function removeQuietly(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // A marker that cannot be deleted must never block a boot; the worst case
    // is one breadcrumb reported twice.
  }
}

export function writeHangMarker(marker: HangMarker, dir: string = codecastDir()): void {
  try {
    fs.writeFileSync(hangMarkerPath(dir), JSON.stringify(marker), { mode: 0o600 });
  } catch {
    // Losing the breadcrumb is not worth failing the probe tick over.
  }
}

/** Read without deleting — for `cast doctor` / `cast health` on a machine whose
 * daemon is dead or has not rebooted yet, where the file is the only record. */
export function peekHangMarker(dir: string = codecastDir()): HangMarker | null {
  const parsed = readJson(hangMarkerPath(dir)) as Partial<HangMarker> | null;
  if (
    !parsed ||
    typeof parsed.detected_at !== "number" ||
    typeof parsed.pid !== "number" ||
    typeof parsed.unresponsive_ms !== "number"
  ) {
    return null;
  }
  return {
    detected_at: parsed.detected_at,
    pid: parsed.pid,
    unresponsive_ms: parsed.unresponsive_ms,
    hot_stacks: typeof parsed.hot_stacks === "string" ? parsed.hot_stacks : "",
    // A marker the resolve leg never rewrote means the stall never cleared, so
    // a missing flag reads as "did not recover" — the conservative reading.
    self_recovered: parsed.self_recovered === true,
  };
}

/** Read and delete. The daemon calls this once at boot; the record moves into
 * the daemon state file, which is what the CLI surfaces from then on. A
 * corrupted file is deleted too, so it cannot be re-reported forever. */
export function consumeHangMarker(dir: string = codecastDir()): HangMarker | null {
  const markerPath = hangMarkerPath(dir);
  if (!fs.existsSync(markerPath)) return null;
  const marker = peekHangMarker(dir);
  removeQuietly(markerPath);
  return marker;
}

/** The hang a reader should report: the newest of the record the running daemon
 * consumed into its state file and a marker still on disk. The file wins when a
 * daemon hung and was killed before it could boot and consume its own marker —
 * the case with no other witness. */
export function latestHang(
  fromState: HangMarker | null | undefined,
  dir: string = codecastDir(),
  opts: { now?: number; withinMs?: number } = {},
): HangMarker | null {
  const onDisk = peekHangMarker(dir);
  const newest = onDisk && (!fromState || onDisk.detected_at >= fromState.detected_at)
    ? onDisk
    : fromState ?? null;
  if (!newest) return null;
  // The state record is never pruned, so without a window a single stall from a
  // month ago would warn in every `cast doctor` run forever.
  const now = opts.now ?? Date.now();
  const withinMs = opts.withinMs ?? HANG_REPORT_WINDOW_MS;
  return now - newest.detected_at <= withinMs ? newest : null;
}

/** One line for `cast health` / `cast doctor`. `now` makes it testable. */
export function describeHangMarker(marker: HangMarker, now: number = Date.now()): string {
  const seconds = Math.round(marker.unresponsive_ms / 1000);
  const agoMin = Math.max(0, Math.round((now - marker.detected_at) / 60000));
  const when = agoMin === 0 ? "just now" : `${agoMin}m ago`;
  const outcome = marker.self_recovered
    ? "loop resumed on its own"
    : "loop never resumed — the daemon died in it";
  return `${seconds}s of loop silence ${when} (pid ${marker.pid}), ${outcome}` +
    (marker.hot_stacks ? `; hot stacks: ${marker.hot_stacks}` : "");
}

/** The detect/resolve state machine around the marker, kept pure (no clock, no
 * fs of its own) so the lifecycle is testable without freezing an event loop.
 * The daemon's freeze probe drives it: every measured freeze goes to
 * `observeFreeze`, every ordinary tick to `observeHealthyTick`. Orca runs the
 * same two legs from a worker thread; codecast measures the silence in-process
 * on the late tick, so "detect" and "the loop is back" arrive together and only
 * sustained ticking may claim recovery. */
export interface HangRecorder {
  /** True when this freeze was long enough to leave a marker. */
  observeFreeze(freezeMs: number, at: number, hotStacks: string): boolean;
  observeHealthyTick(at: number): void;
}

export function createHangRecorder(opts: {
  write: (marker: HangMarker) => void;
  pid?: number;
  thresholdMs?: number;
  resolveAfterMs?: number;
}): HangRecorder {
  const pid = opts.pid ?? process.pid;
  const thresholdMs = opts.thresholdMs ?? HANG_MARKER_THRESHOLD_MS;
  const resolveAfterMs = opts.resolveAfterMs ?? HANG_SELF_RECOVERED_AFTER_MS;
  let pending: HangMarker | null = null;
  let resolvesAt = 0;
  return {
    observeFreeze(freezeMs, at, hotStacks) {
      if (freezeMs < thresholdMs) return false;
      pending = {
        detected_at: at,
        pid,
        unresponsive_ms: Math.round(freezeMs),
        hot_stacks: hotStacks,
        self_recovered: false,
      };
      resolvesAt = at + resolveAfterMs;
      opts.write(pending);
      return true;
    },
    observeHealthyTick(at) {
      if (!pending || at < resolvesAt) return;
      pending = { ...pending, self_recovered: true };
      opts.write(pending);
      pending = null;
    },
  };
}

export function writeDaemonExitStamp(reason: string, dir: string = codecastDir()): void {
  try {
    const stamp: DaemonExitStamp = { code: EXIT_DO_NOT_RESTART, at: Date.now(), reason };
    fs.writeFileSync(daemonExitStampPath(dir), JSON.stringify(stamp), { mode: 0o600 });
  } catch {
    // If the stamp cannot be written the daemon is no worse off than before it
    // existed: the watchdog revives it and it exits the same way again.
  }
}

/** The stamp is cleared by the daemon the moment it boots past the config gate,
 * so a `cast start` after the user fixes the config re-arms supervision. */
export function clearDaemonExitStamp(dir: string = codecastDir()): void {
  removeQuietly(daemonExitStampPath(dir));
}

export function readDaemonExitStamp(dir: string = codecastDir()): DaemonExitStamp | null {
  const parsed = readJson(daemonExitStampPath(dir)) as Partial<DaemonExitStamp> | null;
  if (!parsed || typeof parsed.code !== "number") return null;
  return {
    code: parsed.code,
    at: typeof parsed.at === "number" ? parsed.at : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
  };
}

/** Why a supervisor must NOT restart the daemon, or null when it should.
 * Used by the compiled `_watchdog` pass; the dev shell watchdog greps the same
 * file for the same code (see buildWatchdogShellScript). */
export function noRestartReason(dir: string = codecastDir()): string | null {
  const stamp = readDaemonExitStamp(dir);
  if (!stamp || stamp.code !== EXIT_DO_NOT_RESTART) return null;
  return stamp.reason || "daemon declared its exit terminal";
}
