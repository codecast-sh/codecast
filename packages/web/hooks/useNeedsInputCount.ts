import { useMemo } from "react";
import {
  placeInboxRows,
  placementDecisionsSig,
  pendingSendWakeSig,
  resolveShowOld,
  sessionsWakeSig,
  useTrackedStore,
  type PlacedInbox,
} from "../store/inboxStore";
import { useCoarseNow } from "./useCoarseNow";
import { assistantScopeOnly, bySessionAgent, withinScope } from "../lib/assistantScope";
import { hostedStopsSig, splitHostedStops } from "../lib/hostedNotice";

// The user's personal attention count: the inbox's QUESTIONS + NEEDS INPUT
// buckets, mine-scoped, over the shared working-set selection. One source —
// the placement chokepoint (placeInboxRows, sync-convergence C5) — for every
// surface that claims to mirror the inbox (the sidebar count badge and the
// desktop dock badge), so a number shown anywhere always matches the cards
// the panel actually renders. Questions are included because an explicit ask
// is still the user's move; before the questions bucket existed those rows
// counted here as needs-input.
//
// `enabled: false` skips the placement pass and returns 0 — for callers that
// only need the count on some platforms (DesktopProvider in a plain browser
// tab), where running it would double the sidebar badge's identical work.
//
// In hosted mode the count follows the panel's Assistant/Everything scope
// (lib/assistantScope), and a hosted conversation that ended on a stop is
// left out: the assistant failed there, the person owes no reply. The panel
// files those under "Couldn't finish" by the same rule (splitHostedStops).
export function useNeedsInputCount(enabled = true): number {
  const placed = useMinePlacement(enabled);
  const scope = useTrackedStore([
    (s) => assistantScopeOnly(s.clientState.ui),
    (s) => hostedStopsSig(s.sessions, s.messages),
  ]);
  const only = assistantScopeOnly(scope.clientState.ui);
  const stops = hostedStopsSig(scope.sessions, scope.messages);
  return useMemo(() => {
    if (!placed) return 0;
    const asks = splitHostedStops(placed.needsInput, (id) => scope.messages[id]).asks;
    return withinScope(asks, only, bySessionAgent).length + withinScope(placed.questions, only, bySessionAgent).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, only, stops]);
}

// The mine-scoped placement itself, for a surface that renders more than the
// count (the agent dock's dots and card). Same wake signatures, same clock.
export function useMinePlacement(enabled = true): PlacedInbox | null {
  const s = useTrackedStore([
    // Wake on STRUCTURAL session change only — the raw s.sessions ref flips on
    // every ~1s liveness heartbeat. pendingMessages likewise: only the
    // pending-send MEMBERSHIP matters. The body reads the raw fields for
    // data; these signatures only gate the re-render. See store/wakeSig.ts.
    s => sessionsWakeSig(s.sessions),
    s => s.sessionsWithQueuedMessages,
    s => s.blockedReviveRequestedAt,
    s => pendingSendWakeSig(s.pendingMessages),
    s => s.currentUser?._id,
    s => resolveShowOld(s.clientState.ui),
    s => placementDecisionsSig(s.sessionDecisions),
    s => s.questionResolutions,
  ]);
  // Mine-scoped: this is your personal attention, so a teammate row cached
  // from a team-board visit must not inflate it.
  const meId = s.currentUser?._id;
  // The chokepoint's time-driven flips (trust TTL, revive expiry, the epoch)
  // ride its deadline signature — keep them alive with a coarse clock (shared
  // timer, so extra subscribers are free).
  const coarseNow = useCoarseNow(15_000);
  return useMemo(
    () => (enabled ? placeInboxRows(s, { scope: "mine", now: coarseNow }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, sessionsWakeSig(s.sessions), meId, s.sessionsWithQueuedMessages, s.blockedReviveRequestedAt, pendingSendWakeSig(s.pendingMessages), resolveShowOld(s.clientState.ui), placementDecisionsSig(s.sessionDecisions), s.questionResolutions, coarseNow],
  );
}
