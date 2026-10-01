/**
 * Chapter 1, Inbox: the agent icons ripple down the column, the lead's row
 * drops in on top and the rows under it glide down to make room; the workers
 * (chapter 3's cues) land the same way under the lead.
 */

import { DESK, INBOX_ROWS, LIST_ROW_H } from "../fixtures/desk";
import { CUES } from "../fixtures/story";
import type { ChapterMotion } from "./contract";

const land = (id: string, cue: number) => ({ id, cue, preset: "drop" as const, z: 120, rx: -14, y: -14 });

export const motion: ChapterMotion = {
  beats: {
    desk: [
      ...Array.from({ length: INBOX_ROWS }, (_, i) => ({ id: `inbox.row:${i}`, cue: DESK.iconPulse + i * DESK.iconStep, dur: 0.4, preset: "pulse" as const, s: 0.018 })),
      land("inbox.row:lead", CUES.leadLands),
      land("inbox.row:api", CUES.workerRowA),
      land("inbox.row:ui", CUES.workerRowB),
      // The rows under the newcomers wait over the newcomers' space, then glide down as each lands, 25ms behind it.
      { id: "inbox.rows", cue: CUES.leadLands + 0.025, dur: 0.6, preset: "push", y: -LIST_ROW_H.lead },
      { id: "inbox.rows", cue: CUES.workerRowA + 0.025, dur: 0.6, preset: "push", y: -LIST_ROW_H.worker },
      { id: "inbox.rows", cue: CUES.workerRowB + 0.025, dur: 0.6, preset: "push", y: -LIST_ROW_H.worker },
    ],
  },
};
