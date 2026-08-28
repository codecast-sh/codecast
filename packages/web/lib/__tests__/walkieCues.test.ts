// The walkie cues, measured rather than heard.
//
// The founder's report was "no sound that i started recording", and it was a
// level problem: every walkie cue peaked around 0.011 while the ring sat at
// 0.046 and the kill thud at 0.080. Nobody on this team is allowed to play
// these out loud, so a claim that a cue is now audible is worth nothing on its
// own. `cueRender` builds the same graph `sounds.ts` builds and hands back the
// samples, so these tests assert the numbers a speaker would actually get.
//
// The second half drives the real cue functions against a stand-in
// AudioContext and counts the nodes they start, the same way arrivalSound.test
// checks the chat knock: by what a cue builds, not by a claim that it played.

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cueDuration, cueHighBandShare, cuePeak, renderCue } from "../cueRender";
import type { CueSpec } from "../cueSpec";
import {
  WALKIE_AWAY,
  WALKIE_JOINED,
  WALKIE_KEY_UP,
  WALKIE_OPEN,
  WALKIE_ROGER,
  WALKIE_SQUELCH,
} from "../cueSpec";

// ── where the rest of the app sits ────────────────────────────────────────
//
// Transcribed from the cues in sounds.ts that were never in question, so the
// band the walkie cues had to join is measured by the same renderer and not
// asserted from memory.

const CALL_JOIN: CueSpec = {
  master: 0.05,
  tones: [
    { freq: 523.25, start: 0, dur: 0.15, gain: 0.4 },
    { freq: 659.25, start: 0.08, dur: 0.18, gain: 0.35 },
    { freq: 783.99, start: 0.16, dur: 0.25, gain: 0.3 },
  ],
};

const CALL_RING: CueSpec = {
  master: 0.06,
  tones: [
    { freq: 329.63, start: 0, dur: 0.4, gain: 0.22 },
    { freq: 830.61, start: 0, dur: 1.0, gain: 0.5 },
    { freq: 1661.22, start: 0, dur: 0.6, gain: 0.14 },
    { freq: 659.25, start: 0.18, dur: 1.1, gain: 0.45 },
  ],
};

/** soundKill's noise thud: master 0.1 on an envelope that opens at 0.8. The
 *  loud end of the app, reserved for an alarm. No cue here may reach it. */
const KILL_PEAK = 0.08;

const CUES: Array<{ name: string; spec: CueSpec; ms: number }> = [
  { name: "joined", spec: WALKIE_JOINED, ms: 310 },
  { name: "keyUp", spec: WALKIE_KEY_UP, ms: 185 },
  { name: "roger", spec: WALKIE_ROGER, ms: 130 },
  { name: "open", spec: WALKIE_OPEN, ms: 105 },
  { name: "away", spec: WALKIE_AWAY, ms: 90 },
  { name: "squelch", spec: WALKIE_SQUELCH, ms: 90 },
];

describe("the renderer measures what it is given", () => {
  test("a plain sine peaks at its gain times its master", () => {
    // The whole method rests on this. A tone with a long enough attack to
    // reach full scale, and no filter, must measure exactly what the two
    // numbers multiply out to.
    const peak = cuePeak({ master: 0.09, tones: [{ freq: 440, start: 0, dur: 0.4, gain: 0.5 }] });
    expect(peak).toBeGreaterThan(0.0445);
    expect(peak).toBeLessThan(0.045);
  });

  test("silence renders as silence", () => {
    expect(cuePeak({ master: 0.09, tones: [] })).toBe(0);
  });

  test("a sine is almost nothing but its fundamental", () => {
    const sine: CueSpec = { master: 1, tones: [{ freq: 880, start: 0, dur: 0.2, gain: 0.5 }] };
    expect(cueHighBandShare(sine)).toBeLessThan(0.01);
  });

  test("a lowpass takes a square's harshness out and leaves its level alone", () => {
    // Worth locking down, because it is the opposite of what it sounds like it
    // should do and it is why this file measures a third quantity at all.
    // Filtering a square barely moves its peak or its RMS: the energy the
    // harmonics give up goes straight back into the fundamental, whose
    // amplitude is 4/pi of the square's, so the peak actually goes UP. The
    // only measure that sees the change is where the energy sits.
    const bare: CueSpec = { master: 1, tones: [{ freq: 880, start: 0, dur: 0.2, gain: 0.5, type: "square" }] };
    const filtered: CueSpec = { master: 1, tones: [{ ...bare.tones![0], lowpass: 1500 }] };

    expect(cueHighBandShare(bare)).toBeGreaterThan(0.3);
    expect(cueHighBandShare(filtered)).toBeLessThan(0.1);
    expect(cuePeak(filtered)).toBeGreaterThan(cuePeak(bare));
  });
});

