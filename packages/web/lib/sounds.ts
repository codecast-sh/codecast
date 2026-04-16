import { useInboxStore } from "../store/inboxStore";

let ctx: AudioContext | null = null;

function isSupported(): boolean {
  return typeof AudioContext !== "undefined";
}

function isEnabled(): boolean {
  return useInboxStore.getState().clientState?.ui?.sounds_enabled !== false;
}

function getCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function play(
  notes: Array<{ freq: number; start: number; dur: number; gain?: number; type?: OscillatorType }>,
  masterGain = 0.12,
) {
  if (!isSupported()) return;
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
  if (!isEnabled()) return;
  play([
    { freq: 392, start: 0, dur: 0.2, gain: 0.5, type: "sine" },
    { freq: 523.25, start: 0.12, dur: 0.25, gain: 0.35, type: "sine" },
  ], 0.05);
}

export function soundIdle() {
  if (!isEnabled()) return;
  play([
    { freq: 392, start: 0, dur: 0.25, gain: 0.4, type: "sine" },
    { freq: 494, start: 0.15, dur: 0.3, gain: 0.3, type: "sine" },
  ], 0.05);
}

export function soundDismiss() {
  if (!isEnabled() || !isSupported()) return;
  try {
    const ac = getCtx();
    const master = ac.createGain();
    master.gain.value = 0.08;
    master.connect(ac.destination);

    const bufferSize = ac.sampleRate * 0.3;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = buffer;

    const filter = ac.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 2;
    filter.frequency.setValueAtTime(3000, ac.currentTime);
    filter.frequency.exponentialRampToValueAtTime(300, ac.currentTime + 0.2);

    const env = ac.createGain();
    env.gain.setValueAtTime(0, ac.currentTime);
    env.gain.linearRampToValueAtTime(0.6, ac.currentTime + 0.03);
    env.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.22);

    noise.connect(filter);
    filter.connect(env);
    env.connect(master);
    noise.start(ac.currentTime);
    noise.stop(ac.currentTime + 0.25);
  } catch {}
}

export function soundKill() {
  if (!isEnabled() || !isSupported()) return;
  try {
    const ac = getCtx();
    const master = ac.createGain();
    master.gain.value = 0.1;
    master.connect(ac.destination);

    // Short noise burst through a lowpass — a dry "thud"
    const bufferSize = ac.sampleRate * 0.15;
    const buffer = ac.createBuffer(1, bufferSize, ac.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const noise = ac.createBufferSource();
    noise.buffer = buffer;

    const filter = ac.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(800, ac.currentTime);
    filter.frequency.exponentialRampToValueAtTime(120, ac.currentTime + 0.08);
    filter.Q.value = 1;

    const env = ac.createGain();
    env.gain.setValueAtTime(0.8, ac.currentTime);
    env.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.1);

    noise.connect(filter);
    filter.connect(env);
    env.connect(master);
    noise.start(ac.currentTime);
    noise.stop(ac.currentTime + 0.12);
  } catch {}
}

export function soundSend() {
  if (!isEnabled() || !isSupported()) return;
  try {
    const ac = getCtx();
    const master = ac.createGain();
    master.gain.value = 0.04;
    master.connect(ac.destination);

    // Quick upward sweep — gives a soft "fwip" send feel
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(620, ac.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1240, ac.currentTime + 0.07);

    const env = ac.createGain();
    env.gain.setValueAtTime(0, ac.currentTime);
    env.gain.linearRampToValueAtTime(0.4, ac.currentTime + 0.01);
    env.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.1);

    osc.connect(env);
    env.connect(master);
    osc.start(ac.currentTime);
    osc.stop(ac.currentTime + 0.12);
  } catch {}
}
