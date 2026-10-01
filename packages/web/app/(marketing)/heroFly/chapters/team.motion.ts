/**
 * Chapter 9, Team: beats, typed text, flyers and arcs, as pure data.
 * Every id starts with "team." (see contract.ts).
 */

import type { Beat } from "../world";
import { MESSAGES, TEAM } from "../fixtures/team";
import type { ChapterMotion } from "./contract";

/** A channel line rises into place the way chat rows arrive. */
const lines: Beat[] = MESSAGES.flatMap((m) =>
  "cue" in m ? [{ id: `team.msg:${m.id}`, cue: m.cue, preset: "push" as const, y: 18, dur: 0.5 }, { id: `team.msg:${m.id}`, cue: m.cue, preset: "fadeIn" as const, dur: 0.3 }] : [],
);

export const motion: ChapterMotion = {
  beats: {
    team: [
      ...lines,
      // The feed gives way to the huddle when it starts.
      { id: "team.feed", cue: TEAM.feedOut, preset: "liftOut", y: -8, z: -80, dur: 0.5 },
      { id: "team.feed", cue: TEAM.feedOut, preset: "fadeOut", dur: 0.35 },
      { id: "team.huddle", cue: TEAM.huddle, preset: "fadeIn", dur: 0.35 },
      ...TEAM.faces.map((cue, i) => ({ id: `team.face:${i}`, cue, preset: "popIn" as const, s: 0.4, dur: 0.4 })),
      { id: "team.thread", cue: TEAM.faces[2] + 0.1, preset: "drop", z: 60, rx: -8, y: -10 },
    ],
  },
};
