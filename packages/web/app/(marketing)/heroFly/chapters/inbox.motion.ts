/**
 * Chapter 1, Inbox: the agent icons ripple down the column, the lead's row
 * drops in on top and the rows under it glide down as it opens its room
 * (FilmGrow in ./inbox.tsx); the workers (chapter 3's cues) land the same way
 * under the lead.
 */

import { DESK, INBOX_ORDER } from "../fixtures/desk";
import { CUES } from "../fixtures/story";
import type { ChapterMotion } from "./contract";

const land = (id: string, cue: number) => ({ id, cue, preset: "drop" as const, z: 120, rx: -14, y: -14 });

export const motion: ChapterMotion = {
  beats: {
    desk: [
      // Down the column as it reads, section by section.
      ...INBOX_ORDER.map((row, k) => ({ id: `inbox.row:${row}`, cue: DESK.iconPulse + k * DESK.iconStep, dur: 0.4, preset: "pulse" as const, s: 0.018 })),
      land("inbox.row:lead", CUES.leadLands),
      land("inbox.row:api", CUES.workerRowA),
      land("inbox.row:ui", CUES.workerRowB),
      // Each spawned row answers once it has landed under the lead, so the eye finds it in the list.
      { id: "inbox.row:api", cue: CUES.workerRowA + 0.45, dur: 0.45, preset: "pulse" as const, s: 0.04 },
      { id: "inbox.row:ui", cue: CUES.workerRowB + 0.45, dur: 0.45, preset: "pulse" as const, s: 0.04 },
      // 13 Anywhere: the API worker's row (the cloud host's) is opened.
      { id: "inbox.row:api", cue: CUES.remoteOpen - 0.15, dur: 0.4, preset: "pulse" as const, s: 0.03 },
    ],
  },
};
