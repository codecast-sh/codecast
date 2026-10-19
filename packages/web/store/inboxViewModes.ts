// The groupings the inbox offers, in tab and Ctrl+, cycle order, each only
// when it has something to group by. A leaf (types only) so the tab strip can
// import it without booting the store.
import type { InboxViewMode } from "./clientPrefsTypes";
import type { OrgLensMode } from "./orgLens";

export function inboxViewModes({ hasLabels, hasPlans, orgLenses, hasTriggers }: {
  hasLabels: boolean;
  hasPlans: boolean;
  orgLenses: readonly OrgLensMode[];
  hasTriggers: boolean;
}): InboxViewMode[] {
  return [
    "grouped", "recent", "time",
    ...(hasLabels ? ["bucket" as const] : []),
    ...(hasPlans ? ["plan" as const] : []),
    ...orgLenses,
    ...(hasTriggers ? ["trigger" as const] : []),
  ];
}
