// Where a spoken turn ends, decided from the audio on this device.
//
// gpt-live-transcribe refuses server turn detection, streams deltas while it
// listens, and finishes a line only when the client sends
// `input_audio_buffer.commit`. So the client decides where turns end, and
// this is that decision: an energy gate over 20 ms frames of 24 kHz PCM16.
//
// - The gate is three times the noise floor, never below -50 dBFS. The floor
//   is the 10th percentile of the last 10 s of frames, so it follows a room
//   that gets louder or quieter without a speaker's own voice pulling it up.
//   For the first second, before there is a window, it is the quietest frame.
// - A turn opens on the first voiced frame and counts once it has 250 ms of
//   voiced frames; a click or a cough shorter than that never becomes a turn.
// - A counted turn closes after 600 ms of quiet. A turn that never counted is
//   forgotten; its audio stays in the server's buffer and rides the next
//   commit, so nothing said is lost.
// - Nobody pauses for 15 s straight in a monologue, so past 15 s the turn is
//   cut at the next frame that is the quietest of the last second (a gap
//   between words), and at 20 s regardless. Speech carries on into a new turn.
//
// Positions are sample counts since the first sample fed, so a turn's start
// and end are when it was said, not when the recognizer answered.
//
// Pure and synchronous: asrPipe (browser and phone) feeds it, the speech lab
// replays files through it, and the tests drive it with synthetic PCM.

export const ENDPOINTER_SAMPLE_RATE = 24_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = (ENDPOINTER_SAMPLE_RATE * FRAME_MS) / 1000;
const MIN_GATE = 10 ** (-50 / 20);
const FLOOR_FACTOR = 3;
const FLOOR_PERCENTILE = 0.1;
const FLOOR_WINDOW_FRAMES = 10_000 / FRAME_MS;
const FLOOR_REFRESH_FRAMES = 5;
/** Until this much has been heard the floor is the quietest frame so far: a
 *  person who starts talking as the mic opens would otherwise set the floor
 *  to their own voice, and a fixed gate would hear a noisy room as speech. */
const FLOOR_WARMUP_FRAMES = 1_000 / FRAME_MS;
export const ENDPOINT_SILENCE_MS = 600;
export const ENDPOINT_MIN_SPEECH_MS = 250;
export const ENDPOINT_FORCE_AFTER_MS = 15_000;
const FORCE_HARD_MS = 20_000;
const QUIET_LOOKBACK_FRAMES = 1_000 / FRAME_MS;

export type EndpointEvent =
  /** A turn reached 250 ms of voiced audio. `at` is its first voiced sample. */
  | { type: "start"; at: number }
  /** A turn is over. `start`/`end` bound the speech in samples; `commitAt`
   *  is the sample where it closed, which is where the commit belongs.
   *  `forced` cuts keep the speaker talking: no stop, and a new turn already
   *  counts from `end`. */
  | { type: "end"; start: number; end: number; commitAt: number; forced: boolean };

export type Endpointer = {
  /** Feed PCM16 mono at 24 kHz, any chunk size. Returns what happened. */
  push(pcm: Int16Array): EndpointEvent[];
  /** Samples fed so far. */
  readonly position: number;
  /** True while a counted turn is open. */
  readonly speaking: boolean;
  /** First sample of the open turn, counted or not; null when quiet. */
  readonly turnStart: number | null;
};

export function samplesToMs(samples: number): number {
  return (samples * 1000) / ENDPOINTER_SAMPLE_RATE;
}

export function createEndpointer(): Endpointer {
  let position = 0;
  // The frame being filled: sum of squares and how many samples so far.
  let acc = 0;
  let accN = 0;
  const history = new Float64Array(FLOOR_WINDOW_FRAMES);
  let historyN = 0;
  let historyAt = 0;
  let gate = MIN_GATE;
  let framesSinceFloor = FLOOR_REFRESH_FRAMES;
  const recent = new Float64Array(QUIET_LOOKBACK_FRAMES);
  let recentN = 0;
  let recentAt = 0;
  // The open turn, in frame-end sample positions.
  let start: number | null = null;
  let lastVoicedEnd = 0;
  let voicedSamples = 0;
  let counted = false;

  function refreshGate() {
    const sorted = Array.from(history.subarray(0, historyN)).sort((a, b) => a - b);
    const pct = historyN < FLOOR_WARMUP_FRAMES ? 0 : FLOOR_PERCENTILE;
    const floor = sorted[Math.floor((sorted.length - 1) * pct)] ?? 0;
    gate = Math.max(floor * FLOOR_FACTOR, MIN_GATE);
  }

  function frame(rms: number, end: number, out: EndpointEvent[]) {
    history[historyAt] = rms;
    historyAt = (historyAt + 1) % FLOOR_WINDOW_FRAMES;
    historyN = Math.min(historyN + 1, FLOOR_WINDOW_FRAMES);
    if (++framesSinceFloor >= FLOOR_REFRESH_FRAMES) {
      framesSinceFloor = 0;
      refreshGate();
    }
    let quietest = true;
    for (let i = 0; i < recentN; i++) if (recent[i]! < rms) quietest = false;
    recent[recentAt] = rms;
    recentAt = (recentAt + 1) % QUIET_LOOKBACK_FRAMES;
    recentN = Math.min(recentN + 1, QUIET_LOOKBACK_FRAMES);

    const voiced = rms >= gate;
    if (voiced) {
      if (start === null) {
        start = end - FRAME_SAMPLES;
        voicedSamples = 0;
        counted = false;
      }
      voicedSamples += FRAME_SAMPLES;
      lastVoicedEnd = end;
      if (!counted && samplesToMs(voicedSamples) >= ENDPOINT_MIN_SPEECH_MS) {
        counted = true;
        out.push({ type: "start", at: start });
      }
    }
    if (start === null) return;
    if (samplesToMs(end - lastVoicedEnd) >= ENDPOINT_SILENCE_MS) {
      if (counted) out.push({ type: "end", start, end: lastVoicedEnd, commitAt: end, forced: false });
      start = null;
      counted = false;
      return;
    }
    const length = samplesToMs(end - start);
    if (counted && length >= ENDPOINT_FORCE_AFTER_MS && (quietest || length >= FORCE_HARD_MS)) {
      out.push({ type: "end", start, end, commitAt: end, forced: true });
      start = end;
      voicedSamples = 0;
      lastVoicedEnd = end;
      // Still talking: the next turn counts at once, so no start/stop flaps.
    }
  }

  return {
    push(pcm) {
      const out: EndpointEvent[] = [];
      for (let i = 0; i < pcm.length; i++) {
        const v = pcm[i]! / 32768;
        acc += v * v;
        position += 1;
        if (++accN === FRAME_SAMPLES) {
          frame(Math.sqrt(acc / FRAME_SAMPLES), position, out);
          acc = 0;
          accN = 0;
        }
      }
      return out;
    },
    get position() {
      return position;
    },
    get speaking() {
      return counted;
    },
    get turnStart() {
      return start;
    },
  };
}
