/**
 * Chapter 1, Inbox: the agent icons ripple down the column, the lead's row
 * drops in on top and the rows under it glide down to make room; the workers
 * (chapter 3's cues) land the same way under the lead.
 */

import { DESK, glideOver, INBOX_ROWS, LIST_ROW_H } from "../fixtures/desk";
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
      // The rows under each newcomer glide down over its height as it mounts.
      ...glideOver("inbox.rows", CUES.leadLands, -LIST_ROW_H.lead, 0.6),
      ...glideOver("inbox.rows", CUES.workerRowA, -LIST_ROW_H.worker, 0.6),
      ...glideOver("inbox.rows", CUES.workerRowB, -LIST_ROW_H.worker, 0.6),
    ],
  },
};
