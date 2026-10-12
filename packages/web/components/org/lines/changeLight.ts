// Which proposed changes the reader is pointing at in the company, so their
// cards in the conversation light up (cohesive build spec §4.3.5, D8). The
// reverse of OrgHoverContext, which runs from a card to the map: a ghost line
// on the document says "this one", and the card that answers it answers.
//
// A module signal rather than a context: the document and the thread sit in
// the two panes of one screen and share no provider between them, and a
// pointer over a line is gone the moment it moves, so nothing is persisted.
import { useSyncExternalStore } from "react";

let lit: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

/** Light these changes' cards, or none. */
export function lightChanges(ids: readonly string[] | null): void {
  const next = new Set(ids ?? []);
  if (next.size === lit.size && [...next].every((id) => lit.has(id))) return;
  lit = next;
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Whether any of a card's changes is lit. */
export function useChangeLit(ids: readonly string[]): boolean {
  return useSyncExternalStore(subscribe, () => ids.some((id) => lit.has(id)), () => false);
}
