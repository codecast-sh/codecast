import { useSyncExternalStore } from "react";

// The queue item the stepper (DecisionQueue) is showing, so the inbox panel's
// Decisions list can light the same row the pager's "2 of 32" names. Per
// window and ephemeral: null whenever no stepper is mounted.
let current: string | null = null;
const listeners = new Set<() => void>();

export function setDecisionQueueCursor(key: string | null): void {
  if (key === current) return;
  current = key;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

export function useDecisionQueueCursor(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
