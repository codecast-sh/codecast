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
const FLUSH_MIN_INTERVAL_MS = 8_000;
// The hold limit: how long undelivered words may wait for a lull before the
// engine flushes mid-conversation. Also unwedges a pipe whose VAD sticks with
// `speaking` true, which would otherwise block delivery forever.
export const MAX_HOLD_MS = 30_000;
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
};

const IDLE: ScribeStatus = {
  active: false,
  transcriptId: null,
  trackCount: 0,
  error: null,
  tail: [],
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
  const pipes = new Map<string, AsrPipe>();
  let lastSpeechEndMs = 0;
  let anySegmentsSinceFlush = false;
  let firstUnflushedAt = 0;
  let lastFlushAt = 0;
  let gapTimer: ReturnType<typeof setInterval> | null = null;

  function nowMs(): number {
    return Date.now() - startedAt;
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
          if (!firstUnflushedAt) firstUnflushedAt = Date.now();
          emit({ tail: [...status.tail, { speaker: speakerName, text }].slice(-TAIL) });
          convex
            ?.mutation(api.transcripts.appendSegments, {
              transcript_id: transcriptId,
              segments: [{ speaker_id: speakerId, speaker_name: speakerName, text, t0, t1 }],
            })
            .catch(() => {});
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
      lastSpeechEndMs = 0;
      anySegmentsSinceFlush = false;
      firstUnflushedAt = 0;
      lastFlushAt = Date.now();
      emit({ active: true, transcriptId, error: null, tail: [] });

      // The gap watcher: flush the live routes when nobody has spoken for
      // GAP_MS, or when the oldest undelivered words have waited MAX_HOLD_MS —
      // whichever comes first. FLUSH_MIN_INTERVAL_MS keeps a stop-start
      // conversation from spamming a routed agent. The hold path fires between
      // utterances, never mid-word: segments only exist once the VAD closes
      // them.
      gapTimer = setInterval(() => {
        if (!status.active || !transcriptId || !convex) return;
        if (!anySegmentsSinceFlush || Date.now() - lastFlushAt < FLUSH_MIN_INTERVAL_MS) return;
        const anySpeaking = [...pipes.values()].some((p) => p.speaking);
        const quiet = !anySpeaking && lastSpeechEndMs > 0 && Date.now() - lastSpeechEndMs >= GAP_MS;
        const heldTooLong = firstUnflushedAt > 0 && Date.now() - firstUnflushedAt >= MAX_HOLD_MS;
        if (quiet || heldTooLong) {
          anySegmentsSinceFlush = false;
          firstUnflushedAt = 0;
          lastFlushAt = Date.now();
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
      for (const key of [...pipes.keys()]) detach(key);
      if (gapTimer) clearInterval(gapTimer);
      gapTimer = null;
      transcriptId = null;
      emit({ active: false, transcriptId: null, trackCount: 0, tail: [] });
      if (client && id && !opts?.keepLive) {
        await client.mutation(api.transcripts.stop, { transcript_id: id }).catch(() => {});
      }
    },
  };
}
