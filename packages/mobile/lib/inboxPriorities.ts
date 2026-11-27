// The inbox's priority tags and Priorities view on the phone, in web's order
// and words (web store/priorityOrder, a leaf the shared inbox store already
// brings into the bundle). In every view a row filed under one of the
// viewer's priorities carries its rank and title, and its workspace's mark
// when that is not the active one. The Priorities view also sorts each status
// section by that priority, the active workspace's first (its rank then its
// milestone), then other workspaces' by rank, every other session after in
// the order it had. Pinned keeps the person's order, so the inbox does not
// pass it through `sort`.
import { priorityOrderSig, priorityPlaceReader, rankLabelOf, sortByPriority, type PriorityOrderState, type PriorityRankLabel } from '@codecast/web/store/priorityOrder';

type Linked = { priority_id?: string | null; priority_step_key?: string | null };

export type PriorityInboxView = {
  sort: <T extends Linked>(rows: T[]) => T[];
  rankOf: (s: Linked) => PriorityRankLabel;
};

/**
 * What the view wakes on, as web's panel does: each session's priority link,
 * each priority's owner, rank and milestones, other workspaces' ranks, the
 * viewer and the active workspace. A link that changes re-sorts the list.
 */
export const priorityInboxSig = priorityOrderSig;

/** Over the store's state: its current session rows are where a session's link is read (a placed row can be an older copy). `sorts`: the Priorities view, else rows keep their order. */
export function priorityInboxView(state: PriorityOrderState, sorts = true): PriorityInboxView {
  const placeOf = priorityPlaceReader(state);
  return {
    sort: (rows) => (sorts ? sortByPriority(rows, placeOf) : rows),
    rankOf: (s) => rankLabelOf(placeOf(s)),
  };
}
