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
  isOnConversationPage: boolean;
}): SessionSelectKind {
  if (opts.isOnSettingsPage) return "leave";
  if (opts.isOnInboxPage) return "inboxInPlace";
  return "leave";
}
