import { useEffect, useRef } from "react";
import { useServerIdentityLost } from "./useServerAuthSettled";
import { whenInputQuiet } from "../lib/inputQuiet";

// A coalesced flush never waits more than this past its window for a pause
// in typing.
const TYPING_MAX_DEFER_MS = 1500;

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
 * so the window collapses into one apply with the newest data. While the person
 * is typing, the flush waits for a pause in the keys (at most 1.5s more).
 *
 * Nothing is applied while the server has lost an identity it had confirmed
 * (useServerIdentityLost): the push was computed for an anonymous caller, so
 * an empty answer means "not yours to see", not "you have none". The store
 * keeps what it last knew, and the re-authenticated answer applies as usual.
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
  const cancelRef = useRef<(() => void) | null>(null);
  // An answer that arrived while the identity was lost stays refused after
  // the flip back: it is still in hand for a render or more before the real
  // one lands, and any dep change in that gap would otherwise apply it. Both
  // are refs, read at apply time, because a coalesced flush fires later.
  const lostRef = useRef(false);
  lostRef.current = useServerIdentityLost();
  const refusedRef = useRef<T | undefined>(undefined);
  if (lostRef.current && data !== undefined) refusedRef.current = data;
  const refused = (d: T) => lostRef.current || d === refusedRef.current;

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => {
    if (data === undefined || refused(data)) return;
    // Default path: identical to the original (apply on every data/sync change).
    if (coalesceMs <= 0) {
      sync(data);
      return;
    }
    // Coalescing path: collapse a burst into one trailing apply. A coalesced
    // feed is background bulk (the inbox), so while the person is typing the
    // flush waits for a pause in the keys, never longer than TYPING_MAX_DEFER_MS.
    latestRef.current = data;
    if (cancelRef.current) return; // flush already scheduled; it will use latestRef
    const flush = () => {
      cancelRef.current = null;
      const latest = latestRef.current;
      if (latest !== undefined && !refused(latest)) syncRef.current(latest);
    };
    let cancelQuiet: (() => void) | null = null;
    const timer = setTimeout(() => { cancelQuiet = whenInputQuiet(flush, TYPING_MAX_DEFER_MS); }, coalesceMs);
    cancelRef.current = () => { clearTimeout(timer); cancelQuiet?.(); };
  }, [data, sync, coalesceMs]); // eslint-disable-line react-hooks/exhaustive-deps

  // eslint-disable-next-line no-restricted-syntax
  useEffect(() => () => { cancelRef.current?.(); }, []);
}
