// The inbox's Priorities view on the phone, in web's order and words (web
// store/priorityOrder, a leaf the shared inbox store already brings into the
// bundle): each status section sorted by the viewer's priority a session
// serves, the active workspace's first (its rank then its milestone), then
// other workspaces' by rank, every other session after in the order it had;
// a ranked row carries its rank, and its workspace's mark when that is not the
// active one. Pinned keeps the person's order, so the inbox does not pass it
// through `sort`.
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

/** Over the store's state: its current session rows are where a session's link is read (a placed row can be an older copy). */
export function priorityInboxView(state: PriorityOrderState): PriorityInboxView {
  const placeOf = priorityPlaceReader(state);
  return {
    sort: (rows) => sortByPriority(rows, placeOf),
    rankOf: (s) => rankLabelOf(placeOf(s)),
  };
}
