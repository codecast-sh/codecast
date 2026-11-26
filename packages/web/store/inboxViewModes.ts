// The groupings the inbox offers, in tab and Ctrl+, cycle order, each only
// when it has something to group by. A leaf (types only) so the tab strip can
// import it without booting the store.
import type { InboxViewMode } from "./clientPrefsTypes";
import type { OrgLensMode } from "./orgLens";

export function inboxViewModes({ hasPriorities, hasLabels, hasPlans, orgLenses, hasTriggers, hasMachines }: {
  /** The workspace has the priorities feature on. */
  hasPriorities: boolean;
  hasLabels: boolean;
  hasPlans: boolean;
  orgLenses: readonly OrgLensMode[];
  hasTriggers: boolean;
  /** Sessions run on more than one machine. */
  hasMachines: boolean;
}): InboxViewMode[] {
  return [
    "grouped",
    ...(hasPriorities ? ["priorities" as const] : []),
    "recent", "time",
    ...(hasLabels ? ["bucket" as const] : []),
    ...(hasPlans ? ["plan" as const] : []),
    ...orgLenses,
    ...(hasTriggers ? ["trigger" as const] : []),
    ...(hasMachines ? ["machine" as const] : []),
  ];
}
