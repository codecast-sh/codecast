import type { AppTab } from "../store/inboxStore";
import { pathLabel, inboxTabSessionId } from "./pathLabel";
import { vaultNoteTitle } from "./vault/noteTitle";
import { channelDisplayName } from "./chatViews";
import { dmOtherIds } from "@codecast/shared/chat";

// Tab title derivation, kept out of TabBar.tsx so that module exports only
// components: a helper export next to a component breaks React Fast Refresh
// for the file, and TabBar sits directly under DashboardLayout.

/** "design" for /chat/<id>, once the store knows the channel. pathLabel can
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
  const m = path.match(/^\/chat\/([^/?#]+)/);
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

export function tabTitle(tab: AppTab, sessions: Record<string, any>, channels: Record<string, any>, members?: any[], viewerId?: string): string {
  const sid = tabSessionId(tab);
  if (sid && sessions[sid]) {
    const s = sessions[sid];
    return s.title || s.session_id?.slice(0, 12) || "Session";
  }
  const chat = chatTabTitle(tab.path, channels, members, viewerId);
  if (chat) return chat;
  // A vault note is titled by its own H1 or frontmatter title when the index
  // knows one — the filename is the fallback, not the identity (Obsidian's
  // rule). Read lazily so no vault code loads for anyone who never opens one.
  const vaultTitle = vaultNoteTitle(tab.path);
  if (vaultTitle) return vaultTitle;
  // A stored title with a query string in it is a raw path that leaked in
  // before pathLabel stripped queries — never show it, re-derive instead.
  const stored = tab.title && !tab.title.includes("?") ? tab.title : null;
  return stored ?? pathLabel(tab.path);
}
