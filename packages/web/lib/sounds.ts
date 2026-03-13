let ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function play(
  notes: Array<{ freq: number; start: number; dur: number; gain?: number; type?: OscillatorType }>,
  masterGain = 0.12,
) {
  try {
    const ac = getCtx();
    const master = ac.createGain();
    master.gain.value = masterGain;
    master.connect(ac.destination);

    for (const n of notes) {
      const osc = ac.createOscillator();
      const env = ac.createGain();
      osc.type = n.type ?? "sine";
      osc.frequency.value = n.freq;
      env.gain.setValueAtTime(0, ac.currentTime + n.start);
      env.gain.linearRampToValueAtTime(n.gain ?? 1, ac.currentTime + n.start + 0.02);
      env.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + n.start + n.dur);
      osc.connect(env);
      env.connect(master);
      osc.start(ac.currentTime + n.start);
      osc.stop(ac.currentTime + n.start + n.dur);
    }
  } catch {}
}

export function soundNewSession() {
  play([
    { freq: 392, start: 0, dur: 0.2, gain: 0.5, type: "sine" },
    { freq: 523.25, start: 0.12, dur: 0.25, gain: 0.35, type: "sine" },
  ], 0.05);
}

export function soundIdle() {
  play([
    { freq: 440, start: 0, dur: 0.3, gain: 0.6, type: "sine" },
    { freq: 349.23, start: 0.15, dur: 0.35, gain: 0.4, type: "sine" },
  ], 0.07);
}

export function soundDismiss() {
  play([
    { freq: 600, start: 0, dur: 0.12, gain: 0.7, type: "sine" },
    { freq: 440, start: 0.06, dur: 0.18, gain: 0.5, type: "sine" },
  ], 0.06);
}
