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
// shared contract, the same function the call page and a frame embed use, so
// `cl-42@12:34` names one picture everywhere. Local ffmpeg then seeks that
// file over HTTPS range requests and writes one PNG; nothing else is kept on
// disk, and by default the PNG lands in the CLI's owner-only scratch
// directory (tempFiles.ts), swept after a day, because a frame of a private
// call is as private as the call.
//
// A screen share is recorded twice: inside the room composite, shrunk to a
// tile, and as its own file at full resolution. The default takes the share's
// own file whenever one covers the moment, because the text on a shared
// screen is what an agent needs to read and the composite has made it mush.

import * as fs from "node:fs";
import * as path from "node:path";
import {
  locateCallMoment,
  recordingWindow,
  sampleCallMoments,
  lineMomentMs,
  type CallRecordingKind,
  type CallRecordingSpan,
  type CallMomentPrefer,
  callMomentHref,
} from "@codecast/shared/contracts";
import { callRefId, formatCallTime, parseCallRef, parseCallTime, parseEntityUrl } from "@codecast/shared/entities";
import { spawn, whichBin } from "./proc.js";
import { TOOL_PATH, installHintFor } from "./toolInstall.js";
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
 *  keep noise out, not pick the frames. */
export const SCENE_THRESHOLD = 0.04;
/** How close to "now" a moment may be and still be answered from the live
 *  frame of a recording that has not been uploaded yet. */
export const LIVE_SLACK_MS = 15_000;
/** One ffmpeg run's ceiling: a frame grab reads a few hundred KB around one
 *  keyframe; a scene pass over a long range reads every keyframe in it. */
const GRAB_TIMEOUT_MS = 90_000;
const SCENE_TIMEOUT_MS = 5 * 60_000;
/** ffmpeg's own network timeout, in microseconds: a stalled read fails the
 *  run rather than hanging it until our timeout. */
const RW_TIMEOUT_US = "30000000";

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
  live_frame_url: string | null;
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

export type SnapTarget = { call: string; moment: SnapMoment };

export const SNAP_FORMS =
  "cl-42:15 (a transcript line), cl-42:15-25 (frames across lines), cl-42@12:34 (a time into the call), or cl-42 alone (right now, while it records)";

/**
 * What a snap names. The call is a short id, a full id or a unique prefix of
 * one; the moment rides it the way prose writes it (`cl-42:15`, `cl-42@12:34`,
 * parsed by the shared call-reference grammar), and a bare call means now. A
 * call page URL works too (`…/calls/<id>?t=754`), since that is what a person
 * pastes. Null for anything else.
 */
export function parseSnapTarget(raw: string | null | undefined): SnapTarget | null {
  let s = (raw ?? "").trim();
  if (/^https?:\/\//i.test(s)) {
    const link = parseEntityUrl(s);
    if (!link || link.type !== "call") return null;
    s = link.id;
  }
  const m = /^([a-z0-9][a-z0-9-]*?)(?:([@:])(.*))?$/i.exec(s);
  if (!m) return null;
  const call = m[1].toLowerCase();
  const [, , sep, tail] = m;
  if (!sep) return { call, moment: { kind: "now" } };
  if (sep === "@") {
    if (tail.trim().toLowerCase() === "now") return { call, moment: { kind: "now" } };
    const atMs = parseCallTime(tail);
    return atMs === null ? null : { call, moment: { kind: "time", atMs } };
  }
  const turns = parseCallRef(`cl-0:${tail}`)?.turns;
  return turns ? { call, moment: { kind: "line", from: turns.from_seq, to: turns.to_seq } } : null;
}

/** Whether the server resolves this call name itself (a short id or a full
 *  id) or it is a prefix the CLI must expand first. */
export function isServerCallRef(call: string): boolean {
  return /^cl-\d+$/i.test(call) || /^[a-z0-9]{32}$/i.test(call);
}

// ── Time ─────────────────────────────────────────────────────────────────

/**
 * The moment a line's frame is taken: the first whole second a little after
 * its first word. A little after, because a line's t0 is where the recognizer
 * heard speech begin and the speaker is still finishing the gesture that goes
 * with it; a whole second, because the citation printed beside the frame is
 * `cl-42@12:34` and a whole second is what it can name, so the frame an
 * agent cites is the frame it saw. A line too short to reach that second
 * keeps its own start.
 */
export function lineFrameMs(seg: { t0: number; t1: number }): number {
  const start = lineMomentMs(seg);
  const nudged = Math.ceil((start + 250) / 1000) * 1000;
  return nudged <= Math.max(start, seg.t1) ? nudged : start;
}

