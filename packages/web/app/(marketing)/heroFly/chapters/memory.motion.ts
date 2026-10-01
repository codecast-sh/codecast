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
    blame: [
      { id: "memory.file", cue: MEMORY.blame, preset: "drop", z: 140, rx: -8, y: -14 },
      // Line 42 lights as the blame focuses the lead session: the answer to "why is this line here".
      { id: "memory.line", cue: MEMORY.focus - 0.3, preset: "fadeIn", dur: 0.4 },
      { id: "memory.line", cue: MEMORY.focus - 0.3, preset: "growX", s: 0.3, dur: 0.5 },
    ],
  },
};
