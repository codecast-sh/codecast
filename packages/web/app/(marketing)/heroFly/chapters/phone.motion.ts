/**
 * Chapter 4, Approve: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "phone." (see contract.ts).
 */

import { localToWorld, regionPt } from "../world";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  flyers: [
    { id: "phone.permission", cue: 23.3, dur: 0.85, from: regionPt("desk.list", 170, 120), to: localToWorld("phone", 0, -206, 8), arc: 320, rot: [[0, 0, 0], [0, -30, 4], [0, -16, -2]], scale: [1, 0.86], ease: "glide", fade: [0.1, 0.08] },
  ],
  arcs: [
    { id: "phone.approved", cue: 27.0, dur: 0.5, hold: 0.8, from: localToWorld("phone", -150, -140), to: regionPt("desk.list", 320, 120), color: "#859900" },
  ],
};