/** A call time as a file name wants it: `0m07s`, `12m34s`, `1h02m03s`. */
export function clockForName(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m${sec}s` : `${m}m${sec}s`;
}

/** The file a frame is written to when no path is given: the call, the
 *  moment and what the picture is, `cl-42_12m34s_screen.png`, so a directory
 *  of frames reads in order and says what each one is. */
export function frameFileName(handle: string, atMs: number, kind: CallRecordingKind, live = false): string {
  return `${handle}_${clockForName(atMs)}_${kind}${live ? "_live" : ""}.png`;
}

/** What a frame shows, as a person would say it. */
export function frameSubject(rec: { kind: CallRecordingKind; participant_name?: string | null }): string {
  if (rec.kind === "composite") return "the room";
  return rec.participant_name ? `${rec.participant_name}'s screen` : "a shared screen";
}

// ── What was recorded ────────────────────────────────────────────────────

export type CoveredSpan = { fromMs: number; toMs: number; subject: string; pending: boolean };

/** Every stretch of the call that has a picture, in call time: each run's
 *  room file, and each screen share inside it. Failed files are left out;
 *  files still being written are marked, since they cannot be sought yet. */
export function recordedSpans(recs: readonly SnapRecording[], callStartedAt: number, now: number): CoveredSpan[] {
  return recs
    .filter((r) => r.status !== "failed")
    .map((r) => ({ r, w: recordingWindow(r, now) }))
    .filter((x): x is { r: SnapRecording; w: { start: number; end: number } } => !!x.w && x.w.end > x.w.start)
    .map(({ r, w }) => ({
      fromMs: w.start - callStartedAt,
      toMs: w.end - callStartedAt,
      subject: frameSubject(r),
      pending: r.status !== "ready",
    }))
    .sort((a, b) => a.fromMs - b.fromMs || (a.subject === "the room" ? -1 : 1));
}

/** The recorded spans as one line: `0:00-4:10 the room, 1:02-3:30 Ana's screen`. */
export function describeSpans(spans: readonly CoveredSpan[]): string {
  return spans
    .map((s) => `${formatCallTime(s.fromMs)}-${formatCallTime(s.toMs)} ${s.subject}${s.pending ? " (still saving)" : ""}`)
    .join(", ");
}

/** The recorded moment nearest `atMs`, for a "try this instead" hint: the
 *  moment itself when covered, else the closest edge of a finished span (a
 *  second inside it, since an end is exclusive). */
export function nearestRecordedMs(spans: readonly CoveredSpan[], atMs: number): number | null {
  let best: number | null = null;
  for (const s of spans) {
    if (s.pending) continue;
    // A whole second inside [fromMs, toMs), as near atMs as the span allows,
    // so the hint is a reference that will itself succeed.
    const clamped = Math.min(Math.max(atMs, s.fromMs), s.toMs - 1);
    let at = Math.ceil(clamped / 1000) * 1000;
    if (at >= s.toMs) at = Math.floor(clamped / 1000) * 1000;
    if (at < s.fromMs) continue;
    if (best === null || Math.abs(at - atMs) < Math.abs(best - atMs)) best = at;
  }
  return best;
}

// ── What was said ────────────────────────────────────────────────────────

/** How far back a line is still "what was being said" at a silent moment. */
const LAST_SAID_WINDOW_MS = 20_000;

/** The line being spoken at `atMs`, or the last one said shortly before it,
 *  so a frame arrives with its context. Null in a long silence. */
export function lineAt(segments: readonly SnapSegment[] | undefined, atMs: number): { seg: SnapSegment; during: boolean } | null {
  let last: SnapSegment | null = null;
  for (const s of segments ?? []) {
    if (s.t0 <= atMs && atMs <= Math.max(s.t0, s.t1)) return { seg: s, during: true };
    if (s.t0 <= atMs && (!last || s.t0 >= last.t0)) last = s;
  }
  return last && atMs - Math.max(last.t0, last.t1) <= LAST_SAID_WINDOW_MS ? { seg: last, during: false } : null;
}

// ── Scene changes ────────────────────────────────────────────────────────

export type SceneCandidate = { atMs: number; score: number };

