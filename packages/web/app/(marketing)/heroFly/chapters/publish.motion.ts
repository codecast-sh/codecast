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
      // `cast publish` lands: the reply recedes and rises toward where the page will sit and is gone as the page drops in, so the two layouts never read on top of each other.
      { id: "publish.reply", cue: PUBLISH.published - 0.15, preset: "liftOut", y: -40, z: -160, dur: 0.4 },
      { id: "publish.reply", cue: PUBLISH.published - 0.15, preset: "fadeOut", dur: 0.25 },
      { id: "publish.card", cue: PUBLISH.published, preset: "drop", z: 160, rx: -12, y: -24 },
    ],
  },
};
