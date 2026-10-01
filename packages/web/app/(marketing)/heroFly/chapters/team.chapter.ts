/**
 * Chapter 9, Team (53 to 61s): the team channel with a session answering in
 * it, and a huddle with live captions beside it. The views are in
 * ./team.tsx, fed by ../fixtures/team.ts. See README.md for the contract.
 */

import { TeamScene } from "./team";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "team",
  parts: [{ key: "scene", region: "team.main", order: 0, Component: TeamScene }],
};
