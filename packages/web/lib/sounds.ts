import { useInboxStore } from "../store/inboxStore";
import { isNotificationLeader } from "./desktop";
import type { CueSpec } from "./cueSpec";
import {
  WALKIE_AWAY,
  WALKIE_JOINED,
  WALKIE_KEY_UP,
  WALKIE_OPEN,
  WALKIE_ROGER,
  WALKIE_SQUELCH,
} from "./cueSpec";

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

/** Drop the cached AudioContext.
 *
 *  One context per page is the production rule — browsers cap how many may be
 *  open — so `getCtx` caches one and never lets go. Under `bun test` that cache
 *  outlives the file that filled it: each sound test installs its own stand-in
 *  AudioContext and counts the nodes a cue builds, so the FIRST file to sound
 *  anything pins the context for every file after it, and those files count
 *  zero. The symptom is a suite that passes one file at a time and fails when
 *  run together. Every sound test drops the cache before it counts. */
export function resetAudioContext() {
  ctx = null;
}

function play(
  notes: Array<{ freq: number; start: number; dur: number; gain?: number; type?: OscillatorType }>,
  masterGain = 0.12,
) {
  playCue({ master: masterGain, tones: notes.map((n) => ({ ...n, gain: n.gain ?? 1 })) });
}

/** Build and start the graph a CueSpec describes.
 *
 *  `lib/cueRender.ts` renders the same spec numerically, node for node and
 *  envelope for envelope. That is the only reason anyone can say what these
 *  cues sound like: nobody working on them is allowed to play them out loud,
 *  so every level in this file was set by measuring a render, and the
 *  measurement is only worth anything while the two stay the same graph. Keep
 *  them in step — filter after the envelope for tones, before it for noise. */
