/**
 * Chapter 3, Fan out (15 to 21s): the lead spawns two workers; each flies from
 * its spawn block to its row under the lead, and they boot on the pair. The
 * spawn blocks are entries of the lead's transcript (./conversation.tsx) and
 * the worker rows are rows of the inbox list (./inbox.tsx), so each feed
 * lifts as one; this chapter owns the pair and the flights between.
 */

import { BootA, BootB, HeaderA, HeaderB, SpawnFlyerA, SpawnFlyerB } from "./fanout";
import type { HeroChapter } from "./contract";

export const chapter: HeroChapter = {
  id: "fanout",
  parts: [
    { key: "headerA", region: "pairA.header", order: 0, Component: HeaderA },
    { key: "headerB", region: "pairB.header", order: 0, Component: HeaderB },
    { key: "bootA", region: "pairA.transcript", order: 10, Component: BootA },
    { key: "bootB", region: "pairB.transcript", order: 10, Component: BootB },
  ],
  flyers: {
    "fanout.spawnA": SpawnFlyerA,
    "fanout.spawnB": SpawnFlyerB,
  },
};
