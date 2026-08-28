// An offline render of a CueSpec, so a cue can be measured instead of heard.
//
// This reproduces the graph `sounds.ts` builds — the same envelope shape, the
// same oscillator waveforms band-limited the way Web Audio band-limits them,
// and the biquad formulas straight out of the Web Audio spec (which is why a
// lowpass Q is in decibels and a bandpass Q is not: the spec treats them
// differently, and matching that is the difference between a measurement and
// an estimate).
//
// It exists because nobody working on these cues can play them out loud. Every
// peak in a comment or a test comes from here.

import type { CueNoise, CueSpec, CueTone } from "./cueSpec";

export const RENDER_SAMPLE_RATE = 48_000;

/** Web Audio's floor for an exponential ramp; below it a ramp cannot go. */
const RAMP_FLOOR = 0.001;

// ── the envelope `play()` writes on every note ────────────────────────────

function toneEnvelope(t: number, n: CueTone): number {
  if (t < n.start || t > n.start + n.dur) return 0;
  const attack = n.attack ?? 0.02;
  const local = t - n.start;
  if (local <= attack) return (n.gain * local) / attack;
  // exponentialRampToValueAtTime from `gain` at the attack to the floor at dur
  return n.gain * Math.pow(RAMP_FLOOR / n.gain, (local - attack) / (n.dur - attack));
}

function noiseEnvelope(t: number, n: CueNoise): number {
  if (t < n.start || t > n.start + n.dur) return 0;
  // Noise cues open at full and only decay — a squelch tail has no attack.
  return n.gain * Math.pow(RAMP_FLOOR / n.gain, (t - n.start) / n.dur);
}

// ── oscillators, band-limited to Nyquist the way Web Audio's are ──────────

function oscillator(type: OscillatorType, phase: number, freq: number, sampleRate: number): number {
  if (type === "sine") return Math.sin(phase);
  const maxHarmonic = Math.floor(sampleRate / 2 / Math.max(freq, 1));
  let sum = 0;
  if (type === "square") {
    for (let k = 1; k <= maxHarmonic; k += 2) sum += Math.sin(k * phase) / k;
    return (4 / Math.PI) * sum;
  }
  if (type === "triangle") {
    for (let k = 1; k <= maxHarmonic; k += 2) {
      sum += (((k - 1) / 2) % 2 === 0 ? 1 : -1) * (Math.sin(k * phase) / (k * k));
    }
    return (8 / (Math.PI * Math.PI)) * sum;
  }
  // sawtooth
  for (let k = 1; k <= maxHarmonic; k++) sum += Math.sin(k * phase) / k;
  return (2 / Math.PI) * sum;
}

/** Instantaneous frequency, following the exponential glide when there is one. */
function toneFrequency(t: number, n: CueTone): number {
  if (n.sweepTo === undefined) return n.freq;
  const local = Math.min(Math.max(t - n.start, 0), n.dur);
  return n.freq * Math.pow(n.sweepTo / n.freq, local / n.dur);
}

// ── biquads, per the Web Audio spec's own coefficient formulas ────────────

type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

function lowpassCoefficients(freq: number, qDb: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  // Lowpass and highpass take Q in decibels. This is the spec's rule, not ours.
  const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function highpassCoefficients(freq: number, qDb: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.pow(10, qDb / 20));
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function bandpassCoefficients(freq: number, q: number, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const sin = Math.sin(w0);
  // Bandpass takes Q as a bandwidth in octaves, again per the spec.
  const alpha = sin * Math.sinh(((Math.LN2 / 2) * q * w0) / sin);
  const cos = Math.cos(w0);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 };
}

function filterInPlace(samples: Float32Array, c: Biquad): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    samples[i] = y0;
  }
}

// ── deterministic noise ───────────────────────────────────────────────────

/** A cue that fills its buffer from Math.random measures differently on every
 *  run. Seeded here so a rendered peak is a fact about the cue, not a draw. */
