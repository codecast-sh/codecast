import { useMemo } from "react";
import {
  categorizeMineSessions,
  pendingSendWakeSig,
  resolveShowOld,
  sessionsWakeSig,
  useTrackedStore,
} from "../store/inboxStore";
import { sessionCards, type ThreadCardModel } from "../lib/threadCards";
import { useCoarseNow } from "./useCoarseNow";

// The Threads page's session cards: the Inbox's own membership — the shared
// working-set selection via categorizeMineSessions, with the exact wake deps
// useNeedsInputCount uses — never the raw never-prune cache. Off by default
// (the toggle), because that queue already lives in the Inbox.

/** The Inbox's sessions as thread cards, or none while the toggle is off.
 *  Dep list mirrors hooks/useNeedsInputCount, plus the seen cursors (the
 *  unread rule) by ref. */
export function useSessionThreadCards(enabled: boolean): ThreadCardModel[] {
  const s = useTrackedStore([
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => s.blockedReviveRequestedAt,
    s => pendingSendWakeSig(s.pendingMessages),
    s => s.currentUser?._id,
    s => resolveShowOld(s.clientState.ui),
    s => s._seenMessageCount,
  ]);
  const meId = s.currentUser?._id;
  // The trust-TTL sweep inside categorizeSessions is time-driven; a coarse
  // clock keeps it honest (shared timer, extra subscribers are free).
  const coarseNow = useCoarseNow(15_000);
  return useMemo(() => {
    if (!enabled) return [];
    const cat = categorizeMineSessions(s as any, coarseNow);
    // Every bucket the Inbox shows; stashed and dismissed are out of it.
    // sortCards re-orders by activity, so bucket order here is moot.
    const rows = [...cat.pinned, ...cat.newSessions, ...cat.needsInput, ...cat.working, ...cat.dormant, ...cat.done];
    return sessionCards(rows, s._seenMessageCount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sessionsWakeSig(s.sessions), meId, s.sessionsWithQueuedMessages, s.blockedReviveRequestedAt, pendingSendWakeSig(s.pendingMessages), resolveShowOld(s.clientState.ui), s._seenMessageCount, coarseNow]);
}

