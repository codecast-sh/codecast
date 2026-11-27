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
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import {
  CALL_FRAME_PREFER,
  callFrameHref,
  coveredSpans,
  describeClockSpan,
  describeClockSpans,
  describeSpan,
  describeSpans,
  lineFilmed,
  lineFrameMs,
  isRecordingFilming,
  locateCallMoment,
  nearestRecordedMs,
  parseCallViewParam,
  playableFiles,
  recordingSubject,
  recordingWindow,
  sampleCallMoments,
  CALL_JUST_SAID_MS,
  FRAME_SHARE_REFUSED_WORDS,
  lineSaidAt,
  wholeSecond,
  spanStartSecond,
  type CallCoveredSpan,
  type CallMomentPrefer,
  type CallRecordingKind,
  type CallRecordingSpan,
  type CallView,
} from "@codecast/shared/contracts";
import { callRefId, formatCallTime, parseCallRef, parseCallTime, parseEntityUrl } from "@codecast/shared/entities";
import { spawn, whichBin, TOOL_PATH, installCommandFor, installHintFor } from "./proc.js";
import { agentTempPath, secureTempFile } from "./tempFiles.js";
import { rememberCallFrames } from "./callFrameRefs.js";
import { fmt, icons } from "./colors.js";
import { mapLimit } from "@codecast/shared/async";

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
 *  that makes a change a cut: a new slide, window or page. Cuts take a
 *  range's frames first, spread through it (pickSceneMoments). Every other change the scene pass
 *  reports (SCENE_CHANGED) is real too, only gradual, and the frames left
 *  go to those, spread through time. Measured 2026-10-04 on 1920x1080
 *  editor recordings through sceneArgs' chain: a new slide of code scores
 *  about 0.045, a line typed or a scroll step under 0.002. It assumes a
 *  keyframe about every second, which the screen egress asks for. */
export const SCENE_THRESHOLD = 0.04;
/** What counts as the screen having changed, as ffmpeg's mpdecimate on the
 *  480 px copy a scene pass reads: some 8x8 block differs from the last
 *  picture KEPT by more than `hi`, or more than `frac` of the blocks by more
 *  than `lo`. Against the last picture kept, not the previous frame, so a
 *  screen changing a little at a time (code typed a line a second, a slow
 *  scroll) adds up to a change, where a consecutive-frame score never rises
 *  off the floor. `hi` at 64*16 keeps every line typed or scrolled and
 *  drops a blinking text cursor (measured 2026-10-04: a cursor blinking on
 *  an idle editor passed at 64*12, not at 64*16; one line typed a second
 *  passed at every value up to 64*32). Encoder noise on a still screen
 *  never passes. */
export const SCENE_CHANGED = "mpdecimate=hi=64*16:lo=64*3:frac=0.05";
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
/** Frames read from the recording at once. Each is an ffmpeg process with
 *  its own range requests; a few overlap their network waits without
 *  piling decoders onto a busy machine. */
export const GRAB_CONCURRENCY = 3;
const SCENE_TIMEOUT_MS = 5 * 60_000;
/** ffmpeg's own network timeout, in microseconds: a stalled read fails the
 *  run rather than hanging it until our timeout. */
const RW_TIMEOUT_US = "30000000";
/** How ffmpeg reads over HTTP: a stalled read fails rather than hangs, and a
 *  connection that drops mid-body (the loopback proxy cuts its response when
 *  the read from storage breaks) is resumed by range. Without the second,
 *  ffmpeg takes a cut body for the end of the file, exits 0 and writes
 *  nothing, which read as "no frame there" about once in 70 grabs on a busy
 *  machine. `-reconnect` alone, because ffmpeg before 4.4 does not know
 *  `-reconnect_on_network_error` and would refuse every run. Both are HTTP
 *  options, and ffmpeg refuses them on a local file. */
function netArgs(source: string): string[] {
  return /^https?:/i.test(source) ? ["-rw_timeout", RW_TIMEOUT_US, "-reconnect", "1", "-reconnect_delay_max", "5"] : [];
}
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
  /** False when the server kept the live frames back: only someone in the
   *  room (or a session the call feeds live) may see it as it is now. Absent
   *  from an older server, which handed them to every reader. */
  live_watch?: boolean;
};

// ── The reference ────────────────────────────────────────────────────────

export type SnapMoment =
  | { kind: "line"; from: number; to: number }
  | { kind: "time"; atMs: number }
  | { kind: "now" };

export type SnapTarget = {
  call: string;
  moment: SnapMoment;
  /** The view a pasted call page link was on (`view=screen:<identity>`):
   *  the screen the person was watching when they copied it. */
  view?: CallView;
  /** `cl-42:12:34` reads as lines 12 to 34 (the way `cast call cl-42 12:34`
   *  prints them), but it is also how a person mistypes the time 12:34. Set
   *  when the pair is a valid time, so the answer can say which was meant. */
  alsoTime?: number;
};

export const SNAP_FORMS =
  "cl-42:15 (a transcript line), cl-42:15-25 (frames across lines), cl-42@12:34 (a time into the call), or cl-42 alone (right now, while it records)";

/**
 * A time into a call as snap takes it, in ms. The prose grammar (`12:34`,
 * `754s`, `1:02:03`, parseCallTime) stays strict, because a message is
 * scanned for it. A command can afford to read more, and an agent arrives
 * with two other spellings this CLI itself prints: bare seconds (a call page
 * link ends `?t=754`, JSON carries `at_ms`) and the unit form of a frame's
 * file name (`12m34s`, `1h02m03s`). Any of them may end in a fraction of a
 * second (`2:30.5`, `150.5s`, `2m30.5s`, to the millisecond): a range's
 * frames and `shown_at_ms` are not always on a whole second, and an agent
 * stepping between two frames a second apart asks for the middle.
 */
export function parseSnapTime(text: string | null | undefined): number | null {
  const s = (text ?? "").trim();
  const frac = /^(.*\d)\.(\d{1,3})(s?)$/i.exec(s);
  if (frac) {
    const whole = parseSnapTime(`${frac[1]}${frac[3]}`);
    return whole === null ? null : whole + Math.round(Number(`0.${frac[2]}`) * 1000);
  }
  const prose = parseCallTime(s);
  if (prose !== null) return prose;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const u = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i.exec(s);
  if (!u || (u[1] === undefined && u[2] === undefined)) return null;
  const [h, m, sec] = [u[1], u[2], u[3]].map((x) => Number(x ?? 0));
  // Under a larger unit, minutes and seconds are clock digits.
  if ((u[1] !== undefined && m > 59) || sec > 59) return null;
  return (h * 3600 + m * 60 + sec) * 1000;
}

/** The `t` a pasted link carries, in its query or after the hash, as
 *  written; null when it carries none or is no URL. */
