// `cast call snap`: a frame of a recorded call, at a transcript line or a time.
//
// An agent reading a call has the words but not what the room was looking
// at: "this bit here", said over a shared screen, means nothing in a
// transcript. A huddle that was recorded keeps its video on LiveKit's
// servers, and this command turns a reference an agent already reads into a
// picture it can open:
//
//   cast call snap cl-42:15        the moment line 15 was said
//   cast call snap cl-42@12:34     12m34s into the call
//   cast call snap cl-42:15-25     frames across those lines
//   cast call snap cl-42           the call as it is right now, while recording
//
// The work happens on this machine. The server answers with the call's files,
// each with the wall clock of its own time 0 and a URL into the private
// bucket signed for ten minutes (/cli/calls/recordings). The one rule for
// which file shows a moment, and where inside it, is locateCallMoment in the
// shared contract, and the view a frame takes when nobody asked is
// CALL_FRAME_PREFER there, which the `cl-42@12:34` embed in a message reads
// too: the frame an agent saw and the frame its citation renders as are one
// picture. Local ffmpeg then seeks that file over HTTP range requests and
// writes one PNG. A single frame reads a couple of MB around its keyframe; a
// range on a shared screen reads the whole stretch once to find where the
// screen changed (bounded by SCENE_SCAN_MAX_BYTES). By default the PNG lands
// in the CLI's owner-only scratch directory (tempFiles.ts), swept after a
// day, because a frame of a private call is as private as the call.
//
// A screen share is recorded twice: inside the room composite, shrunk to a
// tile, and as its own file at full resolution. A frame takes the share's
// own file whenever one covers the moment, because the text on a shared
// screen is what an agent needs to read and the composite has made it mush.
//
// ffmpeg never sees a signed link. It reads through a loopback proxy
// (serveSources) that holds the links in memory and signs again when one is
// about to lapse or storage refuses it, so a long scene pass cannot outlive
// its link, and the credential (good from anywhere for ten minutes) is not on
// a command line `ps` shows other accounts. What `ps` does show is the
// proxy's own address, which serves only while the command runs and only on
// this machine: the residual exposure on a shared host.

import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  CALL_FRAME_PREFER,
  callMomentHref,
  coveredSpans,
  lineMomentMs,
  locateCallMoment,
  playableFiles,
  recordingSubject,
  recordingWindow,
  sampleCallMoments,
  segmentAt,
  type CallCoveredSpan,
  type CallMomentPrefer,
  type CallRecordingKind,
  type CallRecordingSpan,
} from "@codecast/shared/contracts";
import { callRefId, formatCallTime, parseCallRef, parseCallTime, parseEntityUrl } from "@codecast/shared/entities";
import { spawn, whichBin, TOOL_PATH, installHintFor } from "./proc.js";
import { agentTempPath, secureTempFile } from "./tempFiles.js";
import { fmt, icons } from "./colors.js";

// ── Limits ────────────────────────────────────────────────────────────────

/** Frames a line range yields when --max is not given: enough to follow a
 *  walkthrough, few enough that an agent reads every one. */
export const DEFAULT_RANGE_FRAMES = 8;
/** The ceiling on --max. Past it a range is a video, not a set of frames. */
export const MAX_RANGE_FRAMES = 50;
/** Evenly spaced room frames sit at least this far apart: faces barely
 *  change from one second to the next, so closer frames are copies. */
export const ROOM_FRAME_GAP_MS = 5000;
/** Scene-change frames on a screen share sit at least this far apart, so a
 *  slide that animates in yields one frame, not three. */
export const SCREEN_FRAME_GAP_MS = 2000;
/** The scene score (ffmpeg `scene`, 0 to 1, between consecutive keyframes)
 *  that counts as the screen changing. A new slide or window scores 0.3 and
 *  up; typing and a blinking cursor stay under 0.02; a scroll lands between.
 *  Candidates above this are ranked by score, so the threshold only has to
 *  keep noise out, not pick the frames. It assumes a keyframe about every
 *  second, which the screen egress asks for. */
export const SCENE_THRESHOLD = 0.04;
/** How much of a screen file one scene pass may read. Skipping decoding
 *  (keyframes only) does not skip downloading: the demuxer still pulls every
 *  packet in the stretch, measured at the file's whole bitrate. Past this a
 *  stretch is sampled evenly instead. */
export const SCENE_SCAN_MAX_BYTES = 300 * 1024 * 1024;
/** The same bound for a file whose size is not known yet. */
export const SCENE_SCAN_MAX_MS = 20 * 60_000;
/** How close to "now" a moment may be and still be answered from the live
 *  frame of a recording that has not been uploaded yet. */
export const LIVE_SLACK_MS = 15_000;
/** One ffmpeg run's ceiling: a frame grab reads a couple of MB around one
 *  keyframe; a scene pass reads its whole stretch. */
const GRAB_TIMEOUT_MS = 90_000;
const SCENE_TIMEOUT_MS = 5 * 60_000;
/** ffmpeg's own network timeout, in microseconds: a stalled read fails the
 *  run rather than hanging it until our timeout. */
const RW_TIMEOUT_US = "30000000";
/** How far back a line is still "what was being said" at a silent moment. */
const LAST_SAID_WINDOW_MS = 20_000;
/** A signed link is renewed this long before it lapses. */
const RESIGN_MARGIN_MS = 60_000;
/** How long the server signs a CLI link for, when it does not say. */
const DEFAULT_LINK_LIFE_MS = 10 * 60_000;

// ── Shapes the server sends ──────────────────────────────────────────────

export type SnapSegment = { seq: number; speaker_name: string; text: string; t0: number; t1: number };

export type SnapCall = {
  _id: string;
  short_id?: string | null;
  title?: string | null;
  room_key?: string | null;
  started_at: number;
  segments?: SnapSegment[];
  last_seq?: number;
};

export type SnapRecording = CallRecordingSpan & {
  run_id: string;
  url: string | null;
  url_expires_at?: number | null;
  live_frame_url: string | null;
  size_bytes?: number | null;
  error?: string | null;
};

type RecordingRow = Omit<SnapRecording, "id"> & { _id: string };

export type SnapRecordings = {
  transcript_id: string;
  short_id: string | null;
  call_started_at: number;
  call_ended_at: number | null;
  configured: boolean;
  recordings: RecordingRow[];
  server_now: number;
  live_frame_interval_ms?: number;
};

// ── The reference ────────────────────────────────────────────────────────

export type SnapMoment =
  | { kind: "line"; from: number; to: number }
  | { kind: "time"; atMs: number }
  | { kind: "now" };

export type SnapTarget = {
  call: string;
  moment: SnapMoment;
  /** `cl-42:12:34` reads as lines 12 to 34 (the way `cast call cl-42 12:34`
   *  prints them), but it is also how a person mistypes the time 12:34. Set
   *  when the pair is a valid time, so the answer can say which was meant. */
  alsoTime?: number;
};

export const SNAP_FORMS =
  "cl-42:15 (a transcript line), cl-42:15-25 (frames across lines), cl-42@12:34 (a time into the call), or cl-42 alone (right now, while it records)";

/**
 * The moment a second argument names, joined onto the call the way prose
 * writes it, so `cast call snap cl-42 15` is `cl-42:15`. Lines take the rule
 * `cast call cl-42 15:25` prints by (`15`, `15-25`, `15:25` are lines); a
 * time is anything else the call clock reads (`@12:34`, `754s`, `1:02:03`),
 * and `now` is now.
 */
function joinMoment(ref: string, extra: string): string | null {
  const e = extra.trim();
  if (ref.endsWith("@")) return ref + e;
  if (/[@:]/.test(ref)) return null;
  if (e.startsWith("@")) return ref + e;
  if (/^now$/i.test(e)) return `${ref}@now`;
  if (/^\d+(?:[-:]\d+)?$/.test(e)) return `${ref}:${e}`;
  if (parseCallTime(e) !== null) return `${ref}@${e}`;
  return `${ref}:${e}`;
}

