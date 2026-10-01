// A cause's priority on the line (docs/architecture/the-line-end-to-end.md
// LE5): computed, never judged. The sweep admits causes highest first (LE6).
//
//   priority = goal × severity × (1 + log2(signals))
//
//   goal      the threatened goal's priority: p0 8, p1 4, p2 2, p3 1; a goal
//             with no priority set 1; goal_ref "none" (or none yet) 0.25, so a
//             cause that serves no goal ranks below any that does unless its
//             signals pile up.
//   severity  the cause task's priority: urgent 4, high 3, medium 2, low or
//             none 1.
//   signals   damped by log2, so doubling the reports adds one step: a p3
//             cause needs 128 signals to tie a single-signal p0 at the
//             same severity.
import type { GoalPriority } from "@codecast/shared/contracts/goalsBrief";

export type Severity = "urgent" | "high" | "medium" | "low" | "none";

const GOAL_WEIGHT: Record<GoalPriority, number> = { p0: 8, p1: 4, p2: 2, p3: 1 };
const SEVERITY_WEIGHT: Record<Severity, number> = { urgent: 4, high: 3, medium: 2, low: 1, none: 1 };
/** goal_ref "none": the cause threatens nothing in the brief. */
export const NO_GOAL_WEIGHT = 0.25;
/** A goal is named but carries no priority. */
export const UNRANKED_GOAL_WEIGHT = 1;

/** `goalPriority`: the goal's p0..p3, "unranked" for a goal without one, null for no goal. */
export function priority(goalPriority: GoalPriority | "unranked" | null | undefined, severity: Severity | null | undefined, signalCount: number): number {
  const goal = !goalPriority ? NO_GOAL_WEIGHT : goalPriority === "unranked" ? UNRANKED_GOAL_WEIGHT : GOAL_WEIGHT[goalPriority] ?? UNRANKED_GOAL_WEIGHT;
  const sev = SEVERITY_WEIGHT[severity ?? "none"] ?? 1;
  const signals = 1 + Math.log2(Math.max(1, Math.floor(signalCount) || 1));
  return goal * sev * signals;
}