/**
 * The scene scores ffmpeg's `metadata=print` filter logs, one pair of lines
 * per frame that passed the select: `frame:3 pts:… pts_time:12.4` then
 * `lavfi.scene_score=0.42`. Times are seconds in the file (the pass runs with
 * -copyts); returned in ms.
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
 * image, a live frame). `-ss` before `-i` is an input seek: ffmpeg jumps to
 * the keyframe before the moment through a range request and decodes forward
 * to the exact frame, so a grab an hour into a file reads a few hundred KB
 * rather than the hour.
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

/**
 * A scene pass over `durMs` of a file from `startMs`: keyframes only (a
 * screen file carries one a second, and decoding nothing else keeps an hour
 * of 4K affordable), shrunk before scoring, every score logged. -copyts keeps
 * the logged times in the file's own clock.
 */
export function sceneArgs(source: string, startMs: number, durMs: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    "-rw_timeout", RW_TIMEOUT_US,
    "-skip_frame", "nokey",
    "-ss", secs(startMs), "-t", secs(durMs),
    "-i", source,
    "-an", "-copyts",
    "-vf", "scale=480:-2,select='gt(scene,0)',metadata=print",
    "-f", "null", "-",
  ];
}

/** The ffmpeg on this machine, looked up on a login shell's PATH (agents
 *  often run with a bare one), or null. */
export function findFfmpeg(): string | null {
  return whichBin("ffmpeg", TOOL_PATH);
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
 *  input it failed on, and that input is a signed link to a private
 *  recording; what is printed lands in a session transcript others can read,
 *  so every URL is cut out before a line is shown. */
export function ffmpegFailure(rawStderr: string, timedOut: boolean): string {
  const stderr = rawStderr.replace(/\b(?:https?|tcp|tls):\/\/\S+/gi, "<recording>");
  if (timedOut) return "ffmpeg took too long reading the recording. Try again; a moment nearer the start of a long file is faster.";
  if (/\b403\b|Forbidden/i.test(stderr)) return "Storage refused the signed link to the recording (HTTP 403). Links last ten minutes; run the command again.";
  if (/\b404\b|Not Found/i.test(stderr)) return "The recording file is missing from storage. It may have been deleted.";
  const line = stderr.split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()).filter(Boolean).pop();
  return `ffmpeg could not read the recording${line ? `: ${line}` : ""}`;
}

// ── Errors ───────────────────────────────────────────────────────────────

export type SnapErrorCode =
  | "bad_target"
  | "bad_option"
  | "not_found"
  | "not_configured"
  | "not_recorded"
  | "recording_failed"
  | "no_line"
  | "outside"
  | "not_ready"
  | "not_live"
  | "ffmpeg_missing"
  | "ffmpeg_failed";

export class SnapError extends Error {
  constructor(readonly code: SnapErrorCode, message: string) {
    super(message);
  }
}

// ── Output paths ─────────────────────────────────────────────────────────

/**
 * Where each frame is written. No `--out`: the owner-only scratch directory.
 * A directory (existing, ending in a slash, or with no image extension):
 * each frame by its own name inside it, created if missing. A file: that
 * file for one frame, and for several its stem plus each frame's moment.
 * Two frames that would share a name get `-2`, `-3`.
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
    const isDir = out.endsWith("/") || out.endsWith(path.sep) || (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) || !/\.(png|jpe?g)$/i.test(out);
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
  source: string;
  live: boolean;
};

export type SnapPlan = { frames: PlannedFrame[]; notes: string[]; rangeLabel?: string };

type PlanInput = {
  call: SnapCall;
  recs: SnapRecordings;
  moment: SnapMoment;
  prefer: CallMomentPrefer;
  strictScreen: boolean;
  max: number;
  ffmpeg: FfmpegRunner;
  handle: string;
};

function rows(recs: SnapRecordings): SnapRecording[] {
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

/** The frame at one moment: the stored file when it is ready, the live frame
 *  when the moment is now and the file is still being written. */
