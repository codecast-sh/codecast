import { useMemo, useRef } from 'react';
import { useIsFocused } from '@react-navigation/native';
import {
  useInboxStore, placeInboxRows, sessionsWakeSig, pendingSendWakeSig, resolveShowOld, type PlacedInbox,
} from '@codecast/web/store/inboxStore';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';

/** The inbox's rows as the shared chokepoint places them (store
 *  placeInboxRows): the exact computation web runs, so the inbox, its
 *  slide-out panel and the desktop never disagree about membership or counts.
 *
 *  Wake-signature gates (web store/wakeSig.ts): the raw s.sessions and
 *  s.pendingMessages refs flip on every liveness tick and send-lifecycle
 *  write, so subscribing to them re-rendered (and re-laid-out) the whole list
 *  about once a second on an idle phone. The structural signatures stand in
 *  for them, and placement reads the latest store state on each recompute.
 *  The trust-TTL adaptation (stale "working" → needs-input) and relative
 *  times are time-driven, so a coarse clock re-runs it too.
 *
 *  A screen under another (the inbox tab beneath an open conversation) holds
 *  its last placement and places again when it is back on top: re-placing
 *  every row on each live delta was the largest cost of an idle conversation. */
export function useInboxPlacement() {
  const sessionsSig = useInboxStore((s) => sessionsWakeSig(s.sessions));
  const pendingSendSig = useInboxStore((s) => pendingSendWakeSig(s.pendingMessages));
  const coarseNow = useCoarseNow(15_000);
  const currentSessionId = useInboxStore((s) => s.currentSessionId);
  const pendingSessionCreates = useInboxStore((s) => s.pendingSessionCreates);
  const sessionsWithQueuedMessages = useInboxStore((s) => s.sessionsWithQueuedMessages);
  // Same synced per-user flag web reads (clientState.ui.inbox_show_old), so
  // the phone and desktop hide the same old rows.
  const showOld = useInboxStore((s) => resolveShowOld(s.clientState.ui));
  // Scope pre-filter before the old-session partition, like web: the
  // never-prune cache holds rows from other inbox scopes and teams.
  const inboxScope = useInboxStore((s) => s.clientState.ui?.inbox_scope ?? "mine");
  const teamInboxIds = useInboxStore((s) => s.teamInboxIds);
  const meId = useInboxStore((s) => s.currentUser?._id?.toString?.() ?? null);
  const livenessHeldAt = useInboxStore((s) => s.livenessHeldAt);
  const onTop = useIsFocused();
  const held = useRef<PlacedInbox | null>(null);
  const placed = useMemo(
    () => (!onTop && held.current) || placeInboxRows(useInboxStore.getState(), { focusedId: currentSessionId, now: coarseNow }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionsSig/pendingSendSig stand in for the churny refs; coarseNow drives the deadline signature
    [onTop, sessionsSig, pendingSendSig, inboxScope, meId, teamInboxIds, showOld, currentSessionId, pendingSessionCreates, sessionsWithQueuedMessages, coarseNow, livenessHeldAt],
  );
  held.current = placed;
  return { placed, sessionsSig, pendingSendSig, coarseNow, currentSessionId, sessionsWithQueuedMessages };
}
