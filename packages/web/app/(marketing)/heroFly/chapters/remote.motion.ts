/**
 * Chapter 13, Anywhere: the lead's pane clears as the API worker's row takes
 * the selection and the worker's conversation fades in on the clean pane; its
 * browser call and the result drop in after it.
 */

import { CUES } from "../fixtures/story";
import type { ChapterMotion } from "./contract";

/** Seconds the lead's pane takes to clear to the page's cream before the worker's fades in. */
export const REMOTE_CLEAR = 0.2;

export const motion: ChapterMotion = {
  beats: {
    desk: [
      { id: "remote.headCover", cue: CUES.remoteOpen - REMOTE_CLEAR, dur: REMOTE_CLEAR, preset: "fadeIn" },
      { id: "remote.cover", cue: CUES.remoteOpen - REMOTE_CLEAR, dur: REMOTE_CLEAR, preset: "fadeIn" },
      { id: "remote.head", cue: CUES.remoteOpen + 0.05, dur: 0.3, preset: "fadeIn" },
      { id: "remote.feed", cue: CUES.remoteOpen + 0.05, dur: 0.3, preset: "fadeIn" },
      { id: "remote.browse", cue: CUES.remoteOpen + 0.25, preset: "drop", z: 140, rx: -12, y: -12 },
      { id: "remote.after", cue: CUES.remoteOpen + 0.75, preset: "drop", z: 120, rx: -10, y: -10 },
    ],
  },
};