function linkTime(url: string): string | null {
  try {
    const u = new URL(url);
    return u.searchParams.get("t") ?? new URLSearchParams(u.hash.replace(/^#/, "")).get("t");
  } catch {
    return null;
  }
}

/**
 * The moment a second argument names, joined onto the call the way prose
 * writes it, so `cast call snap cl-42 15` is `cl-42:15`. Lines take the rule
 * `cast call cl-42 15:25` prints by (`15`, `15-25`, `15:25` are lines); a
 * time is anything else parseSnapTime reads (`@12:34`, `754s`, `1:02:03`,
 * `12m34s`), and `now` is now.
 */
function joinMoment(ref: string, extra: string): string | null {
  const e = extra.trim();
  if (ref.endsWith("@")) return ref + e;
  if (/[@:]/.test(ref)) return null;
  if (e.startsWith("@")) return ref + e;
  if (/^now$/i.test(e)) return `${ref}@now`;
  if (/^\d+(?:[-:]\d+)?$/.test(e)) return `${ref}:${e}`;
  if (parseSnapTime(e) !== null) return `${ref}@${e}`;
  return `${ref}:${e}`;
}

/**
 * What a snap names. The call is a short id, a full id or a unique prefix of
 * one; the moment rides it the way prose writes it (`cl-42:15`, `cl-42@12:34`,
 * the shared call-reference grammar) or comes as a second argument, and a
 * bare call means now. A call page URL works too (`…/calls/<id>?t=754`),
 * since that is what a person pastes. Null for anything else, including a
 * second moment on a reference that already names one, and a link whose `t`
 * is no time: read as "now" it would hand back the live picture in place of
 * the moment linked.
 */
export function parseSnapTarget(raw: string | null | undefined, extra?: string | null): SnapTarget | null {
  const target = readSnapTarget(raw, extra);
  // A pasted link keeps the screen it was copied on, so the snap shows the
  // picture the person pointed at.
  const link = (raw ?? "").trim();
  if (!target || !/^https?:\/\//i.test(link)) return target;
  try {
    const view = parseCallViewParam(new URL(link).searchParams);
    return view ? { ...target, view } : target;
  } catch {
    return target;
  }
}

function readSnapTarget(raw: string | null | undefined, extra?: string | null): SnapTarget | null {
  let s = (raw ?? "").trim();
  if (/^https?:\/\//i.test(s)) {
    const link = parseEntityUrl(s);
    if (!link || link.type !== "call") return null;
    s = link.id;
    // The shared link grammar reads `t` as plain seconds. A hand-edited one
    // (`?t=12:34`, `#t=754`) is read here, or refused.
    const t = linkTime(raw!.trim());
    if (t !== null && !/[@:]/.test(s)) {
      if (parseSnapTime(t) === null) return null;
      s = `${s}@${t}`;
    }
  }
  if (extra != null && extra.trim()) {
    const joined = joinMoment(s, extra);
    if (!joined) return null;
    s = joined;
  }
  const now = /^(.+)@now$/i.exec(s);
  if (now) s = now[1];
  // A time in any spelling snap reads, handed on in the one the shared
  // grammar does (whole seconds), its exact ms kept beside it.
  const at = /^([^@]+)@(.+)$/.exec(s);
  let exactMs: number | null = null;
  if (at) {
    exactMs = parseSnapTime(at[2]);
    if (exactMs === null) return null;
    s = `${at[1]}@${Math.floor(exactMs / 1000)}s`;
  }
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
    if (ref.at_ms != null) return { call, moment: { kind: "time", atMs: exactMs ?? ref.at_ms } };
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

/** The part of a second past the whole one, as written after a clock's
 *  seconds (`.5`, `.25`), or "" on a whole second. */
function fraction(ms: number): string {
  const f = Math.round(ms) % 1000;
  return f ? `.${String(f).padStart(3, "0").replace(/0+$/, "")}` : "";
}

/** A call time to the millisecond when it is not on a whole second
 *  (`2:30.5`), for a moment asked for between two seconds. A citation
 *  (`cl-42@2:30`) still names whole seconds; this is what was asked. */
export function preciseCallTime(ms: number): string {
  return `${formatCallTime(ms)}${fraction(ms)}`;
}

/** The moment as a snap command takes it: the citation, with the part of a
 *  second kept when there is one (`cl-42@2:30.5`). */
export function snapMomentRef(handle: string, ms: number): string {
  return `${callRefId(handle, null, ms)}${fraction(ms)}`;
}

/** A call time as a file name wants it: `0m07s`, `12m34s`, `1h02m03s`, and
 *  `2m30.5s` between two seconds. */
export function clockForName(ms: number): string {
  const parts = formatCallTime(ms).split(":");
  const sec = parts.pop()!;
  const m = parts.pop()!;
  const h = parts.pop();
  return `${h ? `${h}h${m}` : m}m${sec}${fraction(ms)}s`;
}

/** The file a frame is written to when no path is given: the call, the
 *  moment and what the picture is, `cl-42_12m34s_screen.png`, so a directory
 *  of frames reads in order and says what each one is. Part of a frame
 *  (--crop) names its part, `cl-42_12m34s_screen_top-left.png`: the whole
 *  frame an agent already holds is never written over by a piece of it,
 *  and two crops of one moment are two files. */
export function frameFileName(handle: string, atMs: number, kind: CallRecordingKind, live = false, crop: CropRegion | null = null): string {
  return `${handle}_${clockForName(atMs)}_${kind}${live ? "_live" : ""}${crop ? `_${cropTag(crop)}` : ""}.png`;
}

// ── What was recorded ────────────────────────────────────────────────────

// describeSpans, nearestRecordedMs and the line rule (lineFrameMs,
// lineFilmed) live in the shared contract (the call page says the same
// spans, offers the same nearest moment and marks the same lines filmed);
// re-exported for this module's callers.
export { describeSpans, nearestRecordedMs, lineFrameMs, lineFilmed };

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

/** The parts of [fromMs, toMs] some span covers, in order: what
 *  uncoveredParts leaves out. */
export function coveredParts(spans: ReadonlyArray<{ fromMs: number; toMs: number }>, fromMs: number, toMs: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = fromMs;
  for (const [a, b] of uncoveredParts(spans, fromMs, toMs)) {
    if (a > at) out.push([at, a]);
    at = b;
  }
  if (at < toMs) out.push([at, toMs]);
  return out;
}

/** A stretch long enough to hold a frame or be worth naming: a sliver under
 *  a second between two files is neither. */
const atLeastASecond = ([a, b]: readonly [number, number]) => b - a >= 1000;

/** What a call has on video, in call time, for `cast call <id>` (which
 *  prints it with describeSpans). Empty when it has none. */
export function callVideoSpans(recs: Pick<SnapRecordings, "recordings" | "call_started_at" | "server_now">): CallCoveredSpan[] {
  return coveredSpans(rows(recs), recs.call_started_at, recs.server_now);
}

/** The first line a finished span filmed (lineFilmed), or null: the line a
 *  hint names as the way to a frame, so the command it offers is one that
 *  answers with a picture. A line said before Record was pressed is
 *  skipped even when the first recorded second falls in its pause. */
export function firstFilmedLine<T extends { seq: number; t0: number; t1: number }>(spans: readonly CallCoveredSpan[], segments: readonly T[]): T | null {
  return nearestFilmedLine(spans, segments, 0);
}

/** The filmed line (lineFilmed) whose frame is nearest `atMs`, or null:
 *  what a refusal at a moment nothing filmed offers beside the nearest
 *  recorded second, since an agent reading a transcript steps by line. */
export function nearestFilmedLine<T extends { seq: number; t0: number; t1: number }>(spans: readonly CallCoveredSpan[], segments: readonly T[], atMs: number): T | null {
  const done = spans.filter((s) => !s.pending);
  let best: T | null = null;
  for (const seg of segments) {
    if (!lineFilmed(done, seg)) continue;
    if (!best || Math.abs(lineFrameMs(seg) - atMs) < Math.abs(lineFrameMs(best) - atMs)) best = seg;
  }
  return best;
}

/** The first and last transcript line filmed inside each span, by the same
 *  rule (lineFilmed), or null for a span no line falls in (a silent
 *  stretch). What lets `cast call <id>` say "video: lines 6-41" rather than
 *  leave the reader to hold call times against the transcript. */
export function spanLines(spans: readonly CallCoveredSpan[], segments: readonly SnapSegment[]): Array<{ from: number; to: number } | null> {
  return spans.map((sp) => {
    const inside = segments.filter((seg) => lineFilmed([sp], seg)).map((seg) => seg.seq);
    return inside.length ? { from: Math.min(...inside), to: Math.max(...inside) } : null;
  });
}

/** describeSpans with the lines each span holds leading it: `lines 6-41
 *  (2:12-6:15) Ana's screen`. A span with no line in it reads as before. */
export function describeSpansByLine(spans: readonly CallCoveredSpan[], segments: readonly SnapSegment[]): string {
  const lines = spanLines(spans, segments);
  return spans
    .map((s, i) => {
      const l = lines[i];
      return l ? describeSpan(s, `${l.from === l.to ? `line ${l.from}` : `lines ${l.from}-${l.to}`} (${describeClockSpan(s)})`) : describeSpan(s);
    })
    .join(", ");
}

/** The call time a group of lines points at, in seq order: from the first
 *  line's frame (lineFrameMs, never before its first word) to the later of
 *  the last word said and the last line's own frame, which a short line
 *  takes up to a second after its words end. The one rule for a stretch of
 *  lines, so a range snap holds the frame each of its lines would give alone,
 *  and every view that asks about these lines (snapHint, noPictureNote, the
 *  range a snap samples) measures the same stretch. */
export function linesSpan(lines: readonly SnapSegment[]): { fromMs: number; toMs: number } {
  const fromMs = lineFrameMs(lines[0]);
  return { fromMs, toMs: Math.max(fromMs, lineFrameMs(lines[lines.length - 1]), ...lines.map((l) => Math.max(l.t0, l.t1))) };
}

/** Each span's range snap (`cast call snap cl-42:6-21`) over the lines it
 *  filmed (spanLines), or null for a span no line falls in. Built with
 *  snapHint, so it is never a command that would be refused. A snap prefers
 *  a shared screen, so a room span with a share over the same stretch says
 *  --composite: the entry for the room answers with the room. */
export function spanSnaps(handle: string, spans: readonly CallCoveredSpan[], segments: readonly SnapSegment[]): Array<string | null> {
  return spanLines(spans, segments).map((l, i) => {
    if (!l) return null;
    const span = spans[i];
    const lines = segments.filter((seg) => seg.seq >= l.from && seg.seq <= l.to).sort((a, b) => a.seq - b.seq);
    const hint = snapHint(handle, spans, { from: l.from, to: l.to, ...linesSpan(lines) });
    const shared = span.kind === "composite" && spans.some((s) => s.kind === "screen" && s.fromMs < span.toMs && span.fromMs < s.toMs);
    return hint && shared ? `${hint} --composite` : hint;
  });
}

/** The range snap `cast call <id>` offers: a shared screen's stretch before
 *  the room's, then the one holding the most lines. Null when no stretch
 *  filmed more than one line (one line is offered on its own). */
export function bestSpanSnap(handle: string, spans: readonly CallCoveredSpan[], segments: readonly SnapSegment[]): string | null {
  const lines = spanLines(spans, segments);
  const snaps = spanSnaps(handle, spans, segments);
  const size = (i: number) => lines[i]!.to - lines[i]!.from;
  const best = spans
    .map((_, i) => i)
    .filter((i) => snaps[i] && size(i) > 0)
    .sort((a, b) => Number(spans[b].kind === "screen") - Number(spans[a].kind === "screen") || size(b) - size(a))[0];
  return best === undefined ? null : snaps[best];
}

/**
 * The snap command for what a `cast call` view shows, or null when no
 * finished recording covers it: a moment (`atMs`), or lines (`seqs`, whose
 * own words span [fromMs, toMs]). Every view that offers a snap asks here,
 * so none offers one that would be refused.
 */
export function snapHint(
  handle: string,
  spans: readonly CallCoveredSpan[],
  want: { atMs: number } | { from: number; to: number; fromMs: number; toMs: number },
): string | null {
  const done = spans.filter((s) => !s.pending);
  if ("atMs" in want) {
    return done.some((s) => s.fromMs <= want.atMs && want.atMs < s.toMs) ? `cast call snap ${snapMomentRef(handle, want.atMs)}` : null;
  }
  if (!done.some((s) => s.fromMs < Math.max(want.toMs, want.fromMs + 1) && want.fromMs < s.toMs)) return null;
  return `cast call snap ${callRefId(handle, { from_seq: want.from, to_seq: want.to })}`;
}

const NO_PICTURE_WORDS = {
  moment: { saving: "That moment was recorded and is still saving", when: "at that moment" },
  line: { saving: "That line was recorded and is still saving", when: "while that line was said" },
  lines: { saving: "These lines were recorded and are still saving", when: "during these lines" },
} as const;

/**
 * What a `cast call` view says when snapHint offered nothing for the stretch
 * it shows ([fromMs, toMs]; a moment is fromMs === toMs): that it was filmed
 * and is still saving, that it was not filmed and which recorded moment is
 * nearest, or that the call has no video at all. Null when there is nothing
 * worth saying (the call's video is unknown). The moment view and the line
 * view both print this, so a reader of either can tell "this stretch was not
 * filmed" from "this call has no video".
 *
 * `stretch` says what the view shows (a moment, one line, several lines);
 * `ref` is what to snap once a saving file lands. `note` is the sentence and
 * `command` the snap to run after it, kept apart so a terminal can dim one
 * and not the other. `nearest` is the nearest moment's citation, for JSON.
 */
export function noPictureNote(
  handle: string,
  spans: readonly CallCoveredSpan[],
  knowsVideo: boolean,
  want: { fromMs: number; toMs: number; stretch: "moment" | "line" | "lines"; ref: string },
): { note: string; command: string | null; nearest: string | null } | null {
  const toMs = Math.max(want.toMs, want.fromMs + 1);
  const words = NO_PICTURE_WORDS[want.stretch];
  if (spans.some((s) => s.pending && s.fromMs < toMs && want.fromMs < s.toMs)) {
    return {
      note: `${words.saving}. Once Record is stopped and the file lands: `,
      command: `cast call snap ${want.ref}`,
      nearest: null,
    };
  }
  const near = [nearestRecordedMs(spans, want.fromMs), nearestRecordedMs(spans, want.toMs)]
    .filter((ms): ms is number => ms !== null)
    .sort((a, b) => Math.min(Math.abs(a - want.fromMs), Math.abs(a - want.toMs)) - Math.min(Math.abs(b - want.fromMs), Math.abs(b - want.toMs)))[0];
  if (near !== undefined) {
    const nearest = snapMomentRef(handle, near);
    return { note: `Not recorded ${words.when}. Nearest recorded: `, command: `cast call snap ${nearest}`, nearest };
  }
  if (knowsVideo && spans.length === 0) return { note: "This call has no video.", command: null, nearest: null };
  return null;
}

// ── What was said ────────────────────────────────────────────────────────

/** The line being spoken at `atMs`, or the last one said shortly before it,
 *  so a frame arrives with its context: the shared lineSaidAt, the rule the
 *  call page highlights a line by. Null in a long silence. */
export function lineAt(segments: readonly SnapSegment[] | undefined, atMs: number): { seg: SnapSegment; during: boolean } | null {
  const lines = segments ?? [];
  const hit = lineSaidAt(lines, atMs);
  return hit ? { seg: lines[hit.index], during: hit.during } : null;
}

/** The lines either side of a silent moment (one search over lines in t0
 *  order): what a frame lineAt has no line for is placed between. */
export function linesAround(segments: readonly SnapSegment[] | undefined, atMs: number): { before: SnapSegment | null; after: SnapSegment | null } {
  const lines = segments ?? [];
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].t0 <= atMs) lo = mid + 1;
    else hi = mid;
  }
  return { before: lines[lo - 1] ?? null, after: lines[lo] ?? null };
}

// ── Scene changes ────────────────────────────────────────────────────────

export type SceneCandidate = { atMs: number; score: number };

/**
 * The scene scores ffmpeg's `metadata=print` filter logs, one pair of lines
 * per frame that passed SCENE_CHANGED: `frame:3 pts:… pts_time:12.4` then
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
 * The frames of a screen share worth showing, never closer than `minGapMs`,
 * at most `max`, in time order. Every candidate is a moment the screen
 * changed (sceneArgs reports nothing else). Three tiers, each spent before
 * the next: a candidate with an infinite score (the first picture of a
 * stretch), then the cuts, then the gradual changes. Within a tier the
 * frames go where they cover the most time: each pick is the candidate
 * farthest from every frame already taken, the bigger change on a tie. A
 * walkthrough with more slides than `max` is then shown across its whole
 * length, rather than as its biggest cuts bunched together with minutes of
 * slides between them unseen, and code typed or scrolled through a range is
 * followed across it instead of shown once at its start. A screen that never
 * changed yields the one frame that shows it, and no budget is spent on
 * copies of it.
 */
export function pickSceneMoments(
  cands: readonly SceneCandidate[],
  opts: { max: number; minGapMs?: number; threshold?: number },
): number[] {
  const gap = opts.minGapMs ?? SCREEN_FRAME_GAP_MS;
  const threshold = opts.threshold ?? SCENE_THRESHOLD;
  const picked: number[] = [];
  const distance = (at: number) => picked.reduce((d, p) => Math.min(d, Math.abs(p - at)), Infinity);
  const fill = (tier: readonly SceneCandidate[]) => {
    while (picked.length < opts.max) {
      let best: SceneCandidate | null = null;
      let bestDistance = gap;
      for (const c of tier) {
        const d = distance(c.atMs);
        if (d < gap) continue;
        if (!best || d > bestDistance || (d === bestDistance && (c.score > best.score || (c.score === best.score && c.atMs < best.atMs)))) {
          best = c;
          bestDistance = d;
        }
      }
      if (!best) return;
      picked.push(best.atMs);
    }
  };
  fill(cands.filter((c) => c.score === Infinity));
  fill(cands.filter((c) => c.score >= threshold && c.score !== Infinity));
  fill(cands.filter((c) => c.score < threshold));
  return picked.sort((a, b) => a - b);
}

// ── ffmpeg ───────────────────────────────────────────────────────────────

export type FfmpegResult = { code: number | null; stdout: string; stderr: string };
export type FfmpegRunner = (args: string[], opts: { timeoutMs: number }) => Promise<FfmpegResult>;

const secs = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);

/**
 * One frame: the first at or after `offsetMs` into `source` (null: the source
 * is itself one image, a live frame). `-ss` before `-i` is an input seek,
 * relative to the file's start: ffmpeg jumps to the keyframe before the
 * moment through a range request and decodes forward to it, so a grab an hour
 * into a file reads a couple of MB rather than the hour. grab() hands it the
 * exact time of the frame probeArgs found, so "at or after" lands on that
 * frame. showinfo logs the frame's time (-copyts -start_at_zero keep it on
 * the file's clock, measured from its start, as the seek is), so the caller
 * knows when the picture it wrote is from.
 *
 * `fromMs` is where the probe that found the frame started reading, and the
 * grab reads from there too, picking the frame with trim. An egress screen
 * file can decode a frame before the keyframe that precedes it on screen
 * (cl-107: the frame shown at 8.65 s is decoded ahead of the 5.93 s
 * keyframe), so a seek straight to the frame lands on that keyframe, never
 * decodes it, and writes the next picture, from the future.
 *
 * `dropBlank` is for the one grab no probe chose the frame of: nothing was
 * on screen before the moment, so the first picture after it is taken, and
 * LiveKit's black filler (DROP_BLANK_FRAMES) is not a picture.
 *
 * showinfo runs on a live frame too, for its size (`s:WxH`, shownSize): the
 * size a crop is measured against and the one printed beside the path.
 */
export function frameArgs(source: string, offsetMs: number | null, out: string, fromMs: number | null = offsetMs, dropBlank = false): string[] {
  const jpeg = /\.jpe?g$/i.test(out);
  const from = offsetMs === null ? null : Math.min(fromMs ?? offsetMs, offsetMs);
  const seek = from === null ? [] : ["-ss", secs(from)];
  const pick = [
    ...(offsetMs !== null && from !== null && from < offsetMs ? [`trim=start=${secs(offsetMs)}`] : []),
    ...(dropBlank ? [DROP_BLANK_FRAMES] : []),
    "showinfo",
  ].join(",");
  return [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    ...netArgs(source),
    ...seek,
    "-i", source,
    ...(offsetMs === null ? ["-vf", "showinfo"] : ["-copyts", "-start_at_zero", "-vf", pick]),
    "-frames:v", "1", "-an", "-update", "1",
    ...(jpeg ? ["-q:v", "2"] : []),
    "-y", out,
  ];
}

// ── Part of a frame ──────────────────────────────────────────────────────

/** Past this width a frame is shrunk before a model reads it (image input is
 *  read at about 1.15 megapixels, so a 1920x1080 frame arrives at roughly
 *  1430x805), and small text on a shared screen can blur out of reach. The
 *  printed hint offers a crop then. */
export const SMALL_TEXT_WIDTH = 1600;

/** The named parts of a frame, as fractions of it: x, y, width, height. */
const CROP_REGIONS: Record<string, [number, number, number, number]> = {
  top: [0, 0, 1, 0.5],
  bottom: [0, 0.5, 1, 0.5],
  left: [0, 0, 0.5, 1],
  right: [0.5, 0, 0.5, 1],
  "top-left": [0, 0, 0.5, 0.5],
  "top-right": [0.5, 0, 0.5, 0.5],
  "bottom-left": [0, 0.5, 0.5, 0.5],
  "bottom-right": [0.5, 0.5, 0.5, 0.5],
  center: [0.25, 0.25, 0.5, 0.5],
};
const CROP_ALIASES: Record<string, string> = { tl: "top-left", tr: "top-right", bl: "bottom-left", br: "bottom-right", centre: "center", middle: "center" };

/** One side of a box: pixels, or a percent of the frame's width or height. */
type CropValue = { n: number; pct: boolean };
/** A part of a frame as asked: a named region, or x,y,w,h. */
export type CropRegion = { name: string } | { box: [CropValue, CropValue, CropValue, CropValue] };
/** A part of a frame in its own pixels. */
export type CropRect = { x: number; y: number; w: number; h: number };

export const CROP_FORMS = `${Object.keys(CROP_REGIONS).join(", ")}, or x,y,w,h in pixels or percent (0,0,960,540 or 0,0,50%,50%)`;

/** --crop as given, or a refusal that lists what it takes. */
export function parseCrop(raw: string | null | undefined): CropRegion | null {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  const name = CROP_ALIASES[s] ?? s;
  if (CROP_REGIONS[name]) return { name };
  const parts = s.split(/\s*,\s*/);
  const values = parts.map((p) => /^(\d+(?:\.\d+)?)(%?)$/.exec(p)).map((m) => (m ? { n: Number(m[1]), pct: m[2] === "%" } : null));
  if (values.length !== 4 || values.some((v) => !v || (v.pct && v.n > 100))) {
    throw new SnapError("bad_option", `--crop takes ${CROP_FORMS} (got "${raw}")`);
  }
  const box = values as [CropValue, CropValue, CropValue, CropValue];
  if (box[2].n === 0 || box[3].n === 0) throw new SnapError("bad_option", `--crop needs a width and height above zero (got "${raw}")`);
  return { box };
}

/** A crop as a file name says it: the region's name (`top-left`), or the
 *  box as asked, `x0y0w960h540`, with a percent written `p` (`w50p`). */
