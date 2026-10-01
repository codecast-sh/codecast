/**
 * Chapter 11, Publish: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "publish." (see contract.ts).
 */

import { PUBLISH } from "../fixtures/publish";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  beats: {
    page: [
      { id: "publish.reply", cue: PUBLISH.reply, preset: "drop", z: 160, rx: -12, y: -18 },
      // `cast publish` lands: the reply steps back and the page drops in over it.
      { id: "publish.reply", cue: PUBLISH.published, preset: "liftOut", y: 10, z: -140, dur: 0.7 },
      { id: "publish.reply", cue: PUBLISH.published + 0.1, preset: "fadeOut", dur: 0.5 },
      { id: "publish.card", cue: PUBLISH.published, preset: "drop", z: 320, rx: -16, y: -36 },
    ],
  },
};
