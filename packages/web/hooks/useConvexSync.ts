import { useEffect, useRef } from "react";

/**
 * Apply a Convex live-query result to local state whenever it changes.
 *
 * Default: applies synchronously on every push (unchanged behavior).
 *
 * Pass `coalesceMs` to batch a burst of rapid pushes into a single trailing
 * apply. Use this for hot, team-wide subscriptions (e.g. the inbox session
 * list) where each push runs O(N) store work but sub-second freshness isn't
 * required. Without it, a user with many active agents re-applies the whole
 * list 1-2x/sec — each apply blocks the main thread ~20ms (mutative draft +
 * syncTable diff + re-render fan-out), which steals frames while typing even
 * though nothing visible changed. See ct-33480.
 *
 * Trailing-batch semantics: the first push schedules a flush `coalesceMs` later;
 * further pushes within that window update the pending value but don't reschedule,
 * so the window collapses into one apply with the newest data.
 */
export function useConvexSync<T>(
  data: T | undefined,
  sync: (data: T) => void,
  opts?: { coalesceMs?: number },
): void {
  const coalesceMs = opts?.coalesceMs ?? 0;
  // Newest sync/value, so a scheduled flush never fires a stale closure or data.
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const latestRef = useRef<T | undefined>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (data === undefined) return;
    // Default path: identical to the original (apply on every data/sync change).
    if (coalesceMs <= 0) {
      sync(data);
      return;
    }
    // Coalescing path: collapse a burst into one trailing apply.
    latestRef.current = data;
    if (timerRef.current) return; // flush already scheduled; it will use latestRef
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      const latest = latestRef.current;
      if (latest !== undefined) syncRef.current(latest);
    }, coalesceMs);
  }, [data, sync, coalesceMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
}