function seededNoise(length: number, seed: number): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state / 0x100000000) * 2 - 1;
  }
  return out;
}

// ── the render ────────────────────────────────────────────────────────────

export function cueDuration(spec: CueSpec): number {
  let end = 0;
  for (const n of spec.tones ?? []) end = Math.max(end, n.start + n.dur);
  for (const n of spec.noise ?? []) end = Math.max(end, n.start + n.dur);
  return end;
}

export function renderCue(spec: CueSpec, sampleRate = RENDER_SAMPLE_RATE): Float32Array {
  const frames = Math.ceil(cueDuration(spec) * sampleRate) + 1;
  const out = new Float32Array(frames);

  for (const n of spec.tones ?? []) {
    const voice = new Float32Array(frames);
    let phase = 0;
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate;
      phase += (2 * Math.PI * toneFrequency(t, n)) / sampleRate;
      const env = toneEnvelope(t, n);
      if (env !== 0) voice[i] = env * oscillator(n.type ?? "sine", phase, toneFrequency(t, n), sampleRate);
    }
    if (n.lowpass !== undefined) {
      filterInPlace(voice, lowpassCoefficients(n.lowpass, n.lowpassQ ?? 0, sampleRate));
    }
    for (let i = 0; i < frames; i++) out[i] += voice[i];
  }

  let seed = 0x5eed;
  for (const n of spec.noise ?? []) {
    const voice = seededNoise(frames, (seed = (seed * 31 + 7) >>> 0));
    filterInPlace(voice, bandpassCoefficients(n.band, n.q ?? 1, sampleRate));
    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate;
      out[i] += noiseEnvelope(t, n) * voice[i];
    }
  }

  for (let i = 0; i < frames; i++) out[i] *= spec.master;
  return out;
}

/** The loudest sample the speaker gets. The number every cue is judged by. */
export function cuePeak(spec: CueSpec, sampleRate = RENDER_SAMPLE_RATE): number {
  const samples = renderCue(spec, sampleRate);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak;
}

/** Loudness over the whole cue. A tail of noise and a chirp can share a peak
 *  and still be nothing alike; this is what separates them. */
export function cueRms(spec: CueSpec, sampleRate = RENDER_SAMPLE_RATE): number {
  const samples = renderCue(spec, sampleRate);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** How much of a cue's energy sits above `cutoff`, as a share of all of it.
 *
 *  Peak and broadband RMS both miss the thing that makes a square wave harsh,
 *  which is not how big it is but where its energy sits: the ear weights 2 to
 *  5 kHz far above the rest, so a square and a sine of the same peak and the
 *  same RMS are not the same loudness. That gap is exactly what the walkie
 *  chirps' lowpass exists to close, and this is the only measure in the file
 *  that can see it. Four cascaded highpasses, for a skirt steep enough that
 *  the answer is about the harmonics rather than about the filter.
 *
 *  This is not a loudness model. It is one number that moves when the thing
 *  it is watching moves, which is what a design nobody may listen to needs. */
export function cueHighBandShare(spec: CueSpec, cutoff = 2000, sampleRate = RENDER_SAMPLE_RATE): number {
  const full = renderCue(spec, sampleRate);
  const high = Float32Array.from(full);
  // Butterworth (-3.01 dB is a Q factor of 0.7071), so the analysis filter has
  // no resonant bump of its own. At the default Q of 0 dB, four cascaded
  // sections put a peak over the cutoff big enough to report a share above 1
  // for a cue whose noise sits right there.
  const hp = highpassCoefficients(cutoff, -3.01, sampleRate);
  for (let i = 0; i < 4; i++) filterInPlace(high, hp);
  let allEnergy = 0;
  let highEnergy = 0;
  for (let i = 0; i < full.length; i++) {
    allEnergy += full[i] * full[i];
    highEnergy += high[i] * high[i];
  }
  return allEnergy === 0 ? 0 : Math.sqrt(highEnergy / allEnergy);
}
