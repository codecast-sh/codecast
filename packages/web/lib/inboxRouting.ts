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
 *  - "companion": a working page (task/doc/plan) is on the stage — open the
 *    conversation BESIDE it as the stage's second and last pane. The session
 *    rail is untouched; opening another session swaps this one out.
 *
 * Settings is checked FIRST and deliberately: the tab-aware `pathname` reports the
 * carried "/inbox" tab while you're in Settings, so `isOnInboxPage` is spuriously
 * true there. Without this precedence the click would select in place and never
 * leave Settings. Callers must pass `isOnSettingsPage` from the real router URL.
 */
export type SessionSelectKind = "leave" | "inboxInPlace" | "companion";

export function resolveSessionSelectKind(opts: {
  isOnSettingsPage: boolean;
  isOnInboxPage: boolean;
  isOnConversationPage: boolean;
  /** True on the list+detail working surfaces (tasks/docs/plans). */
  isOnWorkingPage?: boolean;
}): SessionSelectKind {
  if (opts.isOnSettingsPage) return "leave";
  if (opts.isOnInboxPage) return "inboxInPlace";
  if (opts.isOnWorkingPage) return "companion";
  return "leave";
}
