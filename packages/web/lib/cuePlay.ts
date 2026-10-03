import type { CueSpec } from "./cueSpec";

// The one Web Audio graph every cue plays through, apart from the app: no
// store, no settings, no alert routing. `sounds.ts` is its caller inside the
// app (it adds the switches and the volume); a page that boots without the
// store (a guest's meeting page) plays a cue through the same graph, so a
// chime there is the chime the app plays, not a second drawing of it.

/** Build and start the graph a CueSpec describes.
 *
 *  `lib/cueRender.ts` renders the same spec numerically, node for node and
 *  envelope for envelope. That is the only reason anyone can say what these
 *  cues sound like: nobody working on them is allowed to play them out loud,
 *  so every level in this file was set by measuring a render, and the
 *  measurement is only worth anything while the two stay the same graph. Keep
 *  them in step: filter after the envelope for tones, before it for noise. */
function scheduleEnvelope(gain: AudioParam, t0: number, n: { start: number; dur: number; gain: number }, attack: number) {
  gain.setValueAtTime(attack > 0 ? 0 : n.gain, t0 + n.start);
  if (attack > 0) gain.linearRampToValueAtTime(n.gain, t0 + n.start + attack);
  gain.exponentialRampToValueAtTime(0.001, t0 + n.start + n.dur);
}

function scheduleGlide(freq: AudioParam, t0: number, n: { start: number; dur: number; sweepTo?: number }, from: number) {
  freq.setValueAtTime(from, t0 + n.start);
  if (n.sweepTo !== undefined) freq.exponentialRampToValueAtTime(n.sweepTo, t0 + n.start + n.dur);
}

/** Schedule `spec` on `ac`, starting now. `volume` multiplies the cue's own
 *  master gain (1 is the measured level in cueSpec.ts). */
export function scheduleCue(ac: AudioContext, spec: CueSpec, volume = 1): void {
  const t0 = ac.currentTime;
  const master = ac.createGain();
  master.gain.value = spec.master * volume;
  master.connect(ac.destination);

  for (const n of spec.tones ?? []) {
    const osc = ac.createOscillator();
    osc.type = n.type ?? "sine";
    scheduleGlide(osc.frequency, t0, n, n.freq);

    const env = ac.createGain();
    scheduleEnvelope(env.gain, t0, n, n.attack ?? 0.02);

    osc.connect(env);
    let tail: AudioNode = env;
    if (n.lowpass !== undefined) {
      const lp = ac.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = n.lowpass;
      lp.Q.value = n.lowpassQ ?? 0;
      env.connect(lp);
      tail = lp;
    }
    tail.connect(master);
    osc.start(t0 + n.start);
    osc.stop(t0 + n.start + n.dur);
  }

  for (const n of spec.noise ?? []) {
    const frames = Math.floor(ac.sampleRate * n.dur);
    const buf = ac.createBuffer(1, frames, ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;

    const band = ac.createBiquadFilter();
    band.type = "bandpass";
    scheduleGlide(band.frequency, t0, n, n.band);
    band.Q.value = n.q ?? 1;

    const env = ac.createGain();
    scheduleEnvelope(env.gain, t0, n, n.attack ?? 0);

    src.connect(band);
    band.connect(env);
    env.connect(master);
    src.start(t0 + n.start);
    src.stop(t0 + n.start + n.dur);
  }
}

let shared: AudioContext | null = null;

/** Play a cue on a context of the page's own, for a page without the app's
 *  sound settings. Silent, never an error, where the browser has no audio or
 *  is still holding it for a page nobody touched. */
export function playCueStandalone(spec: CueSpec): void {
  if (typeof AudioContext === "undefined") return;
  try {
    shared ??= new AudioContext();
    if (shared.state === "suspended") void shared.resume().catch(() => {});
    scheduleCue(shared, spec);
  } catch {}
}
