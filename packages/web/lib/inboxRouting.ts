export function isInboxRoute(pathname?: string | null): boolean {
  return pathname === "/inbox" || pathname?.startsWith("/inbox/") || false;
}

export function isInboxSessionView(pathname?: string | null, source?: string | null): boolean {
  return isInboxRoute(pathname) || ((pathname?.startsWith("/conversation/") ?? false) && source === "inbox");
}

/**
 * WHICH pointer the session rail highlights on a surface. Three-way, and the
 * split is not "inbox vs everything else":
 *  - "current" — the inbox: it highlights the attended conversation,
 *    `viewingDismissedId ?? currentSessionId`.
 *  - "url"     — a conversation page: the id in the URL, because a non-owner
 *    viewer never sets the store pointer.
 *  - "panel"   — everywhere else: the side panel's own selection.
 *
 * Shared so the rail's highlight (DashboardLayout) and anything that has to
 * MOVE that highlight (the workbench filter's focus eviction) can't disagree
 * about which pointer is live. Inbox is tested first, so a /conversation/ page
 * opened from the inbox counts as the inbox — exactly as isInboxSessionView says.
 */
export type SessionFocusKind = "current" | "url" | "panel";

export function sessionFocusKind(pathname?: string | null, source?: string | null): SessionFocusKind {
  if (isInboxSessionView(pathname, source)) return "current";
  if (pathname?.includes("/conversation/")) return "url";
  return "panel";
}

/**
 * Whether the mounted PAGE publishes the "panel" pointer itself. Leaving the
 * inbox carries the attended conversation into the rail so the highlight
 * survives the move; that carry-over is a default for pages that say nothing
 * about the rail. The decision queue (/questions) is not one of them: it
 * writes the question you are reading into sidePanelSessionId from its own
 * effect, and that effect commits BEFORE the layout's (children first), so an
 * unconditional carry-over lands on top of it and the rail lights the inbox's
 * conversation, or nothing, instead of the question. The layout asks here
 * before it writes a default.
 */
export function pageOwnsRailHighlight(pathname?: string | null): boolean {
  return pathname === "/questions" || (pathname?.startsWith("/questions/") ?? false);
}

/**
 * What NAVIGATION does to the rail's own pointer (`sidePanelSessionId`).
 *
 * The rail highlights what is on the stage. A page like /tasks or /docs puts no
 * conversation there, so nothing on it is selected and the rail must show no
 * lit row — carrying the inbox's attended session (or the session you just left)
 * into the pointer made /tasks read as "this session is open" when it was not.
 * So arriving on a "panel" surface CLEARS the pointer; a deliberate selection
 * made while standing on that page (a liveness dot, a call panel, a new session)
 * still lights the rail, because that is a click, not a navigation.
 *
 * "keep" covers the inbox and conversation pages, which highlight their own
 * pointer anyway, and the pages that publish the rail pointer themselves.
 */
export function railPointerOnNavigate(pathname?: string | null, source?: string | null): "clear" | "keep" {
  if (pageOwnsRailHighlight(pathname)) return "keep";
  return sessionFocusKind(pathname, source) === "panel" ? "clear" : "keep";
}

/**
 * What clicking a session in the global list should do, given which surface is
 * mounted:
 *  - "leave": promote to the stage — navigate to the inbox with the session
 *    selected. The default everywhere outside the inbox: a conversation is a
 *    primary object and always opens on the stage; the rail stays the
 *    glanceable session list and never hosts content. Side by side is a
 *    DRAG (onto the stage), never a click's side effect.
 *  - "inboxInPlace": already on the inbox — select without navigating.
 *
 * Settings is checked FIRST and deliberately: the tab-aware `pathname` reports the
 * carried "/inbox" tab while you're in Settings, so `isOnInboxPage` is spuriously
 * true there. Without this precedence the click would select in place and never
 * leave Settings. Callers must pass `isOnSettingsPage` from the real router URL.
 */
export type SessionSelectKind = "leave" | "inboxInPlace";

export function resolveSessionSelectKind(opts: {
  isOnSettingsPage: boolean;
  isOnInboxPage: boolean;
}): SessionSelectKind {
  if (opts.isOnSettingsPage) return "leave";
  if (opts.isOnInboxPage) return "inboxInPlace";
  return "leave";
}
