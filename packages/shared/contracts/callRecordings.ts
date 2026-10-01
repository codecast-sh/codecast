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
// "huddle_ended" is the room emptying; "share_ended" ends a screen file when
// its share stops while the run goes on; "limit" is LiveKit's own ceiling.
export const CALL_RECORDING_STOP_REASONS = ["pressed", "huddle_ended", "share_ended", "limit", "failed"] as const;
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

export type CallMomentPrefer = "composite" | "screen";

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
  covered: Array<{ fromMs: number; toMs: number; kind: CallRecordingKind }>;
};

/**
 * The file and offset that show a call at `atMs` (ms since the transcript's
 * started_at, the same clock transcript lines use).
 *
 * `prefer: "screen"` takes a screen file covering the moment if there is one
 * and falls back to the composite (a frame of the room still shows the share,
 * smaller); the default takes the composite first and falls back to a screen
 * file. Among several files of one kind covering the moment (two people
 * sharing at once, or a share restarted), `identity` picks whose screen, and
 * otherwise the most recently started wins: the share somebody just put up is
 * the one the room is looking at.
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
  const wall = opts.callStartedAt + opts.atMs;
  const usable = opts.recordings.filter((r) => r.status !== "failed");
  const covered = usable
    .map((r) => ({ r, w: recordingWindow(r, now) }))
    .filter((x): x is { r: R; w: { start: number; end: number } } => x.w !== null && x.w.end > x.w.start)
    .map(({ r, w }) => ({ fromMs: w.start - opts.callStartedAt, toMs: w.end - opts.callStartedAt, kind: r.kind }))
    .sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
  if (usable.length === 0) return { ok: false, reason: "no_recordings", covered };

  const order: CallRecordingKind[] = opts.prefer === "screen" ? ["screen", "composite"] : ["composite", "screen"];
  let pending = false;
  for (const kind of order) {
    const hits = usable
      .filter((r) => r.kind === kind)
      .map((r) => ({ r, w: recordingWindow(r, now) }))
      // The end is exclusive: a file has no frame at its own length, so a
      // moment exactly at a stop belongs to whatever was recording next.
      .filter((x) => x.w && wall >= x.w.start && wall < x.w.end) as Array<{ r: R; w: { start: number; end: number } }>;
    const ready = hits.filter((x) => x.r.status === "ready");
    if (hits.length > ready.length) pending = true;
    if (ready.length === 0) continue;
    const mine = opts.identity ? ready.filter((x) => x.r.participant_identity === opts.identity) : [];
    const pick = (mine.length ? mine : ready).sort((a, b) => b.w.start - a.w.start)[0];
    return { ok: true, recording: pick.r, offsetMs: Math.max(0, wall - pick.w.start) };
  }
  return { ok: false, reason: pending ? "not_ready" : "outside", covered };
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
