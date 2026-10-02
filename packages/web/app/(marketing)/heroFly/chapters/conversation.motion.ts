/**
 * Chapter 2, Steer: the pane cross-fades from the open session to the lead,
 * each transcript entry drops in as it opens its own room (FilmGrow in
 * ./conversation.tsx, so the feed above it rises), and the send button
 * presses as the steer goes out.
 */

import { DESK } from "../fixtures/desk";
import { ENTRIES, SARAH_VIEWING } from "../fixtures/conversation";
import { CUES } from "../fixtures/story";
import type { ChapterMotion } from "./contract";

/** The lead's turn runs from the prompt until both workers are spawned. */
export const LEAD_TURN_ENDS = CUES.spawnB + 1.2;

export const motion: ChapterMotion = {
  beats: {
    desk: [
      { id: "conversation.prevHead", cue: DESK.paneSwap, dur: 0.35, preset: "fadeOut" },
      { id: "conversation.head", cue: DESK.paneSwap, dur: 0.45, preset: "fadeIn" },
      // The previous session's transcript is gone in a quarter second, as the lead's prompt drops in (CUES.prompt), so the pane never sits empty.
      { id: "conversation.prev", cue: DESK.paneSwap, dur: 0.25, preset: "fadeOut" },
      { id: "conversation.feed", cue: DESK.paneSwap, dur: 0.45, preset: "fadeIn" },
      ...ENTRIES.map((e) => ({ id: `conversation.entry:${e.key}`, cue: e.cue, preset: "drop" as const, z: 140, rx: -12, y: -10 })),
      { id: "conversation.send", cue: DESK.steerSent - 0.18, dur: 0.22, preset: "press" },
      { id: "conversation.working", cue: CUES.prompt, dur: 0.35, preset: "fadeIn" },
      { id: "conversation.working", cue: LEAD_TURN_ENDS, dur: 0.4, preset: "fadeOut" },
      { id: "conversation.viewer", cue: SARAH_VIEWING, dur: 0.35, preset: "popIn", s: 0.7 },
    ],
  },
};
