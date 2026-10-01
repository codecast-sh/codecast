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
      { id: "team.huddle", cue: TEAM.huddle, preset: "fadeIn", dur: 0.35 },
      ...TEAM.faces.map((cue, i) => ({ id: `team.face:${i}`, cue, preset: "popIn" as const, s: 0.4, dur: 0.4 })),
      { id: "team.thread", cue: TEAM.faces[2] + 0.1, preset: "drop", z: 120, rx: -10, y: -10 },
      // The org chart lands over the channel as a lifted sheet; the huddle steps back under it.
      { id: "team.huddle", cue: TEAM.orgOut, preset: "liftOut", y: 0, z: -60, dur: 0.6 },
      { id: "team.org", cue: TEAM.org, preset: "drop", z: 260, rx: -14, y: -30 },
      { id: "team.cursor", cue: TEAM.cursor, preset: "push", x: -260, y: 150, dur: 1.4 },
      { id: "team.cursor", cue: TEAM.cursor, preset: "fadeIn", dur: 0.25 },
    ],
  },
};
