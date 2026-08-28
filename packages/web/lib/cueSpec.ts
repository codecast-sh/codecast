// The walkie cues as numbers rather than as a graph.
//
// A sound nobody on this team can listen to has to be designed by its
// measurements, so each cue is plain data here and two things read it: the
// Web Audio graph in `sounds.ts` that plays it, and the offline renderer in
// `cueRender.ts` that measures it. One description, so a peak quoted in a
// comment or asserted in a test is the peak the speaker actually gets.

export type CueTone = {
  freq: number;
  /** Seconds after the cue starts. */
  start: number;
  /** Seconds from that start to silence. */
  dur: number;
  /** Envelope peak, before the cue's master gain. */
  gain: number;
  type?: OscillatorType;
  /** Glide the pitch to this frequency across `dur`. */
  sweepTo?: number;
  /** Seconds to reach `gain`. Default 0.02; a tick wants far less. */
  attack?: number;
  /** Cutoff of a lowpass in front of the note, and its Q in decibels. */
  lowpass?: number;
  lowpassQ?: number;
};

export type CueNoise = {
  start: number;
  dur: number;
  /** Envelope peak. Noise starts at full and decays; it has no attack. */
  gain: number;
  /** Bandpass centre and its Q. */
  band: number;
  q?: number;
};

export type CueSpec = {
  /** Multiplies every voice below. Peak on the wire is master times what the voices sum to. */
  master: number;
  tones?: CueTone[];
  noise?: CueNoise[];
};

// Where the rest of the app sits, measured by `cueRender` off the same
// envelopes `sounds.ts` builds. This is the band the walkie cues had to join;
// the founder's "no sound that i started recording" was the four of them
// sitting a factor of four below it.
//
//   soundCallRing    0.0458
//   soundChatMessage 0.0316
//   soundNewSession  0.0247
//   soundCallJoin    0.0196
//
// soundKill is the loud end and is not in that list: its lowpass sweeps, so it
// is not a CueSpec and cannot be rendered here. Its own two numbers are a
// master of 0.1 on an envelope opening at 0.8, and it is an alarm. Nothing
// below goes near it.
//
// The measured peak of each cue below is on its `soundWalkie*` export in
// `sounds.ts` and asserted in `walkieCues.test.ts`.

// A square wave is what makes a chirp read as a radio rather than as a chime,
// and it is also what makes one harsh: a third of a bare square's energy sits
// above 2 kHz, the range the ear weights most heavily, against a thousandth
// for a sine. Peak and RMS both miss this completely — filtering a square
// barely moves either, because the energy its harmonics give up goes straight
// back into the fundamental — so harshness is measured on its own terms by
// `cueHighBandShare`.
//
// Each square note therefore gets a lowpass placed just above ITS OWN
// fundamental, not one cutoff shared across the cue. A shared cutoff high
// enough to pass the top note leaves the bottom note barely filtered: for the
// 880 Hz note, measured share above 2 kHz is 0.332 unfiltered, 0.182 through
// 2600 Hz, and 0.063 through 1500 Hz. Only the last one is doing anything.
//
// The Q is left at the Web Audio default of 0 dB, whose slight bump over the
// cutoff is welcome here: it puts a little presence right where a small radio
// speaker has its own.

/** YOUR key down, mic genuinely open. A rising fifth, A5 to E6. */
export const WALKIE_KEY_UP: CueSpec = {
  master: 0.09,
  tones: [
    { freq: 880, start: 0, dur: 0.085, gain: 0.34, type: "square", lowpass: 1500 },
    { freq: 1318.51, start: 0.075, dur: 0.11, gain: 0.38, type: "square", lowpass: 2200 },
  ],
};

/** YOUR key up, the burst is closed and gone. One falling tone. */
export const WALKIE_ROGER: CueSpec = {
  master: 0.085,
  tones: [
    { freq: 880, start: 0, dur: 0.13, gain: 0.46, type: "sine", sweepTo: 587.33 },
  ],
};

/** A teammate's burst is opening on your speakers. Two clicks at one pitch. */
export const WALKIE_OPEN: CueSpec = {
  master: 0.085,
  tones: [
    { freq: 1046.5, start: 0, dur: 0.045, gain: 0.3, type: "square", lowpass: 1700 },
    { freq: 1046.5, start: 0.055, dur: 0.05, gain: 0.26, type: "square", lowpass: 1700 },
  ],
};

/** That burst ended. The receiver's own hiss coming back. */
export const WALKIE_SQUELCH: CueSpec = {
  master: 0.085,
  noise: [{ start: 0, dur: 0.09, gain: 0.6, band: 1800, q: 0.8 }],
};

/** Someone stepped into your burst: it is a call now. Rising E5, B5, E6. */
export const WALKIE_JOINED: CueSpec = {
  master: 0.1,
  tones: [
    { freq: 659.25, start: 0, dur: 0.12, gain: 0.4, type: "sine" },
    { freq: 987.77, start: 0.085, dur: 0.14, gain: 0.45, type: "sine" },
    { freq: 1318.51, start: 0.17, dur: 0.14, gain: 0.5, type: "sine" },
    // An octave over the last note only, so the figure brightens as it lands
    // rather than shimmering all the way through.
    { freq: 2637.02, start: 0.17, dur: 0.09, gain: 0.1, type: "sine" },
  ],
};

/** Nobody is live; your burst is landing as a message. One soft low tick. */
export const WALKIE_AWAY: CueSpec = {
  master: 0.085,
  tones: [
    // The attack is shorter than one cycle at this pitch, which is what makes
    // it a tick rather than a note.
    { freq: 220, start: 0, dur: 0.09, gain: 0.3, type: "sine", attack: 0.004 },
  ],
};