/**
 * What a snap names. The call is a short id, a full id or a unique prefix of
 * one; the moment rides it the way prose writes it (`cl-42:15`, `cl-42@12:34`,
 * the shared call-reference grammar) or comes as a second argument, and a
 * bare call means now. A call page URL works too (`…/calls/<id>?t=754`),
 * since that is what a person pastes. Null for anything else, including a
 * second moment on a reference that already names one.
 */
export function parseSnapTarget(raw: string | null | undefined, extra?: string | null): SnapTarget | null {
  let s = (raw ?? "").trim();
  if (/^https?:\/\//i.test(s)) {
    const link = parseEntityUrl(s);
    if (!link || link.type !== "call") return null;
    s = link.id;
  }
  if (extra != null && extra.trim()) {
    const joined = joinMoment(s, extra);
    if (!joined) return null;
    s = joined;
  }
  const now = /^(.+)@now$/i.exec(s);
  if (now) s = now[1];
  // A colon pair is lines, as the transcript printer reads it.
  let alsoTime: number | undefined;
  const pair = /^([^@:]+):(\d+):(\d+)$/.exec(s);
  if (pair) {
    alsoTime = parseCallTime(`${pair[2]}:${pair[3]}`) ?? undefined;
    s = `${pair[1]}:${pair[2]}-${pair[3]}`;
  }
  const withTime = (t: SnapTarget): SnapTarget => (alsoTime !== undefined ? { ...t, alsoTime } : t);
  const fromRef = (call: string, ref: ReturnType<typeof parseCallRef>): SnapTarget | null => {
    if (!ref) return null;
    if (now) return ref.turns || ref.at_ms != null ? null : { call, moment: { kind: "now" } };
    if (ref.at_ms != null) return { call, moment: { kind: "time", atMs: ref.at_ms } };
    if (ref.turns) return withTime({ call, moment: { kind: "line", from: ref.turns.from_seq, to: ref.turns.to_seq } });
    return { call, moment: { kind: "now" } };
  };
  // A short id or a full id is a call reference as prose writes it.
  const ref = parseCallRef(s);
  if (ref) return fromRef(ref.call, ref);
  // A prefix of an id, or a bare full id (which the shared grammar does not
  // take for a call, since it could be any table's): split off the call and
  // read the moment with the same grammar, on a stand-in call.
  const m = /^([a-z0-9][a-z0-9-]*?)([@:].*)?$/i.exec(s);
  if (!m) return null;
  const call = m[1].toLowerCase();
  if (!m[2]) return { call, moment: { kind: "now" } };
  return fromRef(call, parseCallRef(`cl-0${m[2]}`));
}

/** Whether the server resolves this call name itself (a short id or a full
 *  id) or it is a prefix the CLI must expand first. */
export function isServerCallRef(call: string): boolean {
  return /^cl-\d+$/i.test(call) || /^[a-z0-9]{32}$/i.test(call);
}

// ── Time ─────────────────────────────────────────────────────────────────

/** The whole second at or after `ms`, or before it when that would pass
 *  `limit`: a moment a citation (`cl-42@m:ss`, whole seconds) can name
 *  exactly. */
function wholeSecond(ms: number, limit = Infinity): number {
  const up = Math.ceil(ms / 1000) * 1000;
  return up <= limit ? up : Math.floor(ms / 1000) * 1000;
}

/**
 * The moment a line's frame is taken: the first whole second a little after
 * its first word. A little after, because a line's t0 is where the recognizer
 * heard speech begin and the speaker is still finishing the gesture that goes
 * with it; a whole second, because the citation printed beside the frame is
 * `cl-42@12:34` and a whole second is what it can name, so the frame an
 * agent cites is the frame it saw. A line too short to reach that second
 * takes the whole second nearest its start that it still spans.
 */
export function lineFrameMs(seg: { t0: number; t1: number }): number {
  const start = lineMomentMs(seg);
  const end = Math.max(start, seg.t1);
  const nudged = Math.ceil((start + 250) / 1000) * 1000;
  return nudged <= end ? nudged : wholeSecond(start, end);
}

/** A call time as a file name wants it: `0m07s`, `12m34s`, `1h02m03s`. */
export function clockForName(ms: number): string {
  const parts = formatCallTime(ms).split(":");
  const sec = parts.pop()!;
  const m = parts.pop()!;
  const h = parts.pop();
  return `${h ? `${h}h${m}` : m}m${sec}s`;
}

/** The file a frame is written to when no path is given: the call, the
 *  moment and what the picture is, `cl-42_12m34s_screen.png`, so a directory
 *  of frames reads in order and says what each one is. */
export function frameFileName(handle: string, atMs: number, kind: CallRecordingKind, live = false): string {
  return `${handle}_${clockForName(atMs)}_${kind}${live ? "_live" : ""}.png`;
}

// ── What was recorded ────────────────────────────────────────────────────

/** The recorded spans as one line: `0:00-4:10 the room, 1:02-3:30 Ana's screen`. */
export function describeSpans(spans: readonly CallCoveredSpan[]): string {
  return spans
    .map((s) => `${formatCallTime(s.fromMs)}-${formatCallTime(s.toMs)} ${recordingSubject(s)}${s.pending ? " (still saving)" : ""}`)
    .join(", ");
}

/** The recorded moment nearest `atMs`, for a "try this instead" hint: the
 *  moment itself when covered, else the closest edge of a finished span (a
 *  whole second inside it, since an end is exclusive), so the hint is a
 *  reference that will itself succeed. */
export function nearestRecordedMs(spans: readonly CallCoveredSpan[], atMs: number): number | null {
  let best: number | null = null;
  for (const s of spans) {
    if (s.pending) continue;
    const at = wholeSecond(Math.min(Math.max(atMs, s.fromMs), s.toMs - 1), s.toMs - 1);
    if (at < s.fromMs) continue;
    if (best === null || Math.abs(at - atMs) < Math.abs(best - atMs)) best = at;
  }
  return best;
}

/** The first whole second in [fromMs, toMs) that a finished span covers, or
 *  null: where a line that began before the press was first on camera. */
export function firstRecordedWithin(spans: readonly CallCoveredSpan[], fromMs: number, toMs: number): number | null {
  let best: number | null = null;
  for (const s of spans) {
    if (s.pending) continue;
    const at = Math.ceil(Math.max(fromMs, s.fromMs) / 1000) * 1000;
    if (at < Math.min(toMs, s.toMs) && (best === null || at < best)) best = at;
  }
  return best;
}

/** The parts of [fromMs, toMs] no span covers, in order. */
export function uncoveredParts(spans: ReadonlyArray<{ fromMs: number; toMs: number }>, fromMs: number, toMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = fromMs;
  for (const s of [...spans].sort((a, b) => a.fromMs - b.fromMs)) {
    if (s.toMs <= at) continue;
    if (s.fromMs >= toMs) break;
    if (s.fromMs > at) out.push([at, s.fromMs]);
    at = Math.max(at, s.toMs);
  }
  if (at < toMs) out.push([at, toMs]);
  return out;
}

/** What a call has on video, in call time, for `cast call <id>` (which
 *  prints it with describeSpans). Empty when it has none. */
export function callVideoSpans(recs: Pick<SnapRecordings, "recordings" | "call_started_at" | "server_now">): CallCoveredSpan[] {
  return coveredSpans(rows(recs), recs.call_started_at, recs.server_now);
}

// ── What was said ────────────────────────────────────────────────────────

/** The line being spoken at `atMs`, or the last one said shortly before it,
 *  so a frame arrives with its context: the shared segmentAt, the rule the
 *  call page highlights a line by. Null in a long silence. */
