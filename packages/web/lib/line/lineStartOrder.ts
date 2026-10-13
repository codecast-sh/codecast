// The order a project's line takes its ready problems (convex orgLine rankedCandidates): the one line priority, goal x
// severity x findings, then oldest first. The Turn on review names the first ones in it, and Problems > Not started
// lists a project's ready problems in it, so the review starts what the list shows on top.
import { priority as linePriority, type Severity } from "@codecast/shared/contracts/linePriority";
import type { GoalPriority } from "@codecast/shared/contracts/goalsBrief";

export type RankTask = { _id: string; priority?: string | null; created_at?: number; goal_ref?: string | null; cause?: { signal_count?: number } | null };

/** A goal ref's priority, from the projects by short id: none for no goal, unranked for one nothing ranks. */
export function goalOfRefs(projects: Iterable<{ short_id?: string; priority?: string | null }>): (ref: string | null | undefined) => GoalPriority | "unranked" | null {
  const goals = new Map([...projects].filter((p) => p.short_id).map((p) => [p.short_id!, p.priority]));
  return (ref) => {
    const r = ref?.trim();
    if (!r || r === "none") return null;
    const p = goals.get(r.split(":")[0]);
    return p === "p0" || p === "p1" || p === "p2" || p === "p3" ? p : "unranked";
  };
}

export const lineRank = (t: RankTask, goalOf: ReturnType<typeof goalOfRefs>): number =>
  linePriority(goalOf(t.goal_ref), (t.priority ?? "none") as Severity, t.cause?.signal_count ?? 1);

/** Tasks in the line's start order: highest rank first, ties oldest first. */
export function inStartOrder<T extends RankTask>(tasks: ReadonlyArray<T>, goalOf: ReturnType<typeof goalOfRefs>): T[] {
  return tasks.map((t) => ({ t, rank: lineRank(t, goalOf) })).sort((x, y) => y.rank - x.rank || (x.t.created_at ?? 0) - (y.t.created_at ?? 0)).map(({ t }) => t);
}
