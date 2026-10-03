// A call's video, and the one rule for finding a moment inside it.
//
// A huddle is recorded on LiveKit's servers (Egress), never by a browser, so
// what is kept does not depend on whose tab stayed open. One press starts a
// RUN, and a run is several files:
//
//   composite  the room as people saw it: every face and the screen share,
//              laid out by LiveKit, with everyone's audio. The file a person
//              watches on the call page.
//   screen     one shared screen at its own resolution, no layout, no audio.
//              One file per share, started when the share appears and ended
//              when it stops. This is the file an agent's frame comes from:
//              text on a shared screen is legible here and mush in a composite
//              that has shrunk it to a tile.
//
// Every file is a row of `call_recordings` on the call's transcript (a call
// IS a transcripts row). Stopping and starting again in the same call adds
// rows; the call keeps all of them.
//
// TIME. Transcript lines carry t0/t1 in ms since the transcript's started_at,
// and a file's own time 0 is the wall clock its egress reported for the
// file's start. Both are wall clock underneath, so a moment is converted once,
// to wall ms, and every file is asked whether it covers it:
//
//   offset into file = transcript.started_at + atMs - recording.started_at
//
// That is the whole alignment; `locateCallMoment` is the only place it is
// written, so the CLI's frame grab, the call page's seek and a frame embed in
// a message can never disagree about which picture a line points at.

import { parseRoomKey } from "./callRoomKeys";

export const CALL_RECORDING_KINDS = ["composite", "screen"] as const;
export type CallRecordingKind = (typeof CALL_RECORDING_KINDS)[number];

// A file's life, as the reconciler reads it off LiveKit (ListEgress):
//   starting   asked for; LiveKit has not begun writing (no started_at yet)
//   recording  writing; started_at is known, the end is not
//   stopping   told to stop; LiveKit is finishing and uploading the file
//   ready      the file is in the bucket with its length; seekable
//   failed     LiveKit gave up, or never started; `error` says why
// Only `ready` files can be sought into: an MP4 is uploaded whole when it
// ends, so a file still recording has nothing in the bucket yet. What a
// recording file DOES have is a live frame, one JPEG LiveKit rewrites every
// couple of seconds, which is how the CLI shows a call as it is right now.
export const CALL_RECORDING_STATUSES = ["starting", "recording", "stopping", "ready", "failed"] as const;
export type CallRecordingStatus = (typeof CALL_RECORDING_STATUSES)[number];

/** A run is live while any of its files is still being written. */
export function isRecordingActive(status: CallRecordingStatus): boolean {
  return status === "starting" || status === "recording" || status === "stopping";
}

// Why a file stopped. "pressed" is somebody in the room (a guest included);
// "huddle_ended" is the call's record ending (the huddle is over);
// "room_empty" is the media room left with no teammate in it while the seat
// leases agree (guests may still be there); "share_ended" ends a screen file
// when its share stops while the run goes on; "limit" is a ceiling (ours or
// LiveKit's); "ended" is LiveKit finishing a file without saying why.
export const CALL_RECORDING_STOP_REASONS = ["pressed", "huddle_ended", "room_empty", "share_ended", "limit", "ended", "failed"] as const;
export type CallRecordingStopReason = (typeof CALL_RECORDING_STOP_REASONS)[number];

/** The fields of a recording row that alignment reads. Ids are strings so the
 *  web, the CLI and Convex all hand their own row shapes straight in. */
export type CallRecordingSpan = {
  id: string;
  kind: CallRecordingKind;
  status: CallRecordingStatus;
  /** Wall ms of the file's time 0. Absent until LiveKit reports it. */
  started_at?: number | null;
  /** Wall ms the file ends, when known. */
  ended_at?: number | null;
  /** The file's length, authoritative once ready. */
  duration_ms?: number | null;
  /** Screen files: whose screen. */
  participant_identity?: string | null;
  participant_name?: string | null;
};

/** Where a file sits on the wall clock, or null when it has not started. A
 *  ready file's length wins over its ended_at (the length is the file; the
 *  end stamp is when LiveKit noticed). A file still being written runs to
 *  `now`. */
