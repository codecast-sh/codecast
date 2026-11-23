import { useSyncExternalStore } from "react";

// The server answers a socket's whole query set in one transition, so on a
// cold boot the inbox list waited for every large feeder subscribed beside it
// (labels, the decision queue, read marks, favorites: over a megabyte). Those
// feeders subscribe once the inbox list has answered, or after a bounded wait
// when it never does.
const FALLBACK_MS = 4_000;

let answered = false;
let fallback: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

export function markInboxAnswered(): void {
  if (answered) return;
  answered = true;
  if (fallback !== null) clearTimeout(fallback);
  for (const l of [...listeners]) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!answered && fallback === null) fallback = setTimeout(markInboxAnswered, FALLBACK_MS);
  return () => { listeners.delete(l); };
}

const snapshot = () => answered;

/** True once the inbox list has answered (or the fallback passed): when a large, non-first-paint feeder may subscribe. */
export function useInboxAnswered(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