export function lineAt(segments: readonly SnapSegment[] | undefined, atMs: number): { seg: SnapSegment; during: boolean } | null {
  const lines = segments ?? [];
  const hit = segmentAt(lines, atMs, { holdMs: LAST_SAID_WINDOW_MS });
  return hit ? { seg: lines[hit.index], during: hit.during } : null;
}

// ── Scene changes ────────────────────────────────────────────────────────

export type SceneCandidate = { atMs: number; score: number };

/**
 * The scene scores ffmpeg's `metadata=print` filter logs, one pair of lines
 * per frame that passed the select: `frame:3 pts:… pts_time:12.4` then
 * `lavfi.scene_score=0.42`. Times are seconds in the file (sceneArgs keeps
 * the file's clock); returned in ms.
 */
export function parseSceneScores(log: string): SceneCandidate[] {
  const out: SceneCandidate[] = [];
  let t: number | null = null;
  for (const line of log.split(/\r?\n|\r/)) {
    const pts = /pts_time:\s*(-?[\d.]+)/.exec(line);
    if (pts) t = Number(pts[1]);
    const score = /lavfi\.scene_score=([\d.]+)/.exec(line);
    if (score && t !== null && Number.isFinite(t)) {
      out.push({ atMs: Math.round(t * 1000), score: Number(score[1]) });
      t = null;
    }
  }
  return out;
}

/**
 * The frames of a screen share worth showing: the moments the screen changed
 * most, never closer than `minGapMs`, at most `max`, in time order. A
 * candidate with an infinite score (the first picture of a stretch) always
 * goes in first, so a range whose screen never changed still yields the one
 * frame that shows it.
 */
export function pickSceneMoments(
  cands: readonly SceneCandidate[],
  opts: { max: number; minGapMs?: number; threshold?: number },
): number[] {
  const gap = opts.minGapMs ?? SCREEN_FRAME_GAP_MS;
  const threshold = opts.threshold ?? SCENE_THRESHOLD;
  const ranked = cands
    .filter((c) => c.score >= threshold)
    .slice()
    .sort((a, b) => b.score - a.score || a.atMs - b.atMs);
  const picked: number[] = [];
  for (const c of ranked) {
    if (picked.length >= opts.max) break;
    if (picked.some((p) => Math.abs(p - c.atMs) < gap)) continue;
    picked.push(c.atMs);
  }
  return picked.sort((a, b) => a - b);
}

// ── ffmpeg ───────────────────────────────────────────────────────────────

export type FfmpegResult = { code: number | null; stdout: string; stderr: string };
export type FfmpegRunner = (args: string[], opts: { timeoutMs: number }) => Promise<FfmpegResult>;

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/**
 * One frame, at `offsetMs` into `source` (null: the source is itself one
 * image, a live frame). `-ss` before `-i` is an input seek, relative to the
 * file's start: ffmpeg jumps to the keyframe before the moment through a
 * range request and decodes forward to the exact frame, so a grab an hour
 * into a file reads a couple of MB rather than the hour.
 */
export function frameArgs(source: string, offsetMs: number | null, out: string): string[] {
  const jpeg = /\.jpe?g$/i.test(out);
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-rw_timeout", RW_TIMEOUT_US,
    ...(offsetMs === null ? [] : ["-ss", secs(offsetMs)]),
    "-i", source,
    "-frames:v", "1", "-an", "-update", "1",
    ...(jpeg ? ["-q:v", "2"] : []),
    "-y", out,
  ];
}

/** How far back from a file's end the last-picture fallback reads. A share
 *  writes a keyframe a second while it sends anything at all, so the last
 *  picture is always inside this; the bound keeps the read to a few MB. */
export const TAIL_READ_MS = 15_000;

/**
 * The last picture a file holds, for a moment past its final frame. -sseof
 * reads only the file's tail, -update writes each decoded frame over the
 * last so the output ends as the final one, and showinfo logs every frame's
 * time (-copyts keeps it on the file's own clock), so the caller can say
 * when the picture is from.
 */
export function lastFrameArgs(source: string, out: string): string[] {
  const jpeg = /\.jpe?g$/i.test(out);
  return [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    "-rw_timeout", RW_TIMEOUT_US,
    "-sseof", `-${secs(TAIL_READ_MS)}`,
    "-i", source,
    "-copyts", "-an", "-vf", "showinfo", "-update", "1",
    ...(jpeg ? ["-q:v", "2"] : []),
    "-y", out,
  ];
}

/** The file time (ms) of the last frame showinfo logged, or null. */
export function lastShownMs(log: string): number | null {
  let last: number | null = null;
  for (const m of log.matchAll(/pts_time:\s*(-?[\d.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) last = Math.round(t * 1000);
  }
  return last;
}

/**
 * A scene pass over `durMs` of a file from `startMs`: keyframes only decoded
 * (a screen file carries one a second), shrunk before scoring, every score
 * logged. Every packet of the stretch is still downloaded, which is why
 * planSnap bounds the stretch. -copyts keeps the logged times on the file's
 * clock, and -start_at_zero measures that clock from the file's start the
 * way frameArgs' seek does: an egress MP4 can begin at a nonzero timestamp,
 * and without it every change would be placed that far off.
 */
export function sceneArgs(source: string, startMs: number, durMs: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    "-rw_timeout", RW_TIMEOUT_US,
    "-skip_frame", "nokey",
    "-ss", secs(startMs), "-t", secs(durMs),
    "-i", source,
    "-an", "-copyts", "-start_at_zero",
    "-vf", "scale=480:-2,select='gt(scene,0)',metadata=print",
    "-f", "null", "-",
  ];
}

/** The ffmpeg on this machine, looked up on a login shell's PATH (agents
 *  often run with a bare one), or null. */
export function findFfmpeg(): string | null {
  return whichBin("ffmpeg", TOOL_PATH);
}

/** The machine's ffmpeg, found once, or the refusal that says how to get
 *  it. Asked for only when a frame is about to be read, so a call with no
 *  video says so without first sending anyone to install ffmpeg. */
function lazyFfmpeg(given?: FfmpegRunner): () => FfmpegRunner {
  let runner = given ?? null;
  return () => {
    if (runner) return runner;
    const bin = findFfmpeg();
    if (!bin) {
      throw new SnapError("ffmpeg_missing", `cast call snap reads the recording with ffmpeg, which is not installed. ${installHintFor("ffmpeg", { winget: "Gyan.FFmpeg" })}`);
    }
    runner = ffmpegRunner(bin);
    return runner;
  };
}

/** Runs the real ffmpeg, collecting its output and killing it at the
 *  timeout. */
export function ffmpegRunner(bin: string): FfmpegRunner {
  return (args, { timeoutMs }) =>
    new Promise((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on("data", (d: Buffer) => {
        // A scene pass logs a line per keyframe; keep the tail, which is all
        // an error needs, and every score line, which the pass needs.
        stderr += d.toString();
        if (stderr.length > 4_000_000) stderr = stderr.slice(-2_000_000);
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err) });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code: signal === "SIGKILL" ? null : code, stdout, stderr });
      });
    });
}

/** ffmpeg's complaint about a URL, said as what happened. ffmpeg quotes the
 *  input it failed on; that is the loopback proxy's address, never a signed
 *  link, but what is printed lands in a session transcript others can read,
 *  so every URL is cut out before a line is shown all the same. */
export function ffmpegFailure(rawStderr: string, timedOut: boolean): string {
  const stderr = rawStderr.replace(/\b(?:https?|tcp|tls):\/\/\S+/gi, "<recording>");
  if (timedOut) return "ffmpeg took too long reading the recording. Try again; a shorter line range reads less of the file.";
  if (/\b403\b|Forbidden/i.test(stderr)) return "Storage refused the link to the recording (HTTP 403), even after it was signed again. Run the command again; if it keeps failing, the recording may have been deleted.";
  if (/\b404\b|Not Found/i.test(stderr)) return "The recording file is missing from storage. It may have been deleted.";
  const line = stderr.split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()).filter(Boolean).pop();
  return `ffmpeg could not read the recording${line ? `: ${line}` : ""}`;
}

