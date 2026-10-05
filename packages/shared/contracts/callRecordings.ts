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
import { isGuestIdentity, markedName, normalizeGuestName } from "./callGuests";

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

/** A run is live while any of its files is still being written. Active
 *  includes "stopping": LiveKit is still finishing and uploading the file, so
 *  the run holds its place (no second press, the loop keeps looking). */
export function isRecordingActive(status: CallRecordingStatus): boolean {
  return status === "starting" || status === "recording" || status === "stopping";
}

/** Is this file filming the room right now? Unlike isRecordingActive, a
 *  "stopping" file is not: somebody has already pressed stop, so what happens
 *  in the room from here is not being kept. Every surface that tells people
 *  they are on camera (the REC mark, a live frame, the CLI's "filming" note)
 *  asks this, so a new status lands on all of them at once. No status (no
 *  run) is not filming. */
export function isRecordingFilming(status: CallRecordingStatus | null | undefined): boolean {
  return status === "starting" || status === "recording";
}

// Why a file stopped. "pressed" is somebody in the room (a guest included);
// "huddle_ended" is the call's record ending (the huddle is over);
// "room_empty" is the media room left with no teammate in it while the seat
// leases agree (guests may still be there); "share_ended" ends a screen file
// when its share stops while the run goes on; "limit" is a ceiling (ours or
// LiveKit's); "ended" is LiveKit finishing a file without saying why;
// "calls_off" is an admin turning calls off for the team, which takes the
// room (and its REC mark, and every Stop) away from the people in it.
export const CALL_RECORDING_STOP_REASONS = ["pressed", "huddle_ended", "room_empty", "share_ended", "limit", "ended", "failed", "calls_off"] as const;
export type CallRecordingStopReason = (typeof CALL_RECORDING_STOP_REASONS)[number];

// What kind of failure a failed file's `error` words describe, kept beside the
// words so decisions never read copy: "minutes_spent" is the plan out of
// recording minutes (no retry can succeed until someone raises it); "busy" is
// no egress capacity this minute (passes on its own); "credentials" is LiveKit
// refusing this server's keys; "server" is this server's own fault (storage,
// configuration, an exception); "livekit" is anything else LiveKit did.
export const CALL_RECORDING_ERROR_KINDS = ["minutes_spent", "busy", "credentials", "server", "livekit"] as const;
export type CallRecordingErrorKind = (typeof CALL_RECORDING_ERROR_KINDS)[number];

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
 *
 * A guest's share is decided by the sharer's IDENTITY, never their name: the
 * name is whatever the guest typed, so a guest calling themselves "Ashot"
 * must not read as Ashot's screen. The stored name already carries the
 * room's "(guest)" (guestDisplayName); it is stripped and the mark put back
 * where it reads as one. Prose says "Riley Harness's screen (guest)"; a
 * label stays "Riley's screen" because every surface that draws one puts its
 * guest badge right after it (ParticipantTag on the identity).
 */