export function cropTag(region: CropRegion): string {
  if ("name" in region) return region.name;
  const v = (c: CropValue) => `${c.n}${c.pct ? "p" : ""}`;
  const [x, y, w, h] = region.box;
  return `x${v(x)}y${v(y)}w${v(w)}h${v(h)}`;
}

/** --tiles as given (columns x rows, 1 to 4 each, more than one tile), or a
 *  refusal. */
export function parseTiles(raw: string | null | undefined): { cols: number; rows: number } | null {
  if (raw == null) return null;
  const m = /^\s*([1-4])\s*x\s*([1-4])\s*$/i.exec(String(raw));
  if (!m || (m[1] === "1" && m[2] === "1")) throw new SnapError("bad_option", `--tiles takes columns x rows, 1 to 4 each: 2x2 for quadrants, 2x1 for halves side by side, 1x2 stacked (got "${raw}")`);
  return { cols: Number(m[1]), rows: Number(m[2]) };
}

/** A region in the pixels of a `width` x `height` frame, cut back to the
 *  frame where it runs past an edge. Null when nothing of it is inside. */
export function cropRect(region: CropRegion, width: number, height: number): CropRect | null {
  const [fx, fy, fw, fh] =
    "name" in region
      ? CROP_REGIONS[region.name]
      : region.box.map((v, i) => (v.pct ? v.n / 100 : v.n / (i % 2 === 0 ? width : height)));
  const x = Math.round(fx * width);
  const y = Math.round(fy * height);
  const w = Math.min(width - x, Math.round(fw * width));
  const h = Math.min(height - y, Math.round(fh * height));
  return x < width && y < height && w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** How far each tile reaches past an inner edge, as a share of a tile's
 *  size: a line of code or a table row sitting on a seam is whole in one of
 *  the two tiles, rather than cut in half in both. */
export const TILE_OVERLAP = 0.06;

/** The tiles of a frame, each with the suffix its file takes: quadrants as
 *  tl/tr/bl/br, halves as l/r or t/b, finer grids by row and column. Every
 *  tile keeps the frame's own pixels, and overlaps its neighbours by
 *  TILE_OVERLAP. */
export function tileRects(cols: number, rows: number, width: number, height: number): Array<{ suffix: string; rect: CropRect }> {
  const out: Array<{ suffix: string; rect: CropRect }> = [];
  const ox = Math.round((TILE_OVERLAP * width) / cols);
  const oy = Math.round((TILE_OVERLAP * height) / rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = Math.max(0, Math.floor((width * c) / cols) - (c > 0 ? ox : 0));
      const y = Math.max(0, Math.floor((height * r) / rows) - (r > 0 ? oy : 0));
      const x1 = Math.min(width, Math.floor((width * (c + 1)) / cols) + (c < cols - 1 ? ox : 0));
      const y1 = Math.min(height, Math.floor((height * (r + 1)) / rows) + (r < rows - 1 ? oy : 0));
      const rect = { x, y, w: x1 - x, h: y1 - y };
      const suffix =
        cols === 2 && rows === 2 ? ["tl", "tr", "bl", "br"][r * 2 + c] : rows === 1 && cols === 2 ? ["l", "r"][c] : cols === 1 && rows === 2 ? ["t", "b"][r] : `r${r + 1}c${c + 1}`;
      out.push({ suffix, rect });
    }
  }
  return out;
}

/** What a model reads an image at without shrinking it: up to 1568 px on
 *  the long side and about 1.15 to 1.2 megapixels (1092x1092 square). */
const READ_LONG_SIDE = 1568;
const READ_PIXELS = 1092 * 1092;

/** The fewest tiles (columns x rows, up to 4x4) that each fit what a model
 *  reads without shrinking, so every tile is read at the frame's own
 *  pixels: 2x1 for 1080p, 2x2 for 1440p, 3x3 for 4K. Squarer tiles on a
 *  tie. Null for a frame that already fits, or one too big for 4x4. */
export function readableTiles(width: number, height: number): { cols: number; rows: number } | null {
  // How far from square a grid's most elongated tile is, or null when a
  // tile would be shrunk.
  const shape = (cols: number, rows: number): number | null => {
    let worst = 1;
    for (const { rect } of tileRects(cols, rows, width, height)) {
      if (Math.max(rect.w, rect.h) > READ_LONG_SIDE || rect.w * rect.h > READ_PIXELS) return null;
      worst = Math.max(worst, Math.max(rect.w, rect.h) / Math.max(1, Math.min(rect.w, rect.h)));
    }
    return worst;
  };
  if (shape(1, 1) !== null) return null;
  let best: { cols: number; rows: number; worst: number } | null = null;
  for (let cols = 1; cols <= 4; cols++) {
    for (let rows = 1; rows <= 4; rows++) {
      const worst = shape(cols, rows);
      if (worst === null) continue;
      const n = cols * rows;
      if (!best || n < best.cols * best.rows || (n === best.cols * best.rows && worst < best.worst)) best = { cols, rows, worst };
    }
  }
  return best && { cols: best.cols, rows: best.rows };
}

/** Cuts `rect` out of a frame already written (a local image, so no network
 *  and no seek): the crop and every tile are made this way, after the frame
 *  is read once and its size is known. */
export function cutArgs(source: string, rect: CropRect, out: string): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", source,
    "-vf", `crop=${rect.w}:${rect.h}:${rect.x}:${rect.y}`,
    "-frames:v", "1", "-update", "1",
    ...(/\.jpe?g$/i.test(out) ? ["-q:v", "2"] : []),
    "-y", out,
  ];
}

/** The --tiles grid to offer a frame wider than SMALL_TEXT_WIDTH that was
 *  neither cropped nor tiled, as its JSON field; null for any other. */
function suggestTiles(size: { width: number; height: number } | null, crop: CropRect | null, tiles: SnapTile[] | null): { suggested_tiles: string } | null {
  if (!size || crop || tiles || size.width <= SMALL_TEXT_WIDTH) return null;
  const grid = readableTiles(size.width, size.height);
  return grid ? { suggested_tiles: `${grid.cols}x${grid.rows}` } : null;
}

/** The size showinfo logged for the frame written, or null. */
export function shownSize(log: string): { width: number; height: number } | null {
  const m = /\bs:(\d+)x(\d+)\b/.exec(log);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** How far back from a moment grab() looks for the picture on screen at it,
 *  one step at a time. A room file has a frame every 33 ms, so the first step
 *  always finds one. A screen file has frames only when the screen changed,
 *  and a slide left up is seconds or minutes with none: each wider step reads
 *  further back, which costs little there, since an unchanging screen is few
 *  bytes. TAIL_READ_MS is the step that covers a file's quiet last stretch
 *  (measured 2026-10-02: a 25.5 s run held 14.7 s of picture). The last step
 *  is for a screen left alone for minutes: without it the picture that had
 *  been up all that time was passed over for the next one written, from the
 *  future. It reads as far as a scene pass may (SCENE_SCAN_MAX_MS) and gets
 *  a scene pass's time to do it. */
export const TAIL_READ_MS = 15_000;
export const LOOKBACK_STEPS_MS = [2_000, TAIL_READ_MS, 120_000, SCENE_SCAN_MAX_MS] as const;

/**
 * Drops the black frames LiveKit writes in place of a picture. A screen file
 * is a TrackComposite transcode, and when the SFU pauses the share (a
 * publisher short of CPU or bandwidth, a congested link) the egress keeps its
 * frame rate by encoding solid black, interleaved with whatever real frames
 * still arrive: cl-117's share (2026-10-03, publisher on a loaded machine)
 * was 602 black frames of 1492, a real one every second or two between them,
 * while the room file showed the share held on its last picture. A frame
 * with no pixel brighter than near black is that filler (a real screen,
 * however dark, has text or a cursor on it), so the picture on screen at a
 * moment is the last frame before it that is not. Run it on a shrunk copy:
 * the decode is the cost, not the stats.
 */
export const DROP_BLANK_FRAMES = "signalstats,metadata=mode=select:key=lavfi.signalstats.YMAX:value=40:function=greater";

/**
 * Which picture is on screen at `offsetMs`: every frame from `lookbackMs`
 * before it up to the moment is decoded (not encoded: -f null writes
 * nothing, so a dense room file costs a fraction of a second) and showinfo
 * logs its time. Two taps: one before LiveKit's black filler is dropped and
 * one after (probeTimes tells them apart). The last time the second logs is
 * the picture on screen at that moment, which is the frame written. The last
 * the first logs is the frame a `<video>` seeked there shows, which is what a
 * citation renders as; where the two differ the share was stalled, and the
 * citation cannot be promised to match. Times are on the file's clock from
 * its start (-copyts -start_at_zero), the clock frameArgs seeks on.
 */
export function probeArgs(source: string, offsetMs: number, lookbackMs: number): string[] {
  return [
    "-nostdin", "-hide_banner", "-loglevel", "info",
    ...netArgs(source),
    "-ss", secs(offsetMs - lookbackMs),
    "-i", source,
    "-an", "-copyts", "-start_at_zero",
    // trim's end is the first time dropped; a frame exactly at the moment
    // is the one on screen at it. LiveKit's black filler is never a picture.
    "-vf", [`trim=end=${secs(offsetMs + 1)}`, "scale=320:-2", "showinfo", DROP_BLANK_FRAMES, "showinfo"].join(","),
    "-f", "null", "-",
  ];
}

/** Every frame time (ms into the file, rounded down so a seek to it lands on
 *  that frame and not the next) showinfo logged, in order. */
export function shownTimes(log: string): number[] {
  const out: number[] = [];
  for (const m of log.matchAll(/pts_time:\s*(-?[\d.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) out.push(Math.max(0, Math.floor(t * 1000 + 1e-6)));
  }
  return out;
}

/** Which filter of probeArgs' chain is its first showinfo: the tap that sees
 *  every frame, filler included. ffmpeg names a filter in its log by its
 *  place in the chain (`Parsed_showinfo_2`). */
const PROBE_TAP_ALL = 2;

/**
 * A probe's log as two lists of frame times: `real`, the pictures (what the
 * second tap logged), and `all`, every frame written, filler included. A log
 * with no line from the first tap is read as having no filler.
 */
export function probeTimes(log: string): { real: number[]; all: number[] } {
  const first = new RegExp(`Parsed_showinfo_${PROBE_TAP_ALL}\\b`);
  const lines = log.split(/\r?\n|\r/);
  const all = shownTimes(lines.filter((l) => first.test(l)).join("\n"));
  const real = shownTimes(lines.filter((l) => !first.test(l)).join("\n"));
  return { real, all: all.length ? all : real };
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
    ...netArgs(source),
    "-skip_frame", "nokey",
    "-ss", secs(startMs), "-t", secs(durMs),
    "-i", source,
    "-an", "-copyts", "-start_at_zero",
    // Filler dropped before scoring, so a stall reads as no change rather
    // than two cuts (to black and back) that would each claim a frame.
    // select scores every keyframe against the one before it (how big a
    // cut it is), then SCENE_CHANGED keeps only the ones that differ from
    // the last picture kept, and only those are logged.
    "-vf", `scale=480:-2,${DROP_BLANK_FRAMES},select='gte(scene,0)',${SCENE_CHANGED},metadata=print:key=lavfi.scene_score`,
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
 *  video says so without first sending anyone to install ffmpeg. Every run
 *  goes through ffmpegDidNotRun, so a binary that is there but cannot start
 *  is refused the same way as one that is not there. */
function lazyFfmpeg(given?: FfmpegRunner, find: () => string | null = findFfmpeg): () => FfmpegRunner {
  let runner: FfmpegRunner | null = given ? checkedFfmpeg(given, "ffmpeg") : null;
  return () => {
    if (runner) return runner;
    const bin = find();
    if (!bin) {
      const install = installCommandFor("ffmpeg");
      throw new SnapError(
        "ffmpeg_missing",
        `A frame is read out of the recording with ffmpeg, which is not installed. ${installHintFor("ffmpeg", { winget: "Gyan.FFmpeg" })}`,
        install ? { try: [install] } : {},
      );
    }
    runner = checkedFfmpeg(ffmpegRunner(bin), bin);
    return runner;
  };
}

/** A runner that refuses, as ffmpeg_missing, a run whose binary never got
 *  going. Thrown rather than returned, so no caller takes it for a file it
 *  could not read: the scene scan does not fall back to even spacing, grab
 *  does not run it again, and a range stops at its first frame. */
function checkedFfmpeg(run: FfmpegRunner, bin: string): FfmpegRunner {
  return async (args, opts) => {
    const res = await run(args, opts);
    const why = ffmpegDidNotRun(res);
    if (why === null) return res;
    const reinstall = installCommandFor("ffmpeg", { reinstall: true });
    throw new SnapError(
      "ffmpeg_missing",
      `ffmpeg at ${bin} is installed but does not run (${why}). ${reinstall ? `Reinstall it: ${reinstall}` : "Reinstall it with your system package manager."}`,
      reinstall ? { try: [reinstall] } : {},
    );
  };
}

/** Why the ffmpeg binary itself failed to run, or null when it ran (whatever
 *  it then made of the recording). After a Homebrew upgrade ffmpeg can die in
 *  the loader on a library that moved ("dyld: Library not loaded", an abort
 *  with exit 134); a file that is not executable fails to spawn at all (the
 *  'error' event, code -1). Said as a recording problem, an agent would take
 *  either for a damaged recording and stop, when a reinstall fixes it. An
 *  abort counts only before ffmpeg logged anything of its own (its lines
 *  start with a bracketed prefix or name an input), so a decoder that crashes
 *  on a bad file is still the file's problem. */
export function ffmpegDidNotRun(res: FfmpegResult): string | null {
  if (res.code === 0 || res.code === null) return null;
  const lines = res.stderr.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const loader = lines.find((l) => /^dyld|Library not loaded|error while loading shared libraries|cannot execute|Exec format error/i.test(l));
  if (loader) return loader.replace(/^dyld\[\d+\]:\s*/, "");
  if (res.code === -1) return lines[lines.length - 1]?.replace(/^Error:\s*/, "") ?? "it could not be started";
  if (res.code === 134 && !lines.some((l) => /^\[|^Input #/.test(l))) return lines[lines.length - 1] ?? "it aborted before reading anything";
  return null;
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
        // null only for the timeout's kill. Any other signal is said the way a
        // shell says it (128 + its number: an abort is 134), so a crash is
        // never reported as a run that took too long.
        const killed = signal && signal !== "SIGKILL" ? 128 + (os.constants.signals[signal] ?? 0) : null;
        resolve({ code: signal === "SIGKILL" ? null : (code ?? killed), stdout, stderr });
      });
    });
}

/** ffmpeg's complaint about a URL, said as what happened. ffmpeg quotes the
 *  input it failed on; that is the loopback proxy's address, never a signed
 *  link, but what is printed lands in a session transcript others can read,
 *  so every URL is cut out before a line is shown all the same. */
export function ffmpegFailure(rawStderr: string, timedOut: boolean): string {
  if (timedOut) return "ffmpeg took too long reading the recording. Try again; a shorter line range reads less of the file.";
  // The status as ffmpeg words it, never a bare number: a run that logs
  // frames (showinfo) is full of numbers.
  if (/(?:HTTP error|Server returned) 403|403 Forbidden/i.test(rawStderr)) return "Storage refused the link to the recording (HTTP 403), even after it was signed again. Run the command again; if it keeps failing, the recording may have been deleted.";
  if (/(?:HTTP error|Server returned) 404|404 Not Found/i.test(rawStderr)) return "The recording file is missing from storage. It may have been deleted.";
  const line = lastFfmpegLine(rawStderr);
  return `ffmpeg could not read the recording${line ? `: ${line}` : ""}`;
}

/** The last thing ffmpeg said, its log prefix and any URL cut out. */
function lastFfmpegLine(rawStderr: string): string | null {
  const stderr = rawStderr.replace(/\b(?:https?|tcp|tls):\/\/\S+/gi, "<recording>");
  return stderr.split(/\r?\n/).map((l) => l.replace(/^\[[^\]]*\]\s*/, "").trim()).filter(Boolean).pop() ?? null;
}

// ── Errors ───────────────────────────────────────────────────────────────

export type SnapErrorCode =
  | "bad_target"
  | "ambiguous_moment"
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

/** A recorded stretch as data: what describeSpans says in words. */
export type SnapSpanDetail = {
  kind: CallRecordingKind;
  shows: string;
  /** Screen files: whose screen. Null for the room. */
  participant_name: string | null;
  from: string;
  to: string;
  from_ms: number;
  to_ms: number;
  saving: boolean;
};

/** What a refusal knows beyond its sentence, so a script retries without
 *  reading English: `try` holds every command the sentence names, `nearest`
 *  the recorded moment closest to the one asked for, `nearest_line` the
 *  filmed transcript line closest to it, `recorded` what was
 *  filmed, and `retry_after_s` how long to wait when the answer is "not
 *  yet". Built where the message is, from the same values. */
export type SnapErrorDetails = { try?: string[]; nearest?: string; nearest_line?: string; recorded?: SnapSpanDetail[]; retry_after_s?: number };

export class SnapError extends Error {
  constructor(readonly code: SnapErrorCode, message: string, readonly details: SnapErrorDetails = {}) {
    super(message);
  }
}

/** The spans describeSpans prints, as data: a refusal's `recorded`, and the
 *  `video` of `cast call <id> --json`. */
export function spanDetails(spans: readonly CallCoveredSpan[]): SnapSpanDetail[] {
  return spans.map((s) => ({
    kind: s.kind,
    shows: recordingSubject(s),
    participant_name: s.kind === "screen" ? s.participant_name : null,
    from: formatCallTime(spanStartSecond(s)),
    to: formatCallTime(s.toMs),
    from_ms: s.fromMs,
    to_ms: s.toMs,
    saving: s.pending,
  }));
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
  /** Why the last attempt to sign again failed (logged out, network down),
   *  or null. ffmpeg only sees the proxy answer 502, so the command reads
   *  the reason here. */
  lastError: string | null = null;

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
        this.lastError = null;
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        throw err;
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

/** The largest tail of a file the proxy keeps for the rest of a command:
 *  a recording's index (its moov) runs about 2.4 MB an hour of room video,
 *  about 14 MB at the longest run a recording can be. */
export const TAIL_CACHE_MAX_BYTES = 32 * 1024 * 1024;

/** The start of an open-ended range (`bytes=45147540-`), or null. */
function openRangeStart(range: string | undefined): number | null {
  const m = /^bytes=(\d+)-$/.exec(range ?? "");
  return m ? Number(m[1]) : null;
}

/** The bytes a 206 holds from `start` to the end of the file, read from its
 *  Content-Range (`bytes 45147540-45148212/45148213`), or null when the
 *  answer is not that tail. */
function tailLength(contentRange: string | null, start: number): number | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
  if (!m || Number(m[1]) !== start || Number(m[2]) !== Number(m[3]) - 1) return null;
  return Number(m[3]) - start;
}

/**
 * A loopback HTTP server that hands ffmpeg the recordings without handing it
 * the signed links: each request (ranges included, which is how ffmpeg
 * seeks) is forwarded to the current link, signed again and retried once if
 * storage answers 403. Bound to 127.0.0.1 on a free port, behind a random
 * path, for the life of one command.
 *
 * It also keeps a file's tail. LiveKit writes its MP4s with the index (the
 * moov) after the picture data, so every ffmpeg process a snap starts (one
 * to four probes and one or two grabs a frame, eight frames for a range)
 * opens with the same open-ended request for the end of the file: 136 KB
 * for a 4-minute room, megabytes for an hour, each time over the network.
 * The first answer to an open-ended range short enough to hold
 * (TAIL_CACHE_MAX_BYTES) is kept whole and the rest are answered from
 * memory with the same headers. Files only: a live frame is rewritten as
 * the call goes on, so it is always asked for fresh.
 */
export async function serveSources(sources: SignedSources): Promise<SourceServer> {
  const token = randomBytes(16).toString("hex");
  const tails = new Map<string, { headers: Record<string, string>; body: Buffer }>();
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
    const tailStart = live ? null : openRangeStart(req.headers.range);
    const tailKey = tailStart === null ? null : `${id}|${tailStart}`;
    const kept = tailKey === null ? undefined : tails.get(tailKey);
    if (kept) {
      res.writeHead(206, kept.headers);
      res.end(req.method === "HEAD" ? undefined : kept.body);
      return;
    }
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
      const body = Readable.fromWeb(upstream.body as any);
      // Kept only once the whole tail has arrived: ffmpeg often hangs up
      // part way through a long open-ended read, and a partial body must
      // never answer the next process.
      const want = tailKey !== null && upstream.status === 206 ? tailLength(upstream.headers.get("content-range"), tailStart!) : null;
      if (want !== null && want <= TAIL_CACHE_MAX_BYTES) {
        const chunks: Buffer[] = [];
        let got = 0;
        body.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
          got += chunk.length;
        });
        body.on("end", () => {
          if (got === want) tails.set(tailKey!, { headers, body: Buffer.concat(chunks, got) });
        });
      }
      body.on("error", () => res.destroy()).pipe(res);
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
  /** A part of each frame (CROP_FORMS), cut at the frame's own pixels. */
  crop?: string;
  /** Each frame also as a grid of tiles (`2x2`), each at full resolution. */
  tiles?: string;
};

