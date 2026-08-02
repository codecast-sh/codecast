export function isInboxRoute(pathname?: string | null): boolean {
  return pathname === "/inbox" || pathname?.startsWith("/inbox/") || false;
}

export function isInboxSessionView(pathname?: string | null, source?: string | null): boolean {
  return isInboxRoute(pathname) || ((pathname?.startsWith("/conversation/") ?? false) && source === "inbox");
}

/**
 * What clicking a session in the global list should do, given which surface is
 * mounted:
 *  - "leave": promote to the stage — navigate to the inbox with the session
 *    selected. The default everywhere outside the inbox: a conversation is a
 *    primary object and always opens on the stage; the rail stays the
 *    glanceable session list and never hosts content.
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
