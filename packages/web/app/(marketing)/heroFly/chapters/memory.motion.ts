/**
 * Chapter 12, Memory: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "memory." (see contract.ts).
 */

import { MEMORY } from "../fixtures/memory";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  beats: {
    // The palette opens the way it does in the app: a quick rise out of the page.
    palette: [{ id: "memory.palette", cue: MEMORY.palette, preset: "drop", z: 180, rx: -10, y: -20 }],
    blame: [{ id: "memory.file", cue: MEMORY.blame, preset: "drop", z: 140, rx: -8, y: -14 }],
  },
};