export type PlannedFrame = {
  atMs: number;
  recording: SnapRecording;
  /** ms into the file; null when the source is a live frame (one image). */
  offsetMs: number | null;
  live: boolean;
  /** A change in a range's last partial second: the frame is taken at the
   *  change itself, which no whole-second citation names. */
  offBeat?: boolean;
  /** The line asked for, when one was (`cl-42:15`): the frame is reported
   *  against it, never against whatever line is nearest its second. */
  line?: SnapSegment;
  /** ms into the file of a picture the range's scene pass already saw,
   *  under a second before `offsetMs`: the frame to write, with no search
   *  back for one. */
  knownShownMs?: number;
};

/** How a range's frames were chosen: where a shared screen changed, evenly
 *  through the stretch, or both (a share covering part of the range). */
export type SnapRangeKind = "scene" | "even" | "mixed";

export type SnapPlan = { frames: PlannedFrame[]; notes: string[]; range: SnapRangeKind | null; changes?: SnapChanges | null };

type PlanInput = {
  call: SnapCall;
  recs: SnapRecordings;
  moment: SnapMoment;
  prefer: CallMomentPrefer;
  /** --screen: only a shared screen will do. */
  strictScreen: boolean;
  /** The sharer a pasted link was watching (`view=screen:<identity>`): their
   *  file is preferred wherever it covers the moment. */
  identity?: string | null;
  max: number;
  ffmpeg: () => FfmpegRunner;
  /** A URL ffmpeg can read a file at. */
  source: (rec: SnapRecording, live: boolean) => Promise<string>;
  handle: string;
  /** The moment as asked, as a reference (`cl-42:15`, `cl-42@12:34`, or the
   *  call alone for now): what a refusal's "the same without --screen" and
   *  "run it again" commands are built on. */
  ref: string;
  /** The command as run, for a refusal that means "not yet". */
  again: string;
  progress?: (line: string) => void;
};

/** A few times in a sentence: the first three, then how many more. A range
 *  can hold fifty frames, and a note naming each is no longer a note. */
function someTimes(ms: readonly number[]): string {
  return someClocks(ms.map((m) => formatCallTime(m)));
}

/** The same for times already written as clocks. */
function someClocks(at: readonly string[]): string {
  return at.length > 3 ? `${at.slice(0, 3).join(", ")} and ${at.length - 3} more` : at.length > 1 ? `${at.slice(0, -1).join(", ")} and ${at[at.length - 1]}` : at.join("");
}

function rows(recs: Pick<SnapRecordings, "recordings">): SnapRecording[] {
  return recs.recordings.map(({ _id, ...r }) => ({ ...r, id: _id }) as SnapRecording);
}

/** The refusal for a call with no picture at all, or none that worked. */
function nothingRecorded(handle: string, recs: SnapRecordings, all: SnapRecording[], lineHint: string): SnapError {
  const words = `cast call ${handle}${lineHint}`;
  const details = { try: [words] };
  if (all.length > 0 && all.every((r) => r.status === "failed")) {
    const why = all.find((r) => r.error)?.error;
    return new SnapError("recording_failed", `${handle}'s recording failed${why ? `: ${why}` : ""}. Its words are still in the transcript: ${words}`, details);
  }
  if (!recs.configured && all.length === 0) {
    return new SnapError("not_configured", `Video recording is not set up on this server, so ${handle} has no video. Its words are in the transcript: ${words}`, details);
  }
  return new SnapError(
    "not_recorded",
    `${handle} was not recorded. A call has video only while someone in the huddle has pressed Record. Its words are in the transcript: ${words}`,
    details,
  );
}

/** A refusal's pointer to the recorded moment nearest the one asked for,
 *  and to the filmed line nearest it when the transcript has one (an agent
 *  reading a call steps by line): each as a command, with the citations as
 *  data. Nulls when nothing finished is near. */
type NearHint = { cmd: string | null; lineCmd: string | null; details: SnapErrorDetails };
const NO_HINT: NearHint = { cmd: null, lineCmd: null, details: {} };

function nearestHint(
  handle: string,
  spans: readonly CallCoveredSpan[],
  atMs: number | null,
  flag = "",
  segments: readonly SnapSegment[] = [],
): NearHint {
  const near = atMs === null ? null : nearestRecordedMs(spans, atMs);
  if (near === null) return NO_HINT;
  const ref = callRefId(handle, null, near);
  const line = nearestFilmedLine(spans, segments, atMs!);
  const lineRef = line ? callRefId(handle, { from_seq: line.seq, to_seq: line.seq }) : null;
  return {
    cmd: `cast call snap ${ref}${flag}`,
    lineCmd: lineRef ? `cast call snap ${lineRef}${flag}` : null,
    details: { nearest: ref, ...(lineRef ? { nearest_line: lineRef } : {}) },
  };
}

/** A refusal's closing sentences and their commands, in the order the
 *  reader takes them: the nearest moment, then the nearest filmed line; for
 *  a snap asked by line (`line`, its seq) the line first, since that reader
 *  steps by line, then the moment with the warning that it is other words.
 *  `room` (--screen's same snap without the flag) follows them, and a line
 *  ask ends with the line's own words as the way back to what was said. */
function refusalTail(handle: string, near: NearHint, line: number | null, room: string | null = null): { words: string; try: string[] } {
  const moment = near.cmd ? ` Nearest: ${near.cmd}.` : "";
  const filmed = near.lineCmd ? ` Nearest filmed line: ${near.lineCmd}.` : "";
  const drop = room ? ` For the room, drop --screen: ${room}.` : "";
  const hints = (line === null ? [near.cmd, near.lineCmd] : [near.lineCmd, near.cmd]).filter((c): c is string => !!c);
  const tries = room ? [...hints, room] : hints;
  if (line === null) return { words: `${moment}${filmed}${drop}`, try: tries };
  const own = `cast call ${handle} ${line}`;
  const warn = near.cmd ? ` That moment is not line ${line}: other words are being said there.` : "";
  return { words: `${filmed}${moment}${warn}${drop} Its own words: ${own}.`, try: [...tries, own] };
}

/** The refusal for --screen at a moment no share covers. The room is
 *  offered (the same snap without the flag, `ref`) only where a finished
 *  room file can answer: at the moment itself, or for a range (`atMs` null)
 *  anywhere at all. With no share in the call and no room at the moment,
 *  the nearest filmed room moment is offered instead, so the refusal still
 *  names a picture it can give. `line` is the seq of a snap asked by line. */
function noScreen(handle: string, spans: readonly CallCoveredSpan[], atMs: number | null, what: string, ref: string, line: number | null = null, segments: readonly SnapSegment[] = []): SnapError {
  const screens = spans.filter((s) => s.kind === "screen");
  const room = spans.some((s) => s.kind === "composite" && !s.pending && (atMs === null || (s.fromMs <= atMs && atMs < s.toMs))) ? `cast call snap ${ref}` : null;
  const near = screens.length ? nearestHint(handle, screens, atMs, " --screen", segments) : room ? NO_HINT : nearestHint(handle, spans, atMs, "", segments);
  const tail = refusalTail(handle, near, line, room);
  const opening = screens.length
    ? `No screen share was recorded ${what}. Screens recorded: ${describeSpans(screens)}.`
    : `Nobody shared a screen while ${handle} was recorded.`;
  return new SnapError("no_screen", `${opening}${tail.words}`, {
    ...near.details,
    ...(tail.try.length ? { try: tail.try } : {}),
    recorded: spanDetails(screens.length ? screens : spans),
  });
}

/** The refusal for a moment nothing filmed. `opening` says which moment, the
 *  way it was asked for; `line` is the seq of a snap asked by line. */
function outside(handle: string, spans: readonly CallCoveredSpan[], atMs: number, opening: string, line: number | null = null, segments: readonly SnapSegment[] = []): SnapError {
  const near = nearestHint(handle, spans, atMs, "", segments);
  const tail = refusalTail(handle, near, line);
  return new SnapError(
    "outside",
    `${opening} Recorded: ${describeSpans(spans) || "nothing that finished saving"}.${tail.words}`,
    { ...near.details, ...(tail.try.length ? { try: tail.try } : {}), recorded: spanDetails(spans) },
  );
}

/**
 * The frame at one moment: a finished file when one covers it, the live
 * frame when the moment is now and the file is still being written.
 * `asked` names the moment the way the person asked for it ("Line 15",
 * "12:34"), for a note when the answer is a different picture than that.
 * `identity` keeps a range's frame on the share it was found in, when two
 * people shared at once.
 */