function playCue(spec: CueSpec) {
  if (!isSupported()) return;
  try {
    const ac = getCtx();
    const t0 = ac.currentTime;
    const master = ac.createGain();
    master.gain.value = spec.master;
    master.connect(ac.destination);

    for (const n of spec.tones ?? []) {
      const osc = ac.createOscillator();
      osc.type = n.type ?? "sine";
      osc.frequency.setValueAtTime(n.freq, t0 + n.start);
      if (n.sweepTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(n.sweepTo, t0 + n.start + n.dur);
      }

      const env = ac.createGain();
      env.gain.setValueAtTime(0, t0 + n.start);
      env.gain.linearRampToValueAtTime(n.gain, t0 + n.start + (n.attack ?? 0.02));
      env.gain.exponentialRampToValueAtTime(0.001, t0 + n.start + n.dur);

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
      band.frequency.value = n.band;
      band.Q.value = n.q ?? 1;

      const env = ac.createGain();
      env.gain.setValueAtTime(n.gain, t0 + n.start);
      env.gain.exponentialRampToValueAtTime(0.001, t0 + n.start + n.dur);

      src.connect(band);
      band.connect(env);
      env.connect(master);
      src.start(t0 + n.start);
      src.stop(t0 + n.start + n.dur);
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
//
// `messageId` collapses one arrival to one sound. Two layers watch the same
// message through two different feeds and neither can see the other: the
// in-page toast reads the chat rail, and the notification watcher in
// DesktopProvider reads notification rows and sounds the unfocused case that
// silent OS banners leave mute. Both are right to sound it. Unfocused, both
// fired, ~15 ms apart, and it was audible as a doubled blip on every arrival.
// The message's own id settles it — the same rule notifyNative already uses to
// collapse one row reported by every open window into one banner.
export function soundChatMessage(messageId?: string) {
  if (!isChatEnabled() || !isSupported() || !isAnnouncer()) return;
  if (soundedRecently(messageId)) return;
  playKnockMotif();
}

// Long enough to cover the two feeds answering the same push (measured 15 ms
// apart), short enough that a real second message from the same author is
// never swallowed — nobody sends the same message id twice.
const ARRIVAL_COLLAPSE_MS = 3_000;
const soundedAt = new Map<string, number>();

function soundedRecently(key: string | undefined): boolean {
  if (!key) return false;
  const now = Date.now();
  for (const [k, t] of soundedAt) if (now - t > ARRIVAL_COLLAPSE_MS) soundedAt.delete(k);
  const seen = soundedAt.has(key);
  soundedAt.set(key, now);
  return seen;
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

// ── the walkie cues ───────────────────────────────────────────────────────
//
// The founder's report was "no sound that i started recording". The cause was
// measurable rather than a matter of taste: all four walkie cues peaked around
// 0.011 while the ring peaks at 0.046. They were a factor of four below
// everything else the app plays, and none of them lasted a fifth of a second.
// They were not missing. They were under the floor of a room.
//
// Each is a spec in `cueSpec.ts` now, and every number here is what
// `cueRender.ts` measures off that spec rather than what anyone intended.
// Peak is the loudest sample. RMS is taken over a fixed 150 ms from the start,
// because whole-cue RMS only rewards a cue for being short. ">2k" is the share
// of energy above 2 kHz, which is the one column that sees harshness: peak and
// RMS cannot tell a square from a sine, and the ear has no trouble at all.
//
//   cue       peak     was      rms    >2k    length   what it says
//   joined   0.0532      —    0.0138  0.07     310ms   they stepped in; a call now
//   keyUp    0.0458   0.0124  0.0141  0.08     185ms   your mic is open, speak
//   roger    0.0386   0.0122  0.0096  0.00     130ms   your burst is closed and sent
//   open     0.0339   0.0121  0.0103  0.07     105ms   a teammate's burst is arriving
//   away     0.0229      —    0.0057  0.00      90ms   nobody live; it goes as a message
//   squelch  0.0208   0.0036  0.0021  0.49      90ms   that burst ended
//
// For scale: soundCallJoin peaks at 0.0196, soundChatMessage at 0.0316, and
// soundCallRing at 0.0458 — which keyUp now matches to the fourth decimal, by
// arithmetic rather than by aim. soundKill stays the app's alarm and nothing
// here approaches it.
//
// The order is the point. The two moments that carry news — your mic opening,
// and someone stepping into your burst — are the two loudest. The two that are
// only punctuation are the two quietest. squelch's high >2k figure is what
// band-limited noise is; it is also the quietest thing in the table by a
// factor of five, so it reads as a tail and not as a hiss.
//
// ── which of these the leader window owns ─────────────────────────────────
//
// The split is the one this file has always drawn, stated for six cues
// instead of four. A cue that ANNOUNCES an event is gated on
// `isNotificationLeader()`, because on the desktop the main window and every
// detached tab window watch the same data and would each sound it. A cue that
// answers THIS window's own burst is not, for the same reason `soundSend` is
// not: only one window is holding the key.
//
//   leader gated   open, squelch          a teammate's burst, observed by all
//   not gated      keyUp, roger,          your own burst, in the window that
//                  joined, away           is holding the key
//
// `joined` looks like the exception and is not. It fires from a roster
// watcher, which every window runs — but `useWalkieUpgrade` only arms that
// watcher for a room the WALKIE is in, and the walkie's status is module
// state in `walkie.ts`, one copy per window. Only the window that held the
// key has the room, so only that window fires. The election has nothing to
// settle, exactly as with keyUp. `away` is the same burst's other ending.
//
// The guard, not the intention, is what keeps them off the gated side. If
// either is ever raised from a watcher that is not narrowed to this window's
// own room, it has become an announcement and belongs above.

/** YOUR key going down, at the moment the mic is genuinely open — the classic
 *  two-tone rising chirp a radio makes when it keys up, a fifth from A5 to E6.
 *
 *  The cue the founder named, and the one everything else was levelled
 *  against: it is the only confirmation that arrives without looking at the
 *  screen, and it marks the exact instant it becomes worth speaking. It peaks
 *  at 0.0458, which is soundCallRing's peak to the fourth decimal.
 *
 *  Square waves, because that is what makes a chirp read as a radio rather
 *  than as a chime, but each note through its own lowpass — 1500 Hz for the
 *  A5, 2200 Hz for the E6 — placed just above that note's fundamental, where
 *  a handheld radio's speaker gives out. That keeps the buzz and drops the
 *  harmonics that would make it harsh at nearly four times its old level:
 *  measured share of energy above 2 kHz falls from 0.33 to 0.08. */
export function soundWalkieKeyUp() {
  if (!isEnabled()) return;
  playCue(WALKIE_KEY_UP);
}

/** Your key coming up: the "roger" beep, one tone falling from A5 to D5. It
 *  says the burst is closed and on its way, which is the half a push-to-talk
 *  key cannot show — the hand is already off it and the eye has moved on. */
export function soundWalkieRoger() {
  if (!isEnabled()) return;
  playCue(WALKIE_ROGER);
}

/** Someone stepped into the burst you are sending: it is a call now, and the
 *  mic that was going to close is staying open. The biggest change of state
 *  the walkie has, so it is the loudest of the six and the only one that
 *  climbs three notes.
 *
 *  Deliberately not soundCallJoin, which is a major triad on C. This is a
 *  fifth then a fourth from E5 to E6, brighter, shorter, and with an octave
 *  over the last note only — so the two never trade places in the ear, and
 *  "they joined my burst" never sounds like "someone entered a room". */
export function soundWalkieJoined() {
  if (!isEnabled()) return;
  playCue(WALKIE_JOINED);
}

/** Your burst is landing as a message: nobody is live to hear it now. One
 *  soft low tick, the quiet end of the set, because this is the ordinary
 *  case and not a failure — the words still arrive, they just wait to be
 *  read. Its attack is shorter than one cycle at 220 Hz, which is what makes
 *  it a tick rather than a note. */
export function soundWalkieAway() {
  if (!isEnabled()) return;
  playCue(WALKIE_AWAY);
}

/** The walkie door opened: a teammate's push-to-talk burst is about to play
 *  through this machine's speakers. Deliberately NOT a ring — nobody is being
 *  summoned, the voice is already coming — so it is the two-click squelch of a
 *  radio keying up: short, dry, and over before the first word. Both clicks
 *  are the same pitch, so it reads as a click rather than a tune and cannot be
 *  mistaken for the rising keyUp or the falling roger. */
export function soundWalkieOpen() {
  if (!isEnabled() || !isAnnouncer()) return;
  playCue(WALKIE_OPEN);
}

/** The walkie door closed: the burst you were hearing ended. A radio's squelch
 *  tail — the short hiss that follows a released key — so the end of a
 *  sentence is as audible as its start. Noise rather than a tone, because a
 *  squelch tail is the receiver's own hiss coming back and any pitch in it
 *  would read as a second voice. The quietest of the six on purpose: it is
 *  punctuation, and broadband noise carries further than a sine at the same
 *  peak. */
export function soundWalkieSquelch() {
  if (!isEnabled() || !isAnnouncer()) return;
  playCue(WALKIE_SQUELCH);
}

// The six walkie cues, for the one surface that plays them on purpose.
//
// Settings is the only place a person can hear a cue without a teammate on
// the other end, so the list lives beside the cues rather than in the page:
// a cue added above and forgotten below would be a cue nobody can check.
export const WALKIE_PREVIEWS: ReadonlyArray<{ id: string; label: string; spec: CueSpec }> = [
  { id: "keyUp", label: "Live", spec: WALKIE_KEY_UP },
  { id: "roger", label: "Roger", spec: WALKIE_ROGER },
  { id: "open", label: "Incoming", spec: WALKIE_OPEN },
  { id: "squelch", label: "Ended", spec: WALKIE_SQUELCH },
  { id: "joined", label: "Joined", spec: WALKIE_JOINED },
  { id: "away", label: "Away", spec: WALKIE_AWAY },
];

/** Play a cue because somebody asked to hear it.
 *
 *  Not gated on the leader window, and the two receive cues are the reason:
 *  the election exists to keep several windows from answering one event, and a
 *  click is not that event — it happened in exactly this window. A preview
 *  that stayed silent in a second window would read as a broken sound rather
 *  than as a rule. `sounds_enabled` still applies, and the page disables these
 *  buttons when it is off, so the silence is never a surprise. */
export function previewWalkieCue(spec: CueSpec) {
  if (!isEnabled()) return;
  playCue(spec);
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
