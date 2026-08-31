import { useEffect, useRef, type MutableRefObject } from "react";
import { onSyncWake } from "./syncWake";

// A one-shot recovery fetch can hang indefinitely while the Convex WebSocket is
// mid-reconnect (the very situation recovery exists for). Cap it: a fetch that
// never settles would otherwise pin `inFlight` true forever, so every later tick
// early-returns and recovery is dead until a full page reload.
export const RECOVERY_FETCH_TIMEOUT_MS = 20_000;

// Pure gate for "should we kick off a recovery fetch right now?". Extracted so
// the firing decision — the heart of whether a stale value recovers on wake —
// is unit-testable without a DOM. Fires only when not already fetching and the
// tracked value has gone stale past `staleMs`; a healthy subscription keeps
// `lastSync` fresh, so this stays a no-op.
export function shouldRecover(
  now: number,
  lastSync: number,
  staleMs: number,
  inFlight: boolean,
): boolean {
  if (inFlight) return false;
  return now - lastSync >= staleMs;
}

function defaultOnError(err: unknown) {
  console.warn("[useRecoveryPoll] recovery fetch failed", err);
}

// A wake event (focus / visibility / online) is also the moment the Convex
// client resubscribes every live query, and a healthy resubscribe delivers a
// fresh payload within a couple of seconds. Probing at the same instant just
// doubles the recompute the server is already doing — and the probe carries a
// cache-busting token, so nothing dedupes it. Hold the wake probe this long;
// if the live channel lands first, the tick finds the value fresh and skips.
export const WAKE_GRACE_MS = 5_000;

// DOM-free controller holding the in-flight + wedge-guard state. Both the poll
// interval and the wake-event listeners call `tick()`; the gate and timeout cap
// dedupe and bound it. Kept separate from the hook so the wedge guard is
// testable with injected `now`/timeout instead of relying on browser timers.
//
// Backoff: each probe stamps the tracked value's post-fetch reading. If the
// next tick sees that same reading, nothing LIVE arrived in between — the
// subscription is still pending or stalled, and re-probing on the base cadence
// only piles full recomputes onto a server that is already slow (the cold-open
// "sync slow" case is precisely this). Consecutive misses double the required
// staleness up to `maxStaleMs`; any live push resets it.
export function createRecoveryController(opts: {
  getLastSync: () => number;
  fetchAndApply: () => Promise<void>;
  staleMs: number;
  maxStaleMs?: number;
  wakeGraceMs?: number;
  now?: () => number;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}) {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? RECOVERY_FETCH_TIMEOUT_MS;
  const maxStaleMs = opts.maxStaleMs ?? opts.staleMs * 4;
  const wakeGraceMs = opts.wakeGraceMs ?? WAKE_GRACE_MS;
  const onError = opts.onError ?? defaultOnError;
  let inFlight = false;
  let misses = 0;
  let probeStamp: number | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;

  function requiredStaleMs(): number {
    return Math.min(maxStaleMs, opts.staleMs * 2 ** misses);
  }

  async function tick(): Promise<void> {
    if (probeStamp !== null && opts.getLastSync() !== probeStamp) {
      // A live push moved the value since our last probe — back to base cadence.
      misses = 0;
      probeStamp = null;
    }
    if (!shouldRecover(now(), opts.getLastSync(), requiredStaleMs(), inFlight)) return;
    inFlight = true;
    let settled = false;
    const release = () => {
      if (!settled) {
        settled = true;
        inFlight = false;
      }
    };
    const timer = setTimeout(release, timeoutMs);
    try {
      await opts.fetchAndApply();
    } catch (err) {
      onError(err);
    } finally {
      clearTimeout(timer);
      release();
      if (probeStamp !== null) misses++;
      probeStamp = opts.getLastSync();
    }
  }

  // Wake-event entry: defer past the resubscribe window instead of racing it.
  function wake(): void {
    if (wakeTimer) return;
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void tick();
    }, wakeGraceMs);
  }

  function dispose(): void {
    if (wakeTimer) clearTimeout(wakeTimer);
    wakeTimer = null;
  }

  return { tick, wake, dispose, isInFlight: () => inFlight, requiredStaleMs };
}

// Convex subscriptions can silently stall after sleep/wake or a WebSocket
// reconnect — the query simply stops delivering updates, with no error. Each
// subscription is independent, so one (e.g. getCurrentUser) can freeze while
// others (e.g. listInboxSessions) keep flowing.
//
// This polls a one-shot fallback query whenever the tracked value hasn't been
// refreshed within `staleMs`, then lets `fetchAndApply` write the fresh result
// and bump the freshness ref. A healthy subscription keeps the ref fresh, so the
// poll stays a no-op; only a genuine stall triggers a fetch.
//
// Crucially it also re-checks on wake events. A backgrounded tab throttles its
// timers to ~1/min and a sleeping machine freezes them entirely — exactly when a
// subscription stalls — so relying on the interval alone leaves a stale status
// or "hasn't synced" banner stuck until the user reloads. Firing on
// visibility/focus/online refreshes the moment the user returns or the network
// is back.
//
// eslint-disable-next-line no-restricted-syntax -- polled recovery; the effect manages its own interval
export function useRecoveryPoll(
  lastSyncRef: MutableRefObject<number>,
  fetchAndApply: () => Promise<void>,
  staleMs: number,
  pollMs = 10_000,
) {
  const fnRef = useRef(fetchAndApply);
  fnRef.current = fetchAndApply;

  useEffect(() => {
    const controller = createRecoveryController({
      getLastSync: () => lastSyncRef.current,
      fetchAndApply: () => fnRef.current(),
      staleMs,
    });
    const tick = () => {
      void controller.tick();
    };
    const wake = () => controller.wake();

    const id = setInterval(tick, pollMs);

    // Wake-event re-checks are a browser optimization. React Native has no
    // document/window event model (and `document` is undefined there), so
    // feature-detect before wiring them — the interval above still drives
    // recovery on every platform. They go through `wake()` (grace-deferred),
    // never straight to tick(): the resubscribe fired by the same event
    // should be the one that refreshes the value.
    const doc = typeof document !== "undefined" ? document : undefined;
    const win = typeof window !== "undefined" ? window : undefined;
    const onVisible = () => {
      if (doc?.visibilityState === "visible") wake();
    };
    doc?.addEventListener?.("visibilitychange", onVisible);
    win?.addEventListener?.("focus", wake);
    win?.addEventListener?.("online", wake);
    // The platform-neutral wake bus (syncWake): mobile has no DOM events, so
    // AppState "active" (wired by StoreSyncBridge) reaches the controller
    // here. On web it doubles the DOM events above; wake() dedupes.
    const offWake = onSyncWake(wake);

    return () => {
      clearInterval(id);
      controller.dispose();
      offWake();
      doc?.removeEventListener?.("visibilitychange", onVisible);
      win?.removeEventListener?.("focus", wake);
      win?.removeEventListener?.("online", wake);
    };
  }, [lastSyncRef, staleMs, pollMs]);
}
