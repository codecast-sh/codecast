/**
 * Every chapter's entity fixtures, merged for the sandbox's
 * EntityFixtureContext. An entity can change over the film (a task is open
 * when it is filed and in review by the time the team discusses it), so the
 * world reads `ENTITY_STAGES[entityStage(t)]`: each id resolves to the latest
 * chapter that defines it and has started by t, or, before any has, to the
 * first one that will.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import { SCENES, type ChapterId } from "../world";
import { entities as inbox } from "./inbox";
import { entities as conversation } from "./conversation";
import { entities as fanout } from "./fanout";
import { entities as phone } from "./phone";
import { entities as talk } from "./talk";
import { entities as decide } from "./decide";
import { entities as work } from "./work";
import { entities as automation } from "./automation";
import { entities as team } from "./team";
import { entities as integrations } from "./integrations";
import { entities as publish } from "./publish";
import { entities as memory } from "./memory";
import { entities as remote } from "./remote";

type Entities = Record<string, EntityFixture>;

const BY_CHAPTER: Record<ChapterId, Entities> = {
  inbox, conversation, fanout, phone, talk, decide, work, automation, team, integrations, publish, memory, remote,
};

/** Each chapter's entities, in film order. */
const ORDERED = SCENES.map((s) => BY_CHAPTER[s.id]);

/** Stage i: chapters up to i win, latest first; ids none of them define come from the earliest later chapter. */
export const ENTITY_STAGES: Entities[] = SCENES.map((_, i) =>
  Object.assign({}, ...ORDERED.slice(i + 1).reverse(), ...ORDERED.slice(0, i + 1)),
);

/** The stage in force at film time t: the last chapter that has started. */
export const entityStage = (t: number) => {
  let i = 0;
  while (i + 1 < SCENES.length && SCENES[i + 1].start <= t) i++;
  return i;
};

/** The whole film's entities, the final stage: what the sandbox provides outside the film clock. */
export const HERO_ENTITIES: Entities = ENTITY_STAGES[ENTITY_STAGES.length - 1];