// ── Errors ───────────────────────────────────────────────────────────────

export type SnapErrorCode =
  | "bad_target"
  | "bad_option"
  | "not_found"
  | "ambiguous"
  | "server"
  | "not_configured"
  | "not_recorded"
  | "recording_failed"
  | "no_line"
  | "outside"
  | "no_screen"
  | "not_ready"
  | "not_live"
  | "ffmpeg_missing"
  | "ffmpeg_failed"
  | "failed";

export class SnapError extends Error {
  constructor(readonly code: SnapErrorCode, message: string) {
    super(message);
  }
}

// ── Signed links ─────────────────────────────────────────────────────────

/**
 * The call's signed links, kept fresh for as long as the command runs. The
 * server signs each for ten minutes; a scene pass over a long share plus a
 * run of grabs can take longer, so a link is renewed (the whole set, one
 * request) when it is within a minute of lapsing or when storage refuses it.
 * Lifetimes are measured on the server's clock and carried onto ours, so a
 * laptop clock that is off does not renew too late.
 */
export class SignedSources {
  private byId = new Map<string, SnapRecording>();
  private lapseAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    recs: SnapRecordings,
    private readonly refetch: () => Promise<SnapRecordings | null>,
    private readonly now: () => number = Date.now,
  ) {
    this.take(recs);
  }

  private take(recs: SnapRecordings) {
    for (const r of rows(recs)) this.byId.set(r.id, r);
    const exps = recs.recordings.map((r) => r.url_expires_at).filter((x): x is number => typeof x === "number");
    const life = exps.length ? Math.min(...exps) - recs.server_now : DEFAULT_LINK_LIFE_MS;
    this.lapseAt = this.now() + Math.max(0, life);
  }

  /** A link to a file (or to its live frame), signed again first when it is
   *  about to lapse or `force` says storage refused it. */
  async url(id: string, live: boolean, force = false): Promise<string | null> {
    if (force || this.now() > this.lapseAt - RESIGN_MARGIN_MS) await this.refresh();
    const r = this.byId.get(id);
    return (live ? r?.live_frame_url : r?.url) ?? null;
  }

  private refresh(): Promise<void> {
    this.inflight ??= this.refetch()
      .then((recs) => {
        if (recs && Array.isArray(recs.recordings)) this.take(recs);
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}

/** Where ffmpeg reads a file from: a URL per recording (and per live frame),
 *  closed when the command is done. */
export type SourceServer = { urlFor(id: string, live: boolean): string; close(): Promise<void> };

const FORWARDED_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"];

/**
 * A loopback HTTP server that hands ffmpeg the recordings without handing it
 * the signed links: each request (ranges included, which is how ffmpeg
 * seeks) is forwarded to the current link, signed again and retried once if
 * storage answers 403. Bound to 127.0.0.1 on a free port, behind a random
 * path, for the life of one command.
 */
export async function serveSources(sources: SignedSources): Promise<SourceServer> {
  const token = randomBytes(16).toString("hex");
  const server = http.createServer(async (req, res) => {
    const m = new RegExp(`^/${token}/([^/]+)/(file|live)$`).exec((req.url ?? "").split("?")[0]);
    if (!m || (req.method !== "GET" && req.method !== "HEAD")) {
      res.writeHead(404).end();
      return;
    }
    const [, id, which] = m;
    const live = which === "live";
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const ask = (url: string) =>
      fetch(url, {
        method: req.method,
        headers: req.headers.range ? { range: req.headers.range } : {},
        signal: abort.signal,
      });
    try {
      let url = await sources.url(id, live);
      if (!url) {
        res.writeHead(404).end();
        return;
      }
      let upstream = await ask(url);
      if (upstream.status === 403) {
        await upstream.body?.cancel().catch(() => {});
        url = await sources.url(id, live, true);
        if (url) upstream = await ask(url);
      }
      const headers: Record<string, string> = {};
      for (const h of FORWARDED_HEADERS) {
        const v = upstream.headers.get(h);
        if (v) headers[h] = v;
      }
      res.writeHead(upstream.status, headers);
      if (!upstream.body || req.method === "HEAD") {
        res.end();
        return;
      }
      Readable.fromWeb(upstream.body as any)
        .on("error", () => res.destroy())
        .pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(502).end();
      else res.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as { port: number };
  return {
    urlFor: (id, live) => `http://127.0.0.1:${port}/${token}/${encodeURIComponent(id)}/${live ? "live" : "file"}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// ── Output paths ─────────────────────────────────────────────────────────

/**
 * Where each frame is written. No `--out`: the owner-only scratch directory.
 * A directory (one that exists, a path ending in a slash, or one with no
 * extension): each frame by its own name inside it, created if missing. A
 * .png/.jpg file: that file for one frame, and for several its stem plus each
 * frame's moment. Any other extension is refused rather than made into a
 * directory by that name. Two frames that would share a name get `-2`, `-3`.
 */
export function outputPaths(
  frames: ReadonlyArray<{ name: string; atMs: number }>,
  out: string | undefined,
  scratch: (name: string) => string = (name) => agentTempPath("calls", name),
): string[] {
  let paths: string[];
  if (!out) {
    paths = frames.map((f) => scratch(f.name));
  } else {
    const abs = path.resolve(out);
    const existingDir = fs.existsSync(abs) && fs.statSync(abs).isDirectory();
    const isDir = existingDir || out.endsWith("/") || out.endsWith(path.sep) || path.extname(out) === "";
    if (!isDir && !/\.(png|jpe?g)$/i.test(out)) {
      throw new SnapError("bad_option", `-o takes a .png or .jpg file, or a directory (end a new one's name with /), not "${out}"`);
    }
    if (isDir) {
      fs.mkdirSync(abs, { recursive: true });
      paths = frames.map((f) => path.join(abs, f.name));
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const ext = path.extname(abs);
      const stem = abs.slice(0, -ext.length);
      paths = frames.length === 1 ? [abs] : frames.map((f) => `${stem}_${clockForName(f.atMs)}${ext}`);
    }
  }
  const seen = new Map<string, number>();
  return paths.map((p) => {
    const n = (seen.get(p) ?? 0) + 1;
    seen.set(p, n);
    if (n === 1) return p;
    const ext = path.extname(p);
    return `${p.slice(0, -ext.length)}-${n}${ext}`;
  });
}

// ── Planning ─────────────────────────────────────────────────────────────

export type SnapOptions = {
  screen?: boolean;
  composite?: boolean;
  out?: string;
  max?: string | number;
  share?: boolean;
  json?: boolean;
};

export type PlannedFrame = {
  atMs: number;
  recording: SnapRecording;
  /** ms into the file; null when the source is a live frame (one image). */
  offsetMs: number | null;
  live: boolean;
};

/** How a range's frames were chosen: where a shared screen changed, evenly
 *  through the stretch, or both (a share covering part of the range). */
export type SnapRangeKind = "scene" | "even" | "mixed";

export type SnapPlan = { frames: PlannedFrame[]; notes: string[]; range: SnapRangeKind | null };

type PlanInput = {
  call: SnapCall;
  recs: SnapRecordings;
  moment: SnapMoment;
  prefer: CallMomentPrefer;
  /** --screen: only a shared screen will do. */
  strictScreen: boolean;
  max: number;
  ffmpeg: () => FfmpegRunner;
  /** A URL ffmpeg can read a file at. */
  source: (rec: SnapRecording, live: boolean) => Promise<string>;
  handle: string;
  progress?: (line: string) => void;
};

function rows(recs: Pick<SnapRecordings, "recordings">): SnapRecording[] {
  return recs.recordings.map(({ _id, ...r }) => ({ ...r, id: _id }) as SnapRecording);
}

/** The refusal for a call with no picture at all, or none that worked. */
function nothingRecorded(handle: string, recs: SnapRecordings, all: SnapRecording[], lineHint: string): SnapError {
  if (all.length > 0 && all.every((r) => r.status === "failed")) {
    const why = all.find((r) => r.error)?.error;
    return new SnapError("recording_failed", `${handle}'s recording failed${why ? `: ${why}` : ""}. Its words are still in the transcript: cast call ${handle}${lineHint}`);
  }
  if (!recs.configured && all.length === 0) {
    return new SnapError("not_configured", `Video recording is not set up on this server, so ${handle} has no video. Its words are in the transcript: cast call ${handle}${lineHint}`);
  }
  return new SnapError(
    "not_recorded",
    `${handle} was not recorded. A call has video only while someone in the huddle has pressed Record. Its words are in the transcript: cast call ${handle}${lineHint}`,
  );
}

/** The refusal for --screen at a moment no share covers. */
function noScreen(handle: string, spans: readonly CallCoveredSpan[], atMs: number | null, what: string): SnapError {
  const screens = spans.filter((s) => s.kind === "screen");
  if (screens.length === 0) {
    return new SnapError("no_screen", `Nobody shared a screen while ${handle} was recorded. Drop --screen for the room.`);
  }
  const near = atMs === null ? null : nearestRecordedMs(screens, atMs);
  return new SnapError(
    "no_screen",
    `No screen share was recorded ${what}. Screens recorded: ${describeSpans(screens)}.` +
      (near !== null ? ` Nearest: cast call snap ${callRefId(handle, null, near)} --screen.` : "") +
      ` Drop --screen for the room.`,
  );
}

/**
 * The frame at one moment: a finished file when one covers it, the live
 * frame when the moment is now and the file is still being written.
 * `asked` names the moment the way the person asked for it ("Line 15",
 * "12:34"), for a note when the answer is a different picture than that.
 */
function frameAt(input: PlanInput, all: SnapRecording[], atMs: number, notes: string[], asked: string, strict = input.strictScreen): PlannedFrame {
  const { recs, handle } = input;
  const at = { callStartedAt: recs.call_started_at, atMs, prefer: input.prefer, now: recs.server_now };
  const playable = playableFiles(all).filter((r) => !strict || r.kind === "screen");
  const hit = locateCallMoment({ ...at, recordings: playable });
  if (hit.ok) return { atMs, recording: hit.recording, offsetMs: hit.offsetMs, live: false };

  // No file can show it. Ask the rule again over every file, to say why.
  const why = locateCallMoment({ ...at, recordings: strict ? all.filter((r) => r.kind === "screen") : all });
  const spans = coveredSpans(all, recs.call_started_at, recs.server_now);
  if (why.ok) {
    throw new SnapError(
      "not_configured",
      `${handle} was recorded at ${formatCallTime(atMs)}, but this server could not sign a link to the recording (its storage is not configured there). Try again later.`,
    );
  }
  if (why.reason === "not_ready") {
    const nowMs = recs.server_now - recs.call_started_at;
    if (Math.abs(nowMs - atMs) <= LIVE_SLACK_MS) {
      const live = liveFrame(input, all);
      if (live) {
        const ago = Math.round((nowMs - atMs) / 1000);
        if (Math.abs(ago) >= 1) notes.push(`${asked} was ${ago > 0 ? `${ago}s ago` : `${-ago}s from now`}; this is the live picture now.`);
        return { ...live, atMs: nowMs };
      }
    }
    throw new SnapError(
      "not_ready",
      `${handle} is still recording, and LiveKit uploads a recording's video only when Record is stopped or the huddle ends. ` +
        `${formatCallTime(atMs)} can be snapped once that happens. Until then only the live picture is there: cast call snap ${handle}`,
    );
  }
  if (why.reason === "no_recordings") {
    if (strict) throw noScreen(handle, spans, atMs, `at ${formatCallTime(atMs)}`);
    throw nothingRecorded(handle, recs, all, "");
  }
  if (strict) throw noScreen(handle, spans, atMs, `at ${formatCallTime(atMs)}`);
  const near = nearestRecordedMs(spans, atMs);
  throw new SnapError(
    "outside",
    `${handle} was not being recorded at ${formatCallTime(atMs)}. Recorded: ${describeSpans(spans) || "nothing that finished saving"}.` +
      (near !== null ? ` Nearest: cast call snap ${callRefId(handle, null, near)}` : ""),
  );
}

/** The newest live frame a recording file is writing, in the view the
 *  snap prefers. Null when nothing is recording. */
function liveFrame(input: PlanInput, all: SnapRecording[]): Omit<PlannedFrame, "atMs"> | null {
  const live = all.filter((r) => r.status === "recording" && r.live_frame_url && (!input.strictScreen || r.kind === "screen"));
  if (live.length === 0) return null;
  const order: CallRecordingKind[] = input.prefer === "screen" ? ["screen", "composite"] : ["composite", "screen"];
  for (const kind of order) {
    const pick = live.filter((r) => r.kind === kind).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
    if (pick) return { recording: pick, offsetMs: null, live: true };
  }
  return null;
}

/** `budget` frames shared across stretches by length (whole frames, the
 *  remainder to the longest), each stretch sampled evenly. */
function spread(parts: ReadonlyArray<[number, number]>, budget: number, gapMs: number): number[] {
  if (budget <= 0 || parts.length === 0) return [];
  const len = (i: number) => parts[i][1] - parts[i][0];
  const total = parts.reduce((n, _, i) => n + len(i), 0) || 1;
  const counts = parts.map((_, i) => Math.floor((budget * len(i)) / total));
  let left = budget - counts.reduce((n, c) => n + c, 0);
  for (const i of parts.map((_, i) => i).sort((a, b) => len(b) - len(a))) {
    if (left <= 0) break;
    counts[i]++;
    left--;
  }
  return parts.flatMap(([a, b], i) => (counts[i] ? sampleCallMoments(a, b, counts[i], gapMs) : []));
}

/**
 * The moments to show across [fromMs, toMs] of the call. Where a finished
 * screen file covers the range, the moments its screen changed (one scene
 * pass per file, each stretch's first picture always a candidate); where
 * none does, evenly spaced moments of the room. The `max` budget is split
 * between the two by how much of the range each covers. A share too long to
 * scan, or a scan that fails, is sampled evenly instead, and said so.
 */
async function rangeMoments(input: PlanInput, all: SnapRecording[], fromMs: number, toMs: number, notes: string[]): Promise<{ moments: number[]; range: SnapRangeKind }> {
  const { recs } = input;
  const span = Math.max(1, toMs - fromMs);
  const screens = input.prefer === "screen" ? playableFiles(all).filter((r) => r.kind === "screen") : [];
  const windows = screens
    .map((r) => ({ r, w: recordingWindow(r, recs.server_now)! }))
    .map(({ r, w }) => ({ r, fromMs: Math.max(fromMs, w.start - recs.call_started_at), toMs: Math.min(toMs, w.end - recs.call_started_at), fileStart: w.start }))
    .filter((x) => x.toMs > x.fromMs);
  const uncovered = uncoveredParts(windows, fromMs, toMs).filter(([a, b]) => b - a >= 1000);
  const uncoveredMs = uncovered.reduce((n, [a, b]) => n + (b - a), 0);
  if (input.strictScreen) {
    if (windows.length === 0) throw noScreen(input.handle, coveredSpans(all, recs.call_started_at, recs.server_now), null, `across these lines (${formatCallTime(fromMs)} to ${formatCallTime(toMs)})`);
    if (uncovered.length) {
      notes.push(`No screen was recorded ${uncovered.map(([a, b]) => `${formatCallTime(a)}-${formatCallTime(b)}`).join(", ")}, so those stretches have no frames. Drop --screen to include the room.`);
    }
  }
  // The room's share of the frames follows its share of the range, and a
  // share keeps at least one frame whenever there is one.
  const roomBudget = input.strictScreen
    ? 0
    : windows.length === 0
      ? input.max
      : uncoveredMs >= ROOM_FRAME_GAP_MS
        ? Math.min(input.max - 1, Math.max(1, Math.round((input.max * uncoveredMs) / span)))
        : 0;
  const screenBudget = windows.length ? input.max - roomBudget : 0;

  // Scene candidates, file by file.
  const cands: SceneCandidate[] = [];
  const evenScreen: Array<[number, number]> = [];
  for (const x of windows) {
    const stretch = x.toMs - x.fromMs;
    const size = x.r.size_bytes && x.r.duration_ms ? (x.r.size_bytes * stretch) / x.r.duration_ms : null;
    const who = recordingSubject(x.r);
    if (size !== null ? size > SCENE_SCAN_MAX_BYTES : stretch > SCENE_SCAN_MAX_MS) {
      notes.push(`${who} from ${formatCallTime(x.fromMs)} to ${formatCallTime(x.toMs)} is too long to scan for changes, so its frames are evenly spaced. A shorter line range finds the changes.`);
      evenScreen.push([x.fromMs, x.toMs]);
      continue;
    }
    input.progress?.(`Reading ${formatCallTime(x.fromMs)}-${formatCallTime(x.toMs)} of ${who} for changes...`);
    const startInFile = recs.call_started_at + x.fromMs - x.fileStart;
    const res = await input.ffmpeg()(sceneArgs(await input.source(x.r, false), startInFile, Math.max(1000, stretch)), { timeoutMs: SCENE_TIMEOUT_MS });
    if (res.code !== 0) {
      notes.push(`Could not scan ${who} for changes (${ffmpegFailure(res.stderr, res.code === null)}), so its frames are evenly spaced.`);
      evenScreen.push([x.fromMs, x.toMs]);
      continue;
    }
    cands.push({ atMs: x.fromMs, score: Infinity });
    for (const c of parseSceneScores(res.stderr + res.stdout)) {
      const at = x.fileStart + c.atMs - recs.call_started_at;
      if (at > x.fromMs && at < x.toMs) cands.push({ atMs: at, score: c.score });
    }
  }

  const scanned = windows.length - evenScreen.length;
  const sceneBudget = !scanned ? 0 : evenScreen.length ? Math.ceil(screenBudget / 2) : screenBudget;
  const moments = [
    ...pickSceneMoments(cands, { max: sceneBudget }),
    ...spread(evenScreen, screenBudget - sceneBudget, SCREEN_FRAME_GAP_MS),
    ...spread(uncovered.length ? uncovered : [[fromMs, toMs]], roomBudget, ROOM_FRAME_GAP_MS),
  ];
  const range: SnapRangeKind = cands.length === 0 ? "even" : roomBudget || evenScreen.length ? "mixed" : "scene";
  return { moments, range };
}

/** Which frames to grab, and from where. Throws a SnapError that says what
 *  to do when there is no picture to give. */
export async function planSnap(input: PlanInput): Promise<SnapPlan> {
  const { call, recs, moment, handle } = input;
  const all = rows(recs);
  const notes: string[] = [];
  const segments = call.segments ?? [];
  const lineHint = moment.kind === "line" ? ` ${moment.from}${moment.to !== moment.from ? `:${moment.to}` : ""}` : "";
  const nothing = all.length === 0 || all.every((r) => r.status === "failed");

  if (moment.kind === "now") {
    if (recs.call_ended_at != null) {
      if (nothing) throw nothingRecorded(handle, recs, all, "");
      // Suggest moments that will work: the first recorded second, and the
      // line being said then.
      const spans = coveredSpans(all, recs.call_started_at, recs.server_now);
      const first = spans.find((s) => !s.pending);
      if (!first) {
        throw new SnapError("not_ready", `${handle} has ended and its recording is still saving. Try again in a minute. Recorded: ${describeSpans(spans)}.`);
      }
      const at = nearestRecordedMs(spans, first.fromMs) ?? first.fromMs;
      const line = lineAt(segments, at);
      throw new SnapError(
        "not_live",
        `${handle} has ended, so there is no "now" to show. Name a moment: cast call snap ${callRefId(handle, null, at)}` +
          (line ? `, or a transcript line: cast call snap ${callRefId(handle, { from_seq: line.seg.seq, to_seq: line.seg.seq })}` : "") +
          `. Recorded: ${describeSpans(spans)}.`,
      );
    }
    const live = liveFrame(input, all);
    if (!live) {
      const starting = all.some((r) => r.status === "starting" || (r.status === "recording" && !r.live_frame_url));
      throw new SnapError(
        "not_live",
        starting
          ? `${handle}'s recording is starting. Try again in a few seconds.`
          : input.strictScreen && all.some((r) => r.status === "recording")
            ? `Nobody is sharing a screen in ${handle} right now. Drop --screen for the room.`
            : `${handle} is not being recorded right now. A call has video only while someone in the huddle has pressed Record.`,
      );
    }
    return { frames: [{ ...live, atMs: recs.server_now - recs.call_started_at }], notes, range: null };
  }

  if (nothing) throw nothingRecorded(handle, recs, all, lineHint);

  if (moment.kind === "time") return { frames: [frameAt(input, all, moment.atMs, notes, formatCallTime(moment.atMs))], notes, range: null };

  const lines = segments.filter((s) => s.seq >= moment.from && s.seq <= moment.to).sort((a, b) => a.seq - b.seq);
  if (lines.length === 0) {
    const last = call.last_seq ?? segments[segments.length - 1]?.seq ?? 0;
    throw new SnapError(
      "no_line",
      last > 0
        ? `${handle} has no line ${moment.from === moment.to ? moment.from : `${moment.from}-${moment.to}`}; its lines run 1-${last}. See them with: cast call ${handle} --transcript`
        : `${handle} has no transcript lines to point at. Name a time instead: cast call snap ${handle}@1:30`,
    );
  }

  if (moment.from === moment.to) {
    const line = lines[0];
    const asked = `Line ${line.seq}`;
    try {
      return { frames: [frameAt(input, all, lineFrameMs(line), notes, asked)], notes, range: null };
    } catch (err) {
      // A line that began a moment before the press (egress takes a few
      // seconds to start), or ran into a gap or a share starting, was still
      // on camera for the rest of its words: show the first recorded second
      // of it rather than refusing.
      if (!(err instanceof SnapError) || (err.code !== "outside" && err.code !== "no_screen")) throw err;
      const usable = input.strictScreen ? all.filter((r) => r.kind === "screen") : all;
      const within = firstRecordedWithin(coveredSpans(usable, recs.call_started_at, recs.server_now), line.t0, Math.max(line.t0, line.t1));
      if (within === null) throw err;
      const frame = frameAt(input, all, within, notes, asked);
      notes.push(`Line ${line.seq} began at ${formatCallTime(line.t0)}, before it was being recorded; this frame is from ${formatCallTime(within)}, ${Math.round((within - line.t0) / 1000)}s into it.`);
      return { frames: [frame], notes, range: null };
    }
  }

  // A range. Each moment still goes through frameAt (locateCallMoment), so a
  // range frame and a single snap of the same moment are one picture.
  const fromMs = lineFrameMs(lines[0]);
  const toMs = Math.max(fromMs, ...lines.map((l) => Math.max(l.t0, l.t1)));
  const { moments: raw, range } = await rangeMoments(input, all, fromMs, toMs, notes);
  // Every frame sits on a whole second, rounded up (a scene change is on
  // screen from its keyframe on), so the `cl-42@m:ss` printed beside a frame
  // names that exact frame, the same promise lineFrameMs keeps for a line.
  const moments = [...new Set(raw.map((m) => wholeSecond(Math.min(Math.max(m, fromMs), toMs), toMs)))].sort((a, b) => a - b);
  const frames: PlannedFrame[] = [];
  const missed: number[] = [];
  let lastError: SnapError | null = null;
  for (const at of moments) {
    try {
      frames.push(frameAt(input, all, at, [], formatCallTime(at), false));
    } catch (err) {
      if (!(err instanceof SnapError)) throw err;
      lastError = err;
      missed.push(at);
    }
  }
  if (frames.length === 0) throw lastError!;
  if (missed.length > 0) {
    notes.push(`${missed.length} of the moments across these lines were not recorded (${missed.map((m) => formatCallTime(m)).join(", ")}).`);
  }
  // Two moments can land on one live frame; keep one.
  const unique = frames.filter((f, i) => !f.live || frames.findIndex((g) => g.live && g.recording.id === f.recording.id) === i);
  return { frames: unique, notes, range };
}

// ── The command ──────────────────────────────────────────────────────────

/** A call lookup that failed, with why: the CLI's resolveCallId throws one
 *  of these rather than exiting, so `--json` can answer in JSON. */
export type CallLookupError = Error & { code?: "not_found" | "ambiguous" };

export type SnapDeps = {
  /** Posts to the server, throwing on any failure. */
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  resolveCallId: (ref: string) => Promise<string>;
  baseUrl: string;
  /** Uploads a written frame (`cast image`'s pipeline). */
  upload?: (file: string, alt: string) => Promise<{ url: string; markdown: string }>;
  /** Tests hand in a fake; otherwise the machine's ffmpeg is found. */
  ffmpeg?: FfmpegRunner;
  /** Tests hand in a directory; otherwise the scratch directory. */
  scratch?: (name: string) => string;
  /** Tests read the links straight; otherwise the loopback proxy. */
  serveSources?: (sources: SignedSources) => Promise<SourceServer>;
  /** One line per slow step, for a person watching. */
  progress?: (line: string) => void;
};

export type SnapFrameResult = {
  path: string;
  ref: string;
  at: string;
  at_ms: number;
  kind: CallRecordingKind;
  shows: string;
  live: boolean;
  recording_id: string;
  offset_ms: number | null;
  call_url: string;
  line: { ref: string; speaker: string; text: string; at: string; during: boolean } | null;
  image?: { url: string; markdown: string };
};

export type SnapResult = {
  call: { id: string; short_id: string | null; title: string | null };
  target: string;
  range: SnapRangeKind | null;
  frames: SnapFrameResult[];
  notes: string[];
};

function parseMax(raw: SnapOptions["max"]): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_RANGE_FRAMES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_RANGE_FRAMES) {
    throw new SnapError("bad_option", `--max takes a whole number from 1 to ${MAX_RANGE_FRAMES} (got "${raw}")`);
  }
  return n;
}

/** Grabs one planned frame to `out`. A moment in a file's last fraction of
 *  a second can fall past the final frame ffmpeg decodes, which writes
 *  nothing and exits 0; one retry a second earlier covers it.
 *
 *  A moment can also sit well past a file's final frame and still inside
 *  the span its row claims. LiveKit reports how long the egress ran, not
 *  how much picture it wrote, and a screen share sends frames only when the
 *  screen changes: a slide left up for the last ten seconds of a run is
 *  ten seconds with no frame in the file (measured 2026-10-02: a 25.5 s
 *  run held 14.7 s of picture). The screen at that moment is the last
 *  picture the file holds, so that is the frame, and the caller is told
 *  how far back it was written (heldFromMs, ms into the file). */
async function grab(ffmpeg: FfmpegRunner, source: string, frame: PlannedFrame, out: string): Promise<{ heldFromMs: number | null }> {
  const attempts = frame.offsetMs === null ? [null] : [frame.offsetMs, Math.max(0, frame.offsetMs - 1000)];
  let last: FfmpegResult | null = null;
  const wrote = () => fs.existsSync(out) && fs.statSync(out).size > 0;
  const clear = () => {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      // A file we cannot remove is one ffmpeg -y will report on.
    }
  };
  for (const offset of attempts) {
    clear();
    last = await ffmpeg(frameArgs(source, offset, out), { timeoutMs: GRAB_TIMEOUT_MS });
    if (last.code !== 0) break;
    if (wrote()) return { heldFromMs: null };
  }
  if (last && last.code !== 0) throw new SnapError("ffmpeg_failed", ffmpegFailure(last.stderr, last.code === null));
  if (frame.offsetMs !== null) {
    clear();
    const tail = await ffmpeg(lastFrameArgs(source, out), { timeoutMs: GRAB_TIMEOUT_MS });
    if (tail.code !== 0) throw new SnapError("ffmpeg_failed", ffmpegFailure(tail.stderr, tail.code === null));
    const heldFromMs = lastShownMs(tail.stderr);
    if (wrote() && heldFromMs !== null && heldFromMs <= frame.offsetMs) return { heldFromMs };
  }
  throw new SnapError("ffmpeg_failed", `ffmpeg found no frame at ${formatCallTime(frame.atMs)} in the recording.`);
}

/** A server or lookup failure as a refusal, so it prints the same way and
 *  answers in JSON under --json. */
async function asked<T>(what: Promise<T>): Promise<T> {
  try {
    return await what;
  } catch (err) {
    if (err instanceof SnapError) throw err;
    const code = (err as CallLookupError).code;
    const message = err instanceof Error ? err.message : String(err);
    throw new SnapError(code === "ambiguous" ? "ambiguous" : code === "not_found" ? "not_found" : "server", message);
  }
}

/** Everything `cast call snap <target> [moment]` does short of printing. */
export async function snapCall(targetRaw: string | undefined, options: SnapOptions, deps: SnapDeps, extra?: string): Promise<SnapResult> {
  if (!targetRaw) throw new SnapError("bad_target", `Name the moment to snap: ${SNAP_FORMS}.`);
  const target = parseSnapTarget(targetRaw, extra);
  const shown = extra ? `${targetRaw} ${extra}` : targetRaw;
  if (!target) {
    // `cl-42:1:02:03` is a time typed with a colon: say so.
    const colon = /^(cl-\d+)[:\s]+(\S+)$/i.exec(shown);
    const asTime = colon ? parseCallTime(colon[2]) : null;
    throw new SnapError(
      "bad_target",
      `"${shown}" is not a moment of a call. Use ${SNAP_FORMS}.` +
        (colon && asTime !== null ? ` For a time, write ${callRefId(colon[1].toLowerCase(), null, asTime)}: a colon names transcript lines, @ names a time.` : ""),
    );
  }
  if (options.screen && options.composite) throw new SnapError("bad_option", "Pick one of --screen and --composite.");
  const max = parseMax(options.max);

  const callArg = await asked(isServerCallRef(target.call) ? Promise.resolve(target.call) : deps.resolveCallId(target.call));
  const fetchRecs = () => deps.post("/cli/calls/recordings", { call: callArg }) as Promise<SnapRecordings | null>;
  const [call, recs] = (await asked(Promise.all([deps.post("/cli/calls/get", { transcript_id: callArg }), fetchRecs()]))) as [SnapCall | null, SnapRecordings | null];
  if (!call || !recs) {
    throw new SnapError("not_found", `No call ${target.call} that you can read. \`cast calls\` lists the calls you can.`);
  }
  if (!Array.isArray(recs.recordings)) {
    throw new SnapError("not_configured", "This server does not serve call recordings yet.");
  }
  const handle = recs.short_id ?? call.short_id ?? recs.transcript_id;

  // Signed links stay in this process: ffmpeg reads through the proxy,
  // started the first time a file is read.
  const sources = new SignedSources(recs, () => asked(fetchRecs()));
  let server = null as Promise<SourceServer> | null;
  const source = async (rec: SnapRecording, live: boolean): Promise<string> => {
    server ??= (deps.serveSources ?? serveSources)(sources);
    return (await server).urlFor(rec.id, live);
  };
  try {
    const ffmpeg = lazyFfmpeg(deps.ffmpeg);
    const plan = await planSnap({
      call,
      recs,
      moment: target.moment,
      prefer: options.composite ? "composite" : CALL_FRAME_PREFER,
      strictScreen: !!options.screen,
      max,
      ffmpeg,
      source,
      handle,
      progress: deps.progress,
    });
    const notes = [...plan.notes];
    if (target.alsoTime !== undefined && target.moment.kind === "line") {
      const lines = callRefId(handle, { from_seq: target.moment.from, to_seq: target.moment.to });
      notes.push(`Read ${lines} as transcript lines. For the time ${formatCallTime(target.alsoTime)}, write ${callRefId(handle, null, target.alsoTime)}.`);
    }
    if (options.max !== undefined && plan.range === null) notes.push(`--max counts frames across a line range (${handle}:15-25); this is one moment, so it was ignored.`);

    const run = ffmpeg();
    const names = plan.frames.map((f) => ({ name: frameFileName(handle, f.atMs, f.recording.kind, f.live), atMs: f.atMs }));
    const paths = outputPaths(names, options.out, deps.scratch);
    const frames: SnapFrameResult[] = [];
    for (const [i, f] of plan.frames.entries()) {
      if (plan.frames.length > 1) deps.progress?.(`Frame ${i + 1}/${plan.frames.length} at ${formatCallTime(f.atMs)}`);
      const out = paths[i];
      const { heldFromMs } = await grab(run, await source(f.recording, f.live), f, out);
      if (!options.out) secureTempFile(out);
      // The picture is older than the moment: say from when, on the call's
      // own clock, so a reader never takes a held frame for a fresh one.
      const heldAtMs = heldFromMs !== null && f.offsetMs !== null ? f.atMs - (f.offsetMs - heldFromMs) : null;
      if (heldAtMs !== null && f.atMs - heldAtMs >= 1000) {
        notes.push(`No new picture of ${recordingSubject(f.recording)} was written after ${formatCallTime(heldAtMs)}, so the frame for ${formatCallTime(f.atMs)} is the last one, from ${formatCallTime(heldAtMs)}.`);
      }
      const said = lineAt(call.segments, f.atMs);
      const ref = callRefId(handle, null, f.atMs);
      const shows = recordingSubject(f.recording);
      const result: SnapFrameResult = {
        path: out,
        ref,
        at: formatCallTime(f.atMs),
        at_ms: f.atMs,
        kind: f.recording.kind,
        shows,
        live: f.live,
        recording_id: f.recording.id,
        offset_ms: heldFromMs ?? f.offsetMs,
        call_url: `${deps.baseUrl}${callMomentHref(recs.transcript_id, f.atMs)}`,
        line: said
          ? {
              ref: callRefId(handle, { from_seq: said.seg.seq, to_seq: said.seg.seq }),
              speaker: said.seg.speaker_name,
              text: said.seg.text,
              at: formatCallTime(said.seg.t0),
              during: said.during,
            }
          : null,
      };
      if (options.share && deps.upload) {
        // The image is public to whoever holds its link, and its alt text
        // travels with it: the moment and the view, never the call's title.
        try {
          result.image = await deps.upload(out, `${ref}, ${shows}${f.live ? ", live" : ""}`);
        } catch (err) {
          notes.push(`Could not upload ${path.basename(out)}: ${err instanceof Error ? err.message : String(err)}. The frame is still at ${out}.`);
        }
      }
      frames.push(result);
    }
    return {
      call: { id: recs.transcript_id, short_id: recs.short_id ?? call.short_id ?? null, title: call.title ?? null },
      target: target.moment.kind === "line" ? callRefId(handle, { from_seq: target.moment.from, to_seq: target.moment.to }) : frames[0]?.ref ?? handle,
      range: plan.range,
      frames,
      notes,
    };
  } finally {
    const running = server ? await server.catch(() => null) : null;
    await running?.close();
  }
}

// ── Printing ─────────────────────────────────────────────────────────────

function quote(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

/** How a range's frames were chosen, in words. One person's screen across
 *  the whole range is named. */
function rangeWords(res: SnapResult): string {
  const screens = [...new Set(res.frames.filter((f) => f.kind === "screen").map((f) => f.shows))];
  const changed = screens.length === 1 ? `where ${screens[0]} changed` : "where the shared screen changed";
  if (res.range === "scene") return changed;
  if (res.range === "mixed") return `${changed}, and evenly through the rest`;
  return "evenly spaced";
}

/** The human output: each frame's path, what it shows, what was being said,
 *  and how to cite it. */
export function formatSnapResult(res: SnapResult): string {
  const out: string[] = [];
  const many = res.frames.length > 1;
  if (many) {
    const first = res.frames[0];
    const last = res.frames[res.frames.length - 1];
    out.push(
      `${fmt.highlight(res.target)} ${fmt.muted(`${res.frames.length} frames ${rangeWords(res)}, ${first.at} to ${last.at}${res.call.title ? ` · ${res.call.title}` : ""}`)}`,
    );
  }
  for (const f of res.frames) {
    const live = f.live ? ` ${fmt.warning("live")}` : "";
    const head = many ? `${fmt.accent(f.at)}` : `${fmt.highlight(f.ref)}`;
    const title = !many && res.call.title ? fmt.muted(` · ${res.call.title}`) : "";
    out.push(`${fmt.success(icons.check)} ${head} ${fmt.muted("·")} ${f.shows}${live}${title}`);
    out.push(`  ${fmt.path(f.path)}`);
    if (f.line) {
      const when = f.line.during ? "" : fmt.muted(` (said at ${f.line.at}, just before)`);
      out.push(`  ${fmt.accent(f.line.speaker)} ${fmt.muted(f.line.ref)} ${quote(f.line.text)}${when}`);
    }
    if (f.image) out.push(`  ${f.image.markdown}`);
  }
  for (const note of res.notes) out.push(fmt.warning(`Note: ${note}`));
  const sample = res.frames[0];
  if (sample) {
    out.push("");
    out.push(
      fmt.muted(
        sample.live
          ? `A live picture is not kept, so it cannot be cited. Once the recording is saved, ${sample.ref} renders as that moment of the call.`
          : `Cite a frame as ${sample.ref}: on its own line in a message it renders as this picture for anyone who can read the call, linked to ${sample.call_url}`,
      ),
    );
    if (!res.frames.some((f) => f.image)) out.push(fmt.muted(`For readers outside the team, --share uploads the frames as images anyone with the link can open.`));
  }
  return out.join("\n");
}

/** `cast call snap`: run, print, and exit non-zero with a plain reason on
 *  any refusal (as JSON with --json, so a script always reads JSON). */
export async function runCallSnap(target: string | undefined, options: SnapOptions, deps: SnapDeps, extra?: string): Promise<void> {
  const progress = options.json ? undefined : deps.progress ?? ((line: string) => process.stderr.write(`${fmt.muted(line)}\n`));
  try {
    const res = await snapCall(target, options, { ...deps, progress }, extra);
    console.log(options.json ? JSON.stringify(res, null, 2) : formatSnapResult(res));
  } catch (err) {
    const known = err instanceof SnapError;
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) console.log(JSON.stringify({ error: message, code: known ? err.code : "failed" }, null, 2));
    else console.error(`${fmt.error("Error:")} ${message}`);
    process.exit(1);
  }
}
