/**
 * Chapter 5, Agents talk: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "talk." (see contract.ts).
 */

import { CUES } from "../fixtures/story";
import { localToWorld } from "../world";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  flyers: [
    { id: "talk.envelope", cue: CUES.messageSent, dur: 0.7, from: localToWorld("pairA", -60, 40, 4), to: localToWorld("pairB", -80, 0, 4), arc: 220, rot: [[0, -8, 0], [0, -8, 8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.12] },
    { id: "talk.envelopeBack", cue: CUES.replySent, dur: 0.5, from: localToWorld("pairB", -40, 70, 4), to: localToWorld("pairA", -60, 92, 4), arc: 140, rot: [[0, -8, 0], [0, -8, -8], [0, -8, 0]], ease: "glide", fade: [0.1, 0.14] },
  ],
};
