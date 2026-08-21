import { useEffect, useRef, useSyncExternalStore } from "react";

export type TrackedStoreSource<S> = {
  getState: () => S;
  subscribe: (listener: () => void) => () => void;
};

/**
 * Bind the tracked-store hook to one store.
 *
 * Declare what to watch, access the full state. The component re-renders only
 * when a dep's return value changes (Object.is):
 *
 *   const s = useTrackedStore([s => s.messages[id], s => s.threads[id]]);
 *   s.labels[id]      // full state access
 *   s.getThread(id)   // getters work too
 *
 * One subscription per component instead of N separate selector hooks. Fields
 * outside the deps may be stale between re-renders — add one to the deps if its
 * freshness matters.
 */
export function makeUseTrackedStore<S>(source: TrackedStoreSource<S>) {
  return function useTrackedStore(deps: Array<(s: S) => any>): S {
    const prevRef = useRef<{ deps: any[]; state: S } | null>(null);
    return useSyncExternalStore(source.subscribe, () => {
      const state = source.getState();
      const next = deps.map(d => d(state));
      const prev = prevRef.current;
      if (prev && next.length === prev.deps.length &&
          next.every((v, i) => Object.is(v, prev.deps[i]))) {
        return prev.state;
      }
      prevRef.current = { deps: next, state };
      return state;
    });
  };
}

/**
 * Wire a ClientSync's refresh tick (see binding.ts) to the browser: online /
 * offline, tab visible, window focus, and once on mount. Each tick publishes
 * online state and re-drives the dispatch outbox, so a write the live socket
 * stranded ships on the next reconnect instead of the next reload.
 */
export function useSyncRefresh(sync: { refresh: () => void }) {
  useEffect(() => {
    const refresh = () => sync.refresh();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, [sync]);
}

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
// subscription on a wake signature (see wakeSig.ts). Cosmetic freshness and data
// freshness then scale independently: the list wakes only on structural change,
// the clock ticks every interval regardless.

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
