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
  /** The answered card clears off the conversation it covered. */
  cleared: 39.25,
  gone: 39.8,
} as const;

export const motion: ChapterMotion = {
  beats: {
    desk: [
      { id: "decide.card", cue: DECIDE_AT.asked, preset: "drop", z: 240, rx: -16, y: -28 },
      { id: "decide.card", cue: DECIDE_AT.cleared, preset: "liftOut", dur: 0.5, y: -20, z: 90 },
      { id: "decide.card", cue: DECIDE_AT.cleared, preset: "fadeOut", dur: 0.45 },
      { id: "decide.tap", cue: DECIDE_AT.tap, preset: "ring", dur: 0.6 },
      { id: "decide.answer", cue: DECIDE_AT.answered, preset: "popIn", dur: 0.4, s: 0.94 },
    ],
  },
};