function frameAt(input: PlanInput, all: SnapRecording[], atMs: number, notes: string[]): PlannedFrame {
  const { recs, handle } = input;
  const hit = locateCallMoment({ callStartedAt: recs.call_started_at, atMs, recordings: all, prefer: input.prefer, now: recs.server_now });
  if (hit.ok) {
    if (input.strictScreen && hit.recording.kind !== "screen") {
      notes.push(`No screen share was recorded at ${formatCallTime(atMs)}, so this is the room view.`);
    }
    return { atMs, recording: hit.recording, offsetMs: hit.offsetMs, source: hit.recording.url!, live: false };
  }
  const nowMs = recs.server_now - recs.call_started_at;
  if (hit.reason === "not_ready" && Math.abs(nowMs - atMs) <= LIVE_SLACK_MS) {
    const live = liveFrame(input, all);
    if (live) return { ...live, atMs: nowMs };
  }
  if (hit.reason === "no_recordings") throw nothingRecorded(handle, recs, all, "");
  const spans = recordedSpans(all, recs.call_started_at, recs.server_now);
  if (hit.reason === "not_ready") {
    throw new SnapError(
      "not_ready",
      `The recording covering ${formatCallTime(atMs)} is still being written; LiveKit uploads it when the recording stops. ` +
        `For the call as it is right now: cast call snap ${handle}`,
    );
  }
  const near = nearestRecordedMs(spans, atMs);
  throw new SnapError(
    "outside",
    `${handle} was not being recorded at ${formatCallTime(atMs)}. Recorded: ${describeSpans(spans) || "nothing that finished saving"}.` +
      (near !== null ? ` Nearest: cast call snap ${callRefId(handle, null, near)}` : ""),
  );
}

/** The newest live frame a recording file is writing, screen first unless
 *  the room was asked for. Null when nothing is recording. */
function liveFrame(input: PlanInput, all: SnapRecording[]): Omit<PlannedFrame, "atMs"> | null {
  const live = all.filter((r) => r.status === "recording" && r.live_frame_url);
  if (live.length === 0) return null;
  const order: CallRecordingKind[] = input.prefer === "screen" ? ["screen", "composite"] : ["composite", "screen"];
  for (const kind of order) {
    const pick = live.filter((r) => r.kind === kind).sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))[0];
    if (pick) return { recording: pick, offsetMs: null, source: pick.live_frame_url!, live: true };
  }
  return null;
}

/** Scene-change moments of every screen file across [fromMs, toMs] of the
 *  call, in call time, with each stretch's first picture always a
 *  candidate. Empty when no finished screen file overlaps the range. */
async function screenSceneCandidates(input: PlanInput, all: SnapRecording[], fromMs: number, toMs: number): Promise<SceneCandidate[]> {
  const { recs } = input;
  const out: SceneCandidate[] = [];
  for (const r of all) {
    if (r.kind !== "screen" || r.status !== "ready" || !r.url) continue;
    const w = recordingWindow(r, recs.server_now);
    if (!w) continue;
    const a = Math.max(w.start, recs.call_started_at + fromMs);
    const b = Math.min(w.end, recs.call_started_at + toMs);
    if (b <= a) continue;
    const startInFile = a - w.start;
    out.push({ atMs: a - recs.call_started_at, score: Infinity });
    const res = await input.ffmpeg(sceneArgs(r.url, startInFile, Math.max(1000, b - a)), { timeoutMs: SCENE_TIMEOUT_MS });
    if (res.code !== 0) throw new SnapError("ffmpeg_failed", ffmpegFailure(res.stderr, res.code === null));
    for (const c of parseSceneScores(res.stderr + res.stdout)) {
      const at = w.start + c.atMs - recs.call_started_at;
      if (at > fromMs && at < toMs) out.push({ atMs: at, score: c.score });
    }
  }
  return out;
}

/** Which frames to grab, and from where. Throws a SnapError that says what
 *  to do when there is no picture to give. */
