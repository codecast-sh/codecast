// One audio track, one recognizer.
//
// This is the unit the scribe and the walkie talkie share: an OpenAI Realtime
// transcription websocket fed the PCM of a single MediaStreamTrack, reporting
// the server VAD's speech boundaries and each completed utterance. It knows
// nothing about WHO is speaking or where the words go — the scribe opens one
// per participant and attributes by track, the walkie opens exactly one for the
// local mic while the key is held. Attribution, storage and reconnect policy
// belong to the caller; the pump belongs here.
//
// Why the caller reconnects: the two users want different answers. A scribe
// wants the pipe back after a token expiry because the huddle is still running;
// a burst that dies mid-sentence is over. Reporting `onDropped` and letting each
// side decide keeps that policy out of the transport.
import { api } from "@codecast/convex/convex/_generated/api";

type AsrConvexHandle = {
  action: (fn: any, args: any) => Promise<any>;
};

export type AsrUtterance = {
  text: string;
  /** Start/end on the caller's own clock (see `clock` below). */
  t0: number;
  t1: number;
};

export type AsrPipeEvents = {
  onSpeechStart?: () => void;
  onSpeechStop?: () => void;
  onUtterance?: (u: AsrUtterance) => void;
  /** A recoverable error the recognizer reported mid-run. */
  onError?: (message: string) => void;
  /** The pipe never opened: the mint was refused or is not configured. Nothing
   *  is listening and no retry is implied. */
  onFailed?: (message: string) => void;
  /** The socket closed while the pipe was still wanted — token expiry or a
   *  transient drop. The caller decides whether to open a fresh one. */
  onDropped?: () => void;
};

export type AsrPipe = {
  /** True between the VAD's speech start and stop. */
  readonly speaking: boolean;
  close(): void;
};

const SAMPLE_RATE = 24_000;

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

/**
 * Open a recognizer on one track. Returns synchronously — the mint and the
 * socket settle behind it, and `close()` at any point abandons whatever is in
 * flight, so a caller never has to await a pipe it is about to throw away.
 *
 * `roomKey` is what the ephemeral key is minted against: the server runs the
 * same authorizeRoom the media token runs, so a pipe can only ever exist for a
 * room its opener may already hear.
 */
export function openAsrPipe(opts: {
  convex: AsrConvexHandle;
  roomKey: string;
  track: MediaStreamTrack;
  /** Timeline clock for utterance offsets, in ms. */
  clock: () => number;
  events?: AsrPipeEvents;
}): AsrPipe {
  const { convex, roomKey, track, clock, events } = opts;
  let closed = false;
  let speaking = false;
  let utteranceStart = 0;
  let ws: WebSocket | null = null;
  let actx: AudioContext | null = null;
  let node: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;

  const pipe: AsrPipe = {
    get speaking() {
      return speaking;
    },
    close() {
      if (closed) return;
      closed = true;
      speaking = false;
      try {
        node?.disconnect();
        source?.disconnect();
        void actx?.close();
        ws?.close();
      } catch {}
      ws = null;
      actx = null;
      node = null;
      source = null;
    },
  };

  void (async () => {
    const minted = await convex.action(api.transcripts.mintAsrToken, { room_key: roomKey }).catch(
      (err: any) => ({ error: String(err?.message ?? "Could not start transcription") }),
    );
    if (closed) return;
    if (minted?.error || !minted?.client_secret) {
      events?.onFailed?.(minted?.error ?? "Could not start transcription");
      return;
    }

    // Browser websockets cannot set headers; the Realtime API accepts the
    // ephemeral secret as a subprotocol.
    // GA subprotocol auth: just "realtime" + the ephemeral key. (Verified
    // against the live API; the old beta subprotocol is gone.)
    const socket = new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", [
      "realtime",
      `openai-insecure-api-key.${minted.client_secret}`,
    ]);
    ws = socket;

    socket.onopen = () => {
      if (closed) return;
      // The session arrives fully configured from the mint (model, pcm 24k,
      // server VAD) — no session.update needed, and the beta-era
      // transcription_session.update event no longer exists.
      const stream = new MediaStream([track]);
      const ac = new AudioContext();
      actx = ac;
      const src = ac.createMediaStreamSource(stream);
      source = src;
      // ScriptProcessor over AudioWorklet deliberately: one file, no worklet
      // module fetch, and 4096-frame buffers (~85ms at 48k) are fine for ASR.
      const proc = ac.createScriptProcessor(4096, 1, 1);
      node = proc;
      proc.onaudioprocess = (e) => {
        if (closed || socket.readyState !== WebSocket.OPEN) return;
        const pcm = floatTo16(e.inputBuffer.getChannelData(0), ac.sampleRate);
        socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64(pcm) }));
      };
      src.connect(proc);
      // A ScriptProcessor only runs when connected toward the destination;
      // route through a zero-gain node so nothing is audible.
      const mute = ac.createGain();
      mute.gain.value = 0;
      proc.connect(mute);
      mute.connect(ac.destination);
    };

    socket.onmessage = (e) => {
      if (closed) return;
      let msg: any;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "input_audio_buffer.speech_started") {
        speaking = true;
        utteranceStart = clock();
        events?.onSpeechStart?.();
      } else if (msg.type === "input_audio_buffer.speech_stopped") {
        speaking = false;
        events?.onSpeechStop?.();
      } else if (
        msg.type === "conversation.item.input_audio_transcription.completed" &&
        typeof msg.transcript === "string"
      ) {
        const text = msg.transcript.trim();
        if (!text) return;
        const t1 = clock();
        events?.onUtterance?.({ text, t0: utteranceStart || Math.max(0, t1 - 2000), t1 });
      } else if (msg.type === "error") {
        events?.onError?.(String(msg.error?.message ?? "ASR error").slice(0, 140));
      }
    };

    socket.onclose = () => {
      if (closed) return;
      speaking = false;
      events?.onDropped?.();
    };
  })();

  return pipe;
}
