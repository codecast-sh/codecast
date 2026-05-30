import { useEffect, useRef, type MutableRefObject } from "react";

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

// DOM-free controller holding the in-flight + wedge-guard state. Both the poll
// interval and the wake-event listeners call `tick()`; the gate and timeout cap
// dedupe and bound it. Kept separate from the hook so the wedge guard is
// testable with injected `now`/timeout instead of relying on browser timers.
export function createRecoveryController(opts: {
  getLastSync: () => number;
  fetchAndApply: () => Promise<void>;
  staleMs: number;
  now?: () => number;
  timeoutMs?: number;
  onError?: (err: unknown) => void;
}) {
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? RECOVERY_FETCH_TIMEOUT_MS;
  const onError = opts.onError ?? defaultOnError;
  let inFlight = false;

  async function tick(): Promise<void> {
    if (!shouldRecover(now(), opts.getLastSync(), opts.staleMs, inFlight)) return;
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
    }
  }

  return { tick, isInFlight: () => inFlight };
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

    const id = setInterval(tick, pollMs);

    // Wake-event re-checks are a browser optimization. React Native has no
    // document/window event model (and `document` is undefined there), so
    // feature-detect before wiring them — the interval above still drives
    // recovery on every platform.
    const doc = typeof document !== "undefined" ? document : undefined;
    const win = typeof window !== "undefined" ? window : undefined;
    const onVisible = () => {
      if (doc?.visibilityState === "visible") tick();
    };
    doc?.addEventListener?.("visibilitychange", onVisible);
    win?.addEventListener?.("focus", tick);
    win?.addEventListener?.("online", tick);

    return () => {
      clearInterval(id);
      doc?.removeEventListener?.("visibilitychange", onVisible);
      win?.removeEventListener?.("focus", tick);
      win?.removeEventListener?.("online", tick);
    };
  }, [lastSyncRef, staleMs, pollMs]);
}
