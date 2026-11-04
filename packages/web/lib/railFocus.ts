// The focused rail for a developer on their own (plan pl-842, ct-57307).
//
// People who came to codecast alone and stayed use the inbox and the
// conversations in it, and little else; people who left clicked through a
// dozen rail rows in their first minutes. So a solo account's rail opens on
// approvals, tasks and docs, and a More row lays out the rest.
// Only the rail narrows: every page stays reachable from search, the palette
// and links, so nothing here redirects or hides a page.
//
// Imports nothing: the marketing hero draws the rail too.

/** Accounts created before this keep the full rail they already knew. */
export const RAIL_FOCUS_SINCE = Date.UTC(2026, 9, 27);

/** Rail pages a focused rail leaves to More, beside the whole Agents group. */
const MORE_PAGES = ["/threads", "/feed", "/goals", "/projects", "/org", "/repo", "/files", "/vault", "/pages", "/changes", "/triggers", "/flows"];

export type RailFocusFacts = {
  /** The viewer's account creation time (users._creationTime). */
  createdAt: number | undefined;
  /** The viewer's teams, each with its member count. */
  teams: Array<{ member_count?: number; memberCount?: number } | null | undefined> | undefined;
  /** client_state.ui.rail_everything: the person chose More (true) or Fewer (false). */
  everything: boolean | undefined;
};

/** Whether this viewer gets the More/Fewer choice at all: an account from
 *  RAIL_FOCUS_SINCE on, and no team with anyone else on it. */
export function railFocusOffered(f: RailFocusFacts): boolean {
  if (f.createdAt === undefined || f.createdAt < RAIL_FOCUS_SINCE) return false;
  return !(f.teams ?? []).some((t) => (t?.member_count ?? t?.memberCount ?? 0) > 1);
}

/** Whether the rail is narrowed now. */
export function railFocused(f: RailFocusFacts): boolean {
  return railFocusOffered(f) && f.everything !== true;
}

/** Whether a focused rail leaves the page at `path` to More. */
export function focusHidesPage(path: string): boolean {
  return MORE_PAGES.some((p) => path === p || path.startsWith(`${p}/`));
}