export function recordingWindow<R extends CallRecordingSpan>(rec: R, now: number): { start: number; end: number } | null {
  if (rec.started_at == null || !Number.isFinite(rec.started_at)) return null;
  const start = rec.started_at;
  const end =
    rec.duration_ms != null && rec.duration_ms > 0
      ? start + rec.duration_ms
      : rec.ended_at != null
        ? rec.ended_at
        : isRecordingActive(rec.status)
          ? now
          : start;
  return { start, end: Math.max(start, end) };
}

/** How far into a file (ms) a moment of the call is, or null when the file
 *  does not cover it: the alignment rule above, over recordingWindow, with
 *  the end exclusive (a file has no frame at its own length). The one
 *  conversion; locateCallMoment and the call page's player both ask it. */
export function offsetIntoRecording<R extends CallRecordingSpan>(rec: R, callStartedAt: number, atMs: number, now: number = Date.now()): number | null {
  const w = recordingWindow(rec, now);
  const wall = callStartedAt + atMs;
  if (!w || wall < w.start || wall >= w.end) return null;
  return wall - w.start;
}

/** Does the call's public link show its video? Only when somebody chose it
 *  for this very link (setCallShareVideo): a link made to share a transcript
 *  never starts handing out faces and screens because Record was pressed
 *  later, and a link turned off and on is a new token that starts without. */
export function shareIncludesVideo(call: { share_token?: string | null; share_video_token?: string | null }): boolean {
  return !!call.share_token && call.share_video_token === call.share_token;
}

export type CallMomentPrefer = "composite" | "screen";

/**
 * Which view a frame of a call shows when nobody asked: the shared screen
 * whenever one was recorded at that moment, else the room. A frame is read,
 * not watched, and the text on a shared screen is legible only in the
 * share's own file. `cast call snap`, the frame a `cl-42@12:34` citation
 * renders as, and its hover picture all take this, so the picture an agent
 * saw is the one its readers see. The call page's player is the exception on
 * purpose: it plays the room, which is the file with everyone's sound, except
 * when a citation's link opens it (`view=screen`, callLinks.CallView): then it
 * shows the screen the citation showed, with the room's sound under it.
 */
export const CALL_FRAME_PREFER: CallMomentPrefer = "screen";

/** The files that can be shown: finished, signed, and placed on the clock.
 *  A ready file the server could not sign a link to (its bucket is not
 *  configured there) is left out, so a caller can say so rather than seek a
 *  null. Oldest first. */
export function playableFiles<R extends CallRecordingSpan & { url?: string | null }>(files: readonly R[]): R[] {
  return files
    .filter((f) => f.status === "ready" && !!f.url && f.started_at != null)
    .sort((a, b) => a.started_at! - b.started_at!);
}

/**
 * What a file shows, in words. `label` is the call page's view switch:
 * "Room", or the sharer's first name ("Ana's screen"). `prose` sits inside a
 * sentence: "the room", "Ana Ruiz's screen", "a shared screen".
 */
export function recordingSubject(
  rec: Pick<CallRecordingSpan, "kind" | "participant_name">,
  style: "label" | "prose" = "prose",
): string {
  const name = (rec.participant_name ?? "").trim();
  if (style === "label") {
    if (rec.kind === "composite") return "Room";
    const first = name.split(/\s+/)[0];
    return first ? `${first}'s screen` : "Screen";
  }
  if (rec.kind === "composite") return "the room";
  return name ? `${name}'s screen` : "a shared screen";
}

/** One stretch of the call a file covers, in call time (ms since the
 *  transcript's started_at). `pending` is a file still being written or
 *  uploaded: it covers the stretch but cannot be sought yet. */
export type CallCoveredSpan = {
  id: string;
  kind: CallRecordingKind;
  fromMs: number;
  toMs: number;
  pending: boolean;
  participant_name: string | null;
};

/** Every stretch of the call that has, or will have, a picture: each run's
 *  room file and each screen share inside it, in call time. Failed files and
 *  files LiveKit never started are left out. Ordered by start, the room
 *  before a share that starts with it. */
