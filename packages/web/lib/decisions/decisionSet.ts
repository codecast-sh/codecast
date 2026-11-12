import { useSyncExternalStore } from "react";

// The decisions a decision page flips through with ‹ › and the arrow keys.
// A set the address names (`?set=sd-1,sd-2`, written by a message that names
// several) wins, so a shared link flips through the same ones; otherwise the
// Decisions list the page was opened from publishes its order here.

export const DECISION_SET_PARAM = "set";

let listOrder: readonly string[] = [];
const listeners = new Set<() => void>();
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const read = () => listOrder;

export function publishDecisionOrder(refs: readonly string[]): void {
  if (refs.length === listOrder.length && refs.every((r, i) => r === listOrder[i])) return;
  listOrder = refs;
  for (const l of listeners) l();
}

export function useDecisionListOrder(): readonly string[] {
  return useSyncExternalStore(subscribe, read, read);
}

export function parseDecisionSet(param: string | null | undefined): string[] {
  if (!param) return [];
  return [...new Set(param.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
}

export function decisionSetHref(ref: string, set: readonly string[]): string {
  return set.length > 1 ? `/decisions/${ref}?${DECISION_SET_PARAM}=${set.join(",")}` : `/decisions/${ref}`;
}

/** Where a decision sits in a set, matched by short id or row id; null when it is not in it. */
export function setPosition(set: readonly string[], ids: readonly (string | undefined)[]): { at: number; prev: string | null; next: string | null } | null {
  const keys = ids.filter((x): x is string => !!x).map((x) => x.toLowerCase());
  const at = set.findIndex((r) => keys.includes(r.toLowerCase()));
  if (at < 0) return null;
  return { at, prev: at > 0 ? set[at - 1] : null, next: at < set.length - 1 ? set[at + 1] : null };
}
