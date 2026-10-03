/**
 * Chapter 10, GitHub: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "integrations." (see contract.ts).
 */

import { CUES } from "../fixtures/story";
import { CHECK_COUNT, type PrStage } from "../fixtures/integrations";
import { localToWorld, readyAt, type Beat } from "../world";
import type { ChapterMotion } from "./contract";

/** Chapter-internal cues, in film seconds. Cross-chapter ones are in story.ts. */
export const PR_AT = {
  /** The page assembles face-down, before its surface turns, so it turns over whole. */
  enter: readyAt("pr"),
  approved: 63.3,
  /** Each check goes green in turn, the last one at `checksGreen`. */
  checks: Array.from({ length: CHECK_COUNT }, (_, i) => CUES.checksGreen - (CHECK_COUNT - 1 - i) * 0.3),
  /** Approved and green is ready to merge at once: no frame says "Blocked" or "waiting for a review" beside four passed checks. */
  ready: CUES.checksGreen,
} as const;

/** Every moment the page can show, in order; `stageAt` hands back one of these, so a view can compare by reference. */
const STAGES: { from: number; stage: PrStage }[] = [
  { from: -Infinity, stage: { approved: false, checksPassed: 0, ready: false, merged: false } },
  { from: PR_AT.approved, stage: { approved: true, checksPassed: 0, ready: false, merged: false } },
  // The last check going green and the page turning ready are one stage: two cues at the same moment would give FilmSwap no time to cross, and the page would change in one frame.
  ...PR_AT.checks.slice(0, -1).map((from, i) => ({ from, stage: { approved: true, checksPassed: i + 1, ready: false, merged: false } })),
  { from: PR_AT.ready, stage: { approved: true, checksPassed: CHECK_COUNT, ready: true, merged: false } },
  { from: CUES.merged, stage: { approved: true, checksPassed: CHECK_COUNT, ready: true, merged: true } },
];

/** The cues at which the page changes, and the stage after `step` of them: a FilmSwap draws each crossing from these. */
export const STAGE_CUES = STAGES.slice(1).map((x) => x.from);
export const stageOf = (step: number): PrStage => STAGES[step].stage;

export function stageAt(t: number): PrStage {
  let s = STAGES[0].stage;
  for (const x of STAGES) if (t >= x.from) s = x.stage;
  return s;
}

const pr: Beat[] = [
  { id: "integrations.header", cue: PR_AT.enter, preset: "drop", z: 140, rx: -12, y: -16 },
  { id: "integrations.timeline", cue: PR_AT.enter + 0.15, preset: "drop", z: 160, rx: -14, y: -18 },
  { id: "integrations.header", cue: CUES.merged, dur: 0.5, preset: "pulse", s: 0.015 },
];

export const motion: ChapterMotion = {
  beats: { pr },
  flyers: [
    // Lands on the header of the lead's reply on the page, the session that merged it, and fades into it.
    { id: "integrations.merged", cue: 67.0, dur: 1.55, from: localToWorld("pr", -300, -220, 4), to: localToWorld("page", -230, -236, 4), arc: 260, rot: [[-8, -8, 0], [0, 20, -4], [-10, 0, 0]], ease: "glide", fade: [0.08, 0.25] },
  ],
};
