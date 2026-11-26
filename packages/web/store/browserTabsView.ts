// The inbox's Browser view: the sessions with a browser tab open right now,
// most recently driven first, each with its tabs. Rows come from the
// browserTabs collection (convex/browserTabs.ts, one per machine and session);
// the panel and the keyboard order (computeVisualOrder) both group through here.
import { BROWSER_TABS_STALE_MS, type SessionBrowserTab } from "@codecast/shared/contracts";

export type BrowserTabRow = {
  _id: string;
  conversation_id: string;
  session_id: string;
  device_id: string;
  tabs: SessionBrowserTab[];
  last_used_at: number;
  reported_at: number;
};

export type SessionTabs = { tabs: SessionBrowserTab[]; lastUsedAt: number };

/** Tabs per conversation id, every machine merged; a row its daemon stopped vouching for is gone. */
export function browserTabsByConversation(rows: Record<string, BrowserTabRow> | undefined, now: number): Map<string, SessionTabs> {
  const out = new Map<string, SessionTabs>();
  for (const row of Object.values(rows ?? {})) {
    if (!row?.conversation_id || now - row.reported_at > BROWSER_TABS_STALE_MS) continue;
    const prev = out.get(row.conversation_id);
    out.set(row.conversation_id, prev
      ? { tabs: [...prev.tabs, ...row.tabs], lastUsedAt: Math.max(prev.lastUsedAt, row.last_used_at) }
      : { tabs: row.tabs, lastUsedAt: row.last_used_at });
  }
  return out;
}

/** The sessions among `items` with a tab open, most recently driven first. */
export function groupSessionsByBrowser<T extends { _id: string }>(items: T[], tabsByConv: Map<string, SessionTabs>): T[] {
  return items
    .filter((s) => tabsByConv.has(s._id))
    .sort((a, b) => tabsByConv.get(b._id)!.lastUsedAt - tabsByConv.get(a._id)!.lastUsedAt);
}

/** A tab's address as read at a glance: the host, or the whole thing when it has none. */
export function tabHost(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
}
