// The person's controls over their priorities (convex priorities.ts): a rank,
// a step's tier, set aside and restore. Each paints the `priorities` rows at
// once (lib/priorities paint*) and rides `dispatch` to the side effect of the
// same name (convex/dispatch.ts), which runs the API's own mutation. The
// collection is not localFirst (store/clientSyncRegistry), so the server's
// next push settles the paint; a caller that holds the rows from before puts
// them back when the server refuses (lib/priorities writeOrRestore).
import { asyncAction } from "./mutativeMiddleware";
import type { PriorityRow, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import { paintRank, paintStatus, paintTier } from "../lib/priorities";

export type PrioritiesSliceActions = {
  rankPriority: (shortId: string, rank: number) => Promise<unknown>;
  setPriorityStepTier: (shortId: string, stepKey: string, tier: PriorityStepTier) => Promise<unknown>;
  setPriorityAside: (shortId: string) => Promise<unknown>;
  restorePriority: (shortId: string) => Promise<unknown>;
  /** One pass now in a workspace (priorities.run). Paints nothing: the pass writes its rows in a minute. */
  runPriorities: (workspace: string) => Promise<unknown>;
};

type Rows = { priorities: Record<string, PriorityRow> };
const rowsOf = (s: Rows): PriorityRow[] => Object.values(s.priorities ?? {});

export function createPrioritiesSlice(): PrioritiesSliceActions {
  return {
    rankPriority: asyncAction(function (this: Rows, shortId: string, rank: number) {
      paintRank(rowsOf(this), shortId, rank);
    }) as PrioritiesSliceActions["rankPriority"],
    setPriorityStepTier: asyncAction(function (this: Rows, shortId: string, stepKey: string, tier: PriorityStepTier) {
      const row = rowsOf(this).find((r) => r.short_id === shortId);
      if (row) paintTier(row, stepKey, tier);
    }) as PrioritiesSliceActions["setPriorityStepTier"],
    setPriorityAside: asyncAction(function (this: Rows, shortId: string) {
      paintStatus(rowsOf(this), shortId, "set_aside");
    }) as PrioritiesSliceActions["setPriorityAside"],
    restorePriority: asyncAction(function (this: Rows, shortId: string) {
      paintStatus(rowsOf(this), shortId, "active");
    }) as PrioritiesSliceActions["restorePriority"],
    runPriorities: asyncAction(function (this: Rows, _workspace: string) {}) as PrioritiesSliceActions["runPriorities"],
  };
}