export function coveredSpans<R extends CallRecordingSpan>(recordings: readonly R[], callStartedAt: number, now: number): CallCoveredSpan[] {
  const out: CallCoveredSpan[] = [];
  for (const r of recordings) {
    if (r.status === "failed") continue;
    const w = recordingWindow(r, now);
    if (!w || w.end <= w.start) continue;
    out.push({
      id: r.id,
      kind: r.kind,
      fromMs: w.start - callStartedAt,
      toMs: w.end - callStartedAt,
      pending: r.status !== "ready",
      participant_name: r.participant_name ?? null,
    });
  }
  return out.sort((a, b) => a.fromMs - b.fromMs || (a.kind === b.kind ? 0 : a.kind === "composite" ? -1 : 1) || a.toMs - b.toMs);
}

/** The player clock for a time into a call: `0:07`, `12:34`, `1:02:03`.
 *  Whole seconds, rounded down, so the label never names a later second
 *  than the frame shows. Here beside the spans it names (entities re-exports
 *  it with the `cl-42@12:34` grammar it formats for). */
export function formatCallTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** The whole second at or after `ms`, or before it when that would pass
 *  `limit`: a moment a citation (`cl-42@m:ss`, whole seconds) can name
 *  exactly. */
export function wholeSecond(ms: number, limit = Infinity): number {
  const up = Math.ceil(ms / 1000) * 1000;
  return up <= limit ? up : Math.floor(ms / 1000) * 1000;
}

/** The recorded spans as one line: `0:00-4:10 the room, 1:02-3:30 Ana's
 *  screen`. What `cast call` prints and what the call page's header says. */
export function describeSpans(spans: readonly CallCoveredSpan[]): string {
  return spans
    .map((s) => `${formatCallTime(s.fromMs)}-${formatCallTime(s.toMs)} ${recordingSubject(s)}${s.pending ? " (still saving)" : ""}`)
    .join(", ");
}

/** The recorded moment nearest `atMs`, for a "try this instead" hint (the
 *  CLI's refusal, the call page's "the video starts at"): the moment itself
 *  when covered, else the closest edge of a finished span (a whole second
 *  inside it, since an end is exclusive), so the hint is a reference that
 *  will itself succeed. */
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

export type CallMomentHit<R extends CallRecordingSpan> = {
  ok: true;
  recording: R;
  /** Milliseconds into the recording's file. */
  offsetMs: number;
};

// Why no picture could be found, said so the caller can tell a person what to
// do about it rather than "not found":
//   no_recordings  the call was never recorded
//   not_ready      a file covers the moment but is still being written or
//                  uploaded; try again once the recording stops
//   outside        the call was recorded, just not at that moment (before
//                  the press, after the stop, or in a gap between runs).
//                  `covered` lists what was recorded, in call time, so the
//                  message can name the nearest stretch.
export type CallMomentMiss = {
  ok: false;
  reason: "no_recordings" | "not_ready" | "outside";
  covered: CallCoveredSpan[];
};

/**
 * The file and offset that show a call at `atMs` (ms since the transcript's
 * started_at, the same clock transcript lines use).
 *
 * `prefer: "screen"` takes a screen file covering the moment if there is one
 * and falls back to the composite (a frame of the room still shows the share,
 * smaller); the default takes the composite first and falls back to a screen
 * file. A frame of a moment passes CALL_FRAME_PREFER. Among several files of
 * one kind covering the moment (two people sharing at once, or a share
 * restarted), `identity` picks whose screen, and otherwise the most recently
 * started wins: the share somebody just put up is the one the room is looking
 * at.
 */
