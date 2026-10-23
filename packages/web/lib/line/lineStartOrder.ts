// The order a project's line takes its ready problems (convex orgLine rankedCandidates): the shared start order,
// scored value, then findings, then oldest first (shared/contracts/linePriority byStartOrder). The Turn on review names
// the first ones in it, and Problems > Not started lists a project's ready problems in it, so the review starts what the
// list shows on top.
import { byStartOrder, type StartOrderTask } from "@codecast/shared/contracts/linePriority";

export type RankTask = StartOrderTask & { _id: string };

/** Tasks in the line's start order. */
export function inStartOrder<T extends RankTask>(tasks: ReadonlyArray<T>): T[] {
  return [...tasks].sort(byStartOrder);
}
