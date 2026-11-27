// A session row's status mark: web's mark (components/marks) for the state
// web's card reads (lib/sessionStatus). Rows hold still (web's listRowsHoldStill).
import { railRowPlacement, useInboxStore } from '@codecast/web/store/inboxStore';
import { sessionStatusOf } from '@codecast/web/lib/sessionStatus';
import { pendingDecisionConvIds } from '@codecast/web/lib/decisionQueue';
import { SessionStatusMark } from '@/components/marks';
import type { RowPlacementProps, SessionData } from '@/components/SessionItem';

/** The state comes from where the list placed the row, or from the row's own
 *  placement when the list places nothing, lifted to Needs you by a decision
 *  pending for you, as the inbox's placement lifts it. A subagent drawn under
 *  its parent reads as web's nested card does. */
export function RowStatusMark({ session, blocked, placedBucket, placedState, pendingSend, underParent }: { session: SessionData; blocked: boolean } & RowPlacementProps) {
  const asking = useInboxStore((s) => !placedBucket && askingConvIds(s).has(session._id));
  const now = Date.now();
  const placement = placedBucket ? { bucket: placedBucket, state: placedState } : railRowPlacement(session as any, now);
  return <SessionStatusMark status={sessionStatusOf({ row: session as any, placement: placement as never, now, live: { pendingSend, blocked, asking }, nested: underParent })} />;
}

// The conversations a decision waits on you in, once per decisions snapshot:
// every row's selector runs on every store write, so each is a set lookup.
const askingCache = new WeakMap<object, { me: string | null; ids: Set<string> }>();
function askingConvIds(s: ReturnType<typeof useInboxStore.getState>): Set<string> {
  const decisions = s.sessionDecisions as never as object;
  const me = s.currentUser?._id ? String(s.currentUser._id) : null;
  const hit = askingCache.get(decisions);
  if (hit && hit.me === me) return hit.ids;
  const ids = pendingDecisionConvIds(decisions as never, me);
  askingCache.set(decisions, { me, ids });
  return ids;
}
