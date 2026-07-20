import { useMemo } from "react";
import {
  categorizeSessions,
  filterInboxScope,
  pendingSendWakeSig,
  resolveShowOld,
  sessionsWakeSig,
  sessionsWithPendingSend,
  useTrackedStore,
} from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";

// The user's personal attention count: the inbox's NEEDS INPUT bucket, mine-scoped
// and limited to the server-authoritative active set. This is the single source for
// every surface that claims to mirror the inbox — the sidebar count badge and the
// desktop dock badge — so a number shown anywhere always matches the cards the
// panel actually renders. (The dock badge once counted `has_pending || is_idle`
// over the raw never-prune cache, which is every finished session ever synced —
// permanently 99+.)
//
// `enabled: false` skips the categorize pass and returns 0 — for callers that only
// need the count on some platforms (DesktopProvider in a plain browser tab), where
// running it would double the sidebar badge's identical work for nothing.
export function useNeedsInputCount(enabled = true): number {
  const s = useTrackedStore([
    // Wake on STRUCTURAL session change only — the raw s.sessions ref flips on
    // every ~1s liveness heartbeat, and re-running categorizeSessions over the
    // whole never-prune cache on each flip was measured at ~50ms a pass.
    // pendingMessages likewise: only the pending-send MEMBERSHIP matters. The
    // body reads the raw fields for data; these signatures only gate the
    // re-render. See store/wakeSig.ts.
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => pendingSendWakeSig(s.pendingMessages),
    s => s.currentUser?._id,
    s => s.liveInboxIds,
    s => resolveShowOld(s.clientState.ui),
  ]);
  // Mine-scoped: this is your personal attention count, so a teammate row cached
  // from a team-board visit must not inflate it.
  const meId = s.currentUser?._id;
  // categorizeSessions' trust-TTL sweep (stale "working" → needs-input) is
  // time-driven, not field-driven — keep it alive with a coarse clock (shared
  // timer, so extra subscribers are free).
  const coarseNow = useCoarseNow(15_000);
  // And count only the AUTHORITATIVE active set, not the raw never-prune cache —
  // otherwise this tallies every aged-out "needs input" card the panel already
  // hides, and the number never matches what you see. liveInboxIds + showOld make
  // categorizeSessions drop "old" rows (see its opts).
  return useMemo(
    () => enabled
      ? categorizeSessions(filterInboxScope(s.sessions, "mine", meId ? meId.toString() : null), s.sessionsWithQueuedMessages, sessionsWithPendingSend(s.pendingMessages), { liveInboxIds: s.liveInboxIds, showOld: resolveShowOld(s.clientState.ui) }).needsInput.length
      : 0,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, sessionsWakeSig(s.sessions), meId, s.sessionsWithQueuedMessages, pendingSendWakeSig(s.pendingMessages), s.liveInboxIds, resolveShowOld(s.clientState.ui), coarseNow],
  );
}
