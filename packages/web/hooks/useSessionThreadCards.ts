import { useMemo } from "react";
import {
  placeInboxRows,
  pendingSendWakeSig,
  resolveShowOld,
  sessionsWakeSig,
  useTrackedStore,
} from "../store/inboxStore";
import { sessionCards, type ThreadCardModel } from "../lib/threadCards";
import { useCoarseNow } from "./useCoarseNow";

// The Threads page's session cards: the sessions waiting on the viewer, read
// from the Inbox's own placement (placeInboxRows forced to "mine") with the
// exact wake deps useNeedsInputCount uses, never the raw never-prune cache.
// Only the needs-input bucket: a session with a pending ask is already a
// Question card, and working, dormant or done sessions ask nothing of anyone.

/** Sessions waiting on the viewer as thread cards, or none while the toggle
 *  is off. Dep list mirrors hooks/useNeedsInputCount. */
export function useSessionThreadCards(enabled: boolean): ThreadCardModel[] {
  const s = useTrackedStore([
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => s.blockedReviveRequestedAt,
    s => pendingSendWakeSig(s.pendingMessages),
    s => s.currentUser?._id,
    s => resolveShowOld(s.clientState.ui),
  ]);
  const meId = s.currentUser?._id;
  // The chokepoint's time-driven flips (trust TTL, revive expiry, the epoch)
  // ride its deadline signature; a coarse clock keeps them honest.
  const coarseNow = useCoarseNow(15_000);
  return useMemo(() => {
    if (!enabled) return [];
    const placed = placeInboxRows(s as any, { scope: "mine", now: coarseNow });
    return sessionCards(placed.needsInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionsWakeSig(s.sessions), meId, s.sessionsWithQueuedMessages, s.blockedReviveRequestedAt, pendingSendWakeSig(s.pendingMessages), resolveShowOld(s.clientState.ui), coarseNow]);
}
