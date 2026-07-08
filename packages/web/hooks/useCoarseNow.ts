import { useSyncExternalStore } from "react";

// Shared coarse clocks. One interval timer per distinct intervalMs, fanned out to
// every subscriber — so a list of N cards all calling useCoarseNow(30000) costs a
// SINGLE 30s timer, not N. Returns a millisecond timestamp that advances every
// `intervalMs` and re-renders subscribers on each tick.
//
// WHY THIS EXISTS. Live relative times ("idle 3m") and TTL-based reclassification
// must stay fresh as time passes. The lazy way is to let them ride the data
// heartbeat re-renders — but that couples a cosmetic clock to per-row sync churn
// and is exactly why an always-mounted list re-renders on every liveness tick.
// Give the clock its OWN low-frequency timer instead, and gate the data
// subscription on a wake signature (see store/wakeSig.ts). Cosmetic freshness and
// data freshness then scale independently: the list wakes only on structural
// change, the clock ticks every interval regardless.

type Clock = { now: number; listeners: Set<() => void>; timer: ReturnType<typeof setInterval> | null };
const _clocks = new Map<number, Clock>();

function clockFor(intervalMs: number): Clock {
  let c = _clocks.get(intervalMs);
  if (!c) {
    c = { now: Date.now(), listeners: new Set(), timer: null };
    _clocks.set(intervalMs, c);
  }
  return c;
}

export function useCoarseNow(intervalMs: number): number {
  const c = clockFor(intervalMs);
  return useSyncExternalStore(
    (notify) => {
      c.listeners.add(notify);
      if (c.timer === null) {
        c.timer = setInterval(() => {
          c.now = Date.now();
          c.listeners.forEach((l) => l());
        }, intervalMs);
      }
      return () => {
        c.listeners.delete(notify);
        if (c.listeners.size === 0 && c.timer !== null) {
          clearInterval(c.timer);
          c.timer = null;
        }
      };
    },
    () => c.now,
    () => c.now,
  );
}
