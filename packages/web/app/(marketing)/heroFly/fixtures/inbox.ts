/**
 * Chapter 1, Inbox: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import { PEOPLE } from "./story";

/** The workspace in the top bar's team switcher. */
export const TEAM_CHIP = { name: "Acme", icon: "zap", icon_color: "cyan" };

/** Teammates online beside it, as the presence faces draw them. */
export const TEAMMATES = [
  { _id: PEOPLE.sarah.id, name: PEOPLE.sarah.name, presence_state: "active" },
  { _id: PEOPLE.maya.id, name: PEOPLE.maya.name, presence_state: "active" },
];

export const entities: Record<string, EntityFixture> = {};
