// One transcription run, on however many microphones it is handed.
//
// This is the shared middle of the two things that transcribe: the huddle
// scribe (lib/calls/transcription) attaches every audio track in a LiveKit
// room, and the recorder (lib/calls/recorder) attaches one local microphone.
// Everything between the recognizer and the server is identical for both and
// lives here: which tracks have a pipe open, what to do when one drops,
// appending completed utterances, the rolling caption tail, and the silence
// beat on which live routes deliver.
//
// It is a FACTORY, not a module singleton, because a person can record the
// meeting in the room while sitting in a huddle. Two runs, two sets of pipes,
// two flush clocks, one policy — the alternative was a second copy of that
// policy that would drift the first time either side was tuned.
//
// The recognizer itself is lib/calls/asrPipe: one websocket per track, PCM in,
// VAD boundaries and completed utterances out. Nothing here touches audio.
import { api } from "@codecast/convex/convex/_generated/api";
import { openAsrPipe, type AsrPipe } from "./asrPipe";

export type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
};

// Silence long enough to count as a conversational gap. VAD closes an
// utterance at 600ms; a gap is a real lull, not a breath.
export const GAP_MS = 2_500;
export const FLUSH_MIN_INTERVAL_MS = 8_000;
// The hold limit: how long undelivered words may wait for a lull before the
// engine flushes mid-conversation. Also unwedges a pipe whose VAD sticks with
// `speaking` true, which would otherwise block delivery forever.
export const MAX_HOLD_MS = 30_000;
// The hold limit while every fed agent is mid-turn. The server holds context
// for a busy agent anyway and delivers it when the turn ends, so a flush in
// that window only spends a mutation and an action to be told to wait; the
// engine flushes rarely instead. A line that names an agent flushes on the
// next lull as usual, so an ask reaches a working agent at once.
export const WORKING_HOLD_MS = 180_000;

/** What the engine knows about the agents the words go to, asked at every
 *  tick. `busy` is true only while EVERY fed agent is mid-turn (one idle
 *  agent wants the lull cadence); `addressed` says whether a spoken line
 *  names one of them. Both read the store on the caller's side. */
export type ScribePacing = {
  busy(): boolean;
  addressed(text: string): boolean;
};

/** Whether the gap watcher flushes on this tick. Pure, so the cadence is one
 *  readable rule with tests: never within FLUSH_MIN_INTERVAL_MS of the last
 *  flush; then on a lull, or when the oldest words have waited the hold
 *  limit. A busy room of agents that nobody addressed gets only the long
 *  hold, never the lull. */
export function flushDue(opts: {
  sinceFlushMs: number;
  anySpeaking: boolean;
  quietForMs: number | null;
  heldForMs: number | null;
  busy: boolean;
  addressed: boolean;
}): boolean {
  if (opts.sinceFlushMs < FLUSH_MIN_INTERVAL_MS) return false;
  const waitForTurn = opts.busy && !opts.addressed;
  const quiet = !opts.anySpeaking && opts.quietForMs !== null && opts.quietForMs >= GAP_MS;
  const limit = waitForTurn ? WORKING_HOLD_MS : MAX_HOLD_MS;
  const heldTooLong = opts.heldForMs !== null && opts.heldForMs >= limit;
  return (quiet && !waitForTurn) || heldTooLong;
}

/** A segment the server refused or the network dropped, waiting for the gap
 *  watcher's next tick to send it again. `at` is the first failure, so the
 *  age bound counts from the words, not from the latest retry. */
export type FailedAppend<S = unknown> = { at: number; segment: S };
// The retry list is small and short-lived: a transcript the server keeps
// refusing must not grow it for the length of a call.
export const APPEND_RETRY_MAX = 20;
export const APPEND_RETRY_MAX_AGE_MS = 60_000;

/** Fold freshly failed appends into the retry list under both bounds. Pure:
 *  returns the list to keep and how many segments were given up on, which
 *  the caller surfaces as a lasting status error. */
export function settleFailedAppends<S>(
  queue: FailedAppend<S>[],
  failed: FailedAppend<S>[],
  now: number,
): { queue: FailedAppend<S>[]; dropped: number } {
  const all = [...queue, ...failed].filter((f) => now - f.at < APPEND_RETRY_MAX_AGE_MS);
  const kept = all.slice(-APPEND_RETRY_MAX);
  return { queue: kept, dropped: queue.length + failed.length - kept.length };
}
/** How much of the transcript the status snapshot carries: enough for a
 *  caption strip or a recording pill, never the transcript itself. */
const TAIL = 6;

export type ScribeStatus = {
  active: boolean;
  transcriptId: string | null;
  trackCount: number;
  error: string | null;
  /** Rolling caption tail, newest last. */
  tail: Array<{ speaker: string; text: string }>;
  /** When this run started (wall clock), null while idle. What a room-level
   *  "stop transcribing" is compared against: only an opt-out switched on
   *  AFTER this ends the run (lib/calls/autoScribe). */
  startedAt: number | null;
};

