// "Session view" for a role's standing session (docs/architecture/
// initiatives-projects-role-page.md I3). A seat opens as the role page; the
// plain conversation is a view a person asks for, for that visit only, so it
// is never stored: the pane holds it in component state and the next open is
// the role page again.
//
// The one thing that crosses a route is the ask itself. The role page at
// /org/<or-id> is not the pane, so its control leaves the ask here and the pane
// that opens the session reads it while it mounts.
/** An ask nobody arrived for goes stale, so it cannot change a later open. */
const ASK_TTL_MS = 10_000;
let asked: { conversationId: string; at: number } | null = null;

/** The role page asks for the plain view of `conversationId` on its next open. */
export function askSessionView(conversationId: string): void {
  asked = { conversationId, at: Date.now() };
}

/** Whether the pane opening `conversationId` was asked for the plain view.
 *  A read, not a take: StrictMode runs a state initializer twice, and a take
 *  would answer no the second time. The pane settles it once it has mounted. */
export function sessionViewAsked(conversationId: string): boolean {
  return asked?.conversationId === conversationId && Date.now() - asked.at < ASK_TTL_MS;
}

/** The pane showing `conversationId` holds the answer in its own state now. */
export function settleSessionViewAsk(conversationId: string): void {
  if (asked?.conversationId === conversationId) asked = null;
}