function frameAt(input: PlanInput, all: SnapRecording[], atMs: number, notes: string[], asked: string, identity: string | null = null): PlannedFrame {
  const { recs, handle } = input;
  const strict = input.strictScreen;
  const at = { callStartedAt: recs.call_started_at, atMs, prefer: input.prefer, identity: identity ?? input.identity ?? null, now: recs.server_now };
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
    // The live picture is offered only to a caller who may see it.
    const watch = recs.live_watch !== false;
    throw new SnapError(
      "not_ready",
      `${handle} is still recording, and LiveKit uploads a recording's video only when Record is stopped or the huddle ends. ` +
        `${formatCallTime(atMs)} can be snapped once that happens. ` +
        (watch ? `Until then only the live picture is there: cast call snap ${handle}` : "Until then only someone in the call sees it, live."),
      { ...(watch ? { try: [`cast call snap ${handle}`] } : {}), recorded: spanDetails(spans) },
    );
  }
  // The same moment without --screen, as its own reference: a range frame's
  // moment is not the range asked for.
  const roomRef = callRefId(handle, null, atMs);
  const segments = input.call.segments ?? [];
  if (why.reason === "no_recordings") {
    if (strict) throw noScreen(handle, spans, atMs, `at ${formatCallTime(atMs)}`, roomRef, undefined, segments);
    throw nothingRecorded(handle, recs, all, "");
  }
  if (strict) throw noScreen(handle, spans, atMs, `at ${formatCallTime(atMs)}`, roomRef, undefined, segments);
  throw outside(handle, spans, atMs, `${handle} was not being recorded at ${formatCallTime(atMs)}.`, undefined, segments);
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

/** A moment a range shows, with the stretch it was chosen in: `toMs` (the
 *  stretch's exclusive end) bounds the whole second it is rounded to, and a
 *  moment found in a share's own file keeps that sharer's identity, so the
 *  frame comes from the file the change was seen in. */
type RangeMoment = {
  atMs: number;
  toMs: number;
  identity: string | null;
  change?: boolean;
  /** A change the scene pass saw: the file it was seen in and the file time
   *  of that keyframe, a picture known to be there and not filler, so the
   *  grab can read it without first searching back for one. */
  seen?: { recordingId: string; fileMs: number };
};

/** How many changes a range's scene passes found, and how many of them its
 *  frames show: a reader told 8 frames is told when there were 29. */
export type SnapChanges = { found: number; shown: number };

type Stretch = { fromMs: number; toMs: number; identity?: string | null };

/** `budget` frames shared across stretches by length (whole frames, the
 *  remainder to the longest), each stretch sampled evenly. */
function spread(parts: readonly Stretch[], budget: number, gapMs: number): RangeMoment[] {
  if (budget <= 0 || parts.length === 0) return [];
  const len = (i: number) => parts[i].toMs - parts[i].fromMs;
  const total = parts.reduce((n, _, i) => n + len(i), 0) || 1;
  const counts = parts.map((_, i) => Math.floor((budget * len(i)) / total));
  let left = budget - counts.reduce((n, c) => n + c, 0);
  for (const i of parts.map((_, i) => i).sort((a, b) => len(b) - len(a))) {
    if (left <= 0) break;
    counts[i]++;
    left--;
  }
  return parts.flatMap((p, i) =>
    counts[i] ? sampleCallMoments(p.fromMs, p.toMs, counts[i], gapMs).map((atMs) => ({ atMs, toMs: p.toMs, identity: p.identity ?? null })) : [],
  );
}

/**
 * The moments to show across [fromMs, toMs] of the call. Where a finished
 * screen file covers the range, the moments its screen changed (one scene
 * pass per file, each stretch's first picture always a candidate); where
 * none does, evenly spaced moments of the room. The `max` budget is split
 * between the two by how much of the range each covers. A share too long to
 * scan, or a scan that fails, is sampled evenly instead, and said so.
 */
async function rangeMoments(
  input: PlanInput,
  all: SnapRecording[],
  fromMs: number,
  toMs: number,
  notes: string[],
): Promise<{ moments: RangeMoment[]; range: SnapRangeKind; changes: SnapChanges | null }> {
  const { recs } = input;
  const span = Math.max(1, toMs - fromMs);
  const screens = input.prefer === "screen" ? playableFiles(all).filter((r) => r.kind === "screen") : [];
  const windows = screens
    .map((r) => ({ r, w: recordingWindow(r, recs.server_now)! }))
    .map(({ r, w }) => ({ r, fromMs: Math.max(fromMs, w.start - recs.call_started_at), toMs: Math.min(toMs, w.end - recs.call_started_at), fileStart: w.start }))
    .filter((x) => x.toMs > x.fromMs);
  const uncovered = uncoveredParts(windows, fromMs, toMs).filter(atLeastASecond);
  if (input.strictScreen) {
    if (windows.length === 0) throw noScreen(input.handle, coveredSpans(all, recs.call_started_at, recs.server_now), null, `across these lines (${formatCallTime(fromMs)} to ${formatCallTime(toMs)})`, input.ref);
    if (uncovered.length) {
      notes.push(`No screen was recorded ${describeClockSpans(uncovered.map(([a, b]) => ({ fromMs: a, toMs: b })))}, so those stretches have no frames. Drop --screen to include the room.`);
    }
  }
  // The room is sampled only where its own file runs: lines that began
  // before Record was pressed are common (people press it once talk is under
  // way), and a frame spent on a stretch nothing filmed is a frame the range
  // loses.
  const rooms = coveredSpans(playableFiles(all).filter((r) => r.kind === "composite"), recs.call_started_at, recs.server_now);
  const roomParts = input.strictScreen ? [] : uncovered.flatMap(([a, b]) => coveredParts(rooms, a, b)).filter(atLeastASecond);
  const roomMs = roomParts.reduce((n, [a, b]) => n + (b - a), 0);
  if (!input.strictScreen && (windows.length || roomParts.length)) {
    const unfilmed = uncoveredParts([...windows, ...rooms], fromMs, toMs).filter(atLeastASecond);
    if (unfilmed.length) notes.push(`Nothing was recorded ${describeClockSpans(unfilmed.map(([a, b]) => ({ fromMs: a, toMs: b })))}, so the frames come from the rest of these lines.`);
  }
  // The room's share of the frames follows its share of the range, and a
  // share keeps at least one frame whenever there is one. With nothing
  // filmed anywhere in the range, the room takes the whole budget over the
  // whole range, and frameAt says what was recorded instead.
  const roomBudget = input.strictScreen
    ? 0
    : windows.length === 0
      ? input.max
      : roomMs >= ROOM_FRAME_GAP_MS
        ? Math.min(input.max - 1, Math.max(1, Math.round((input.max * roomMs) / span)))
        : 0;
  const screenBudget = windows.length ? input.max - roomBudget : 0;

  // Scene candidates, file by file, each remembering its file and the time
  // in it the change was seen at.
  const cands: Array<SceneCandidate & { x: (typeof windows)[number]; fileMs?: number }> = [];
  const evenScreen: Stretch[] = [];
  const stretchOf = (x: (typeof windows)[number]): Stretch => ({ fromMs: x.fromMs, toMs: x.toMs, identity: x.r.participant_identity ?? null });
  for (const x of windows) {
    const stretch = x.toMs - x.fromMs;
    const size = x.r.size_bytes && x.r.duration_ms ? (x.r.size_bytes * stretch) / x.r.duration_ms : null;
    const who = recordingSubject(x.r);
    if (size !== null ? size > SCENE_SCAN_MAX_BYTES : stretch > SCENE_SCAN_MAX_MS) {
      notes.push(`${who} from ${formatCallTime(x.fromMs)} to ${formatCallTime(x.toMs)} is too long to scan for changes, so its frames are evenly spaced. A shorter line range finds the changes.`);
      evenScreen.push(stretchOf(x));
      continue;
    }
    input.progress?.(`Reading ${describeClockSpan(x)} of ${who} for changes...`);
    const startInFile = recs.call_started_at + x.fromMs - x.fileStart;
    const res = await input.ffmpeg()(sceneArgs(await input.source(x.r, false), startInFile, Math.max(1000, stretch)), { timeoutMs: SCENE_TIMEOUT_MS });
    if (res.code !== 0) {
      notes.push(`Could not scan ${who} for changes (${ffmpegFailure(res.stderr, res.code === null)}), so its frames are evenly spaced.`);
      evenScreen.push(stretchOf(x));
      continue;
    }
    cands.push({ atMs: x.fromMs, score: Infinity, x });
    for (const c of parseSceneScores(res.stderr + res.stdout)) {
      const at = x.fileStart + c.atMs - recs.call_started_at;
      if (at > x.fromMs && at < x.toMs) cands.push({ atMs: at, score: c.score, x, fileMs: c.atMs });
    }
  }

  const scanned = windows.length - evenScreen.length;
  const sceneBudget = !scanned ? 0 : evenScreen.length ? Math.ceil(screenBudget / 2) : screenBudget;
  // pickSceneMoments returns candidate times; each goes back to the file
  // its change was seen in (two files sharing a time: either change is a
  // frame worth showing).
  const sceneMoments: RangeMoment[] = pickSceneMoments(cands, { max: sceneBudget }).map((atMs) => {
    const c = cands.find((x) => x.atMs === atMs)!;
    const st = stretchOf(c.x);
    // The stretch's first picture is where the range begins, not a change.
    return { atMs, toMs: st.toMs, identity: st.identity ?? null, change: atMs > st.fromMs, ...(c.fileMs !== undefined ? { seen: { recordingId: c.x.r.id, fileMs: c.fileMs } } : {}) };
  });
  const moments: RangeMoment[] = [
    ...sceneMoments,
    ...spread(evenScreen, screenBudget - sceneBudget, SCREEN_FRAME_GAP_MS),
    ...spread((roomParts.length ? roomParts : [[fromMs, toMs] as [number, number]]).map(([a, b]) => ({ fromMs: a, toMs: b })), roomBudget, ROOM_FRAME_GAP_MS),
  ];
  // The room is never scanned for changes: its keyframes are ten seconds
  // apart, and between any two of them faces and a live share both move
  // past SCENE_THRESHOLD (measured 2026-10-04 on cl-107, cl-109 and cl-117:
  // most room keyframes scored over 0.04, up to 0.75, with no slide
  // changing). So a screen filmed only in the room view (an older call, a
  // screen recording that failed) is sampled evenly, and the reader is told
  // what that misses. Only where a share could have gone unrecorded on its
  // own: a call with no screen file at all, or a screen recording that
  // failed in these lines. Where screen recording worked, a share here
  // would have its own file.
  // A failed one that never started (LiveKit refused it) has no time to
  // place it by, and counts wherever it was.
  const screenFailed = all.some((r) => {
    if (r.kind !== "screen" || r.status !== "failed") return false;
    if (r.started_at == null) return true;
    const a = r.started_at - recs.call_started_at;
    return a < toMs && (r.duration_ms == null || a + r.duration_ms > fromMs);
  });
  if (roomBudget > 0 && roomParts.length && input.prefer === "screen" && (screenFailed || !all.some((r) => r.kind === "screen"))) {
    notes.push(`No screen was recorded on its own ${windows.length ? "in the rest of these lines" : "across these lines"}, so the room's frames are evenly spaced; a screen shared in the room view may have changed between them.`);
  }
  const range: SnapRangeKind = cands.length === 0 ? "even" : roomBudget || evenScreen.length ? "mixed" : "scene";
  const changes = scanned ? { found: cands.filter((c) => c.score !== Infinity).length, shown: sceneMoments.filter((m) => m.change).length } : null;
  return { moments, range, changes };
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
      // first line that was filmed.
      const spans = coveredSpans(all, recs.call_started_at, recs.server_now);
      const first = spans.find((s) => !s.pending);
      if (!first) {
        throw new SnapError("not_ready", `${handle} has ended and its recording is still saving. Try again in a minute: ${input.again}. Recorded: ${describeSpans(spans)}.`, {
          try: [input.again],
          retry_after_s: 60,
          recorded: spanDetails(spans),
        });
      }
      const at = nearestRecordedMs(spans, first.fromMs) ?? first.fromMs;
      const line = firstFilmedLine(spans, segments);
      const atCmd = `cast call snap ${callRefId(handle, null, at)}`;
      const lineCmd = line ? `cast call snap ${callRefId(handle, { from_seq: line.seq, to_seq: line.seq })}` : null;
      throw new SnapError(
        "not_live",
        `${handle} has ended, so there is no "now" to show. Name a moment: ${atCmd}` + (lineCmd ? `, or a transcript line: ${lineCmd}` : "") + `. Recorded: ${describeSpans(spans)}.`,
        { try: lineCmd ? [atCmd, lineCmd] : [atCmd], recorded: spanDetails(spans) },
      );
    }
    const live = liveFrame(input, all);
    // Filming, but the live picture is not this caller's to see: watching
    // from outside would be unseen by the room (callRecordings.mayWatchLive).
    if (!live && recs.live_watch === false && all.some((r) => isRecordingFilming(r.status))) {
      throw new SnapError(
        "not_live",
        `${handle} is being recorded right now, and only someone in the call sees it as it is now. Join the call to see it live; the video can be snapped here once the recording stops.`,
      );
    }
    if (!live) {
      // Only the room's file writes a live picture (LiveKit will not write
      // one beside a screen's file), so a screen being recorded is never
      // "starting" for want of one: it is readable once it is saved.
      const mine = (r: SnapRecording) => !input.strictScreen || r.kind === "screen";
      const starting = all.some((r) => (r.status === "starting" && mine(r)) || (r.kind === "composite" && r.status === "recording" && !r.live_frame_url));
      const screenRecording = all.some((r) => r.kind === "screen" && r.status === "recording");
      // Record was just stopped: the files are uploading, and the moments
      // they cover can be snapped as soon as they land.
      const saving = all.some((r) => r.status === "stopping" && mine(r));
      const spans = coveredSpans(all.filter(mine), recs.call_started_at, recs.server_now);
      const roomNow = `cast call snap ${handle}`;
      if (input.strictScreen && screenRecording) {
        throw new SnapError(
          "not_live",
          `A shared screen in ${handle} is being recorded, and its own picture can be read once the recording is saved. For the call as it is now, with the share in it, drop --screen: ${roomNow}`,
          { try: [roomNow] },
        );
      }
      if (starting) {
        throw new SnapError("not_live", `${handle}'s recording is starting. Try again in a few seconds: ${input.again}`, { try: [input.again], retry_after_s: 5 });
      }
      if (saving) {
        // No command to offer: "now" is over, and the moments to name are
        // the ones listed, once they land.
        throw new SnapError("not_live", `${handle}'s recording was just stopped and is saving; its moments can be snapped in a minute. Recorded: ${describeSpans(spans)}.`, {
          recorded: spanDetails(spans),
          retry_after_s: 60,
        });
      }
      if (input.strictScreen && all.some((r) => r.status === "recording")) {
        throw new SnapError("not_live", `Nobody is sharing a screen in ${handle} right now. For the room, drop --screen: ${roomNow}`, { try: [roomNow] });
      }
      throw new SnapError("not_live", `${handle} is not being recorded right now. A call has video only while someone in the huddle has pressed Record.`);
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
      { try: [last > 0 ? `cast call ${handle} --transcript` : `cast call snap ${handle}@1:30`] },
    );
  }

  if (moment.from === moment.to) {
    const line = lines[0];
    const asked = `Line ${line.seq}`;
    try {
      return { frames: [{ ...frameAt(input, all, lineFrameMs(line), notes, asked), line }], notes, range: null };
    } catch (err) {
      // A line that began a moment before the press (egress takes a few
      // seconds to start), or ran into a gap or a share starting, was still
      // on camera for the rest of its words: show the first recorded second
      // of it rather than refusing.
      if (!(err instanceof SnapError) || (err.code !== "outside" && err.code !== "no_screen")) throw err;
      const usable = input.strictScreen ? all.filter((r) => r.kind === "screen") : all;
      const spans = coveredSpans(usable, recs.call_started_at, recs.server_now).filter((x) => !x.pending);
      const within = firstRecordedWithin(spans, line.t0, Math.max(line.t0, line.t1));
      if (within === null) {
        // Asked by line, answered by line: the call clock alone leaves the
        // reader to work out that 0:14 is its line 3. The nearest recorded
        // moment is offered still, with the warning that other words are
        // being said there, and the line's own words as the way back.
        // `at` is where the frame would be, which finds the nearest moment;
        // the words name when the line began, the clock the transcript
        // prints beside it.
        const at = lineFrameMs(line);
        const said = formatCallTime(line.t0);
        if (err.code === "no_screen") {
          throw noScreen(handle, coveredSpans(all, recs.call_started_at, recs.server_now), at, `when line ${line.seq} was said (${said})`, input.ref, line.seq, segments);
        }
        const filmed = coveredSpans(all, recs.call_started_at, recs.server_now);
        const where = spans.every((x) => at < x.fromMs)
          ? `before ${handle} was being recorded`
          : spans.every((x) => at >= x.toMs)
            ? `after ${handle}'s recording had stopped`
            : `between two recordings of ${handle}`;
        throw outside(handle, filmed, at, `Line ${line.seq} was said at ${said}, ${where}.`, line.seq, segments);
      }
      const frame = frameAt(input, all, within, notes, asked);
      // Why the frame is not where a line's frame usually is: the recording
      // began after the line did, or it was running when the line began and
      // stopped (or a share ended) before the usual moment.
      const running = spans.filter((x) => x.fromMs <= line.t0 && line.t0 < x.toMs);
      if (running.length > 0) {
        const until = formatCallTime(Math.max(...running.map((x) => x.toMs)));
        notes.push(
          input.strictScreen
            ? `${recordingSubject(running[0])} was recorded only until ${until}, during line ${line.seq}; this frame is from ${formatCallTime(within)}.`
            : `Recording stopped at ${until}, during line ${line.seq}; this frame is from ${formatCallTime(within)}.`,
        );
      } else {
        const into = within - line.t0;
        notes.push(
          `Line ${line.seq} began at ${formatCallTime(line.t0)}, before it was being recorded; this frame is from ${formatCallTime(within)}` +
            (into >= 1000 ? `, ${Math.round(into / 1000)}s into it.` : `, its first recorded second.`),
        );
      }
      return { frames: [{ ...frame, line }], notes, range: null };
    }
  }

  // A range. Each moment still goes through frameAt (locateCallMoment), so a
  // range frame and a single snap of the same moment are one picture. It
  // starts where its first line's frame is, which is never before that
  // line's first word (lineFrameMs).
  const { fromMs, toMs } = linesSpan(lines);
  const { moments: raw, range, changes } = await rangeMoments(input, all, fromMs, toMs, notes);
  // Every frame sits on a whole second, rounded up (a scene change is on
  // screen from its keyframe on), so the `cl-42@m:ss` printed beside a frame
  // names that exact frame, the same promise lineFrameMs keeps for a line.
  // The second is bounded by the stretch the moment came from (its file's
  // end, exclusive), so rounding never carries a frame out of the share it
  // was found in. --screen holds for every moment, as for one.
  // A change in the stretch's last partial second has no whole second after
  // it to stand on, and the one before it shows the screen before the
  // change. Its frame is taken at the change itself, and marked as one its
  // citation cannot name.
  const byAt = new Map<number, RangeMoment & { offBeat: boolean }>();
  for (const m of raw) {
    const limit = Math.min(toMs, m.toMs - 1);
    const inside = Math.min(Math.max(m.atMs, fromMs), toMs);
    const offBeat = !!m.change && Math.ceil(inside / 1000) * 1000 > limit && inside % 1000 !== 0;
    const at = offBeat ? inside : wholeSecond(inside, limit);
    if (!byAt.has(at)) byAt.set(at, { ...m, offBeat });
  }
  const moments = [...byAt.keys()].sort((a, b) => a - b);
  const frames: PlannedFrame[] = [];
  const missed: number[] = [];
  let lastError: SnapError | null = null;
  for (const at of moments) {
    try {
      const m = byAt.get(at)!;
      const f: PlannedFrame = { ...frameAt(input, all, at, [], formatCallTime(at), m.identity), ...(m.offBeat ? { offBeat: true } : {}) };
      // The keyframe the scene pass saw the change in is the picture on
      // screen at the second it was rounded up to, when the frame comes
      // from that same file.
      if (m.seen && f.recording.id === m.seen.recordingId && f.offsetMs !== null && m.seen.fileMs <= f.offsetMs + 1 && f.offsetMs - m.seen.fileMs < 1000) {
        f.knownShownMs = m.seen.fileMs;
      }
      frames.push(f);
    } catch (err) {
      if (!(err instanceof SnapError)) throw err;
      lastError = err;
      missed.push(at);
    }
  }
  if (frames.length === 0) throw lastError!;
  if (missed.length > 0) {
    notes.push(`${missed.length} of the moments across these lines were not recorded (${someTimes(missed)}).`);
  }
  // Two moments can land on one live frame; keep one.
  const unique = frames.filter((f, i) => !f.live || frames.findIndex((g) => g.live && g.recording.id === f.recording.id) === i);
  return { frames: unique, notes, range, changes };
}

