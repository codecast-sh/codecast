import { useEffect, useRef, type MutableRefObject } from "react";

// Convex subscriptions can silently stall after sleep/wake or a WebSocket
// reconnect — the query simply stops delivering updates, with no error. Each
// subscription is independent, so one (e.g. getCurrentUser) can freeze while
// others (e.g. listInboxSessions) keep flowing.
//
// This polls a one-shot fallback query whenever the tracked value hasn't been
// refreshed within `staleMs`, then lets `fetchAndApply` write the fresh result
// and bump the freshness ref. A healthy subscription keeps the ref fresh, so
// the poll stays a no-op; only a genuine stall triggers a fetch.
//
// eslint-disable-next-line no-restricted-syntax -- polled recovery; the effect manages its own interval
export function useRecoveryPoll(
  lastSyncRef: MutableRefObject<number>,
  fetchAndApply: () => Promise<void>,
  staleMs: number,
  pollMs = 10_000,
) {
  const inFlightRef = useRef(false);
  const fnRef = useRef(fetchAndApply);
  fnRef.current = fetchAndApply;

  useEffect(() => {
    const tick = async () => {
      if (inFlightRef.current) return;
      if (Date.now() - lastSyncRef.current < staleMs) return;
      inFlightRef.current = true;
      try {
        await fnRef.current();
      } catch (err) {
        console.warn("[useRecoveryPoll] recovery fetch failed", err);
      } finally {
        inFlightRef.current = false;
      }
    };
    const id = setInterval(tick, pollMs);
    return () => clearInterval(id);
  }, [lastSyncRef, staleMs, pollMs]);
}
