import { useRef } from 'react';

/** The previous value while a rebuilt record holds the same entries, so a
 *  memoized child given it skips the render. For records derived from a list
 *  whose identity changes more often than its contents. */
export function useShallowStable<T extends Record<string, unknown> | undefined>(next: T): T {
  const prev = useRef(next);
  if (prev.current !== next && !(prev.current && next && sameEntries(prev.current, next))) prev.current = next;
  return prev.current;
}

function sameEntries(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  for (const k of keys) if (a[k] !== b[k]) return false;
  return true;
}
