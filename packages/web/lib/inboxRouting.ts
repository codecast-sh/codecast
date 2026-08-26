import { slotPolicyFor, surfaceForPath } from "../store/workspace";

export function isInboxRoute(pathname?: string | null): boolean {
  return pathname === "/inbox" || pathname?.startsWith("/inbox/") || false;
}

export function isInboxSessionView(pathname?: string | null, source?: string | null): boolean {
  return isInboxRoute(pathname) || ((pathname?.startsWith("/conversation/") ?? false) && source === "inbox");
}

/**
 * WHICH pointer the session rail highlights on a surface. Three-way, and the
 * split is not "inbox vs everything else":
 *  - "current" — the inbox AND the working pages (task/doc/plan, i.e. the ones
 *    that can host a companion conversation). Both highlight the attended
 *    conversation, `viewingDismissedId ?? currentSessionId`; sidePanelSessionId
 *    is a stale pointer nothing on those surfaces writes anymore.
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
  if (slotPolicyFor(surfaceForPath(pathname ?? "")).secondary === "split") return "current";
  if (pathname?.includes("/conversation/")) return "url";
  return "panel";
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