describe("every walkie cue is in the app's band", () => {
  // The floor is soundCallJoin, the quietest cue anybody has complained about
  // being too loud rather than too quiet. The ceiling is soundKill, which is
  // an alarm. A walkie cue belongs strictly between them.
  const floor = cuePeak(CALL_JOIN);

  for (const { name, spec } of CUES) {
    test(`${name} sits above soundCallJoin and below soundKill`, () => {
      const peak = cuePeak(spec);
      expect(peak).toBeGreaterThan(floor);
      expect(peak).toBeLessThan(KILL_PEAK);
    });
  }

  test("the set spans the ring rather than hiding under it", () => {
    // The complaint was that the walkie was a class quieter than the app, so
    // it is not enough for each cue to clear the floor: the moments that
    // carry news have to reach the ring, which is the level a person already
    // hears across a room.
    const ring = cuePeak(CALL_RING);
    expect(cuePeak(WALKIE_JOINED)).toBeGreaterThan(ring);
    expect(cuePeak(WALKIE_KEY_UP)).toBeGreaterThan(ring * 0.95);
  });
});

describe("the cues rank by how much they have to say", () => {
  const peak = (s: CueSpec) => cuePeak(s);

  test("joined is the loudest of the six", () => {
    for (const { name, spec } of CUES) {
      if (name === "joined") continue;
      expect(peak(WALKIE_JOINED)).toBeGreaterThan(peak(spec));
    }
  });

  test("your mic opening is louder than anything but the join", () => {
    // keyUp is the cue the founder named. It answers a gesture nobody is
    // looking at the screen for, so it outranks every cue that only reports.
    for (const name of ["roger", "open", "away", "squelch"]) {
      const other = CUES.find((c) => c.name === name)!;
      expect(peak(WALKIE_KEY_UP)).toBeGreaterThan(peak(other.spec));
    }
  });

  test("the two punctuation cues are the two quietest", () => {
    // squelch closes a burst and away says one did not go live. Neither is
    // news, so neither may outrank a cue that is.
    const loud = [WALKIE_JOINED, WALKIE_KEY_UP, WALKIE_ROGER, WALKIE_OPEN];
    for (const s of loud) {
      expect(peak(WALKIE_SQUELCH)).toBeLessThan(peak(s));
      expect(peak(WALKIE_AWAY)).toBeLessThan(peak(s));
    }
  });

  test("every cue is louder than it was before this change", () => {
    // The four that existed, exactly as they stood on main.
    const was: Record<string, CueSpec> = {
      keyUp: { master: 0.028, tones: [
        { freq: 880, start: 0, dur: 0.06, gain: 0.4, type: "square" },
        { freq: 1174.66, start: 0.06, dur: 0.09, gain: 0.35, type: "square" }] },
      roger: { master: 0.035, tones: [{ freq: 659.25, start: 0, dur: 0.09, gain: 0.35 }] },
      open: { master: 0.03, tones: [
        { freq: 1046.5, start: 0, dur: 0.05, gain: 0.35, type: "square" },
        { freq: 698.46, start: 0.06, dur: 0.09, gain: 0.3 }] },
      squelch: { master: 0.018, noise: [{ start: 0, dur: 0.08, gain: 0.5, band: 1800, q: 0.8 }] },
    };
    for (const [name, old] of Object.entries(was)) {
      const now = CUES.find((c) => c.name === name)!.spec;
      expect(cuePeak(now) / cuePeak(old)).toBeGreaterThan(2);
    }
  });
});

