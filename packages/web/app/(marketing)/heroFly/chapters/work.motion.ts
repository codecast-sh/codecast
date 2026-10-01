/**
 * Chapter 7, Track: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "work." (see contract.ts).
 */

import { CUES } from "../fixtures/story";
import { localToWorld, regionPt } from "../world";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  flyers: [
    { id: "work.task", cue: CUES.taskLands - 1.4, dur: 1.3, from: regionPt("desk.transcript", 400, 470, 4), to: localToWorld("board", -300, -200, 4), arc: 200, rot: [[0, 0, 0], [30, 0, -10], [24, 0, 0]], ease: "fall", fade: [0.06, 0.1] },
  ],
};
