// The scribe engine: live, speaker-attributed transcription of a huddle.
//
// Runs entirely in the client that toggled Transcribe on. For every audio
// track in the room — the local mic and each subscribed remote track — it
// opens one OpenAI Realtime transcription websocket and streams that track's
// PCM. One track = one participant, so every piece of text arrives already
// attributed; there is no diarization step to be wrong. Completed utterances
// are appended to convex (transcripts.appendSegments); when EVERY track has
// been silent for GAP_MS (per the server VAD's speech start/stop events), the
// engine calls transcripts.flush — the beat where live routes deliver and a
// routed agent naturally answers.
//
// Module singleton beside callManager, same pattern: components read the
// small status snapshot via subscribe/getSnapshot; nothing here touches the
// store except through convex mutations.
import { Room, RoomEvent, Track } from "livekit-client";
import { api } from "@codecast/convex/convex/_generated/api";
import { openAsrPipe, type AsrPipe } from "./asrPipe";

type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
};

// Silence long enough to count as a conversational gap. VAD closes an
// utterance at 600ms; a gap is a real lull, not a breath.
export const GAP_MS = 6_000;
const FLUSH_MIN_INTERVAL_MS = 10_000;

export type ScribeStatus = {
  active: boolean;
  transcriptId: string | null;
  trackCount: number;
  error: string | null;
  /** Rolling caption tail, newest last. */
  tail: Array<{ speaker: string; text: string }>;
};

let status: ScribeStatus = {
  active: false,
  transcriptId: null,
  trackCount: 0,
  error: null,
  tail: [],
};
const subscribers = new Set<() => void>();
function emit(patch: Partial<ScribeStatus>) {
  status = { ...status, ...patch };
  for (const cb of subscribers) cb();
}
export function subscribeScribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}
export function getScribeStatus(): ScribeStatus {
  return status;
}

type TrackPipe = {
  pipe: AsrPipe;
  speakerId: string;
  speakerName: string;
};

let convex: ConvexHandle | null = null;
let room: Room | null = null;
let transcriptId: string | null = null;
let startedAt = 0;
let pipes = new Map<string, TrackPipe>();
let lastSpeechEndMs = 0;
let anySegmentsSinceFlush = false;
let lastFlushAt = 0;
let gapTimer: ReturnType<typeof interval> | null = null;
let roomListener: (() => void) | null = null;

function interval(fn: () => void, ms: number) {
  return setInterval(fn, ms);
}

function nowMs(): number {
  return Date.now() - startedAt;
}

// One recognizer per track (lib/calls/asrPipe), wrapped in the scribe's own
// bookkeeping: who the track belongs to, where its words go, and the reconnect
// the huddle wants — a dropped socket mid-huddle is a token expiry, not the end
// of the conversation.
function openPipe(
  key: string,
  mediaTrack: MediaStreamTrack,
  speakerId: string,
  speakerName: string,
  roomKey: string,
): void {
  if (!convex || pipes.has(key)) return;
  const forget = () => {
    pipes.delete(key);
    emit({ trackCount: pipes.size });
  };
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
        const seg = { speaker_id: speakerId, speaker_name: speakerName, text, t0, t1 };
        anySegmentsSinceFlush = true;
        emit({ tail: [...status.tail, { speaker: speakerName, text }].slice(-6) });
        convex
          ?.mutation(api.transcripts.appendSegments, {
            transcript_id: transcriptId,
            segments: [seg],
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
        if (room && transcriptId) {
          setTimeout(() => {
            if (status.active && !pipes.has(key) && mediaTrack.readyState === "live") {
              openPipe(key, mediaTrack, speakerId, speakerName, roomKey);
            }
          }, 1000);
        }
      },
    },
  });
  pipes.set(key, { pipe, speakerId, speakerName });
  emit({ trackCount: pipes.size });
}

function closePipe(key: string) {
  const entry = pipes.get(key);
  if (!entry) return;
  entry.pipe.close();
  pipes.delete(key);
  emit({ trackCount: pipes.size });
}

