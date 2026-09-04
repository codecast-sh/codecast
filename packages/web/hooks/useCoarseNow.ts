import { useRef, useState, useSyncExternalStore } from "react";

import { useWatchEffect } from "./useWatchEffect";
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

// Subscribe a plain listener to the shared clock for `intervalMs` — the same
// fan-out useCoarseNow rides, usable outside React (a store-level loop such as
// the digest compare ticks here instead of owning a private interval). The
// timer starts with the first listener and stops with the last.
export function subscribeCoarseTick(intervalMs: number, listener: () => void): () => void {
  const c = clockFor(intervalMs);
  c.listeners.add(listener);
  if (c.timer === null) {
    c.timer = setInterval(() => {
      c.now = Date.now();
      c.listeners.forEach((l) => l());
    }, intervalMs);
  }
  return () => {
    c.listeners.delete(listener);
    if (c.listeners.size === 0 && c.timer !== null) {
      clearInterval(c.timer);
      c.timer = null;
    }
  };
}

export function useCoarseNow(intervalMs: number): number {
  const c = clockFor(intervalMs);
  return useSyncExternalStore(
    (notify) => subscribeCoarseTick(intervalMs, notify),
    () => c.now,
    () => c.now,
  );
}

/**
 * A clock that re-renders only when it MATTERS. `sig(now)` projects the clock
 * onto the decisions the caller renders from it (e.g. "is the last activity
 * under 45s old?"); the component re-renders when that projection changes,
 * not on every tick. For an always-mounted, expensive component (the
 * conversation view re-rendered every 10s to recompute three booleans) this
 * turns a periodic full re-render into a re-render at each threshold crossing.
 * The returned `now` is the clock at the last (re)render, so it is at most one
 * threshold crossing stale — exactly what the caller's decisions can tolerate.
 */
export function useNowWhen(sig: (now: number) => string, intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  const sigRef = useRef(sig);
  sigRef.current = sig;
  const renderedSigRef = useRef("");
  renderedSigRef.current = sig(now);
  useWatchEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      if (sigRef.current(t) !== renderedSigRef.current) setNow(t);
    }, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
