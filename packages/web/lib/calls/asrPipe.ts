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
//
// CAPTURE STARTS BEFORE THE SOCKET DOES. The AudioContext used to be built
// inside `onopen`, which put a mint round trip and a TLS handshake in front of
// the microphone: everything said in that gap was never captured by anything.
// A walkie burst is two or three seconds long, so most of it was spoken before
// anything was listening and the whole burst came back as "no words". Capture
// now begins in this function's own synchronous body and buffers PCM until the
// socket is ready, so the words are only ever delayed, never lost.
//
// AND IT ENDS WITH A COMMIT. `close()` used to drop the socket the instant the
// key came up, which threw away the utterance the server VAD had not closed
// yet — always the last one, and for a short burst the only one. `finish()`
// commits the buffer and waits, bounded, for the transcription to come back.
// `close()` remains what it always was: the abandon path.
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
  /** The utterance being spoken RIGHT NOW, revised as each delta lands, and
   *  emitted as "" the moment it closes into an `onUtterance`. The caller shows
   *  it after the committed text and replaces it wholesale — it is a redraw of
   *  one sentence, never an append. */
  onPartial?: (text: string) => void;
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
  /**
   * End it properly: stop capturing, send everything still buffered, commit it,
   * and wait for the words to come back before closing. Bounded — a recognizer
   * that has gone quiet must not hold a released key hostage. Idempotent, and
   * safe to call on a pipe whose socket never opened.
   */
  finish(): Promise<void>;
  /** Abandon it. Nothing is committed and nothing is waited for. */
  close(): void;
};

const SAMPLE_RATE = 24_000;
/** How much speech may wait for a socket that has not opened yet. Generous
 *  next to a burst; the cap only exists so a pipe that never connects cannot
 *  grow without limit. */