describe("every cue is long enough to register and short enough to stay out of the way", () => {
  for (const { name, spec, ms } of CUES) {
    test(`${name} runs ${ms}ms`, () => {
      expect(Math.round(cueDuration(spec) * 1000)).toBe(ms);
    });
  }

  test("keyUp is the two-tone rise it is described as", () => {
    // Two notes, the second higher than the first, overlapping so they read as
    // one gesture rather than two beeps.
    const [a, b] = WALKIE_KEY_UP.tones!;
    expect(b.freq).toBeGreaterThan(a.freq);
    expect(b.start).toBeLessThan(a.start + a.dur);
  });

  test("roger falls where keyUp rises", () => {
    const r = WALKIE_ROGER.tones![0];
    expect(r.sweepTo).toBeLessThan(r.freq);
  });

  test("joined climbs on wider steps than soundCallJoin's triad", () => {
    // The two must not trade places in the ear: "they joined my burst" cannot
    // sound like "someone entered a room". What separates them is the shape,
    // not the notes — joined steps a fifth then a fourth and covers a full
    // octave, where the call triad steps two thirds and covers a fifth.
    const steps = (freqs: number[]) => freqs.slice(1).map((f, i) => f / freqs[i]);
    const climb = WALKIE_JOINED.tones!.slice(0, 3).map((t) => t.freq);
    const triad = CALL_JOIN.tones!.map((t) => t.freq);

    expect(Math.min(...steps(climb))).toBeGreaterThan(Math.max(...steps(triad)));
    expect(climb[2] / climb[0]).toBeGreaterThan(triad[2] / triad[0]);
  });

  test("joined does not sound like keyUp either", () => {
    // They share a top note on purpose — both are walkie, both centre on E —
    // so the separation has to come from the other two axes: joined is three
    // sine voices over 310ms, keyUp is two filtered squares over 185ms.
    expect(WALKIE_JOINED.tones!.length).toBeGreaterThan(WALKIE_KEY_UP.tones!.length);
    expect(WALKIE_JOINED.tones!.every((t) => (t.type ?? "sine") === "sine")).toBe(true);
    expect(WALKIE_KEY_UP.tones!.every((t) => t.type === "square")).toBe(true);
  });

  test("open is two clicks at one pitch, not a tune", () => {
    const [a, b] = WALKIE_OPEN.tones!;
    expect(a.freq).toBe(b.freq);
    expect(b.start).toBeGreaterThan(a.start + a.dur);
  });

  test("away ticks: its attack is shorter than one cycle of its own pitch", () => {
    const t = WALKIE_AWAY.tones![0];
    expect(t.attack!).toBeLessThan(1 / t.freq);
  });

  test("squelch is noise, so no pitch in it can read as a second voice", () => {
    expect(WALKIE_SQUELCH.tones ?? []).toHaveLength(0);
    expect(WALKIE_SQUELCH.noise).toHaveLength(1);
  });

  test("no tonal cue is harsh", () => {
    // A square at this level and no filter puts two thirds of its energy above
    // 2 kHz, which is loud in the worst way: the kind that gets sounds turned
    // off rather than turned down. Every cue that is not noise stays under a
    // tenth. squelch is exempt because band-limited noise sitting at 1800 Hz
    // straddles the line by construction, and it is the quietest of the six.
    for (const { name, spec } of CUES) {
      if (name === "squelch") continue;
      expect(cueHighBandShare(spec), name).toBeLessThan(0.1);
    }
  });

  test("no cue clips", () => {
    for (const { name, spec } of CUES) {
      const samples = renderCue(spec);
      let peak = 0;
      for (const v of samples) peak = Math.max(peak, Math.abs(v));
      expect(peak, name).toBeLessThan(1);
    }
  });
});

// ── the gating split ──────────────────────────────────────────────────────

let oscStarts = 0;
let bufferStarts = 0;

function fakeParam() {
  return {
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  };
}

class FakeAudioContext {
  state = "running";
  sampleRate = 48_000;
  currentTime = 0;
  destination = {};
  resume() {}
  createGain() { return { gain: fakeParam(), connect() {} }; }
  createOscillator() {
    return { type: "sine", frequency: fakeParam(), connect() {}, start() { oscStarts++; }, stop() {} };
  }
  createBuffer(_ch: number, len: number) { return { getChannelData: () => new Float32Array(len) }; }
  createBufferSource() {
    return { buffer: null, connect() {}, start() { bufferStarts++; }, stop() {} };
  }
  createBiquadFilter() {
    return { type: "lowpass", frequency: fakeParam(), Q: fakeParam(), connect() {} };
  }
}

