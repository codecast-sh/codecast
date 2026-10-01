/**
 * Chapter 3, Fan out: each worker lifts off its spawn block as the row it will
 * become, arcs over the pane divider and lands on its row under the lead
 * (inbox.motion.ts drops the row in at the same cue); on the pair, each
 * worker's prompt and first tool call drop in.
 */

import { BOOT } from "../fixtures/fanout";
import { CUES } from "../fixtures/story";
import { regionPt } from "../world";
import type { ChapterMotion } from "./contract";

const land = (id: string, cue: number) => ({ id, cue, preset: "drop" as const, z: 140, rx: -12, y: -12 });

// The spawn blocks sit at the foot of the lead's transcript; the worker rows
// sit under the lead's row in the list (list head, section header, lead row).
const ROW_A = regionPt("desk.list", 170, 136, 0);
const ROW_B = regionPt("desk.list", 170, 162, 0);

export const motion: ChapterMotion = {
  beats: {
    pairA: [land("fanout.prompt:api", BOOT.api.prompt), land("fanout.tool:api", BOOT.api.tool)],
    pairB: [land("fanout.prompt:ui", BOOT.ui.prompt), land("fanout.tool:ui", BOOT.ui.tool)],
  },
  flyers: [
    { id: "fanout.spawnA", cue: CUES.workerRowA - 0.6, dur: 0.6, from: regionPt("desk.transcript", 320, 440), to: ROW_A, arc: 260, rot: [[0, 0, 0], [0, 35, -4], [0, 0, 0]], ease: "glide", fade: [0.12, 0.12] },
    { id: "fanout.spawnB", cue: CUES.workerRowB - 0.6, dur: 0.6, from: regionPt("desk.transcript", 320, 480), to: ROW_B, arc: 260, rot: [[0, 0, 0], [0, 35, -4], [0, 0, 0]], ease: "glide", fade: [0.12, 0.12] },
  ],
};
