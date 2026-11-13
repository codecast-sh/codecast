// The one name of a place, as Modern says it everywhere: the trail's entries,
// the back control's label, the header's crumbs, the tab, and the history
// menu. An object page is named by its object (a session's title, a task's,
// a doc's, a channel's), read from the store by key; a page is named by the
// registry (lib/pathLabel, which reads lib/navRegistry in Modern).

import { isHostedAgentType } from "@codecast/shared/contracts";
import { conversationTitle } from "./conversationTitle";
import { pathLabel } from "./pathLabel";
import { chatTabTitle, initiativeTabTitle, recordTabTitle } from "./tabTitle";
import { activeWorkspaceKeyOf } from "./workspaceScope";
import { canonicalPlacePath, placeOf, placeSessionId, type PlaceNames } from "./navPlace";
import { lookup } from "./liveEntities";
import { cleanTitle } from "./conversationProcessor";
import { teamMembersOf } from "./activeTeam";

/** The store fields a name reads (all optional: a test passes what it needs). */
export type PlaceState = { [key: string]: any };

/** A session's name: its title, a hosted one's ask, else its short handle. */
export function sessionPlaceTitle(s: PlaceState, id: string): string | null {
  const row = s.sessions?.[id] ?? s.conversations?.[id];
  if (!row) return null;
  if (isHostedAgentType(row.agent_type)) return conversationTitle(row);
  const title = cleanTitle(row.title || "");
  return title || id.slice(0, 7);
}

/** The object's own name, or null when the store cannot name it yet. */
export function placeTitle(s: PlaceState, rawPath: string): string | null {
  const path = canonicalPlacePath(rawPath);
  const sid = placeSessionId(path);
  if (sid) return sessionPlaceTitle(s, sid);
  const chat = chatTabTitle(path, s.chatChannels, teamMembersOf(s), s.currentUser?._id ? String(s.currentUser._id) : undefined);
  if (chat) return chat;
  if (path.startsWith("/org")) {
    const key = s.clientState ? activeWorkspaceKeyOf(s as any) : null;
    return initiativeTabTitle(path, s.initiatives, key) ?? recordTabTitle(path, s as any);
  }
  return recordTabTitle(path, s as any);
}

/** The name a person reads for a place: the object's, else the page's. */
export function placeName(s: PlaceState, path: string): string {
  return placeTitle(s, path) ?? pathLabel(canonicalPlacePath(path));
}

/** The names a crumb reads, bound to one store snapshot. */
export function placeNamesOf(s: PlaceState): PlaceNames {
  return {
    title: (type, id) => {
      const rows = type === "project" ? s.projects : type === "plan" ? s.plans : type === "doc" ? s.docs : s.tasks;
      const row = lookup(rows, id);
      return row?.display_title ?? row?.title;
    },
    taskPlan: (taskId) => {
      const task = lookup(s.tasks, taskId);
      const planId = task?.plan_id ? String(task.plan_id) : null;
      if (!planId) return undefined;
      const plan = lookup(s.plans, planId);
      return { id: planId, title: plan?.title, short_id: plan?.short_id };
    },
  };
}

/** The crumbs above a page, as one string: what a header subscribes to, so a
 *  write the crumbs do not show never re-renders it. */
export function placeCrumbsSig(s: PlaceState, path: string): string {
  return placeOf(path, placeNamesOf(s)).crumbs.map((c) => `${c.label}\x1e${c.href ?? ""}\x1e${c.more ? 1 : 0}\x1e${c.mono ? 1 : 0}`).join("\x1f");
}
