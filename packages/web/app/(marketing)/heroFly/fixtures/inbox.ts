/**
 * Chapter 1, Inbox: fixture data for its views. Timestamps are offsets
 * applied to the mount-time `now` (see story.ts); `entities` answers any id
 * this chapter renders as a pill or card.
 */

import type { EntityFixture } from "@/lib/entityDisplay";
import type { SidebarNavActive } from "@/components/sidebar/SidebarNav";
import { PEOPLE } from "./story";

/** The workspace in the top bar's team switcher. */
export const TEAM_CHIP = { name: "Acme", icon: "zap", icon_color: "cyan" };

/** Teammates online beside it, as the presence faces draw them. */
export const TEAMMATES = [
  { _id: PEOPLE.sarah.id, name: PEOPLE.sarah.name, presence_state: "active" },
  { _id: PEOPLE.maya.id, name: PEOPLE.maya.name, presence_state: "active" },
];

/** The rail's counts: the team's feed has moved, and #eng has unread messages (chapter 9's channel). */
export const RAIL = { feedUnread: 3, chatUnread: 1 } as const;

/** The rail on the inbox: no other section is the page. */
export const RAIL_ACTIVE: SidebarNavActive = {
  initiatives: false, projects: false, tasks: false, docs: false, code: false, files: false, pages: false,
  sessions: false, workflows: false, line: false, triggers: false, org: false, rootAgent: false, windows: false,
};

export const entities: Record<string, EntityFixture> = {};
