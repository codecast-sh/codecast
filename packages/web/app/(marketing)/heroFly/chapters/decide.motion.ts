/**
 * Chapter 6, Decide: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "decide." (see contract.ts).
 *
 * The lead's question drops onto the desk as a card, an option is tapped and
 * recorded, and the card clears before the camera leaves for the board.
 */

import { CUES } from "../fixtures/story";
import type { ChapterMotion } from "./contract";

export const DECIDE_AT = {
  asked: CUES.decisionAsked,
  /** The tap lands; the card records the answer a moment later. */
  tap: CUES.decisionAnswered - 0.15,
  answered: CUES.decisionAnswered + 0.1,
  /** The answered card reads to the end of the hold, then clears off the conversation as the camera leaves for the board. */
  cleared: 41.7,
  gone: 42.2,
} as const;

export const motion: ChapterMotion = {
  beats: {
    desk: [
      { id: "decide.veil", cue: DECIDE_AT.asked - 0.1, dur: 0.4, preset: "fadeIn" },
      { id: "decide.veil", cue: DECIDE_AT.cleared, dur: 0.45, preset: "fadeOut" },
      { id: "decide.card", cue: DECIDE_AT.asked, preset: "drop", z: 240, rx: -16, y: -28 },
      { id: "decide.card", cue: DECIDE_AT.cleared, preset: "liftOut", dur: 0.5, y: -20, z: 90 },
      { id: "decide.card", cue: DECIDE_AT.cleared, preset: "fadeOut", dur: 0.45 },
      { id: "decide.tap", cue: DECIDE_AT.tap, preset: "ring", dur: 0.6 },
      // The answered card fades in as the pending one sinks back and out, so the two separate in depth and never read on top of each other.
      { id: "decide.answered", cue: DECIDE_AT.tap, preset: "fadeIn", dur: 0.18 },
      { id: "decide.pending", cue: DECIDE_AT.tap + 0.05, preset: "fadeOut", dur: 0.2 },
      { id: "decide.pending", cue: DECIDE_AT.tap + 0.05, preset: "liftOut", dur: 0.3, y: -6, z: -40 },
      { id: "decide.answer", cue: DECIDE_AT.answered, preset: "pulse", s: 0.03, dur: 0.35 },
    ],
  },
};
