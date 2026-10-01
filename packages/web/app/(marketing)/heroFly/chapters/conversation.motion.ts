/**
 * Chapter 2, Steer: the pane cross-fades from the open session to the lead,
 * each transcript entry drops in as the feed lifts by its height, and the
 * send button presses as the steer goes out.
 */

import { DESK, glideOver } from "../fixtures/desk";
import { ENTRIES, TESTS_DONE_H } from "../fixtures/conversation";
import { CUES, FEED_FOOT } from "../fixtures/story";
import type { Beat } from "../world";
import type { ChapterMotion } from "./contract";

// The feed is anchored to the composer, so each entry that lands lifts it by
// the entry's height; the test run's result lifts it again when it arrives,
// and what other chapters add under it (FEED_FOOT) lifts it the same way.
const lifts: Beat[] = [
  ...ENTRIES.flatMap((e) => glideOver("conversation.feed", e.cue, e.h, 0.7)),
  ...(TESTS_DONE_H > 0 ? glideOver("conversation.feed", CUES.testsPass, TESTS_DONE_H, 0.5) : []),
  ...FEED_FOOT.flatMap((f) => glideOver("conversation.feed", f.cue, f.h, 0.6)),
];

export const motion: ChapterMotion = {
  beats: {
    desk: [
      { id: "conversation.prevHead", cue: DESK.paneSwap, dur: 0.35, preset: "fadeOut" },
      { id: "conversation.head", cue: DESK.paneSwap, dur: 0.45, preset: "fadeIn" },
      { id: "conversation.prev", cue: DESK.paneSwap, dur: 0.35, preset: "fadeOut" },
      { id: "conversation.feed", cue: DESK.paneSwap, dur: 0.45, preset: "fadeIn" },
      ...lifts,
      ...ENTRIES.map((e) => ({ id: `conversation.entry:${e.key}`, cue: e.cue, preset: "drop" as const, z: 140, rx: -12, y: -10 })),
      { id: "conversation.send", cue: DESK.steerSent - 0.18, dur: 0.22, preset: "press" },
    ],
  },
};
