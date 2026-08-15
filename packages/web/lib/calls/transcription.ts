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

type ConvexHandle = {
  mutation: (fn: any, args: any) => Promise<any>;
  action: (fn: any, args: any) => Promise<any>;
};

// Silence long enough to count as a conversational gap. VAD closes an
// utterance at 600ms; a gap is a real lull, not a breath.
export const GAP_MS = 6_000;
const SAMPLE_RATE = 24_000;
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
  ws: WebSocket | null;
  ctx: AudioContext | null;
  node: ScriptProcessorNode | null;
  source: MediaStreamAudioSourceNode | null;
  speakerId: string;
  speakerName: string;
  speaking: boolean;
  utteranceStartMs: number;
  closed: boolean;
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

// PCM16 mono downsample from the AudioContext rate to 24k, base64-encoded
// the way input_audio_buffer.append wants it.
function floatTo16(input: Float32Array, inRate: number): ArrayBuffer {
  const ratio = inRate / SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const v = input[Math.floor(i * ratio)];
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }
  return out.buffer;
}
function b64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

async function openPipe(
  key: string,
  mediaTrack: MediaStreamTrack,
  speakerId: string,
  speakerName: string,
  roomKey: string,
): Promise<void> {
  if (!convex || pipes.has(key)) return;
  const pipe: TrackPipe = {
    ws: null,
    ctx: null,
    node: null,
    source: null,
    speakerId,
    speakerName,
    speaking: false,
    utteranceStartMs: 0,
    closed: false,
  };
  pipes.set(key, pipe);
  emit({ trackCount: pipes.size });

  const minted = await convex.action(api.transcripts.mintAsrToken, { room_key: roomKey });
  if (pipe.closed) return;
  if (minted?.error || !minted?.client_secret) {
    emit({ error: minted?.error ?? "Could not start transcription" });
    pipes.delete(key);
    emit({ trackCount: pipes.size });
    return;
  }

  // Browser websockets cannot set headers; the Realtime API accepts the
  // ephemeral secret as a subprotocol.
  // GA subprotocol auth: just "realtime" + the ephemeral key. (Verified
  // against the live API; the old beta subprotocol is gone.)
  const ws = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", [
    "realtime",
    `openai-insecure-api-key.${minted.client_secret}`,
  ]);
  pipe.ws = ws;

  ws.onopen = () => {
    if (pipe.closed) return;
    // The session arrives fully configured from the mint (model, pcm 24k,
    // server VAD) — no session.update needed, and the beta-era
    // transcription_session.update event no longer exists.
    const stream = new MediaStream([mediaTrack]);
    const actx = new AudioContext();
    pipe.ctx = actx;
    const source = actx.createMediaStreamSource(stream);
    pipe.source = source;
    // ScriptProcessor over AudioWorklet deliberately: one file, no worklet
    // module fetch, and 4096-frame buffers (~85ms at 48k) are fine for ASR.
    const node = actx.createScriptProcessor(4096, 1, 1);
    pipe.node = node;
    node.onaudioprocess = (e) => {
      if (pipe.closed || ws.readyState !== WebSocket.OPEN) return;
      const pcm = floatTo16(e.inputBuffer.getChannelData(0), actx.sampleRate);
      ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64(pcm) }));
    };
    source.connect(node);
    // A ScriptProcessor only runs when connected toward the destination;
    // route through a zero-gain node so nothing is audible.
    const mute = actx.createGain();
    mute.gain.value = 0;
    node.connect(mute);
    mute.connect(actx.destination);
  };

  ws.onmessage = (e) => {
    if (pipe.closed) return;
    let msg: any;
    try {
      msg = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (msg.type === "input_audio_buffer.speech_started") {
      pipe.speaking = true;
      pipe.utteranceStartMs = nowMs();
    } else if (msg.type === "input_audio_buffer.speech_stopped") {
      pipe.speaking = false;
      lastSpeechEndMs = Date.now();
    } else if (
      msg.type === "conversation.item.input_audio_transcription.completed" &&
      typeof msg.transcript === "string"
    ) {
      const text = msg.transcript.trim();
      if (!text) return;
      const t1 = nowMs();
      const seg = {
        speaker_id: pipe.speakerId,
        speaker_name: pipe.speakerName,
        text,
        t0: pipe.utteranceStartMs || Math.max(0, t1 - 2000),
        t1,
      };
      anySegmentsSinceFlush = true;
      emit({ tail: [...status.tail, { speaker: pipe.speakerName, text }].slice(-6) });
      convex
        ?.mutation(api.transcripts.appendSegments, {
          transcript_id: transcriptId,
          segments: [seg],
        })
        .catch(() => {});
    } else if (msg.type === "error") {
      emit({ error: String(msg.error?.message ?? "ASR error").slice(0, 140) });
    }
  };

  ws.onclose = () => {
    if (!pipe.closed && status.active) {
      // Token expiry or transient drop: reopen this pipe fresh.
      pipes.delete(key);
      emit({ trackCount: pipes.size });
      if (room && transcriptId) {
        setTimeout(() => {
          if (status.active && !pipes.has(key) && mediaTrack.readyState === "live") {
            void openPipe(key, mediaTrack, speakerId, speakerName, roomKey);
          }
        }, 1000);
      }
    }
  };
}

function closePipe(key: string) {
  const pipe = pipes.get(key);
  if (!pipe) return;
  pipe.closed = true;
  try {
    pipe.node?.disconnect();
    pipe.source?.disconnect();
    void pipe.ctx?.close();
    pipe.ws?.close();
  } catch {}
  pipes.delete(key);
  emit({ trackCount: pipes.size });
}

function attachRoomTracks(roomKey: string) {
  if (!room) return;
  // Local mic.
  const micPub = room.localParticipant.getTrackPublication(Track.Source.Microphone);
  const me = room.localParticipant;
  if (micPub?.track?.mediaStreamTrack) {
    void openPipe(
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
      void openPipe(
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
    const anySpeaking = [...pipes.values()].some((p) => p.speaking);
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