const IDLE: ScribeStatus = {
  active: false,
  transcriptId: null,
  trackCount: 0,
  error: null,
  tail: [],
  startedAt: null,
};

export type ScribeEngine = {
  subscribe(cb: () => void): () => void;
  getStatus(): ScribeStatus;
  /** Open the transcript. Returns its id, or null when this client is not
   *  the scribe: the server refused, somebody else's run is live in the room
   *  ("observer"), or the huddle turned transcription off and this was an
   *  `auto` start. Null means nothing was armed — attach nothing. */
  start(opts: {
    convex: ConvexHandle;
    roomKey: string;
    routes?: Array<{ kind: "session" | "doc" | "slack"; target: string; mode: "live" | "after" }>;
    auto?: boolean;
    pacing?: ScribePacing;
  }): Promise<string | null>;
  /** Put a microphone on the run. `key` is the caller's handle for it and the
   *  only thing `detach` needs; a repeat attach on a live key is ignored. */
  attach(key: string, track: MediaStreamTrack, speakerId: string, speakerName: string): void;
  detach(key: string): void;
  /** Milliseconds since `start`, which is the clock every segment offset uses. */
  elapsed(): number;
  stop(opts?: { keepLive?: boolean; graceful?: boolean }): Promise<void>;
};

export function createScribeEngine(): ScribeEngine {
  let status: ScribeStatus = IDLE;
  const subscribers = new Set<() => void>();
  function emit(patch: Partial<ScribeStatus>) {
    status = { ...status, ...patch };
    for (const cb of subscribers) cb();
  }

  let convex: ConvexHandle | null = null;
  let roomKey = "";
  let transcriptId: string | null = null;
  let startedAt = 0;
  // Zero on the record's clock: segment t0/t1 are offsets from the huddle's
  // start, and one huddle is many runs (handoffs, adoptions, off and on).
  let epoch = 0;
  const pipes = new Map<string, AsrPipe>();
  let lastSpeechEndMs = 0;
  let anySegmentsSinceFlush = false;
  let addressedSinceFlush = false;
  let firstUnflushedAt = 0;
  let lastFlushAt = 0;
  let gapTimer: ReturnType<typeof setInterval> | null = null;
  let pacing: ScribePacing | null = null;
  type Segment = { speaker_id: string; speaker_name: string; text: string; t0: number; t1: number };
  let failedAppends: FailedAppend<Segment>[] = [];

  function nowMs(): number {
    return Date.now() - epoch;
  }

  // The one path words take to the server. A refused or dropped append keeps
  // its segments for the gap watcher's next tick; past the bounds the loss
  // stays visible in status.error rather than vanishing.
  function append(items: FailedAppend<Segment>[]) {
    const id = transcriptId;
    if (!convex || !id || items.length === 0) return;
    convex
      .mutation(api.transcripts.appendSegments, { transcript_id: id, segments: items.map((i) => i.segment) })
      .catch((err) => {
        const settled = settleFailedAppends(failedAppends, items, Date.now());
        failedAppends = settled.queue;
        if (settled.dropped > 0) {
          emit({ error: `${settled.dropped} line(s) never reached the transcript: ${String(err?.message ?? err).slice(0, 100)}` });
        }
      });
  }

  function detach(key: string) {
    const pipe = pipes.get(key);
    if (!pipe) return;
    pipe.close();
    pipes.delete(key);
    emit({ trackCount: pipes.size });
  }

  function attach(
    key: string,
    mediaTrack: MediaStreamTrack,
    speakerId: string,
    speakerName: string,
  ): void {
    if (!convex || pipes.has(key)) return;
    // Dropping a pipe from the map IS closing it — they were two functions
    // doing almost the same thing, and the "almost" was the bug: a forgotten
    // pipe still holds a recognizer and, since capture starts at open(), an
    // AudioContext and a ScriptProcessor. Outside the map, `stop` can never
    // reach them, and the scribe re-attaches on every TrackSubscribed and
    // every reconnect — so a huddle where the mint keeps failing accumulates
    // them for its whole length. One function, so the two can never disagree.
    const forget = () => detach(key);
    const pipe = openAsrPipe({
      convex,
      roomKey,
      track: mediaTrack,
      clock: nowMs,
      events: {
        onSpeechStop: () => {
          lastSpeechEndMs = Date.now();
        },
        onUtterance: ({ text, t0, t1 }) => {
          anySegmentsSinceFlush = true;
          if (pacing?.addressed(text)) addressedSinceFlush = true;
          if (!firstUnflushedAt) firstUnflushedAt = Date.now();
          emit({ tail: [...status.tail, { speaker: speakerName, text }].slice(-TAIL) });
          append([{ at: Date.now(), segment: { speaker_id: speakerId, speaker_name: speakerName, text, t0, t1 } }]);
        },
        onError: (message) => emit({ error: message }),
        onFailed: (message) => {
          emit({ error: message });
          forget();
        },
        onDropped: () => {
          if (!status.active) return forget();
          // Token expiry or transient drop: reopen this pipe fresh.
          forget();
          setTimeout(() => {
            if (status.active && !pipes.has(key) && mediaTrack.readyState === "live") {
              attach(key, mediaTrack, speakerId, speakerName);
            }
          }, 1000);
        },
      },
    });
    pipes.set(key, pipe);
    emit({ trackCount: pipes.size });
  }

  return {
    subscribe(cb) {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    getStatus: () => status,
    elapsed: nowMs,
    attach,
    detach,

    async start(opts) {
      if (status.active) return transcriptId;
      convex = opts.convex;
      roomKey = opts.roomKey;
      const res = await opts.convex.mutation(api.transcripts.start, {
        room_key: opts.roomKey,
        routes: (opts.routes ?? []).map((r) => ({ ...r, sent_seq: 0 })),
        ...(opts.auto ? { auto: true } : {}),
      });
      // The server is the arbiter of who scribes (transcripts.start). Any
      // answer but "you" leaves this engine idle: opening pipes as an observer
      // would append every word a second time.
      if (!res?.transcript_id || (res.role && res.role !== "scribe")) {
        convex = null;
        roomKey = "";
        return null;
      }
      transcriptId = String(res.transcript_id);
      startedAt = Date.now();
      epoch = startedAt - (res.elapsed_ms ?? 0);
      lastSpeechEndMs = 0;
      anySegmentsSinceFlush = false;
      addressedSinceFlush = false;
      firstUnflushedAt = 0;
      lastFlushAt = Date.now();
      pacing = opts.pacing ?? null;
      failedAppends = [];
      emit({ active: true, transcriptId, error: null, tail: [], startedAt });

      // The gap watcher: flush the live routes when nobody has spoken for
      // GAP_MS, or when the oldest undelivered words have waited the hold
      // limit — whichever comes first (flushDue). FLUSH_MIN_INTERVAL_MS keeps
      // a stop-start conversation from spamming a routed agent. The hold
      // path fires between utterances, never mid-word: segments only exist
      // once the VAD closes them.
      gapTimer = setInterval(() => {
        if (!status.active || !transcriptId || !convex) return;
        // Words a previous append lost go first, so the flush below has them.
        if (failedAppends.length) append(failedAppends.splice(0));
        if (!anySegmentsSinceFlush) return;
        const now = Date.now();
        const due = flushDue({
          sinceFlushMs: now - lastFlushAt,
          anySpeaking: [...pipes.values()].some((p) => p.speaking),
          quietForMs: lastSpeechEndMs > 0 ? now - lastSpeechEndMs : null,
          heldForMs: firstUnflushedAt > 0 ? now - firstUnflushedAt : null,
          busy: pacing?.busy() ?? false,
          addressed: addressedSinceFlush,
        });
        if (due) {
          anySegmentsSinceFlush = false;
          addressedSinceFlush = false;
          firstUnflushedAt = 0;
          lastFlushAt = now;
          convex.mutation(api.transcripts.flush, { transcript_id: transcriptId }).catch(() => {});
        }
      }, 1000);
      return transcriptId;
    },

    /**
     * End this run.
     *
     * `keepLive` separates the two things stopping used to mean at once:
     * releasing the local machinery (pipes, timers) and declaring the
     * transcript OVER on the server. They come apart when the conversation
     * outlives this RUN — the call panel handoff moves a huddle to another
     * window, and the people being transcribed never saw a boundary. Ending
     * the record there would cut a transcript in half at a window edge.
     *
     * Resuming needs nothing more: `transcripts.start` is idempotent per room
     * ("one live transcript per room: a second Transcribe toggle joins the
     * existing run rather than forking the record"), so the window taking the
     * call over starts a run and lands back in the same row, continuing the
     * same numbering.
     */
    async stop(opts?: { keepLive?: boolean; graceful?: boolean }) {
      const id = transcriptId;
      const client = convex;
      // `graceful` spends up to a couple of seconds committing what each
      // recognizer has not closed yet — always the last utterance, and for
      // somebody who just pressed stop on a recording, often the sentence they
      // pressed it after. A huddle does not ask for this: its transcript ends
      // when the room empties, long after anyone stopped talking.
      if (opts?.graceful) {
        await Promise.all([...pipes.values()].map((p) => p.finish().catch(() => {})));
      }
      // One last try for words an append lost; the run is over after this.
      if (failedAppends.length) append(failedAppends.splice(0));
      for (const key of [...pipes.keys()]) detach(key);
      if (gapTimer) clearInterval(gapTimer);
      gapTimer = null;
      pacing = null;
      transcriptId = null;
      emit({ active: false, transcriptId: null, trackCount: 0, tail: [], startedAt: null });
      if (client && id && !opts?.keepLive) {
        await client.mutation(api.transcripts.stop, { transcript_id: id }).catch(() => {});
      }
    },
  };
}
