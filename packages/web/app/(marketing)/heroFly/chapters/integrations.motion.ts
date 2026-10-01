/**
 * Chapter 10, GitHub: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "integrations." (see contract.ts).
 */

import { CUES } from "../fixtures/story";
import { CHECK_COUNT, type PrStage } from "../fixtures/integrations";
import { localToWorld, type Beat } from "../world";
import type { ChapterMotion } from "./contract";

/** Chapter-internal cues, in film seconds. Cross-chapter ones are in story.ts. */
export const PR_AT = {
  approved: 63.3,
  /** Each check goes green in turn, the last one at `checksGreen`. */
  checks: Array.from({ length: CHECK_COUNT }, (_, i) => CUES.checksGreen - (CHECK_COUNT - 1 - i) * 0.3),
  ready: CUES.checksGreen + 0.6,
} as const;

/** Every moment the page can show, in order; `stageAt` hands back one of these, so a view can compare by reference. */
const STAGES: { from: number; stage: PrStage }[] = [
  { from: -Infinity, stage: { approved: false, checksPassed: 0, ready: false, merged: false } },
  { from: PR_AT.approved, stage: { approved: true, checksPassed: 0, ready: false, merged: false } },
  ...PR_AT.checks.map((from, i) => ({ from, stage: { approved: true, checksPassed: i + 1, ready: false, merged: false } })),
  { from: PR_AT.ready, stage: { approved: true, checksPassed: CHECK_COUNT, ready: true, merged: false } },
  { from: CUES.merged, stage: { approved: true, checksPassed: CHECK_COUNT, ready: true, merged: true } },
];

export function stageAt(t: number): PrStage {
  let s = STAGES[0].stage;
  for (const x of STAGES) if (t >= x.from) s = x.stage;
  return s;
}

const pr: Beat[] = [
  // The page assembles in the last half second of the approach, so the camera lands on it whole.
  { id: "integrations.header", cue: CUES.prOpened - 0.5, preset: "drop", z: 140, rx: -12, y: -16 },
  { id: "integrations.timeline", cue: CUES.prOpened - 0.35, preset: "drop", z: 160, rx: -14, y: -18 },
  { id: "integrations.header", cue: CUES.merged, dur: 0.5, preset: "pulse", s: 0.015 },
];

export const motion: ChapterMotion = {
  beats: { pr },
  flyers: [
    { id: "integrations.merged", cue: 67.1, dur: 1.4, from: localToWorld("pr", -300, -220, 4), to: localToWorld("page", 300, -240, 4), arc: 260, rot: [[-8, -8, 0], [0, 20, -4], [-10, 0, 0]], ease: "glide", fade: [0.08, 0.1] },
  ],
};