const BUFFER_CAP_SAMPLES = SAMPLE_RATE * 30;
/** How long a release waits for the last words before giving up on them. */
const FINISH_TIMEOUT_MS = 2_500;

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
 * Open a recognizer on one track. Returns synchronously WITH THE MICROPHONE
 * ALREADY BEING READ — the mint and the socket settle behind it, and `close()`
 * at any point abandons whatever is in flight, so a caller never has to await a
 * pipe it is about to throw away.
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
  // False from the moment `finish` is called: what is buffered by then is
  // exactly what gets committed, so no audio arrives after the commit.
  let capturing = true;
  let finishing: Promise<void> | null = null;
  // The mint refused, the socket died: either way there is nothing left to wait
  // for, so a release stops waiting instead of spending its whole budget.
  let hopeless = false;
  // Set by the transcription that answers our commit — the one thing `finish`
  // is actually waiting for.
  let transcribedSinceCommit = false;
  /** PCM that has nowhere to go yet, oldest first. */
  let buffered: ArrayBuffer[] = [];
  let bufferedSamples = 0;
  // The utterance in progress, rebuilt from its deltas. Keyed by item so a new
  // sentence starts from empty rather than from the last one's tail.
  let partialItem = "";
  let partialText = "";

  function socketOpen(): boolean {
    return !!ws && ws.readyState === 1;
  }

  function append(pcm: ArrayBuffer) {
    ws!.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64(pcm) }));
  }

  function feed(pcm: ArrayBuffer) {
    if (socketOpen()) {
      append(pcm);
      return;
    }
    buffered.push(pcm);
    bufferedSamples += pcm.byteLength / 2;
    // Drop the oldest rather than the newest: if a socket takes so long that
    // half a minute has piled up, the recent half minute is the useful one.
    while (bufferedSamples > BUFFER_CAP_SAMPLES && buffered.length > 0) {
      bufferedSamples -= buffered.shift()!.byteLength / 2;
    }
  }

  /** Everything said before the socket existed, in the order it was said. */
  function flush() {
    const queued = buffered;
    buffered = [];
    bufferedSamples = 0;
    for (const pcm of queued) {
      if (!socketOpen()) return;
      append(pcm);
    }
  }

  function startCapture() {
    try {
      const stream = new MediaStream([track]);
      const ac = new AudioContext();
      actx = ac;
      // A context built outside a gesture starts suspended and its processor
      // never runs; the walkie's press IS a gesture, so this only matters for a
      // pipe opened from a timer.
      void Promise.resolve(ac.resume?.()).catch(() => {});
      const src = ac.createMediaStreamSource(stream);
      source = src;
      // ScriptProcessor over AudioWorklet deliberately: one file, no worklet
      // module fetch, and 4096-frame buffers (~85ms at 48k) are fine for ASR.
      const proc = ac.createScriptProcessor(4096, 1, 1);
      node = proc;
      proc.onaudioprocess = (e) => {
        if (closed || !capturing) return;
        feed(floatTo16(e.inputBuffer.getChannelData(0), ac.sampleRate));
      };
      src.connect(proc);
      // A ScriptProcessor only runs when connected toward the destination;
      // route through a zero-gain node so nothing is audible.
      const mute = ac.createGain();
      mute.gain.value = 0;
      proc.connect(mute);
      mute.connect(ac.destination);
    } catch {
      // No capture path at all (an AudioContext the browser refused). The
      // recognizer will report nothing, which the caller already treats as a
      // burst without words rather than a failed burst.
      hopeless = true;
    }
  }

  /** Poll a condition to a deadline. Small and dependency-free on purpose: the
   *  two things `finish` waits for are set from a socket callback, and a poll
   *  cannot miss one that fired before the wait began. */
  function until(pred: () => boolean, deadline: number): Promise<void> {
    return new Promise((resolve) => {
      const tick = () => {
        if (pred() || closed || hopeless || Date.now() >= deadline) return resolve();
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  const pipe: AsrPipe = {
    get speaking() {
      return speaking;
    },
    async finish() {
      if (closed) return;
      if (finishing) return finishing;
      capturing = false;
      finishing = (async () => {
        const deadline = Date.now() + FINISH_TIMEOUT_MS;
        try {
          // A socket still handshaking may yet carry the words: wait for it
          // inside the same budget rather than throwing the burst away.
          await until(socketOpen, deadline);
          if (socketOpen()) {
            flush();
            transcribedSinceCommit = false;
            ws!.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            await until(() => transcribedSinceCommit, deadline);
          }
        } catch {}
        pipe.close();
      })();
      return finishing;
    },
    close() {
      if (closed) return;
      closed = true;
      speaking = false;
      buffered = [];
      bufferedSamples = 0;
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

  // The microphone, first and synchronously. Everything below this line is a
  // round trip, and none of it may stand between a person talking and the audio
  // being kept.
  startCapture();

  void (async () => {
    const minted = await convex.action(api.transcripts.mintAsrToken, { room_key: roomKey }).catch(
      (err: any) => ({ error: String(err?.message ?? "Could not start transcription") }),
    );
    if (closed) return;
    if (minted?.error || !minted?.client_secret) {
      hopeless = true;
      // Close BEFORE reporting, so `onFailed` means "this object is finished"
      // rather than "this object is now your chore". That distinction did not
      // exist while capture began in `onopen`: a refused mint had allocated
      // nothing, so a caller that dropped the pipe on the floor lost nothing.
      // Capture now starts at open(), so the same pipe is holding an
      // AudioContext and a ScriptProcessor wired to the destination — and the
      // scribe's failure path drops the pipe without closing it, which would
      // strand them where nothing can ever reach them again.
      const reason = minted?.error ?? "Could not start transcription";
      pipe.close();
      events?.onFailed?.(reason);
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
      //
      // What was said while this was connecting goes first, in order, so the
      // server hears one continuous take rather than the tail of one.
      flush();
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
        msg.type === "conversation.item.input_audio_transcription.delta" &&
        typeof msg.delta === "string"
      ) {
        const item = String(msg.item_id ?? "");
        if (item !== partialItem) {
          partialItem = item;
          partialText = "";
        }
        partialText += msg.delta;
        events?.onPartial?.(partialText);
      } else if (msg.type === "conversation.item.input_audio_transcription.completed") {
        // Whatever the words turn out to be, the commit has been answered.
        transcribedSinceCommit = true;
        partialItem = "";
        partialText = "";
        events?.onPartial?.("");
        const text = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
        if (!text) return;
        const t1 = clock();
        events?.onUtterance?.({ text, t0: utteranceStart || Math.max(0, t1 - 2000), t1 });
      } else if (msg.type === "conversation.item.input_audio_transcription.failed") {
        // The server heard the commit and got nothing out of it. Waiting longer
        // would only delay the release.
        transcribedSinceCommit = true;
        events?.onError?.("Could not make out the words");
      } else if (msg.type === "error") {
        // An error after a commit is the answer to that commit.
        transcribedSinceCommit = true;
        events?.onError?.(String(msg.error?.message ?? "ASR error").slice(0, 140));
      }
    };

    socket.onclose = () => {
      if (closed) return;
      speaking = false;
      hopeless = true;
      // Same contract as onFailed: this pipe is over. A caller that wants the
      // words back opens a FRESH one (the scribe does exactly that), so holding
      // this one's microphone processor open serves nobody.
      pipe.close();
      events?.onDropped?.();
    };
  })();

  return pipe;
}
