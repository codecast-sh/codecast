import { useInboxStore } from "../store/inboxStore";
import { isNotificationLeader } from "./desktop";

let ctx: AudioContext | null = null;

function isSupported(): boolean {
  return typeof AudioContext !== "undefined";
}

function isEnabled(): boolean {
  return useInboxStore.getState().clientState?.ui?.sounds_enabled !== false;
}

// Chat has its own switch (see clientState.ui.chat_sounds_enabled).
function isChatEnabled(): boolean {
  return useInboxStore.getState().clientState?.ui?.chat_sounds_enabled !== false;
}

// Sounds that ANNOUNCE something (a message, a ring, a session waiting) play
// in every window that observes the event — on the desktop that is the main
// window plus every detached tab window, all subscribed to the same data. Only
// the shell-elected leader window sounds them, so one event is one sound.
// Feedback for the user's own gesture (send, kill, dismiss) is not gated: it
// happens in exactly the window that acted.
function isAnnouncer(): boolean {
  return isNotificationLeader();
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
  if (!isEnabled() || !isAnnouncer()) return;
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

// A chat message that raised a toast. One sound for every chat toast, quiet
// or loud — the way Slack's "Knock Brush" is one sound: the CARD says how much
// the message matters, the sound only says "someone spoke". A separate louder
// sound for mentions trains people to ignore the ordinary one.
//
// The character is a soft mallet on wood — two short marimba notes rising a
// fourth (G5 → C6), each with the 4× partial that makes a marimba read as
// marimba rather than as a sine, plus a 20 ms filtered-noise transient for
// the wooden knock at the front. Over in ~300 ms, master gain kept low so it
// can land mid-sentence in another window without startling.
export function soundChatMessage() {
  if (!isChatEnabled() || !isSupported() || !isAnnouncer()) return;
  playKnockMotif();
}

// Someone knocking at the locked huddle you are in. The SAME two-tap wooden
// motif — it is literally a knock, and it can't be mistaken for a ring — but
// gated as a call event rather than a chat one: muting chat must not mute the
// door. One motif, two gates, so the two can never drift apart.
export function soundRoomKnock() {
  if (!isEnabled() || !isSupported() || !isAnnouncer()) return;
  playKnockMotif();
}

function playKnockMotif() {
  try {
    const ac = getCtx();
    const master = ac.createGain();
    master.gain.value = 0.045;
    master.connect(ac.destination);
    const t0 = ac.currentTime;

    const knock = (at: number, gain: number) => {
      const len = Math.floor(ac.sampleRate * 0.03);
      const buf = ac.createBuffer(1, len, ac.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ac.createBufferSource();
      src.buffer = buf;
      const bp = ac.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 1900;
      bp.Q.value = 1.2;
      const env = ac.createGain();
      env.gain.setValueAtTime(gain, t0 + at);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + at + 0.03);
      src.connect(bp);
      bp.connect(env);
      env.connect(master);
      src.start(t0 + at);
      src.stop(t0 + at + 0.035);
    };

    const mallet = (freq: number, at: number, dur: number, gain: number) => {
      // Fundamental and the marimba's bright 4× partial, the partial dying
      // faster — that is what makes it wood, not glass.
      for (const [mult, g, d] of [[1, 1, dur], [4, 0.18, dur * 0.35]] as const) {
        const osc = ac.createOscillator();
        osc.type = "sine";
        osc.frequency.value = freq * mult;
        const env = ac.createGain();
        env.gain.setValueAtTime(0, t0 + at);
        env.gain.linearRampToValueAtTime(gain * g, t0 + at + 0.006);
        env.gain.exponentialRampToValueAtTime(0.001, t0 + at + d);
        osc.connect(env);
        env.connect(master);
        osc.start(t0 + at);
        osc.stop(t0 + at + d + 0.01);
      }
    };

    knock(0, 0.5);
    mallet(783.99, 0, 0.26, 0.6);
    // The second strike lands while the first still rings, so the two read as
    // one gesture ("plink-plonk"), not two events.
    knock(0.085, 0.35);
    mallet(1046.5, 0.085, 0.32, 0.55);
  } catch {}
}

// Older name for soundChatMessage. useChatToasts still imports it on main;
// the rename to soundChatMessage lands with the chat toast rework. Alias, not
// a copy, so the two can never drift into different sounds.
export const soundChatMention = soundChatMessage;

// One ring cycle for an incoming huddle: two warm fifths, held slightly —
// unmistakably a "someone wants you", distinct from every notification chirp
// above. The ring HOOK (useCallRing) repeats this on an interval and owns the
// 45s ceiling; this stays a single cycle so a dismissed ring stops instantly.
export function soundCallRing() {
  if (!isEnabled() || !isAnnouncer()) return;
  // The huddle ring motif — same bell call-and-answer the mobile app plays
  // (assets/sounds/huddle-ring.m4a, generated by packages/mobile/scripts/
  // ringtone.py, candidate A): a friendly knock (G#5→E5), then a brighter
  // answer (B5→E6), over a soft low E. Each strike carries a quiet octave
  // partial for the struck-bell timbre. One cell = CALL_RING_PERIOD_MS.
  play([
    { freq: 329.63, start: 0, dur: 0.4, gain: 0.22, type: "sine" },
    { freq: 830.61, start: 0, dur: 1.0, gain: 0.5, type: "sine" },
    { freq: 1661.22, start: 0, dur: 0.6, gain: 0.14, type: "sine" },
    { freq: 659.25, start: 0.18, dur: 1.1, gain: 0.45, type: "sine" },
    { freq: 1318.51, start: 0.18, dur: 0.65, gain: 0.12, type: "sine" },
    { freq: 247.22, start: 0.72, dur: 0.35, gain: 0.13, type: "sine" },
    { freq: 987.77, start: 0.72, dur: 0.9, gain: 0.34, type: "sine" },
    { freq: 1975.53, start: 0.72, dur: 0.5, gain: 0.09, type: "sine" },
    { freq: 1318.51, start: 0.9, dur: 1.15, gain: 0.3, type: "sine" },
    { freq: 2637.02, start: 0.9, dur: 0.55, gain: 0.07, type: "sine" },
  ], 0.06);
}

// Someone joined the room you're in (or you connected): a soft rising triad.
export function soundCallJoin() {
  if (!isEnabled()) return;
  play([
    { freq: 523.25, start: 0, dur: 0.15, gain: 0.4, type: "sine" },
    { freq: 659.25, start: 0.08, dur: 0.18, gain: 0.35, type: "sine" },
    { freq: 783.99, start: 0.16, dur: 0.25, gain: 0.3, type: "sine" },
  ], 0.05);
}

// A participant left / the call ended: the join triad, descending.
export function soundCallLeave() {
  if (!isEnabled()) return;
  play([
    { freq: 783.99, start: 0, dur: 0.15, gain: 0.35, type: "sine" },
    { freq: 659.25, start: 0.08, dur: 0.18, gain: 0.3, type: "sine" },
    { freq: 523.25, start: 0.16, dur: 0.25, gain: 0.25, type: "sine" },
  ], 0.045);
}

// The walkie door opened: a teammate's push-to-talk burst is about to play
// through this machine's speakers. Deliberately NOT a ring — nobody is being
// summoned, the voice is already coming — so it is the two-click squelch of a
// radio keying up: short, dry, and over before the first word.
export function soundWalkieOpen() {
  if (!isEnabled() || !isAnnouncer()) return;
  play([
    { freq: 1046.5, start: 0, dur: 0.05, gain: 0.35, type: "square" },
    { freq: 698.46, start: 0.06, dur: 0.09, gain: 0.3, type: "sine" },
  ], 0.03);
}

// Your ring was declined or timed out — one low, brief, apologetic note.
export function soundCallDeclined() {
  if (!isEnabled() || !isAnnouncer()) return;
  play([
    { freq: 329.63, start: 0, dur: 0.25, gain: 0.4, type: "sine" },
    { freq: 261.63, start: 0.18, dur: 0.3, gain: 0.3, type: "sine" },
  ], 0.045);
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