// ── The command ──────────────────────────────────────────────────────────

/** A call lookup that failed, with why: the CLI's resolveCallId throws one
 *  of these rather than exiting, so `--json` can answer in JSON. */
export type CallLookupError = Error & { code?: "not_found" | "ambiguous"; try?: string[] };

export type SnapDeps = {
  /** Posts to the server, throwing on any failure. */
  post: (route: string, body: Record<string, unknown>) => Promise<any>;
  resolveCallId: (ref: string) => Promise<string>;
  baseUrl: string;
  /** Shares a written frame as a public image tied to the recording file it
   *  came from (imageCommand.shareCallFrame), so deleting the recording
   *  deletes the image. */
  share?: (file: string, recordingId: string, alt: string, atMs: number) => Promise<{ url: string; markdown: string }>;
  /** Tests hand in a fake; otherwise the machine's ffmpeg is found. */
  ffmpeg?: FfmpegRunner;
  /** Tests stand in for the lookup of the machine's ffmpeg (findFfmpeg). */
  findFfmpeg?: () => string | null;
  /** Tests hand in a directory; otherwise the scratch directory. */
  scratch?: (name: string) => string;
  /** Tests read the links straight; otherwise the loopback proxy. */
  serveSources?: (sources: SignedSources) => Promise<SourceServer>;
  /** One line per slow step, for a person watching. */
  progress?: (line: string) => void;
};

/** One tile of a frame (--tiles): its file, its place, its size. */
export type SnapTile = { path: string; part: string; x: number; y: number; width: number; height: number };

export type SnapFrameResult = {
  path: string;
  /** The picture's size in pixels (after --crop), null when ffmpeg did not
   *  say. What a crop or tile is measured in. */
  width: number | null;
  height: number | null;
  /** --crop: the part of the frame written, in the frame's own pixels. */
  crop: CropRect | null;
  /** --tiles: the frame again as a grid, each tile at full resolution. */
  tiles?: SnapTile[];
  /** A frame wide enough that small text may blur once a model shrinks it,
   *  and neither cropped nor tiled: the --tiles grid (`2x1`) whose every
   *  tile is read at the frame's own pixels (readableTiles). */
  suggested_tiles?: string;
  ref: string;
  at: string;
  at_ms: number;
  kind: CallRecordingKind;
  shows: string;
  live: boolean;
  recording_id: string;
  offset_ms: number | null;
  /** When the picture written was put on screen, on the call's clock: equal
   *  to `at_ms` for a fresh frame, earlier for one held on an unchanged
   *  screen, later for a file's first picture. Null for a live picture. */
  shown_at: string | null;
  shown_at_ms: number | null;
  /** The view the snap asked for with --screen or --composite, null when it
   *  took the default. `kind` differing from it is a fallback, as data. */
  requested_kind: CallRecordingKind | null;
  /** What is true of this frame and not of the others: held, substituted,
   *  stalled, not uploaded. The top-level `notes` say the same for a reader. */
  notes: string[];
  call_url: string;
  /** The line being said, or the last one said: `at`/`at_ms` is when it
   *  began, `ended_ms` when its words ended. */
  line: { ref: string; speaker: string; text: string; at: string; at_ms: number; ended_ms: number; during: boolean } | null;
  /** Whether `ref` in a message renders as this very picture. False when the
   *  snap asked for a view the citation does not take (--composite over a
   *  share, say), or the picture is a live one. */
  citation_matches: boolean;
  /** What `ref` renders as in a message ("Ana's screen", "the room"), or
   *  null when it renders as nothing yet (a live picture). */
  citation_shows: string | null;
  /** A citation that renders this picture when `ref` does not: the share
   *  stalled at the moment asked for, and this second is its last picture. */
  cite_instead?: string;
  /** When nothing was being said (`line` null): the lines either side, so
   *  the frame can be placed in the transcript. Null when there is a line,
   *  or no transcript. */
  between: { before: { ref: string; at: string } | null; after: { ref: string; at: string } | null } | null;
  image?: { url: string; markdown: string };
  /** --share was asked for and this frame's upload failed: why. */
  image_error?: string;
};

export type SnapResult = {
  call: { id: string; short_id: string | null; title: string | null };
  target: string;
  /** --crop and --tiles as asked, null when not: a reader of the frames
   *  knows whether it was offered part of the picture. */
  crop: string | null;
  tiles: string | null;
  range: SnapRangeKind | null;
  /** How many changes the scene passes found across a range, null when none
   *  ran. Above the frames shown, the frames are a spread of them. */
  changes_found: number | null;
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

/** What grab() learned about the frame it wrote. */
type Grabbed = {
  /** File time of the frame written; null for a live picture. */
  shownMs: number | null;
  /** The frame a `<video>` shows at the moment is LiveKit's black filler,
   *  not the picture written: the share was stalled there. */
  stalled: boolean;
  /** Nothing was on screen before the moment, so the frame is from after. */
  forward: boolean;
  /** How far back was searched for a picture, when that is not the file's
   *  start; null when the search reached the start (or was not needed). */
  searchedMs: number | null;
  /** The picture's size, from showinfo; null when it did not say. */
  size: { width: number; height: number } | null;
  /** When `stalled`: file time of the first filler frame after the picture,
   *  where a `<video>` stops showing it. */
  stallMs: number | null;
};

/**
 * Grabs one planned frame to `out`: the picture on screen at the moment, which
 * is the last frame at or before it, not the first after. The two differ
 * wherever a file is sparse. A screen share sends a frame only when the
 * screen changes, so a slide left up for ten seconds is ten seconds with no
 * frame, and a plain seek into that gap would return the next slide, from the
 * future. A `<video>` seeked to the moment shows the last frame at or before
 * it, and so a citation's picture and the agent's are the same frame.
 *
 * Two ffmpeg runs: probeArgs finds that frame's time, widening its lookback a
 * step at a time when a quiet screen wrote nothing recently, and frameArgs
 * writes exactly that frame. When nothing at all was written before the
 * moment (its file's first instant), the first picture after it is the
 * nearest there is.
 *
 * A range frame the scene pass chose skips the probe (`knownShownMs`): the
 * pass already saw a picture, not filler, at that keyframe, under a second
 * before the moment, so the frame is written straight from it. That halves
 * the ffmpeg runs of a range over a share.
 *
 * A run that exits 0 and writes nothing is a read that was cut short (ffmpeg
 * takes a dropped connection for the end of the file), not a moment with no
 * frame: the probe had just seen the frame. It is run once more, and a second
 * miss says what ffmpeg said rather than that the frame does not exist.
 */
async function grab(ffmpeg: FfmpegRunner, source: string, frame: PlannedFrame, out: string): Promise<Grabbed> {
  const fail = (r: FfmpegResult) => new SnapError("ffmpeg_failed", ffmpegFailure(r.stderr, r.code === null));
  const wrote = () => fs.existsSync(out) && fs.statSync(out).size > 0;
  try {
    fs.rmSync(out, { force: true });
  } catch {
    // A file we cannot remove is one ffmpeg -y will report on.
  }
  let at: number | null = null;
  let from: number | null = null;
  let stalled = false;
  let stallMs: number | null = null;
  let searchedMs: number | null = null;
  if (frame.offsetMs !== null && frame.knownShownMs !== undefined) {
    // Read from a little before it, as after a probe: the keyframe can be
    // decoded behind a frame that precedes it.
    at = frame.knownShownMs;
    from = Math.max(0, at - LOOKBACK_STEPS_MS[0]);
  } else if (frame.offsetMs !== null) {
    for (const back of LOOKBACK_STEPS_MS) {
      const probe = await ffmpeg(probeArgs(source, frame.offsetMs, back), { timeoutMs: back > 120_000 ? SCENE_TIMEOUT_MS : GRAB_TIMEOUT_MS });
      if (probe.code !== 0) throw fail(probe);
      const seen = probeTimes(probe.stderr);
      at = seen.real[seen.real.length - 1] ?? null;
      const last = seen.all[seen.all.length - 1] ?? null;
      stalled = last !== null && (at === null || last > at);
      stallMs = stalled ? (seen.all.find((t) => at === null || t > at) ?? null) : null;
      from = Math.max(0, frame.offsetMs - back);
      searchedMs = frame.offsetMs - back <= 0 ? null : back;
      if (at !== null || searchedMs === null) break;
    }
  }
  const forward = frame.offsetMs !== null && at === null;
  // A millisecond early: showinfo's times are rounded, and "at or after" a
  // hair before the frame is still that frame (no file has two in 1 ms).
  const seek = frame.offsetMs === null ? null : at !== null ? Math.max(0, at - 1) : frame.offsetMs;
  const args = frameArgs(source, seek, out, at !== null ? from : seek, forward && frame.recording.kind === "screen");
  let res = await ffmpeg(args, { timeoutMs: GRAB_TIMEOUT_MS });
  if (res.code === 0 && !wrote()) res = await ffmpeg(args, { timeoutMs: GRAB_TIMEOUT_MS });
  if (res.code !== 0) throw fail(res);
  if (!wrote()) {
    const said = lastFfmpegLine(res.stderr);
    throw new SnapError(
      "ffmpeg_failed",
      at !== null
        ? `The read of the recording was cut short before the frame at ${formatCallTime(frame.atMs)} was written${said ? ` (ffmpeg: ${said})` : ""}. The frame is there; run the command again.`
        : `ffmpeg found no frame at ${formatCallTime(frame.atMs)} in the recording.${said ? ` (ffmpeg: ${said})` : ""}`,
    );
  }
  return {
    shownMs: frame.offsetMs === null ? null : shownTimes(res.stderr)[0] ?? at ?? frame.offsetMs,
    stalled,
    forward,
    searchedMs: forward ? searchedMs : null,
    size: shownSize(res.stderr),
    stallMs,
  };
}

/**
 * --crop and --tiles on a frame already written to `out`: the crop replaces
 * the frame (`size` becomes the crop's), and tiles are written beside it as
 * `<name>_tl.png` and so on, cut from what `out` now holds. Each is a local
 * ffmpeg run on one image. A frame whose size ffmpeg did not report cannot
 * be measured, and is refused rather than cut by guess.
 */
async function cutFrame(
  ffmpeg: FfmpegRunner,
  out: string,
  size: { width: number; height: number } | null,
  crop: CropRegion | null,
  tiles: { cols: number; rows: number } | null,
  scratch: boolean,
): Promise<{ size: { width: number; height: number } | null; crop: CropRect | null; tiles: SnapTile[] | null }> {
  if (!crop && !tiles) return { size, crop: null, tiles: null };
  if (!size) throw new SnapError("ffmpeg_failed", `ffmpeg did not report the size of ${path.basename(out)}, so it cannot be cut. The whole frame is at ${out}.`);
  const ext = path.extname(out);
  const stem = out.slice(0, -ext.length);
  const run = async (rect: CropRect, dest: string) => {
    const res = await ffmpeg(cutArgs(out, rect, dest), { timeoutMs: GRAB_TIMEOUT_MS });
    if (res.code !== 0 || !fs.existsSync(dest)) throw new SnapError("ffmpeg_failed", `Could not cut ${path.basename(dest)}: ${ffmpegFailure(res.stderr, res.code === null)}. The whole frame is at ${out}.`);
    if (scratch) secureTempFile(dest);
  };
  let rect: CropRect | null = null;
  let now = size;
  if (crop) {
    rect = cropRect(crop, size.width, size.height);
    if (!rect) throw new SnapError("bad_option", `That --crop is outside the ${size.width}x${size.height} frame. The whole frame is at ${out}.`);
    const tmp = `${stem}.cut${ext}`;
    await run(rect, tmp);
    fs.renameSync(tmp, out);
    now = { width: rect.w, height: rect.h };
  }
  const made: SnapTile[] = [];
  if (tiles) {
    for (const t of tileRects(tiles.cols, tiles.rows, now.width, now.height)) {
      const dest = `${stem}_${t.suffix}${ext}`;
      await run(t.rect, dest);
      made.push({ path: dest, part: t.suffix, x: t.rect.x, y: t.rect.y, width: t.rect.w, height: t.rect.h });
    }
  }
  return { size: now, crop: rect, tiles: tiles ? made : null };
}

/** The answer for a call the server did not return: none by that name, or
 *  none this account may read (the two are one answer, so a call's
 *  existence is not told to someone who cannot read it). `cast call` says
 *  the same. */
export function unreadableCall(call: string): SnapError {
  return new SnapError("not_found", `No call ${call} that you can read. \`cast calls\` lists the calls you can.`, { try: ["cast calls"] });
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
    const tries = (err as CallLookupError).try;
    throw new SnapError(code === "ambiguous" ? "ambiguous" : code === "not_found" ? "not_found" : "server", message, tries?.length ? { try: tries } : {});
  }
}

