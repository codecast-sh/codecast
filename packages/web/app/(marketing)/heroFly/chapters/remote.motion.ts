/**
 * Chapter 13, Anywhere: the inset drops onto the desk and its rows follow it
 * in, 80ms apart.
 */

import { INSET } from "../fixtures/remote";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  beats: {
    desk: [
      { id: "remote.inset", cue: INSET.cue, preset: "drop", z: 180, rx: -16, y: -18 },
      ...[0, 1, 2, 3].map((i) => ({ id: `remote.line:${i}`, cue: INSET.cue + 0.12 + i * INSET.step, preset: "drop" as const, z: 90, rx: -10, y: -8 })),
    ],
  },
};
