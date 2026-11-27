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
//
// TURNS END HERE, NOT ON THE SERVER. gpt-live-transcribe refuses server turn
// detection and emits a completed line only after `input_audio_buffer.commit`.
// The endpointer (shared/contracts/asrEndpointer) reads the same PCM this pipe
// sends, fires the speech start/stop callbacks, and commits each turn it
// closes. A line's t0/t1 are the endpointer's sample positions on the caller's
// clock, so a line is stamped when it was said, not when its words came back.
import { api } from "@codecast/convex/convex/_generated/api";
import { openWebSocket } from "../openWebSocket";
import {
  LIVE_TRANSCRIBE_MODEL,
  createEndpointer,
  samplesToMs,
  isUnexpectedTranscript,
  localTranscribeLanguages,
  normalizeTranscribeLanguages,
} from "@codecast/shared/contracts";
import {
  WORKLET_NAME,
  acquireCaptureContext,
  ensureWorkletLoaded,
  releaseCaptureContext,
  type SharedCaptureContext,
} from "./asrCapture";

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
  /** A turn reached 250 ms of voiced audio (the endpointer's start). */
  onSpeechStart?: () => void;
  /** The endpointer closed a turn after 600 ms of quiet. */
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
  /** True between the endpointer's speech start and stop. */
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

/**
 * The same recognizer, fed PCM instead of a MediaStreamTrack. The phone has
 * no AudioContext, so it taps the microphone as int16 and calls `feedInt16`;
 * the browser pipe below is this session plus an AudioContext on a track.
 */
export type AsrPcmSession = AsrPipe & {
  /** PCM16 mono already at 24 kHz, the rate the socket wants. */
  feedPcm16(pcm: ArrayBuffer): void;
  /** PCM16 mono at `sampleRate`, resampled to 24 kHz then sent. */
  feedInt16(samples: Int16Array, sampleRate: number): void;
};

const SAMPLE_RATE = 24_000;
/** How much speech may wait for a socket that has not opened yet. Generous
 *  next to a burst; the cap only exists so a pipe that never connects cannot
 *  grow without limit. */
const BUFFER_CAP_SAMPLES = SAMPLE_RATE * 30;
/** The least audio the server accepts in a commit (100 ms). */
const MIN_COMMIT_SAMPLES = SAMPLE_RATE / 10;
/** How long a release waits for the last words before giving up on them. */
const FINISH_TIMEOUT_MS = 2_500;

// PCM16 mono downsample from the AudioContext rate to 24k, base64-encoded
// the way input_audio_buffer.append wants it. Box-averaging each output window
// filters frequencies above the 12 kHz Nyquist limit instead of folding them
// back into speech as aliasing noise.
export function floatTo16(input: Float32Array, inRate: number): ArrayBuffer {
  if (!(inRate > 0) || input.length === 0) return new ArrayBuffer(0);
  const ratio = inRate / SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  if (ratio <= 1) {
    for (let i = 0; i < outLen; i++) {
      const v = input[Math.floor(i * ratio)]!;
      out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
    }
    return out.buffer;
  }
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    const v = sum / (end - start);
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

/** PCM16 mono → 24 kHz PCM16. A no-op when the source is already 24 kHz. */
function int16To24k(input: Int16Array, inRate: number): ArrayBuffer {
  if (!(inRate > 0) || input.length === 0) return new ArrayBuffer(0);
  if (inRate === SAMPLE_RATE) {
    const copy = new Int16Array(input.length);
    copy.set(input);
    return copy.buffer;
  }
  const ratio = inRate / SAMPLE_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  if (ratio <= 1) {
    for (let i = 0; i < outLen; i++) out[i] = input[Math.floor(i * ratio)]!;
    return out.buffer;
  }
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = Math.round(sum / (end - start));
  }
  return out.buffer;
}

type AsrSessionOpts = {
  convex: AsrConvexHandle;
  /** The call room the key is minted against, or null for dictation: a
   *  person's own words into a text box, minted by dictation.mintDictationToken. */
  roomKey: string | null;
  /** Timeline clock for utterance offsets, in ms. */
  clock: () => number;
  events?: AsrPipeEvents;
  languages?: string[];
};

/**
 * Open a recognizer the caller feeds. Capture is the caller's job — the
 * browser pipe starts an AudioContext, the phone taps WebRTC PCM — and this
 * is only the socket, the buffer, and the words coming back.
 *
 * Returns synchronously so a caller can start feeding before the mint
 * answers; audio waits in the buffer until the socket is ready.
 */