/** Everything `cast call snap <target> [moment]` does short of printing. */
export async function snapCall(targetRaw: string | undefined, options: SnapOptions, deps: SnapDeps, extra?: string): Promise<SnapResult> {
  if (!targetRaw) throw new SnapError("bad_target", `Name the moment to snap: ${SNAP_FORMS}.`);
  const target = parseSnapTarget(targetRaw, extra);
  const shown = extra ? `${targetRaw} ${extra}` : targetRaw;
  if (!target) {
    // A public share link names a share, not the call: a person pastes the
    // one they were sent.
    if (/\/share\/call\//i.test(shown)) {
      throw new SnapError(
        "bad_target",
        `"${shown}" is a public share link, which does not name the call to snap. Use the call's own page link or its short id (cl-42); \`cast calls\` lists them.`,
        { try: ["cast calls"] },
      );
    }
    // A pasted link whose `t` is no time: name it, rather than the forms.
    const linked = /^https?:\/\//i.test(targetRaw.trim()) ? linkTime(targetRaw.trim()) : null;
    if (linked !== null && parseSnapTime(linked) === null) {
      throw new SnapError("bad_target", `"${linked}" in that link is not a time into a call. Write the moment as seconds (?t=754), or name it directly: ${SNAP_FORMS}.`);
    }
    // `cl-42:1:02:03` is a time typed with a colon: say so.
    const colon = /^(cl-\d+)[:\s]+(\S+)$/i.exec(shown);
    const asTime = colon ? parseSnapTime(colon[2]) : null;
    const timeRef = colon && asTime !== null ? snapMomentRef(colon[1].toLowerCase(), asTime) : null;
    throw new SnapError(
      "bad_target",
      `"${shown}" is not a moment of a call. Use ${SNAP_FORMS}.` + (timeRef ? ` For a time, write ${timeRef}: a colon names transcript lines, @ names a time.` : ""),
      timeRef ? { try: [`cast call snap ${timeRef}`] } : {},
    );
  }
  // `cl-42:12:34` (or `cl-42 12:34`) is lines 12 to 34 to the transcript
  // printer and the time 12:34 to a person typing one. Either reading costs
  // the wrong frames when it guesses wrong, so neither is guessed.
  if (target.alsoTime !== undefined && target.moment.kind === "line") {
    const lines = callRefId(target.call, { from_seq: target.moment.from, to_seq: target.moment.to });
    const time = callRefId(target.call, null, target.alsoTime);
    throw new SnapError(
      "ambiguous_moment",
      `"${shown}" could be lines ${target.moment.from}-${target.moment.to} or the time ${formatCallTime(target.alsoTime)}: write ${lines} for the lines, or ${time} for the time.`,
      { try: [`cast call snap ${lines}`, `cast call snap ${time}`] },
    );
  }
  if (options.screen && options.composite) throw new SnapError("bad_option", "Pick one of --screen and --composite.");
  const max = parseMax(options.max);
  const crop = parseCrop(options.crop);
  const tiles = parseTiles(options.tiles);

  // The moment as asked, on another call name: what a refusal offers.
  const refOn = (call: string) =>
    target.moment.kind === "line"
      ? callRefId(call, { from_seq: target.moment.from, to_seq: target.moment.to })
      : target.moment.kind === "time"
        ? snapMomentRef(call, target.moment.atMs)
        : call;
  const callArg = await asked(isServerCallRef(target.call) ? Promise.resolve(target.call) : deps.resolveCallId(target.call)).catch((err: SnapError) => {
    // A short id typed without its prefix (`107@4:05`): the lookup offers
    // the call, and the snap offers the same moment on it.
    const short = /^\d+$/.test(target.call) ? `cl-${Number(target.call)}` : null;
    if (short && err.details.try?.includes(`cast call ${short}`)) {
      throw new SnapError(err.code, err.message, { try: [`cast call snap ${refOn(short)}`, ...err.details.try.filter((t) => t !== `cast call ${short}`)] });
    }
    throw err;
  });
  const fetchRecs = () => deps.post("/cli/calls/recordings", { call: callArg }) as Promise<SnapRecordings | null>;
  const [call, recs] = (await asked(Promise.all([deps.post("/cli/calls/get", { transcript_id: callArg }), fetchRecs()]))) as [SnapCall | null, SnapRecordings | null];
  if (!call || !recs) throw unreadableCall(target.call);
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
  const askedRef = refOn(handle);
  const requested: CallRecordingKind | null = options.screen ? "screen" : options.composite ? "composite" : null;
  try {
    const ffmpeg = lazyFfmpeg(deps.ffmpeg, deps.findFfmpeg);
    const plan = await planSnap({
      call,
      recs,
      moment: target.moment,
      prefer: options.composite ? "composite" : CALL_FRAME_PREFER,
      strictScreen: !!options.screen,
      // A pasted link copied on someone's screen asks for that screen, the
      // way --screen asks for any; --composite asked for the room instead.
      identity: options.composite ? null : (target.view?.identity ?? null),
      max,
      ffmpeg,
      source,
      handle,
      ref: askedRef,
      again: `cast call snap ${askedRef}${options.screen ? " --screen" : options.composite ? " --composite" : ""}`,
      progress: deps.progress,
    });
    const notes = [...plan.notes];
    if (options.max !== undefined && plan.range === null) notes.push(`--max counts frames across a line range (${handle}:15-25); this is one moment, so it was ignored.`);

    const run = ffmpeg();
    const all = rows(recs);
    const playable = playableFiles(all);
    const spans = coveredSpans(all, recs.call_started_at, recs.server_now);
    // A moment asked for between two seconds is named and printed to the
    // millisecond; a range's off-beat change keeps its whole second, which
    // its citation and the frames around it are written in.
    const shownAt = (f: PlannedFrame) => (f.offBeat ? Math.floor(f.atMs / 1000) * 1000 : f.atMs);
    const names = plan.frames.map((f) => ({ name: frameFileName(handle, shownAt(f), f.recording.kind, f.live, crop), atMs: shownAt(f) }));
    const paths = outputPaths(names, options.out, deps.scratch);
    // A frame as written, with what is only settled once every frame is in:
    // `held` is its "no new picture since" sentence, dropped when the frame
    // turns out to stand for several moments, and `stoodFor` those moments.
    // `swapped` is why a --composite frame is a screen, when it is one.
    const made: Array<{ result: SnapFrameResult; subject: string; held: string | null; stoodFor: number[]; swapped: "saving" | "unfilmed" | null }> = [];
    // --share refused by the server: why, said once for every frame after.
    let shareRefused: string | null = null;
    const byPicture = new Map<string, (typeof made)[number]>();
    // The recording is read a few frames at a time: each grab is one or two
    // ffmpeg runs over the network, and a range of eight one after another
    // was most of a minute. Everything that depends on order (a picture seen
    // twice, the moments one frame stands for) is settled afterwards, frame
    // by frame. Every grab started finishes before a failure is reported,
    // so no ffmpeg is still writing once the command has answered.
    const grabbed = await mapLimit(
      plan.frames,
      GRAB_CONCURRENCY,
      async (f, i) => {
        if (plan.frames.length > 1) deps.progress?.(`Frame ${i + 1}/${plan.frames.length} at ${formatCallTime(f.atMs)}`);
        try {
          return { ok: true as const, got: await grab(run, await source(f.recording, f.live), f, paths[i]) };
        } catch (err) {
          return { ok: false as const, err };
        }
      },
      { until: (r) => !r.ok },
    );
    const failed = grabbed.find((r) => r && !r.ok);
    if (failed && !failed.ok) throw failed.err;
    for (const [i, f] of plan.frames.entries()) {
      let out = paths[i];
      const g = grabbed[i];
      if (!g?.ok) continue;
      const { shownMs, stalled, forward, searchedMs, size, stallMs } = g.got;
      // A screen that did not change between two moments of a range gives
      // both the same frame of the same file. One picture is one file: the
      // copy is removed, and the first says how many moments it stands for.
      const picture = shownMs !== null ? `${f.recording.id}:${shownMs}` : null;
      const twin = picture ? byPicture.get(picture) : undefined;
      if (twin) {
        fs.rmSync(out, { force: true });
        twin.stoodFor.push(f.atMs);
        continue;
      }
      // When the picture was written, on the call's own clock. A screen that
      // did not change shows the picture last written to it; say from when, so
      // a reader never takes a held frame for a fresh one. A frame from after
      // the moment is a file's first picture, or the next one written when
      // the search back for an older one ran out before the file's start.
      const toCall = (fileMs: number) => f.atMs - (f.offsetMs! - fileMs);
      const shownAtMs = shownMs !== null && f.offsetMs !== null ? toCall(shownMs) : null;
      // A stalled share: LiveKit wrote black in place of it at the moment,
      // and a `<video>` seeked there shows the black. The whole second at or
      // after the last real picture, while it was still up, is a citation
      // that renders this very picture, when the view a citation takes there
      // is this file.
      const stalledAt = stalled && !forward && shownAtMs !== null && stallMs !== null ? toCall(stallMs) : null;
      const matchMs = stalledAt !== null ? Math.ceil(shownAtMs! / 1000) * 1000 : null;
      const matchCited =
        matchMs !== null && matchMs < stalledAt!
          ? locateCallMoment({ callStartedAt: recs.call_started_at, atMs: matchMs, recordings: playable, prefer: CALL_FRAME_PREFER, now: recs.server_now })
          : null;
      const matchRef = matchCited?.ok && matchCited.recording.id === f.recording.id ? callRefId(handle, null, matchMs!) : null;
      // A range chose its moment, so it moves to the one that renders the
      // picture written; a moment asked for keeps its name and offers it.
      const anchored = matchRef !== null && plan.range !== null;
      const atMs = anchored ? matchMs! : f.atMs;
      if (anchored && !options.out) {
        const moved = path.join(path.dirname(out), frameFileName(handle, atMs, f.recording.kind, f.live, crop));
        if (!fs.existsSync(moved)) {
          fs.renameSync(out, moved);
          out = moved;
        }
      }
      if (!options.out) secureTempFile(out);
      // Part of the picture, cut from the frame just written, now that its
      // size is known: one read of the recording whatever is cut from it.
      const cut = await cutFrame(run, out, size, crop, tiles, !options.out);
      const subject = recordingSubject(f.recording);
      const Subject = `${subject[0].toUpperCase()}${subject.slice(1)}`;
      const at = anchored ? formatCallTime(atMs) : preciseCallTime(shownAt(f));
      const ref = callRefId(handle, null, atMs);
      const own: string[] = [];
      let held: string | null = null;
      const late = shownAtMs !== null && shownAtMs - atMs >= 1000;
      if (anchored) {
        own.push(`${Subject} stalled at ${formatCallTime(stalledAt!)}; this is its last picture before that, ${ref}.`);
      } else if (stalled && !forward && shownAtMs !== null) {
        // The frame is the last real picture; the moment's own citation
        // shows the black.
        own.push(
          `${Subject} was stalled at ${at} and the recording holds black there, so this frame is its last real picture, from ${formatCallTime(shownAtMs)}` +
            (matchRef ? `; cite ${matchRef}, which renders this picture.` : `, and ${ref} in a message may render black.`),
        );
      } else if (shownAtMs !== null && f.atMs - shownAtMs >= 1000) {
        held = `No new picture of ${subject} was written after ${formatCallTime(shownAtMs)}, so the frame for ${at} is the one on screen since then.`;
      } else if (late && searchedMs !== null) {
        own.push(`No picture of ${subject} was found in the ${Math.round(searchedMs / 60_000)} minutes before ${at}; this frame is the next one written, from ${formatCallTime(shownAtMs!)}.`);
      } else if (late) {
        own.push(`${Subject} had no picture yet at ${at}; this frame is its first, from ${formatCallTime(shownAtMs!)}.`);
      }
      if (f.offBeat) own.push(`The screen changed just after ${formatCallTime(f.atMs)}, in the last moment of these lines; this frame is the picture after the change, and ${ref} names the one before it.`);
      // A moment asked for between two seconds: the citation names the whole
      // second before it, which may be another picture.
      const midSecond = !f.offBeat && !f.live && atMs % 1000 !== 0;
      if (midSecond) own.push(`${at} is between two seconds, and a citation names whole seconds: ${ref} renders the picture at ${formatCallTime(atMs)}, which may not be this one.`);
      // --composite is a preference, the way a bare snap prefers the screen:
      // where no finished room file reaches, the share is the only picture
      // there is. Either the room was not being filmed then (a share's file
      // starts a few seconds before the room's), or it was and its video has
      // not been uploaded yet. Say which, so a frame of a screen is never
      // taken for the room asked for.
      const roomSaving = spans.some((x) => x.kind === "composite" && x.pending && x.fromMs <= atMs && atMs < x.toMs);
      const swapped: "saving" | "unfilmed" | null = options.composite && f.recording.kind !== "composite" ? (roomSaving ? "saving" : "unfilmed") : null;
      // A line asked for is the line the frame is of, said through it or a
      // moment before it; any other frame takes the line being said then.
      const said = f.line ? { seg: f.line, during: f.line.t0 <= atMs && atMs < f.line.t1 } : lineAt(call.segments, atMs);
      // In a silence past the hold, the lines either side, so the frame can
      // still be placed in the transcript.
      const around = said ? null : linesAround(call.segments, atMs);
      const lineRef = (seg: SnapSegment) => ({ ref: callRefId(handle, { from_seq: seg.seq, to_seq: seg.seq }), at: formatCallTime(seg.t0) });
      // What `ref` renders as in a message: the view CALL_FRAME_PREFER picks
      // at that moment, on screen at that moment. It is this picture unless
      // the snap asked for another view, the picture came from after it, or
      // the share was stalled there (a message's video shows the filler).
      const cited = f.live ? null : locateCallMoment({ callStartedAt: recs.call_started_at, atMs, recordings: playable, prefer: CALL_FRAME_PREFER, now: recs.server_now });
      const citedRec = cited?.ok ? cited.recording : null;
      const result: SnapFrameResult = {
        path: out,
        width: cut.size?.width ?? null,
        height: cut.size?.height ?? null,
        crop: cut.crop,
        ...(cut.tiles ? { tiles: cut.tiles } : {}),
        ...(suggestTiles(cut.size, cut.crop, cut.tiles) ?? {}),
        ref,
        at,
        at_ms: atMs,
        kind: f.recording.kind,
        shows: subject,
        live: f.live,
        recording_id: f.recording.id,
        offset_ms: shownMs ?? f.offsetMs,
        shown_at: shownAtMs !== null ? formatCallTime(shownAtMs) : null,
        shown_at_ms: shownAtMs,
        requested_kind: requested,
        notes: own,
        citation_matches: !!citedRec && citedRec.id === f.recording.id && !late && (!stalled || anchored) && !f.offBeat && !midSecond,
        citation_shows: citedRec ? recordingSubject(citedRec) : null,
        ...(matchRef && !anchored ? { cite_instead: matchRef } : {}),
        // On the picture this frame is: a screen's file opens that sharer's
        // screen, the room's opens the room.
        call_url: `${deps.baseUrl}${callFrameHref(handle, atMs, f.recording)}`,
        line: said
          ? {
              ref: callRefId(handle, { from_seq: said.seg.seq, to_seq: said.seg.seq }),
              speaker: said.seg.speaker_name,
              text: said.seg.text,
              at: formatCallTime(said.seg.t0),
              at_ms: said.seg.t0,
              ended_ms: Math.max(said.seg.t0, said.seg.t1),
              during: said.during,
            }
          : null,
        between: around && (around.before || around.after) ? { before: around.before && lineRef(around.before), after: around.after && lineRef(around.after) } : null,
      };
      if (options.share && deps.share && shareRefused) {
        // Refused once is refused for the rest: the same call, the same rule.
        result.image_error = shareRefused;
      } else if (options.share && deps.share) {
        // The image is public to whoever holds its link, and its alt text
        // travels with it: the moment and the view, never the call's title.
        // The server stores it and ties it to the file it came from in one
        // step, so deleting the recording deletes the public image too, and
        // tells the room a picture of it went public (with the moment).
        try {
          const image = await deps.share(out, f.recording.id, `${ref}, ${subject}${f.live ? ", live" : ""}`, atMs);
          result.image = { url: image.url, markdown: image.markdown };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes(FRAME_SHARE_REFUSED_WORDS)) {
            // Not this caller's to publish (the server's mayShareFrame). The
            // reference is the way that is: it renders as this frame for
            // whoever may read the call, and for nobody else.
            shareRefused = `${FRAME_SHARE_REFUSED_WORDS} To show this moment, cite ${ref} in a message instead: it renders as the frame for whoever may read the call.`;
            result.image_error = shareRefused;
            own.push(`Not shared by link. ${shareRefused} The frame is still at ${out}.`);
          } else {
            result.image_error = message;
            own.push(`Could not upload ${path.basename(out)}: ${result.image_error}. The frame is still at ${out}.`);
          }
        }
      }
      const entry = { result, subject: Subject, held, stoodFor: [] as number[], swapped };
      made.push(entry);
      if (picture) byPicture.set(picture, entry);
    }
    for (const m of made) {
      if (m.stoodFor.length) {
        m.result.notes.unshift(
          `${m.subject} did not change from ${m.result.shown_at ?? m.result.at} to ${formatCallTime(Math.max(...m.stoodFor))}, so one frame stands for ${m.stoodFor.length + 1} of the moments across these lines.`,
        );
      } else if (m.held) {
        m.result.notes.unshift(m.held);
      }
    }
    const frames = made.map((m) => m.result);
    // The reader's notes: each frame's own, then the --composite fallback,
    // which a range can hit on every frame and is said once for all of them
    // (each frame still carries it, for a reader of one frame).
    for (const f of frames) notes.push(...f.notes);
    const swap = (why: "saving" | "unfilmed", times: string, n: number) => {
      const frame = n === 0 ? "this frame is" : n === 1 ? "that frame is" : "those frames are";
      return why === "saving"
        ? `The room's video for ${times} is still saving (it uploads when Record is stopped), so ${frame} the shared screen for now.`
        : `The room was not being recorded at ${times}, so ${frame} the shared screen instead.`;
    };
    for (const why of ["unfilmed", "saving"] as const) {
      const hit = made.filter((m) => m.swapped === why);
      if (hit.length) notes.push(swap(why, someTimes(hit.map((m) => m.result.at_ms)), hit.length));
      for (const m of hit) m.result.notes.push(swap(why, m.result.at, 0));
    }
    // More changes than frames: the frames are a spread of them, and the
    // reader is told how many it did not see and how to see them.
    const changes = plan.changes ?? null;
    if (changes && changes.found > changes.shown) {
      const need = max + changes.found - changes.shown;
      notes.push(
        `The screen changed ${changes.found} times across these lines; these ${frames.length} frames are spread through them. ` +
          (need <= MAX_RANGE_FRAMES ? `--max ${need}, or a narrower line range, shows every change.` : `A narrower line range shows every change.`),
      );
    }
    return {
      call: { id: recs.transcript_id, short_id: recs.short_id ?? call.short_id ?? null, title: call.title ?? null },
      target: target.moment.kind === "line" ? askedRef : frames[0]?.ref ?? handle,
      crop: options.crop != null ? String(options.crop) : null,
      tiles: options.tiles != null ? String(options.tiles) : null,
      range: plan.range,
      changes_found: changes?.found ?? null,
      frames,
      notes,
    };
  } catch (err) {
    // ffmpeg only ever sees the proxy answer 502. When that was the server
    // refusing to sign again (logged out, network down), say that.
    if (err instanceof SnapError && err.code === "ffmpeg_failed" && sources.lastError) {
      throw new SnapError("server", `Could not sign the recording link again: ${sources.lastError}`);
    }
    throw err;
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
    // Every row leads with its own reference: the thing to cite it by.
    const title = !many && res.call.title ? fmt.muted(` · ${res.call.title}`) : "";
    out.push(`${fmt.success(icons.check)} ${fmt.highlight(f.ref)} ${fmt.muted("·")} ${f.shows}${live}${title}`);
    const dims = f.width && f.height ? fmt.muted(` ${f.width}x${f.height}${f.crop ? ` (cropped at ${f.crop.x},${f.crop.y})` : ""}`) : "";
    out.push(`  ${fmt.path(f.path)}${dims}`);
    for (const t of f.tiles ?? []) out.push(`    ${fmt.path(t.path)} ${fmt.muted(`${t.part} ${t.width}x${t.height}`)}`);
    if (f.line) out.push(`  ${fmt.accent(f.line.speaker)} ${fmt.muted(f.line.ref)} ${quote(f.line.text)}${lastSaid(f)}`);
    else if (f.between) out.push(`  ${fmt.muted(`(nothing said; ${betweenWords(f.between)})`)}`);
    if (f.image) out.push(`  ${f.image.markdown}`);
  }
  for (const note of res.notes) out.push(fmt.warning(`Note: ${note}`));
  const sample = res.frames[0];
  if (sample) {
    out.push("");
    out.push(fmt.muted(citationWords(res.frames)));
  }
  // A wide frame is shrunk before a model reads it; small text may need
  // part of it. A room frame most of all: a share there is a tile beside the
  // camera column, its text smaller still than in the share's own file.
  // Offered once, only where it can help, with the grid that keeps every
  // tile at the frame's own pixels. One line, since a session that snaps
  // often reads it every time; the full --crop grammar is in --help and in
  // the refusal of a --crop it cannot read.
  const wide = res.frames.find((f) => f.suggested_tiles && f.kind === "screen") ?? res.frames.find((f) => f.suggested_tiles);
  if (wide && !res.crop && !res.tiles) {
    const tiles = `--tiles ${wide.suggested_tiles} for the whole frame in overlapping parts at full size`;
    out.push(
      fmt.muted(
        wide.kind === "screen"
          ? `Text small? cast call snap ${res.target} --crop top-left, or ${tiles}.`
          : `Text on a shared screen small? cast call snap ${res.target} ${tiles}, or --crop around the share.`,
      ),
    );
  }
  return out.join("\n");
}

