import { railRowPlacement } from '@codecast/web/store/inboxStore';
import type { InboxSession } from '@codecast/web/store/inboxStore';
import { convHasPendingSend } from '@codecast/web/store/inboxOverlays';
import { sessionStatusOf } from '@codecast/web/lib/sessionStatus';
import { pendingDecisionConvIds } from '@codecast/web/lib/decisionQueue';
import { ownerRoleHandleOf, ownerSessionTitleOf, withOwnerFactsOf, withOwnerLabelOf, withOwnerShown } from '@codecast/web/lib/withOwner';

/** The "With <owner>" a phone row draws, by web's card rule
 *  (ModernSessionCard): only while the row reads working. A subagent the list
 *  draws under its parent (`underParent`) reads as web's nested card does, so
 *  once its turn ends it is Done and draws no "With <lead>"; standing as its
 *  own row it reads its placement. */
export function rowWithOwnerLabel(s: any, session: InboxSession, { placedBucket, placedState, pendingSend, underParent = false }: { placedBucket?: string; placedState?: string; pendingSend?: boolean; underParent?: boolean }, now: number): string | null {
  const row = withOwnerFactsOf(s as never, session);
  const pending = pendingSend ?? (s.sessionsWithQueuedMessages.has(session._id) || convHasPendingSend(s.pendingMessages?.[session._id], now));
  // A list that places nothing: the row's own placement, lifted into
  // Questions by a pending decide for you, as the inbox's placement lifts it.
  const placement = placedBucket ? { bucket: placedBucket, state: placedState } as never : railRowPlacement(row, now);
  const asking = !placedBucket && pendingDecisionConvIds(s.sessionDecisions as never, s.currentUser?._id ? String(s.currentUser._id) : null).has(session._id);
  const working = sessionStatusOf({ row, section: null, placement, now, live: { pendingSend: pending, asking }, nested: underParent }) === 'working';
  return withOwnerShown(withOwnerLabelOf(row, ownerSessionTitleOf(s as never, row), ownerRoleHandleOf(s as never, row)), working, pending);
}
