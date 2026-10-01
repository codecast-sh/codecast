/**
 * Chapter 7, Track: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "work." (see contract.ts).
 */

import { CUES } from "../fixtures/story";
import { localToWorld, regionPt, type Beat } from "../world";
import type { ChapterMotion } from "./contract";

/** Chapter-internal cues, in film seconds. Cross-chapter ones are in story.ts. */
export const WORK_AT = {
  /** The dead-letter queue ships: the plan's bar advances. */
  planAdvances: 46.0,
} as const;

/** The board's list row height (ListRowShell around a TaskRow): the rows below the new one push down by exactly this. */
export const ROW_H = 41;

/** The plan's other rows, top to bottom, then everything under them: each pushes down a row as the new task lands. */
const BELOW = ["work.row:hero-t2", "work.row:hero-t3", "work.row:hero-t4", "work.row:hero-t5", "work.row:hero-t6", "work.below"];

const board: Beat[] = [
  { id: "work.row:hero-t1", cue: CUES.taskLands, preset: "drop", z: 160, rx: -14, y: -18 },
  ...BELOW.map((id, i): Beat => ({ id, cue: CUES.taskLands + 0.04 + i * 0.025, dur: 0.6, preset: "push", y: -ROW_H })),
  // The new task's stations and activity arrive once it has landed.
  { id: "work.station", cue: CUES.taskLands + 0.3, preset: "drop", z: 80, rx: -8, y: -10 },
  { id: "work.detail", cue: CUES.taskLands + 0.38, preset: "drop", z: 80, rx: -8, y: -10 },
  { id: "work.row:hero-t1", cue: CUES.taskClaimed, dur: 0.45, preset: "pulse", s: 0.015 },
  { id: "work.station", cue: CUES.taskClaimed + 0.1, dur: 0.45, preset: "pulse", s: 0.03 },
  { id: "work.row:hero-t3", cue: WORK_AT.planAdvances, dur: 0.45, preset: "pulse", s: 0.015 },
  { id: "work.plan", cue: WORK_AT.planAdvances + 0.1, dur: 0.5, preset: "pulse", s: 0.03 },
];

export const motion: ChapterMotion = {
  beats: {
    desk: [{ id: "work.files", cue: CUES.taskFiled, preset: "drop", z: 140, rx: -12, y: -16 }],
    board,
  },
  flyers: [
    { id: "work.task", cue: CUES.taskLands - 1.4, dur: 1.3, from: regionPt("desk.transcript", 400, 470, 4), to: localToWorld("board", -300, -200, 4), arc: 200, rot: [[0, 0, 0], [30, 0, -10], [24, 0, 0]], ease: "fall", fade: [0.06, 0.1] },
  ],
};