/** When a line was said, against a later moment (`what`, "this frame"):
 *  when, and how long before the moment its words ended ("just before"
 *  within a few seconds), so words and picture are never read as one moment
 *  when they are not. The gap is measured from the end of the words, the
 *  last moment they and the moment shared. One phrasing for a frame's line
 *  and for `cast call cl-42@m:ss` in a silence. */
export function saidBefore(seg: { t0: number; t1: number }, atMs: number, what: string): string {
  const at = formatCallTime(seg.t0);
  const endedMs = Math.max(seg.t0, seg.t1);
  const ended = formatCallTime(endedMs);
  const said = ended === at ? `said at ${at}` : `said ${at}-${ended}`;
  const gap = Math.max(0, Math.round((atMs - endedMs) / 1000) * 1000);
  if (atMs - endedMs < CALL_JUST_SAID_MS) return `${said}, just before`;
  return `${said}, ${gap < 60_000 ? `${gap / 1000}s` : clockForName(gap)} before ${what}`;
}

/** Where a silent frame sits among the lines: `between cl-42:20 at 7:48
 *  and cl-42:21 at 9:40`, or the one side there is. */
function betweenWords(b: NonNullable<SnapFrameResult["between"]>): string {
  const line = (l: { ref: string; at: string }) => `${l.ref} at ${l.at}`;
  if (b.before && b.after) return `between ${line(b.before)} and ${line(b.after)}`;
  return b.before ? `since ${line(b.before)}` : `before ${line(b.after!)}`;
}

/** When a frame's line was said, against the frame: nothing while it is
 *  being said, else saidBefore. */
function lastSaid(f: SnapFrameResult): string {
  if (!f.line || f.line.during) return "";
  return fmt.muted(` (${saidBefore({ t0: f.line.at_ms, t1: f.line.ended_ms }, f.at_ms, "this frame")})`);
}

/**
 * The footer: how to cite a frame, and whether the citation renders as the
 * picture written. The citation is the way to show the team a frame; a
 * public upload is only ever asked for (--share), never suggested. The
 * promise is made frame by frame (`citation_matches`), so a range names the
 * frames it does not hold for instead of speaking for all of them from the
 * first.
 */
function citationWords(frames: readonly SnapFrameResult[]): string {
  const sample = frames[0];
  const kept = frames.filter((f) => !f.live);
  if (kept.length === 0) {
    return `A live picture is not kept, so it cannot be cited. Once the recording is saved, ${sample.ref} renders as that moment of the call.`;
  }
  const who = "for anyone who can read the call";
  // A citation that takes another view, or the same view at a moment whose
  // picture differs (a stalled share, a file's first picture).
  const otherView = (f: SnapFrameResult) => !f.citation_matches && f.citation_shows !== null && f.citation_shows !== f.shows;
  const otherPicture = (f: SnapFrameResult) => !f.citation_matches && !otherView(f);
  if (frames.length === 1) {
    const renders = sample.citation_matches
      ? "this picture"
      : otherView(sample)
        ? `${sample.citation_shows} at that moment, not the view shown here,`
        : `${sample.citation_shows ?? "the call"} at that moment, which may not be this picture (see the note),`;
    return `Cite a frame as ${sample.ref}: on its own line in a message it renders as ${renders} ${who}, linked to ${sample.call_url}`;
  }
  const except: string[] = [];
  const views = [...new Set(kept.filter(otherView).map((f) => f.citation_shows!))];
  for (const v of views) {
    const at = kept.filter((f) => otherView(f) && f.citation_shows === v).map((f) => f.at);
    except.push(`${someClocks(at)}, which render${at.length === 1 ? "s" : ""} as ${v}`);
  }
  const off = kept.filter(otherPicture).map((f) => f.at);
  if (off.length) except.push(`${someClocks(off)}, which may render as another picture (see the notes)`);
  return (
    `Cite any frame by its reference (${kept[0].ref}): on its own line in a message it renders as that frame's picture ${who}` +
    (except.length ? `, except ${except.join("; ")}` : "") +
    `, linked to the call page at that moment.`
  );
}

/** `cast call snap`: run, print, and exit non-zero with a plain reason on
 *  any refusal (as JSON with --json, so a script always reads JSON). */
export async function runCallSnap(target: string | undefined, options: SnapOptions, deps: SnapDeps, extra?: string): Promise<void> {
  const progress = options.json ? undefined : deps.progress ?? ((line: string) => process.stderr.write(`${fmt.muted(line)}\n`));
  try {
    const res = await snapCall(target, options, { ...deps, progress }, extra);
    // Each frame is remembered with the reference it cites, so the picture
    // an agent Reads syncs as that reference and never as the image
    // (callFrameRefs.ts): a frame of a private call stays as private as the
    // call. Best effort: a frame not remembered still prints.
    try {
      rememberCallFrames(res.frames);
    } catch {
      // The snap itself succeeded; say nothing a script would misread.
    }
    console.log(options.json ? JSON.stringify(res, null, 2) : formatSnapResult(res));
    // Frames asked to be shared that were not: the frames are written, but a
    // script that asked for markdown has none to paste.
    if (res.frames.some((f) => f.image_error)) process.exit(1);
  } catch (err) {
    const known = err instanceof SnapError;
    const message = err instanceof Error ? err.message : String(err);
    if (options.json) console.log(JSON.stringify({ error: message, code: known ? err.code : "failed", ...(known ? err.details : {}) }, null, 2));
    else console.error(`${fmt.error("Error:")} ${message}`);
    process.exit(1);
  }
}
