/**
 * Chapter 13, Anywhere: the pane cross-fades from the lead to the API worker
 * as its row takes the selection, and the worker's browser call and its
 * result drop in after it.
 */

import { CUES } from "../fixtures/story";
import type { ChapterMotion } from "./contract";

export const motion: ChapterMotion = {
  beats: {
    desk: [
      { id: "remote.head", cue: CUES.remoteOpen, dur: 0.35, preset: "fadeIn" },
      { id: "remote.feed", cue: CUES.remoteOpen, dur: 0.35, preset: "fadeIn" },
      { id: "remote.browse", cue: CUES.remoteOpen + 0.25, preset: "drop", z: 140, rx: -12, y: -12 },
      { id: "remote.after", cue: CUES.remoteOpen + 0.75, preset: "drop", z: 120, rx: -10, y: -10 },
    ],
  },
};
