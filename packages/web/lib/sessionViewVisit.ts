// "Session view" for a role's standing session (docs/architecture/
// initiatives-projects-role-page.md I3). A seat opens as the role page; the
// plain conversation is a view a person asks for, for that visit only, so it
// is never stored: the pane holds it in component state and the next open is
// the role page again.
//
// The one thing that crosses a route is the ask itself. The role page at
// /org/<or-id> and the initiative page are not the pane, so their control
// leaves the ask here and navigates to the session. The pane that shows the
// session subscribes: it reads the ask while it mounts, when its session
// changes, and when a new ask lands while it already shows that seat (the tab
// shell keeps the inbox mounted, so that is the ordinary case after a person
// goes inbox, then chart, then Session view). Every ask carries a nonce, so a
// second ask for the same seat is a new one.
import { useSyncExternalStore } from "react";

type Ask = { conversationId: string; nonce: number };
let asked: Ask | null = null;
let nonces = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const l of listeners) l(); };

/** A page asks for the plain view of `conversationId` on its next show. */
export function askSessionView(conversationId: string): void {
  asked = { conversationId, nonce: ++nonces };
  emit();
}

/** The open ask's nonce for `conversationId`, or null. A read, not a take:
 *  StrictMode runs a state initializer twice, and a take would answer null
 *  the second time. The pane settles it once its own state holds the answer. */
export function sessionViewAskFor(conversationId: string): number | null {
  return asked?.conversationId === conversationId ? asked.nonce : null;
}

/** The pane showing `conversationId` holds the answer in its own state now. */
export function settleSessionViewAsk(conversationId: string): void {
  if (asked?.conversationId !== conversationId) return;
  asked = null;
  emit();
}

export function subscribeSessionViewAsk(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The open ask for `conversationId` as it changes: null, or a nonce that is
 *  new for every ask. */
export function useSessionViewAsk(conversationId: string): number | null {
  return useSyncExternalStore(subscribeSessionViewAsk, () => sessionViewAskFor(conversationId), () => null);
}
