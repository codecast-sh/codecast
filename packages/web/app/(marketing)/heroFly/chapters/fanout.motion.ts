/**
 * Chapter 3, Fan out: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "fanout." (see contract.ts).
 */

import { CUES } from "../fixtures/story";
import { regionPt } from "../world";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  flyers: [
    { id: "fanout.spawnA", cue: CUES.workerRowA - 0.6, dur: 0.6, from: regionPt("desk.transcript", 320, 440), to: regionPt("desk.list", 170, 120), arc: 260, rot: [[0, 0, 0], [0, 35, -4], [0, 0, 0]], ease: "glide", fade: [0.12, 0.12] },
    { id: "fanout.spawnB", cue: CUES.workerRowB - 0.6, dur: 0.6, from: regionPt("desk.transcript", 320, 470), to: regionPt("desk.list", 170, 175), arc: 260, rot: [[0, 0, 0], [0, 35, -4], [0, 0, 0]], ease: "glide", fade: [0.12, 0.12] },
  ],
};