(globalThis as any).AudioContext = FakeAudioContext;

const realDesktop = await import("../desktop");
let isLeader = true;
mock.module("../desktop", () => ({ ...realDesktop, isNotificationLeader: () => isLeader }));

const sounds = await import("../sounds");

describe("who is allowed to sound which cue", () => {
  beforeEach(() => {
    oscStarts = 0;
    bufferStarts = 0;
    isLeader = true;
    // Another sound test's stand-in context would otherwise still be cached
    // in sounds.ts and nothing below would count. See `resetAudioContext`.
    sounds.resetAudioContext();
    // sounds_enabled defaults on: the store reads `!== false`.
  });

  test("each cue builds the voices its spec describes", () => {
    sounds.soundWalkieKeyUp();
    expect(oscStarts).toBe(2);
    oscStarts = 0;

    sounds.soundWalkieRoger();
    expect(oscStarts).toBe(1);
    oscStarts = 0;

    sounds.soundWalkieJoined();
    expect(oscStarts).toBe(4);
    oscStarts = 0;

    sounds.soundWalkieAway();
    expect(oscStarts).toBe(1);
    oscStarts = 0;

    sounds.soundWalkieOpen();
    expect(oscStarts).toBe(2);

    sounds.soundWalkieSquelch();
    expect(bufferStarts).toBe(1);
  });

  test("your own burst still sounds in a window that is not the leader", () => {
    // Only one window holds the key, so the election has nothing to settle:
    // gating these would silence the person who pressed.
    isLeader = false;
    sounds.soundWalkieKeyUp();
    sounds.soundWalkieRoger();
    sounds.soundWalkieJoined();
    sounds.soundWalkieAway();
    expect(oscStarts).toBe(8);
  });

  test("a teammate's burst sounds only in the leader window", () => {
    // Every open window sees the same burst row. Ungated, the desktop would
    // click once per window.
    isLeader = false;
    sounds.soundWalkieOpen();
    sounds.soundWalkieSquelch();
    expect(oscStarts).toBe(0);
    expect(bufferStarts).toBe(0);

    isLeader = true;
    sounds.soundWalkieOpen();
    sounds.soundWalkieSquelch();
    expect(oscStarts).toBe(2);
    expect(bufferStarts).toBe(1);
  });

  test("a preview plays in any window, because a click is not an announcement", () => {
    isLeader = false;
    for (const cue of sounds.WALKIE_PREVIEWS) sounds.previewWalkieCue(cue.spec);
    // Every tonal cue's voices, plus the squelch's one noise burst.
    expect(oscStarts).toBe(10);
    expect(bufferStarts).toBe(1);
  });

  test("the previews cover every cue exactly once", () => {
    const specs = sounds.WALKIE_PREVIEWS.map((c) => c.spec);
    expect(specs).toHaveLength(6);
    expect(new Set(specs).size).toBe(6);
    for (const { spec } of CUES) expect(specs).toContain(spec);
  });
});

describe("the master switch", () => {
  test("sounds_enabled off silences every cue and every preview", async () => {
    const { useInboxStore } = await import("../../store/inboxStore");
    const before = useInboxStore.getState().clientState;
    useInboxStore.setState({ clientState: { ...(before ?? {}), ui: { ...(before?.ui ?? {}), sounds_enabled: false } } } as any);
    oscStarts = 0;
    bufferStarts = 0;
    sounds.resetAudioContext();
    try {
      sounds.soundWalkieKeyUp();
      sounds.soundWalkieRoger();
      sounds.soundWalkieJoined();
      sounds.soundWalkieAway();
      sounds.soundWalkieOpen();
      sounds.soundWalkieSquelch();
      for (const cue of sounds.WALKIE_PREVIEWS) sounds.previewWalkieCue(cue.spec);
      expect(oscStarts).toBe(0);
      expect(bufferStarts).toBe(0);
    } finally {
      useInboxStore.setState({ clientState: before } as any);
    }
  });
});