export function locateCallMoment<R extends CallRecordingSpan>(opts: {
  callStartedAt: number;
  atMs: number;
  recordings: readonly R[];
  prefer?: CallMomentPrefer;
  identity?: string | null;
  now?: number;
}): CallMomentHit<R> | CallMomentMiss {
  const now = opts.now ?? Date.now();
  const usable = opts.recordings.filter((r) => r.status !== "failed");
  const covered = coveredSpans(usable, opts.callStartedAt, now);
  if (usable.length === 0) return { ok: false, reason: "no_recordings", covered };

  const order: CallRecordingKind[] = opts.prefer === "screen" ? ["screen", "composite"] : ["composite", "screen"];
  let pending = false;
  for (const kind of order) {
    const hits = usable
      .filter((r) => r.kind === kind)
      // The end is exclusive: a file has no frame at its own length, so a
      // moment exactly at a stop belongs to whatever was recording next.
      .map((r) => ({ r, offset: offsetIntoRecording(r, opts.callStartedAt, opts.atMs, now) }))
      .filter((x): x is { r: R; offset: number } => x.offset !== null);
    const ready = hits.filter((x) => x.r.status === "ready");
    if (hits.length > ready.length) pending = true;
    if (ready.length === 0) continue;
    const mine = opts.identity ? ready.filter((x) => x.r.participant_identity === opts.identity) : [];
    // The latest start is the smallest offset into its file.
    const pick = (mine.length ? mine : ready).sort((a, b) => a.offset - b.offset)[0];
    return { ok: true, recording: pick.r, offsetMs: Math.max(0, pick.offset) };
  }
  return { ok: false, reason: pending ? "not_ready" : "outside", covered };
}

/**
 * The line being said at `atMs`, in a list ordered by t0: the one whose words
 * span it (t0 inclusive, t1 exclusive, the way a file's end is), else the
 * last one said before it while `holdMs` has not run out since it ended
 * (Infinity holds it through any silence, which is what a link to a time
 * lands on: a moment between two lines is still "after what Ann said").
 * `during` tells the two apart. Null before the first line, or in a silence
 * longer than the hold.
 */
export function segmentAt(
  segments: ReadonlyArray<{ t0: number; t1?: number | null }>,
  atMs: number,
  opts: { holdMs?: number } = {},
): { index: number; during: boolean } | null {
  let last: number | null = null;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.t0 > atMs) break;
    if (s.t1 != null && atMs < s.t1) return { index: i, during: true };
    last = i;
  }
  if (last === null || !opts.holdMs) return null;
  const s = segments[last];
  return atMs - Math.max(s.t0, s.t1 ?? s.t0) <= opts.holdMs ? { index: last, during: false } : null;
}

/**
 * The moments to sample across a stretch of a call (a transcript line range):
 * `count` points spread evenly from `fromMs` to `toMs`, ends included, never
 * more than one per `minGapMs`. A short stretch yields one frame, its middle,
 * rather than several copies of the same picture.
 */
export function sampleCallMoments(fromMs: number, toMs: number, count: number, minGapMs = 1000): number[] {
  const a = Math.min(fromMs, toMs);
  const b = Math.max(fromMs, toMs);
  const span = b - a;
  const n = Math.max(1, Math.min(Math.floor(count), Math.floor(span / Math.max(1, minGapMs)) + 1));
  if (n === 1) return [Math.round(a + span / 2)];
  return Array.from({ length: n }, (_, i) => Math.round(a + (span * i) / (n - 1)));
}

/** The moment a transcript line points at: where its first word was said. */
export function lineMomentMs(segment: { t0: number }): number {
  return Math.max(0, segment.t0);
}

// The call page reads a recording through a presigned URL that stays
// byte-identical for one window (convex lib/r2.ts stableSigningWindow) and
// works for two. A reactive query cannot notice time passing, so the page
// passes the window it is in (`url_window`, below, required) and the server
// signs AT that window: the answer is a pure function of its arguments, and
// moving to the next window is the whole refresh, four times an hour rather
// than every second. The CLI and the public share page never subscribe, so
// their URLs are signed fresh and short on each request instead.
export const CALL_RECORDING_URL_WINDOW_MS = 15 * 60 * 1000;

/** The `url_window` argument for a recordings query at `now`. */
export function callRecordingUrlWindow(now: number = Date.now()): number {
  return Math.floor(now / CALL_RECORDING_URL_WINDOW_MS);
}

