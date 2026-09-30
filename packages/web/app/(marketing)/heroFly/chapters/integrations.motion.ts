/**
 * Chapter 10, GitHub: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "integrations." (see contract.ts).
 */

import { localToWorld } from "../world";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  flyers: [
    { id: "integrations.merged", cue: 67.5, dur: 1.4, from: localToWorld("pr", -300, -220, 4), to: localToWorld("page", 300, -240, 4), arc: 260, rot: [[-8, -8, 0], [0, 20, -4], [-10, 0, 0]], ease: "glide", fade: [0.08, 0.1] },
  ],
};