function attachRoomTracks(roomKey: string) {
  if (!room) return;
  // Local mic.
  const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const me = room.localParticipant;
  if (micPub?.track?.mediaStreamTrack) {
    openPipe(
      `local:${micPub.trackSid}`,
      micPub.track.mediaStreamTrack,
      me.identity,
      me.name || "Me",
      roomKey,
    );
  }
  // Every subscribed remote audio track.
  for (const p of room.remoteParticipants.values()) {
    const pub = p.getTrackPublication(Track.Source.Microphone);
    if (pub?.isSubscribed && pub.track?.mediaStreamTrack) {
      openPipe(
        `${p.identity}:${pub.trackSid}`,
        pub.track.mediaStreamTrack,
        p.identity,
        p.name || p.identity,
        roomKey,
      );
    }
  }
}

export async function startScribe(opts: {
  convex: ConvexHandle;
  room: Room;
  roomKey: string;
  routes?: Array<{ kind: "session" | "doc" | "slack"; target: string; mode: "live" | "after" }>;
}): Promise<void> {
  if (status.active) return;
  convex = opts.convex;
  room = opts.room;
  const res = await opts.convex.mutation(api.transcripts.start, {
    room_key: opts.roomKey,
    routes: (opts.routes ?? []).map((r) => ({ ...r, sent_seq: 0 })),
  });
  transcriptId = String(res.transcript_id);
  startedAt = Date.now();
  lastSpeechEndMs = 0;
  anySegmentsSinceFlush = false;
  lastFlushAt = Date.now();
  emit({ active: true, transcriptId, error: null, tail: [] });

  attachRoomTracks(opts.roomKey);
  const onTrack = () => attachRoomTracks(opts.roomKey);
  room.on(RoomEvent.TrackSubscribed, onTrack);
  room.on(RoomEvent.LocalTrackPublished, onTrack);
  room.on(RoomEvent.TrackUnsubscribed, (_t, pub) => closePipe(findPipeKey(pub.trackSid)));
  roomListener = () => {
    room?.off(RoomEvent.TrackSubscribed, onTrack);
    room?.off(RoomEvent.LocalTrackPublished, onTrack);
  };

  // The gap watcher: when nobody has spoken for GAP_MS and there are
  // undelivered words, flush the live routes. FLUSH_MIN_INTERVAL_MS keeps a
  // stop-start conversation from spamming a routed agent.
  gapTimer = interval(() => {
    if (!status.active || !transcriptId || !convex) return;
    const anySpeaking = [...pipes.values()].some((p) => p.pipe.speaking);
    const quietFor = Date.now() - Math.max(lastSpeechEndMs, lastFlushAt);
    if (
      !anySpeaking &&
      anySegmentsSinceFlush &&
      lastSpeechEndMs > 0 &&
      Date.now() - lastSpeechEndMs >= GAP_MS &&
      quietFor >= 0 &&
      Date.now() - lastFlushAt >= FLUSH_MIN_INTERVAL_MS
    ) {
      anySegmentsSinceFlush = false;
      lastFlushAt = Date.now();
      convex.mutation(api.transcripts.flush, { transcript_id: transcriptId }).catch(() => {});
    }
  }, 1000);
}

function findPipeKey(trackSid: string | undefined): string {
  if (!trackSid) return "";
  for (const key of pipes.keys()) if (key.endsWith(`:${trackSid}`)) return key;
  return "";
}

export async function stopScribe(): Promise<void> {
  const id = transcriptId;
  for (const key of [...pipes.keys()]) closePipe(key);
  if (gapTimer) clearInterval(gapTimer);
  gapTimer = null;
  roomListener?.();
  roomListener = null;
  room = null;
  transcriptId = null;
  emit({ active: false, transcriptId: null, trackCount: 0, tail: [] });
  if (convex && id) {
    await convex.mutation(api.transcripts.stop, { transcript_id: id }).catch(() => {});
  }
}

// Dev console / e2e access to the real module instance (a dynamic import()
// of this file would be a second instance with its own empty state — the
// same trap __callManager documents).
if (typeof window !== "undefined" && import.meta.env.DEV) {
  (window as any).__scribe = {
    start: startScribe,
    stop: stopScribe,
    status: getScribeStatus,
  };
}
