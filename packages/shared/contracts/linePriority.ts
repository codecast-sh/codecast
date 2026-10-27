// A cause's priority on the line (docs/architecture/the-line-end-to-end.md
// LE5): computed, never judged. The line's start order is the scored value
// below (byStartOrder), not this.
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
import type { GoalPriority } from "./goalsBrief";
import type { TaskPriority } from "../tasks";

export type Severity = TaskPriority;

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

// The order the line starts ready problems (LE6): the value of fixing each,
// as the scoring pass judged it (cause.scored.score, 1 to 100,
// learning-loop.md LL15), highest first; then the most findings; then the
// oldest. A problem the pass has not scored yet ranks as UNSCORED_VALUE, the
// middle of the scale, so a new problem neither waits behind every scored one
// nor jumps them.
export const UNSCORED_VALUE = 50;

export type StartOrderTask = {
  created_at?: number;
  _creationTime?: number;
  cause?: { signal_count?: number; scored?: { score: number } | null } | null;
};

export const startValue = (t: StartOrderTask): number => t.cause?.scored?.score ?? UNSCORED_VALUE;

/** Sorts tasks into the line's start order. */
export function byStartOrder(a: StartOrderTask, b: StartOrderTask): number {
  const age = (t: StartOrderTask) => t.created_at ?? t._creationTime ?? 0;
  return startValue(b) - startValue(a) || (b.cause?.signal_count ?? 0) - (a.cause?.signal_count ?? 0) || age(a) - age(b);
}

// A live flow's bar (liveFlows.ts, decision sd-1700): which problems its
// agents take. The scoring pass rates a judge's problems once, so one sighting
// rated low waits for another finding, and the finding that joins re-scores
// it. A problem with no score clears the bar: the pass covers only the judges
// it was configured for, so errors, replays, evals and judge cases are never
// scored, and a new problem it covers ranks as UNSCORED_VALUE, behind every
// one over the bar, until its score comes. A problem that waits `quiet_days`
// with no new finding closes, and reopens when one comes.
export type FlowBar = { score: number; findings: number; quiet_days: number };

/** Whether a problem clears the bar: not scored, scored at or over its score, or holding at least its findings. No bar takes every problem. */
export const clearsBar = (t: StartOrderTask, bar: Pick<FlowBar, "score" | "findings"> | null | undefined): boolean =>
  !bar || !t.cause?.scored || t.cause.scored.score >= bar.score || (t.cause?.signal_count ?? 0) >= bar.findings;

/** The bar in words: "score 60+ or 3+ findings". */
export const barWords = (bar: Pick<FlowBar, "score" | "findings">): string => `score ${bar.score}+ or ${bar.findings}+ findings`;
