// The inbox's Priorities view on the phone, in web's order and words (web
// store/priorityOrder, a leaf the shared inbox store already brings into the
// bundle): each status section sorted by the viewer's priority a session
// serves, its rank then its milestone, every other session after in the
// order it had; each row labelled "#N", "—" (a priority in another
// workspace, not loaded here) or "None". Pinned keeps the person's order, so
// the inbox does not pass it through `sort`.
import { priorityPlaceReader, rankLabelOf, sortByPriority, type PriorityRankLabel } from '@codecast/web/store/priorityOrder';

type Linked = { priority_id?: string | null; priority_step_key?: string | null };
type Priorities = Parameters<typeof priorityPlaceReader>[0];

export type PriorityInboxView = {
  sort: <T extends Linked>(rows: T[]) => T[];
  rankOf: (s: Linked) => PriorityRankLabel;
};

export function priorityInboxView(priorities: Priorities, viewerId: string | null | undefined): PriorityInboxView {
  const placeOf = priorityPlaceReader(priorities, viewerId);
  return {
    sort: (rows) => sortByPriority(rows, placeOf),
    rankOf: (s) => rankLabelOf(placeOf(s)),
  };
}