export async function planSnap(input: PlanInput): Promise<SnapPlan> {
  const { call, recs, moment, handle } = input;
  const all = rows(recs);
  const notes: string[] = [];
  const segments = call.segments ?? [];

  if (moment.kind === "now") {
    if (recs.call_ended_at != null) {
      const spans = recordedSpans(all, recs.call_started_at, recs.server_now);
      throw new SnapError(
        "not_live",
        `${handle} has ended, so there is no "now" to show. Name a moment: cast call snap ${handle}@1:30, or a transcript line: cast call snap ${handle}:15.` +
          (spans.length ? ` Recorded: ${describeSpans(spans)}.` : ""),
      );
    }
    const live = liveFrame(input, all);
    if (!live) {
      const starting = all.some((r) => r.status === "starting" || (r.status === "recording" && !r.live_frame_url));
      throw new SnapError(
        "not_live",
        starting
          ? `${handle}'s recording is starting. Try again in a few seconds.`
          : `${handle} is not being recorded right now. A call has video only while someone in the huddle has pressed Record.`,
      );
    }
    return { frames: [{ ...live, atMs: recs.server_now - recs.call_started_at }], notes };
  }

  if (all.length === 0 || all.every((r) => r.status === "failed")) {
    const lineHint = moment.kind === "line" ? ` ${moment.from}${moment.to !== moment.from ? `:${moment.to}` : ""}` : "";
    throw nothingRecorded(handle, recs, all, lineHint);
  }

  if (moment.kind === "time") return { frames: [frameAt(input, all, moment.atMs, notes)], notes };

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
  if (moment.from === moment.to) return { frames: [frameAt(input, all, lineFrameMs(lines[0]), notes)], notes };

  // A range. On a screen share, the moments the screen changed; in the room,
  // evenly spaced moments. Each moment still goes through locateCallMoment,
  // so a range frame and a single snap of the same moment are one picture.
  const fromMs = lineFrameMs(lines[0]);
  const toMs = Math.max(fromMs, ...lines.map((l) => Math.max(l.t0, l.t1)));
  let moments: number[] = [];
  let rangeLabel: string;
  if (input.prefer === "screen") {
    moments = pickSceneMoments(await screenSceneCandidates(input, all, fromMs, toMs), { max: input.max });
  }
  if (moments.length > 0) {
    rangeLabel = "where the shared screen changed";
  } else {
    if (input.strictScreen) notes.push(`No screen share was recorded across these lines, so these are frames of the room.`);
    moments = sampleCallMoments(fromMs, toMs, input.max, ROOM_FRAME_GAP_MS);
    rangeLabel = "evenly spaced";
  }
  // Every frame sits on a whole second, rounded up (a scene change is on
  // screen from its keyframe on), so the `cl-42@m:ss` printed beside a frame
  // names that exact frame, the same promise lineFrameMs keeps for a line.
  moments = [...new Set(moments.map((m) => (Math.ceil(m / 1000) * 1000 <= toMs ? Math.ceil(m / 1000) * 1000 : Math.floor(m / 1000) * 1000)))];
  const frames: PlannedFrame[] = [];
  const missed: number[] = [];
  let lastError: SnapError | null = null;
  for (const at of moments) {
    try {
      frames.push(frameAt({ ...input, strictScreen: false }, all, at, []));
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
  const unique = frames.filter((f, i) => !f.live || frames.findIndex((g) => g.live && g.source === f.source) === i);
  return { frames: unique, notes, rangeLabel };
}

// ── The command ──────────────────────────────────────────────────────────

export type SnapDeps = {
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  resolveCallId: (ref: string) => Promise<string>;
  baseUrl: string;
  /** Uploads a written frame (`cast image`'s pipeline). */
  upload?: (file: string, alt: string) => Promise<{ url: string; markdown: string }>;
  /** Tests hand in a fake; otherwise the machine's ffmpeg is found. */
  ffmpeg?: FfmpegRunner;
  /** Tests hand in a directory; otherwise the scratch directory. */
  scratch?: (name: string) => string;
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
  range: string | null;
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
 *  nothing and exits 0; one retry a second earlier covers it. */
async function grab(ffmpeg: FfmpegRunner, frame: PlannedFrame, out: string): Promise<void> {
  const attempts = frame.offsetMs === null ? [null] : [frame.offsetMs, Math.max(0, frame.offsetMs - 1000)];
  let last: FfmpegResult | null = null;
  for (const offset of attempts) {
    try {
      fs.rmSync(out, { force: true });
    } catch {
      // A file we cannot remove is one ffmpeg -y will report on.
    }
    last = await ffmpeg(frameArgs(frame.source, offset, out), { timeoutMs: GRAB_TIMEOUT_MS });
    if (last.code !== 0) break;
    if (fs.existsSync(out) && fs.statSync(out).size > 0) return;
  }
  if (last && last.code !== 0) throw new SnapError("ffmpeg_failed", ffmpegFailure(last.stderr, last.code === null));
  throw new SnapError("ffmpeg_failed", `ffmpeg found no frame at ${formatCallTime(frame.atMs)} in the recording.`);
}

/** Everything `cast call snap <target>` does short of printing. */
export async function snapCall(targetRaw: string | undefined, options: SnapOptions, deps: SnapDeps): Promise<SnapResult> {
  if (!targetRaw) throw new SnapError("bad_target", `Name the moment to snap: ${SNAP_FORMS}.`);
  const target = parseSnapTarget(targetRaw);
  if (!target) throw new SnapError("bad_target", `"${targetRaw}" is not a moment of a call. Use ${SNAP_FORMS}.`);
  if (options.screen && options.composite) throw new SnapError("bad_option", "Pick one of --screen and --composite.");
  const max = parseMax(options.max);

  let ffmpeg = deps.ffmpeg;
  if (!ffmpeg) {
    const bin = findFfmpeg();
    if (!bin) {
      throw new SnapError("ffmpeg_missing", `cast call snap reads the recording with ffmpeg, which is not installed. ${installHintFor("ffmpeg", { winget: "Gyan.FFmpeg" })}`);
    }
    ffmpeg = ffmpegRunner(bin);
  }

  const callArg = isServerCallRef(target.call) ? target.call : await deps.resolveCallId(target.call);
  const [call, recs] = (await Promise.all([
    deps.post("/cli/calls/get", { transcript_id: callArg }),
    deps.post("/cli/calls/recordings", { call: callArg }),
  ])) as [SnapCall | null, SnapRecordings | null];
  if (!call || !recs) {
    throw new SnapError("not_found", `No call ${target.call} that you can read. \`cast calls\` lists the calls you can.`);
  }
  const handle = recs.short_id ?? call.short_id ?? recs.transcript_id;

  const plan = await planSnap({
    call,
    recs,
    moment: target.moment,
    prefer: options.composite ? "composite" : "screen",
    strictScreen: !!options.screen,
    max,
    ffmpeg,
    handle,
  });

  const names = plan.frames.map((f) => ({ name: frameFileName(handle, f.atMs, f.recording.kind, f.live), atMs: f.atMs }));
  const paths = outputPaths(names, options.out, deps.scratch);
  const frames: SnapFrameResult[] = [];
  for (const [i, f] of plan.frames.entries()) {
    const out = paths[i];
    await grab(ffmpeg, f, out);
    if (!options.out) secureTempFile(out);
    const said = lineAt(call.segments, f.atMs);
    const ref = callRefId(handle, null, f.atMs);
    const shows = frameSubject(f.recording);
    const result: SnapFrameResult = {
      path: out,
      ref,
      at: formatCallTime(f.atMs),
      at_ms: f.atMs,
      kind: f.recording.kind,
      shows,
      live: f.live,
      recording_id: f.recording.id,
      offset_ms: f.offsetMs,
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
      const title = call.title ? ` (${call.title})` : "";
      result.image = await deps.upload(out, `${ref}, ${shows}${f.live ? ", live" : ""}${title}`);
    }
    frames.push(result);
  }
  return {
    call: { id: recs.transcript_id, short_id: recs.short_id ?? call.short_id ?? null, title: call.title ?? null },
    target: target.moment.kind === "line" ? callRefId(handle, { from_seq: target.moment.from, to_seq: target.moment.to }) : frames[0]?.ref ?? handle,
    range: plan.rangeLabel ?? null,
    frames,
    notes: plan.notes,
  };
}

// ── Printing ─────────────────────────────────────────────────────────────

function quote(text: string, max = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

/** The human output: each frame's path, what it shows, what was being said,
 *  and how to cite it. */
export function formatSnapResult(res: SnapResult): string {
  const out: string[] = [];
  const many = res.frames.length > 1;
  if (many) {
    const first = res.frames[0];
    const last = res.frames[res.frames.length - 1];
    // One person's screen across the whole range is named; several, or the
    // room, keep the plan's own words.
    const subjects = [...new Set(res.frames.map((f) => f.shows))];
    const how = res.range === "where the shared screen changed" && subjects.length === 1 ? `where ${subjects[0]} changed` : res.range ?? "";
    out.push(
      `${fmt.highlight(res.target)} ${fmt.muted(`${res.frames.length} frames ${how}, ${first.at} to ${last.at}${res.call.title ? ` · ${res.call.title}` : ""}`)}`,
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
        `Cite a frame as ${sample.ref}: on its own line in a message it renders as that frame of the call, linked to ${sample.call_url}`,
      ),
    );
    if (!res.frames.some((f) => f.image)) out.push(fmt.muted(`Add --share to upload the frames and get markdown that renders anywhere.`));
  }
  return out.join("\n");
}

/** `cast call snap`: run, print, and exit non-zero with a plain reason on
 *  any refusal (as JSON with --json, so a script reads the code). */
export async function runCallSnap(target: string | undefined, options: SnapOptions, deps: SnapDeps): Promise<void> {
  try {
    const res = await snapCall(target, options, deps);
    console.log(options.json ? JSON.stringify(res, null, 2) : formatSnapResult(res));
  } catch (err) {
    if (!(err instanceof SnapError)) throw err;
    if (options.json) console.log(JSON.stringify({ error: err.message, code: err.code }, null, 2));
    else console.error(`${fmt.error("Error:")} ${err.message}`);
    process.exit(1);
  }
}
