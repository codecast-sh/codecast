import type { AppTab } from "../store/inboxStore";
import { isHostedAgentType } from "@codecast/shared/contracts";
import { conversationTitle } from "./conversationTitle";
import { pathLabel, inboxTabSessionId, modePathLabel } from "./pathLabel";
import { isBrowserRoutePath } from "./browserPane";
import { isConvexId, orgObjectOfRef } from "./entityLinks";
import { findEntityInStore } from "./liveEntities";
import { vaultNoteTitle } from "./vault/noteTitle";
import { channelDisplayName } from "./chatViews";
import { filterByWorkspace, inWorkspace, type WorkspaceKey } from "./workspaceScope";
import { dmOtherIds } from "@codecast/shared/chat";
import { currentPagePath } from "./renamedPages";

// Tab title derivation, kept out of TabBar.tsx so that module exports only
// components: a helper export next to a component breaks React Fast Refresh
// for the file, and TabBar sits directly under DashboardLayout.

/** "design" for /chat/<id> or /community/<id>, once the store knows the channel. pathLabel can
 *  only say "Chat", which turns three open channels into three identical tabs;
 *  the name is knowable, and this is where the store is in reach. No "#"
 *  prefix: the tab's PageIcon is already a hash. A DM tab wears the other
 *  side's names, the same derivation every chat surface uses. */
export function chatTabTitle(
  path: string,
  channels: Record<string, any> | undefined,
  members?: any[],
  viewerId?: string,
): string | null {
  const m = path.match(/^\/(?:chat|community)\/([^/?#]+)/);
  const channel = m ? channels?.[m[1]] : undefined;
  if (!channel) return null;
  if (channel.kind === "dm") {
    return channelDisplayName(
      { name: "", kind: "dm", dmMemberIds: dmOtherIds(channel.dm_key, viewerId ?? "") },
      members,
    );
  }
  return channel.name || null;
}

/** The session a tab is pinned to: an explicit sessionId, or the ?s= deep link
 *  the tab's path was stamped to (stampedTabPath normalizes /conversation/<id>
 *  into /inbox?s=<id>, so most conversation tabs carry the session here). */
export function tabSessionId(tab: Pick<AppTab, "sessionId" | "path">): string | null {
  return tab.sessionId ?? inboxTabSessionId(tab.path);
}

/** An initiative's tab reads its title once the store holds the row, the way
 *  a session's does (initiatives-projects-role-page.md I1); its `in-N` stands
 *  in until then (pathLabel). */
export function initiativeTabTitle(path: string, initiatives: Record<string, { short_id?: string; title?: string; workspace?: string; team_id?: string }> | undefined, workspaceKey: WorkspaceKey | null | undefined): string | null {
  const current = currentPagePath(path);
  const ref = current.split("?")[0].split("/")[2];
  if (!initiatives || !current.startsWith("/org/") || !ref) return null;
  // A goal's sheet, by `in-N` or by its key; any other object under /org is not one.
  const object = orgObjectOfRef(ref);
  if (object && object.kind !== "initiative") return null;
  const row = initiatives[ref] ?? filterByWorkspace(Object.values(initiatives), workspaceKey).find((r) => r?.short_id === ref.toLowerCase());
  return row && inWorkspace(row, workspaceKey) ? row.title || null : null;
}

/** The records a tab can be titled by, read by key only (never a scan, so
 *  the window title can derive on every store tick), and the client state
 *  whose mode names a page whose name is a mode word (modePathLabel). */
export type TabRecords = { tasks?: Record<string, any>; projects?: Record<string, any>; workflowRuns?: Record<string, any>; orgTree?: { roles?: readonly unknown[] } | null; teamMembers?: readonly unknown[]; clientState?: { ui?: { lane?: string } } };

/** A task, project, run, role or person tab reads its record's name once the
 *  store holds the row: the task's title, the project's title (by Convex id
 *  or `pj-…`), the role's name, the person's name, and a run as its cause
 *  ("ct-56750 run"). Until then pathLabel names the kind, never the id. A
 *  short id is read through the store's memoized short id index, never a scan
 *  per tick. */
export function recordTabTitle(path: string, records: TabRecords | undefined): string | null {
  if (!records) return null;
  const [, kind, ref, sub] = currentPagePath(path.split("#")[0]).split("?")[0].split("/");
  if (!ref) return null;
  if (kind === "tasks") return records.tasks?.[ref]?.title || null;
  if (kind === "projects") return (records.projects?.[ref] ?? findEntityInStore(records, "project", ref))?.title || null;
  if (kind === "org") {
    const object = orgObjectOfRef(ref);
    if (object?.kind === "project") return findEntityInStore(records, "project", object.ref)?.title || null;
    if (object?.kind === "role") return findEntityInStore(records, "role", object.ref)?.name || null;
    if (object?.kind === "person") return findEntityInStore(records, "person", object.ref)?.name || null;
    return null;
  }
  if (kind === "workflows" && ref === "runs" && sub) {
    const run = records.workflowRuns?.[sub];
    if (!run) return null;
    return run.task_short_id ? `${run.task_short_id} run` : run.workflow_name ? `${run.workflow_name} run` : null;
  }
  return null;
}

export function tabTitle(tab: AppTab, sessions: Record<string, any>, channels: Record<string, any>, members?: any[], viewerId?: string, initiatives?: Record<string, any>, workspaceKey?: WorkspaceKey | null, records?: TabRecords): string {
  const sid = tabSessionId(tab);
  if (sid && sessions[sid]) {
    const s = sessions[sid];
    // A hosted conversation is named by what the person asked until its
    // title arrives, never by an id.
    if (isHostedAgentType(s.agent_type)) return conversationTitle(s);
    // Untitled: the 7-char short handle (what every cast link and command
    // uses), never a slice of the agent's UUID.
    return s.title || (isConvexId(sid) ? sid.slice(0, 7) : "Session");
  }
  const chat = chatTabTitle(tab.path, channels, members, viewerId);
  if (chat) return chat;
  const initiative = initiativeTabTitle(tab.path, initiatives, workspaceKey);
  if (initiative) return initiative;
  const record = recordTabTitle(tab.path, records);
  if (record) return record;
  // A vault note is titled by its own H1 or frontmatter title when the index
  // knows one — the filename is the fallback, not the identity (Obsidian's
  // rule). Read lazily so no vault code loads for anyone who never opens one.
  const vaultTitle = vaultNoteTitle(tab.path);
  if (vaultTitle) return vaultTitle;
  // A browser tab is titled by the page it is on RIGHT NOW: its stored title
  // was stamped at the address it opened with, and the pane has navigated
  // since. pathLabel reads the live path (and any title a backend learned).
  if (isBrowserRoutePath(tab.path)) return pathLabel(tab.path);
  // A page named by a mode word reads the mode now: its stored title was
  // stamped in whichever mode opened it.
  return modePathLabel(tab.path, records?.clientState?.ui) ?? storedTitle(tab) ?? pathLabel(tab.path);
}

// A stored title with a query string in it is a raw path that leaked in
// before pathLabel stripped queries, and a stored title that is a bare record
// id (a call, a session) is no title at all. Never show either; re-derive.
function storedTitle(tab: AppTab): string | null {
  const t = tab.title;
  return t && !t.includes("?") && !isConvexId(t) ? t : null;
}