// ── A press is a moment ───────────────────────────────────────────────────
//
// Record and Stop are things a person does to a room NOW. The client's
// writes ride a durable outbox, which is right for a message and wrong for
// this: a press parked through a network blip and delivered a minute later,
// or replayed when the tab reloads, would start filming a room nobody just
// asked to film (or end a run somebody else has since started). So a press
// carries the wall clock it was made at, and both ends refuse one that is no
// longer a moment: the client before it leaves the browser (the stale row is
// dropped from the outbox), the server when it arrives (dispatch
// setRoomRecording), which is what holds for a client that did not check.
// Half a minute rather than a few seconds because the stamp is the client's
// clock read against the server's: a machine running a little behind must
// not have every press refused.
export const RECORDING_PRESS_FRESH_MS = 30_000;

/** A press within this long of the room's last stop is refused: LiveKit is
 *  still finishing that file, and Record toggled as fast as a hand can press
 *  it would start a billed egress per press. Counted from when the stop was
 *  asked for, never from LiveKit's upload (which can take minutes), and the
 *  same rule on both ends: the server refuses inside it (convex
 *  callRecordings.startRecording) and the Record button waits it out. */
export const RECORDING_RESTART_COOLDOWN_MS = 5_000;

/** Is a press made at `pressedAt` too old to act on at `now`? A press with no
 *  stamp (a client older than the rule) is taken as made now. */
export function recordingPressStale(pressedAt: unknown, now: number): boolean {
  return typeof pressedAt === "number" && now - pressedAt > RECORDING_PRESS_FRESH_MS;
}

/** What a person is told when their press was dropped as stale. */
export function recordingPressStaleWords(on: boolean): string {
  return on
    ? "That press did not reach the server in time, so nothing was recorded. Press Record again."
    : "That press did not reach the server in time, so the recording was not stopped. Press Stop again.";
}

// ── Words ─────────────────────────────────────────────────────────────────
//
// What people are told about a recording, written once, so the member's
// first-press question, a guest's notice, the call page and the room's thread
// cannot drift apart. Recording other people is a consent question, and the
// words must say exactly what the access rule does.

/** Who can watch a room's recording (transcripts.canReadCall: whoever may
 *  open the room's calls, which for a huddle is whoever may enter its room).
 *  Without a room key (a guest's page, which is never told the room's kind)
 *  it names the hosts' team, the widest a huddle's room reaches. */
export function recordingAudience(roomKey?: string | null): string {
  const kind = roomKey ? parseRoomKey(roomKey)?.kind : null;
  if (kind === "dm") return "the people this huddle is between";
  if (kind === "channel") return "everyone in the channel";
  if (kind === "session") return "everyone who can open the session";
  return "the team hosting it";
}

/** Where the video goes once it is kept, in one sentence: with the call, for
 *  the room's audience, and for a public link only when somebody shares the
 *  video on it (shareIncludesVideo: off on every link until turned on). */
export function recordingKeptWords(roomKey?: string | null): string {
  return `The video stays with the call, where ${recordingAudience(roomKey)} can watch it, and anyone with the call's public link if someone shares the video on it.`;
}

/** How a run that stopped by itself is said, by its reason, for the room's
 *  thread and the notice: null for the reasons said otherwise (a press names
 *  who pressed, a failure gives its words). Each says only what is true: the
 *  huddle ending, the media room left without a teammate (guests may still
 *  be in it), a ceiling, or LiveKit closing the file without a reason. */
export function recordingStoppedItselfWords(reason: string | null | undefined): string | null {
  switch (reason) {
    case "huddle_ended":
      return "Recording stopped when the huddle ended";
    case "room_empty":
      return "Recording stopped: no teammate was left in the call";
    case "limit":
      return "Recording stopped at its time limit";
    case "ended":
    case "share_ended":
      return "Recording stopped";
    default:
      return null;
  }
}

/** A failed run's reason as a sentence a person reads. The server's own
 *  reasons (convex callRecordings: "Recording is not set up ...", "Stopped
 *  before ...", "LiveKit lost track ...") already are one; LiveKit's raw
 *  errors get the plain prefix. */
export function recordingFailureWords(error: string | null | undefined): string {
  const e = (error ?? "").trim();
  if (!e) return "The recording failed.";
  if (/^(the recording|recording is|stopped before|livekit (lost|accepted))/i.test(e)) return e;
  return `The recording failed. ${e}`;
}
