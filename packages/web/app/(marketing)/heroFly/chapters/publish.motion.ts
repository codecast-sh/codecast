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
      // `cast publish` lands: the reply sinks away as the page drops in over it, the two crossing in one dissolve so the card is never empty. The page's drop stays shallow (z 60), so its first frames stay inside the face's clip.
      { id: "publish.reply", cue: PUBLISH.published - 0.15, preset: "liftOut", y: -40, z: -160, dur: 0.4 },
      { id: "publish.reply", cue: PUBLISH.published - 0.15, preset: "fadeOut", dur: 0.3 },
      { id: "publish.card", cue: PUBLISH.published - 0.12, preset: "drop", z: 60, rx: -6, y: -10 },
    ],
  },
};