export function recordingSubject(
  rec: Pick<CallRecordingSpan, "kind" | "participant_name" | "participant_identity">,
  style: "label" | "prose" = "prose",
): string {
  const guest = isGuestIdentity(rec.participant_identity);
  const name = (guest ? normalizeGuestName(rec.participant_name) : rec.participant_name?.trim()) ?? "";
  if (style === "label") {
    if (rec.kind === "composite") return "Room";
    const first = name.split(/\s+/)[0];
    return first ? `${first}'s screen` : "Screen";
  }
  if (rec.kind === "composite") return "the room";
  if (name) return markedName(name, rec.participant_identity, null, "'s screen");
  return guest ? "a guest's shared screen" : "a shared screen";
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
  /** Screen spans: whose screen, the identity deciding a guest's mark. */
  participant_identity: string | null;
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
      participant_identity: r.participant_identity ?? null,
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

/** A time into a call as prose writes it: `754s`, `12:34`, `1:02:03`. */
export const CALL_TIME_SOURCE = "\\d+s|\\d+(?::[0-5]\\d){1,2}";

/** A time into a call in ms (`754s`, `12:34`, `1:02:03`), or null: the
 *  reader of what formatCallTime writes. */
export function parseCallTime(text: string | null | undefined): number | null {
  const s = (text || "").trim();
  if (!new RegExp(`^(?:${CALL_TIME_SOURCE})$`, "i").test(s)) return null;
  if (/s$/i.test(s)) return Number(s.slice(0, -1)) * 1000;
  return s.split(":").reduce((acc, part) => acc * 60 + Number(part), 0) * 1000;
}

/** The whole second at or after `ms`, or before it when that would pass
 *  `limit`: a moment a citation (`cl-42@m:ss`, whole seconds) can name
 *  exactly. */
export function wholeSecond(ms: number, limit = Infinity): number {
  const up = Math.ceil(ms / 1000) * 1000;
  return up <= limit ? up : Math.floor(ms / 1000) * 1000;
}

/** A stretch of a call as a clock pair: `2:12-6:15`. The one way every
 *  surface writes a range of call time (the CLI, the call page's header). */
export function describeClockSpan(span: { fromMs: number; toMs: number }): string {
  return `${formatCallTime(span.fromMs)}-${formatCallTime(span.toMs)}`;
}

/** Several stretches as clock pairs: `2:12-6:15, 9:40-12:02`. */
export function describeClockSpans(spans: ReadonlyArray<{ fromMs: number; toMs: number }>): string {
  return spans.map(describeClockSpan).join(", ");
}

/** The reader of describeClockSpans: `2:12-6:15, 9:40-12:02` back into
 *  stretches, or null when any pair is not a clock pair. */
export function parseClockSpans(text: string | null | undefined): Array<{ fromMs: number; toMs: number }> | null {
  const parts = (text ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: Array<{ fromMs: number; toMs: number }> = [];
  for (const p of parts) {
    const [a, b, extra] = p.split("-");
    const fromMs = parseCallTime(a);
    const toMs = parseCallTime(b);
    if (extra !== undefined || fromMs === null || toMs === null) return null;
    out.push({ fromMs, toMs });
  }
  return out;
}

/** The filmed stretches as a reader sees them: the union of every span, a
 *  screen inside its room's run adding nothing, so a surface can say which
 *  part of a call has video (the call page's header, a huddle's digest) and
 *  the transcript can mark the lines in it. */
export function videoStretches(spans: ReadonlyArray<{ fromMs: number; toMs: number }>): Array<{ fromMs: number; toMs: number }> {
  const out: Array<{ fromMs: number; toMs: number }> = [];
  for (const s of [...spans].sort((a, b) => a.fromMs - b.fromMs)) {
    const last = out[out.length - 1];
    if (last && s.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, s.toMs);
    else out.push({ fromMs: s.fromMs, toMs: s.toMs });
  }
  return out;
}

/** One recorded span in words: `1:02-3:30 Ana's screen (still saving)`.
 *  `lead` replaces the clock pair when a caller has more to say before the
 *  subject (`cast call`'s `lines 6-41 (2:12-6:15)`). */
export function describeSpan(span: CallCoveredSpan, lead: string = describeClockSpan(span)): string {
  return `${lead} ${recordingSubject(span)}${span.pending ? " (still saving)" : ""}`;
}

/** The recorded spans as one line: `0:00-4:10 the room, 1:02-3:30 Ana's
 *  screen`. What `cast call` prints and what the call page's header says. */
export function describeSpans(spans: readonly CallCoveredSpan[]): string {
  return spans.map((s) => describeSpan(s)).join(", ");
}

/** How far inside a span's end nearestRecordedMs lands when the moment is
 *  past it. A file's last second is where a share's stall or its ending
 *  sits (LiveKit's black filler, the window closing), so a hint aimed at it
 *  shows filler more often than the picture that was up. */
export const NEAREST_END_INSET_MS = 2_000;

/** The recorded moment nearest `atMs`, for a "try this instead" hint (the
 *  CLI's refusal, the call page's "the video starts at"): the moment itself
 *  when covered, else the closest edge of a finished span (a whole second
 *  inside it), so the hint is a reference that will itself succeed. An end
 *  is approached from NEAREST_END_INSET_MS inside it, never its last
 *  keyframe, unless the span is shorter than that. */
export function nearestRecordedMs(spans: readonly CallCoveredSpan[], atMs: number): number | null {
  let best: number | null = null;
  for (const s of spans) {
    if (s.pending) continue;
    const end = Math.max(s.fromMs, Math.min(s.toMs - 1, s.toMs - NEAREST_END_INSET_MS));
    const at = wholeSecond(atMs >= s.toMs ? end : Math.max(atMs, s.fromMs), s.toMs - 1);
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

/** How long after its last word a line is still "what was being said" at a
 *  silent moment of a call. Past it the moment has no line. */
export const CALL_LAST_SAID_HOLD_MS = 20_000;
/** A line whose words ended this close before a moment reads as said with
 *  it; further back, a surface says when it was said, so words and picture
 *  are never read as one moment when they are not. */
export const CALL_JUST_SAID_MS = 3_000;

/** The line a moment of a call is captioned with: the one being said then,
 *  else the last one said a little before it (segmentAt held for
 *  CALL_LAST_SAID_HOLD_MS). One rule for `cast call snap` and a `cl-42@12:34`
 *  card, so both name the same line beside the same picture. */
export function lineSaidAt(
  segments: ReadonlyArray<{ t0: number; t1?: number | null }>,
  atMs: number,
): { index: number; during: boolean } | null {
  return segmentAt(segments, atMs, { holdMs: CALL_LAST_SAID_HOLD_MS });
}

/**
 * What a synced transcript holds where an agent looked at a frame of a call
 * (`cast call snap`, then a Read of the picture): the moment's reference,
 * never the picture. The picture would otherwise ride the session's message
 * to everyone who can read the session (a team feed, a public share link),
 * none of whom the call's own access rule was asked about, and would outlive
 * the recording it came from. The reference renders as that frame for a
 * reader the call admits, and as nothing once the recording is deleted. The
 * agent's own model input is untouched: this is only what codecast keeps.
 */
export function callFrameSeenText(ref: string): string {
  return `Frame of the call: ${ref}`;
}

/** The moment a tool result's text says the agent looked at, or null. */
export function callFrameSeenRef(text: string | null | undefined): string | null {
  const m = /(?:^|\n)Frame of the call: (cl-\d+@[0-9:.]+s?)[ \t]*(?:\n|$)/.exec(text ?? "");
  return m ? m[1] : null;
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

/**
 * The moment a transcript line points at, and the moment its frame is taken:
 * the first whole second a little after its first word. One rule for every
 * surface (`cast call snap cl-42:<line>`, `cast call`'s [video] marks, the
 * call page's filmed rail and its links), so a line reads as filmed in one
 * place exactly when it does in the others, and a link to it lands on the
 * second the CLI cites. A little after, because a line's t0 is where the
 * recognizer heard speech begin and the speaker is still finishing the
 * gesture that goes with it; a whole second, because the citation printed
 * beside the frame is `cl-42@12:34` and a whole second is what it can name,
 * so the frame an agent cites is the frame it saw. A line too short to reach
 * that second takes the first whole second at or after its start, even when
 * that is a moment past its last word: never a second before it began, which
 * shows what was on screen during the line before it (a quarter of the lines
 * of a real call span no whole second), and at most a second late, still the
 * picture being pointed at.
 */
export function lineFrameMs(seg: { t0: number; t1?: number }): number {
  const start = Math.max(0, seg.t0);
  const end = Math.max(start, seg.t1 ?? start);
  const nudged = Math.ceil((start + 250) / 1000) * 1000;
  return nudged <= end ? nudged : Math.ceil(start / 1000) * 1000;
}

/** Whether a line was on camera: some stretch covers the moment its frame is
 *  taken (lineFrameMs), the moment `cast call snap cl-42:<line>` shows. */
export function lineFilmed(spans: ReadonlyArray<{ fromMs: number; toMs: number }>, seg: { t0: number; t1?: number }): boolean {
  const at = lineFrameMs(seg);
  return spans.some((s) => s.fromMs <= at && at < s.toMs);
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

/** Is a room's Record press still waiting out that cooldown? Its run is
 *  stopping and the stop was asked for less than the cooldown ago (or when,
 *  is not known yet). The Record button on every platform asks this, so the
 *  web's and the phone's "saving" agree with what the server would refuse. */
export function recordingCooling(status: CallRecordingStatus | null | undefined, stopRequestedAt: number | null | undefined, now: number): boolean {
  return status === "stopping" && (stopRequestedAt == null || now - stopRequestedAt < RECORDING_RESTART_COOLDOWN_MS);
}

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
 *  open the room's calls, which for a huddle is whoever may enter its room,
 *  and any teammate seated in it while it recorded, `recorded_people`, even
 *  one rung in on an invite for a minute: they may watch every run). A
 *  room narrower than the team names that second door too. Without a room
 *  key (a guest's page, which is never told the room's kind) it names the
 *  hosts' team, the widest a huddle's room reaches, which holds them all. */
export function recordingAudience(roomKey?: string | null): string {
  const kind = roomKey ? parseRoomKey(roomKey)?.kind : null;
  const seated = " and any teammate who sat in it while it recorded";
  if (kind === "dm") return `the people this huddle is between${seated}`;
  if (kind === "channel") return `everyone in the channel${seated}`;
  if (kind === "session") return `everyone who can open the session${seated}`;
  return "the team hosting it";
}

/** Where the video goes once it is kept: with the call, for the room's
 *  audience; on a public link only when somebody shares the video on it
 *  (shareIncludesVideo: off on every link until turned on); and a single
 *  picture from it by link only from whoever may share the video, or the
 *  person whose screen the picture shows (mayShareFrame). */
export function recordingKeptWords(roomKey?: string | null): string {
  return `The video stays with the call, where ${recordingAudience(roomKey)} can watch it, and anyone with the call's public link if someone shares the video on it. Whoever recorded it, or the person whose screen a picture shows, can also share single pictures from it by link.`;
}

/** Why a picture from a recording was not put on a public link: who may (the
 *  server's mayShareFrame), in words a person or an agent reads. `cast call
 *  snap --share` adds the access-checked alternative, the moment's
 *  reference, which only someone who may read the call can open. */
export const FRAME_SHARE_REFUSED_WORDS =
  "Only whoever recorded this call, a team admin, or the person whose screen it shows can share a picture from it by link.";

/** Why a reader of a call may not open it to anyone: the server's
 *  mayPublishCall, said by the refusal and by the share popover before the
 *  press. Closing the link is any reader's. */
export const CALL_LINK_REFUSED_WORDS = "Only someone who was in this call, or a team admin, can open it to anyone.";

/** How a run that stopped by itself is said, by its reason, for the room's
 *  thread and the notice: null for the reasons said otherwise (a press names
 *  who pressed, a failure gives its words). Each says only what is true: the
 *  huddle ending, the media room left without a teammate (guests may still
 *  be in it), a ceiling, or LiveKit closing the file with no cause the
 *  room could see, which says so rather than reading as unexplained. */
export function recordingStoppedItselfWords(reason: string | null | undefined): string | null {
  switch (reason) {
    case "huddle_ended":
      return "Recording stopped when the huddle ended";
    case "room_empty":
      return "Recording stopped: no teammate was left in the call";
    case "limit":
      return "Recording stopped at its time limit";
    case "ended":
      return "Recording stopped: the media server closed the file";
    case "share_ended":
      return "Recording stopped";
    case "calls_off":
      return "Recording stopped: calls were turned off for this team";
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

/** A stopped recording whose video then failed to save: the room was told it
 *  was saving, so this is said on its own (the thread's record_lost line,
 *  the presser's notice), with the server's plain words for why. */
export const RECORDING_LOST_TITLE = "Recording could not be saved";

export function recordingLostWords(error: string | null | undefined): string {
  const e = (error ?? "").trim();
  return e ? `${RECORDING_LOST_TITLE}. ${e}` : `${RECORDING_LOST_TITLE}.`;
}