export function openAsrPcmSession(opts: AsrSessionOpts): AsrPcmSession {
  const { convex, roomKey, clock, events } = opts;
  let languages = normalizeTranscribeLanguages(
    opts.languages ?? localTranscribeLanguages(),
  );
  let closed = false;
  // The audio's own clock: the caller's time when sample 0 was fed. Every line
  // is this plus its sample position, so latency never moves a line.
  const base = clock();
  const endpointer = createEndpointer();
  const at = (sample: number) => base + samplesToMs(sample);
  // Each commit's span, oldest first, until the server names its item.
  const pendingSpans: Array<{ t0: number; t1: number }> = [];
  const itemSpans = new Map<string, { t0: number; t1: number }>();
  // The latest turn start and the position of the last commit, for a line
  // with no span of its own (finish's commit, an older server's own turns).
  let lastStart = 0;
  let lastCommitAt = 0;
  let ws: WebSocket | null = null;
  // False from the moment `finish` is called: what is buffered by then is
  // exactly what gets committed, so no audio arrives after the commit.
  let capturing = true;
  let finishing: Promise<void> | null = null;
  // The mint refused, the socket died: either way there is nothing left to wait
  // for, so a release stops waiting instead of spending its whole budget.
  let hopeless = false;
  // Commits the server has not answered yet. `finish` waits for this to reach
  // zero: a flag would let the answer to an earlier turn release the wait for
  // the last one, and the last words would be lost.
  let outstanding = 0;
  const answered = () => {
    outstanding = Math.max(0, outstanding - 1);
  };
  // Null until the mint answers. A server that still mints an older model
  // with server VAD closes turns itself, and a second commit from here would
  // only come back as an empty-buffer error.
  let clientCommits: boolean | null = null;
  /** PCM (and turn ends) that have nowhere to go yet, oldest first. */
  let buffered: Array<ArrayBuffer | "commit"> = [];
  /** The span of each "commit" in `buffered`, in the same order. */
  const queuedSpans: Array<{ t0: number; t1: number }> = [];
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

  function sendCommit(span: { t0: number; t1: number }) {
    if (clientCommits === false) return;
    pendingSpans.push(span);
    outstanding += 1;
    ws!.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }

  function feed(item: ArrayBuffer | "commit", span?: { t0: number; t1: number }) {
    if (socketOpen() && clientCommits !== null) {
      if (item === "commit") sendCommit(span!);
      else append(item);
      return;
    }
    // A turn that closed before the socket opened commits in order with its
    // audio, once the socket is there.
    if (item === "commit") {
      buffered.push(item);
      queuedSpans.push(span!);
      return;
    }
    buffered.push(item);
    bufferedSamples += item.byteLength / 2;
    // Drop the oldest rather than the newest: if a socket takes so long that
    // half a minute has piled up, the recent half minute is the useful one.
    while (bufferedSamples > BUFFER_CAP_SAMPLES && buffered.length > 0) {
      const dropped = buffered.shift()!;
      if (dropped === "commit") queuedSpans.shift();
      else bufferedSamples -= dropped.byteLength / 2;
    }
  }
  /** Everything said before the socket existed, in the order it was said. */
  function flush() {
    const queued = buffered;
    buffered = [];
    bufferedSamples = 0;
    for (const item of queued) {
      if (!socketOpen()) return;
      if (item === "commit") sendCommit(queuedSpans.shift()!);
      else append(item);
    }
  }

  /** Run the endpointer over PCM about to be sent. A closed turn commits at
   *  the sample where it closed: the buffer is split there, so a forced cut
   *  lands on its quiet frame and not at the end of a capture buffer. */
  function hear(pcm: ArrayBuffer) {
    const from = endpointer.position;
    const turns = endpointer.push(new Int16Array(pcm, 0, pcm.byteLength >> 1));
    let sent = from;
    for (const ev of turns) {
      if (ev.type === "start") {
        lastStart = ev.at;
        events?.onSpeechStart?.();
        continue;
      }
      if (ev.commitAt > sent) feed(pcm.slice((sent - from) * 2, (ev.commitAt - from) * 2));
      sent = Math.max(sent, ev.commitAt);
      lastCommitAt = ev.commitAt;
      if (!ev.forced) events?.onSpeechStop?.();
      else lastStart = ev.end;
      feed("commit", { t0: at(ev.start), t1: at(ev.end) });
    }
    if (sent === from) feed(pcm);
    else if (sent < endpointer.position) feed(pcm.slice((sent - from) * 2));
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

  const pipe: AsrPcmSession = {
    get speaking() {
      return !closed && endpointer.speaking;
    },
    feedPcm16(pcm: ArrayBuffer) {
      if (closed || !capturing || pcm.byteLength < 2) return;
      hear(pcm);
    },
    feedInt16(samples: Int16Array, sampleRate: number) {
      if (closed || !capturing) return;
      this.feedPcm16(int16To24k(samples, sampleRate));
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
          if (socketOpen() && clientCommits !== null) {
            flush();
            // Whatever the endpointer had not closed yet: the open turn, or
            // the tail since the last commit. Nothing new since the last
            // commit means nothing to commit; the server would answer an
            // empty buffer with an error.
            const tail = endpointer.position - lastCommitAt;
            if (!clientCommits || tail >= MIN_COMMIT_SAMPLES) {
              const from = endpointer.turnStart ?? lastCommitAt;
              if (clientCommits) pendingSpans.push({ t0: at(from), t1: at(endpointer.position) });
              outstanding += 1;
              ws!.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            }
            await until(() => outstanding === 0, deadline);
          }
        } catch {}
        pipe.close();
      })();
      return finishing;
    },
    close() {
      if (closed) return;
      closed = true;
      buffered = [];
      bufferedSamples = 0;
      try {
        ws?.close();
      } catch {}
      ws = null;
    },
  };

  void (async () => {
    // `client_turns` tells the server this pipe closes its own turns. A server
    // from before that field throws on it as an unknown argument, and a
    // production deployment may redact that to "Server Error". So any THROWN
    // first mint (validation or network) is asked once more without it, and
    // `clientCommits` follows whatever model comes back. A returned `{ error }`
    // is the server's answer and is not retried here.
    let clientTurns = true;
    const tryMint = ({ room_key, ...args }: { room_key: string | null; languages?: string[] }) =>
      convex
        .action(
          ...((room_key === null
            ? [api.dictation.mintDictationToken, args]
            : [api.transcripts.mintAsrToken, clientTurns ? { room_key, ...args, client_turns: true } : { room_key, ...args }]) as [any, any]),
        )
        .catch((err: any) => ({
          error: String(err?.message ?? "Could not start transcription"),
          thrown: true,
        }));
    const first = { room_key: roomKey, ...(languages.length ? { languages } : {}) };
    let minted = await tryMint(first);
    if (closed) return;
    // The dictation mint is new with client turns, so it has no older server
    // to fall back to: a thrown first mint is its answer.
    if (minted?.thrown && roomKey !== null) {
      clientTurns = false;
      minted = await tryMint(first);
      if (closed) return;
    }
    if (
      languages.length &&
      typeof minted?.error === "string" &&
      /languages|ArgumentValidation|Unexpected argument|extra field|mint failed/i.test(
        minted.error,
      )
    ) {
      minted = await tryMint({ room_key: roomKey });
    }
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
    // The mint unions this device with everyone already seated, so a Japanese
    // speaker in an English-scribed room is on the allowlist the filter uses.
    // An empty list from the mint must not wipe the list this device already has.
    if (Array.isArray(minted.languages) && minted.languages.length) {
      languages = normalizeTranscribeLanguages(minted.languages);
    }
    clientCommits = minted.model === LIVE_TRANSCRIBE_MODEL;

    // Browser websockets cannot set headers; the Realtime API accepts the
    // ephemeral secret as a subprotocol.
    // GA subprotocol auth: just "realtime" + the ephemeral key. (Verified
    // against the live API; the old beta subprotocol is gone.)
    const socket = openWebSocket("wss://api.openai.com/v1/realtime?intent=transcription", [
      "realtime",
      `openai-insecure-api-key.${minted.client_secret}`,
    ]);
    if (!socket) {
      // A secret the browser refuses as a subprotocol throws here: finish the
      // pipe through the same path as a refused mint.
      hopeless = true;
      pipe.close();
      events?.onFailed?.("Could not start transcription");
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (closed) return;
      // The mint is the session. A session.update here used to re-send the
      // live model and the allowlist so an older mint still ended up
      // constrained; it also rewrote turn detection on a working socket, and
      // a huddle then heard speech without ever getting a completed line.
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
      if (msg.type === "input_audio_buffer.committed" && clientCommits) {
        // Commits are answered in order: the oldest span is this item's.
        const span = pendingSpans.shift();
        if (span && msg.item_id) itemSpans.set(String(msg.item_id), span);
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
        // A script nobody on the allowlist writes is the language-lock bug;
        // show nothing rather than a flash of the wrong one.
        events?.onPartial?.(isUnexpectedTranscript(partialText, languages) ? "" : partialText);
      } else if (msg.type === "conversation.item.input_audio_transcription.completed") {
        // Whatever the words turn out to be, the commit has been answered.
        answered();
        partialItem = "";
        partialText = "";
        events?.onPartial?.("");
        const text = typeof msg.transcript === "string" ? msg.transcript.trim() : "";
        if (!text) return;
        // Dropped on purpose, but never in silence: the scribe shows the drop.
        if (isUnexpectedTranscript(text, languages)) return events?.onError?.("Dropped a line outside the call's languages");
        const item = String(msg.item_id ?? "");
        const span = itemSpans.get(item) ?? { t0: at(lastStart), t1: at(endpointer.position) };
        itemSpans.delete(item);
        events?.onUtterance?.({ text, t0: span.t0, t1: span.t1 });
      } else if (msg.type === "conversation.item.input_audio_transcription.failed") {
        // The server heard the commit and got nothing out of it. Waiting longer
        // would only delay the release.
        answered();
        events?.onError?.("Could not make out the words");
      } else if (msg.type === "error") {
        // An error after a commit is the answer to that commit.
        answered();
        if (msg.error?.code === "input_audio_buffer_commit_empty") pendingSpans.shift();
        events?.onError?.(String(msg.error?.message ?? "ASR error").slice(0, 140));
      }
    };

    socket.onclose = () => {
      if (closed) return;
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

// The shared AudioContext + AudioWorklet capture lives in asrCapture.ts.
export { __resetAsrCaptureForTest } from "./asrCapture";

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
  /** null for dictation (see AsrSessionOpts). */
  roomKey: string | null;
  track: MediaStreamTrack;
  /** Timeline clock for utterance offsets, in ms. */
  clock: () => number;
  events?: AsrPipeEvents;
  /** Languages this pipe may emit. Defaults to the browser's list. */
  languages?: string[];
}): AsrPipe {
  const { track, events } = opts;
  let shared: SharedCaptureContext | null = null;
  let scriptNode: ScriptProcessorNode | null = null;
  let workletNode: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let dropped = false;

  function dropCapture() {
    if (dropped) return;
    dropped = true;
    try {
      if (scriptNode) scriptNode.onaudioprocess = null;
      scriptNode?.disconnect();
    } catch {}
    try {
      if (workletNode?.port) workletNode.port.onmessage = null;
      workletNode?.disconnect();
    } catch {}
    try {
      source?.disconnect();
    } catch {}
    scriptNode = null;
    workletNode = null;
    source = null;
    if (shared) {
      const entry = shared;
      shared = null;
      releaseCaptureContext(entry);
    }
  }

  const session = openAsrPcmSession({
    ...opts,
    events: {
      ...events,
      onFailed: (m) => {
        dropCapture();
        events?.onFailed?.(m);
      },
      onDropped: () => {
        dropCapture();
        events?.onDropped?.();
      },
    },
  });

  function attachWorklet(entry: SharedCaptureContext, src: MediaStreamAudioSourceNode): boolean {
    if (typeof AudioWorkletNode !== "function" || !entry.workletReady) return false;
    try {
      const wn = new AudioWorkletNode(entry.ctx, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
      });
      wn.port.onmessage = (e: MessageEvent<Float32Array>) => {
        if (dropped || !e.data) return;
        session.feedPcm16(floatTo16(e.data, entry.ctx.sampleRate));
      };
      src.connect(wn);
      wn.connect(entry.mute);
      workletNode = wn;
      return true;
    } catch {
      return false;
    }
  }

  try {
    const stream = new MediaStream([track]);
    const entry = acquireCaptureContext();
    shared = entry;
    const src = entry.ctx.createMediaStreamSource(stream);
    source = src;

    if (!attachWorklet(entry, src)) {
      // Synchronous t=0 capture while AudioWorklet loads (or permanently in
      // environments without AudioWorklet, including unit tests).
      const proc = entry.ctx.createScriptProcessor(4096, 1, 1);
      scriptNode = proc;
      proc.onaudioprocess = (e) => {
        if (dropped) return;
        session.feedPcm16(floatTo16(e.inputBuffer.getChannelData(0), entry.ctx.sampleRate));
      };
      src.connect(proc);
      proc.connect(entry.mute);

      void ensureWorkletLoaded(entry).then((ready) => {
        if (!ready || dropped || shared !== entry || !source || workletNode) return;
        if (attachWorklet(entry, source)) {
          try {
            if (scriptNode) scriptNode.onaudioprocess = null;
            scriptNode?.disconnect();
          } catch {}
          scriptNode = null;
        }
      });
    }
  } catch {
    dropCapture();
    // No capture path at all (an AudioContext the browser refused). The
    // recognizer will report nothing, which the caller already treats as a
    // burst without words rather than a failed burst.
  }

  return {
    get speaking() {
      return session.speaking;
    },
    finish: () => {
      dropCapture();
      return session.finish();
    },
    close() {
      dropCapture();
      session.close();
    },
  };
}
