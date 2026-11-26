// The browser tabs a session has open right now, as its machine's daemon
// reports them (cli browser/sessionBrowserTabs.ts → convex/browserTabs.ts →
// the web inbox's Browser view).

/** Which browser holds the tab: the person's own Chrome through cast, the agent
 *  Chrome cast manages, the desktop app's pane, or Claude in Chrome. */
export const BROWSER_TAB_WHERE = ["chrome", "agent", "pane", "claude"] as const;
export type BrowserTabWhere = (typeof BROWSER_TAB_WHERE)[number];

export interface SessionBrowserTab {
  id: string;
  title: string;
  url: string;
  where: BrowserTabWhere;
}

export interface SessionBrowserReport {
  session_id: string;
  tabs: SessionBrowserTab[];
  /** When the session last drove one of these tabs (ms). */
  last_used_at: number;
}

/** The daemon re-sends an unchanged report this often, so a live row stays fresh. */
export const BROWSER_TABS_KEEPALIVE_MS = 5 * 60_000;
/** A row its daemon has not vouched for in this long reads as gone (a daemon that died). */
export const BROWSER_TABS_STALE_MS = 2 * BROWSER_TABS_KEEPALIVE_MS + 60_000;
