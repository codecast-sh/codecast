// A plan's tasks judged by graph.ts's readiness (task-graph.md TG1), for every
// plan surface: the CLI's orchestrate, status and wave (cli/planReadiness) and
// the fenced task list of `cast plan show` and `context` (planForeignText).
//
// Blockers and parents outside the plan resolve from `outside`, the rows
// plans.get read for them (`graph_outside`). A ref it did not look up (an
// older server, or a caller that passes no `outside`) stays unknown: a blocker
// blocks and a subtask waits (parent_unknown), never reads as cleared.

import {
  blockerLabel,
  blockersHoldingBack,
  parentStatusLookup,
  readinessOf,
  statusLookup,
  type GraphTask,
  type Readiness,
  type StatusOf,
  type WaitLabelOptions,
} from "./graph";

type RefRow = { _id?: unknown; short_id?: string | null; status?: string | null };

/** plans.get's `graph_outside`: the rows the plan's blockers and parents name
 *  outside it, and every ref it looked up. */
export type GraphOutside = { tasks: RefRow[]; searched: string[] };

/** Each task's verdict, and the lookup that decided it. */
export function planVerdicts<T extends GraphTask & RefRow>(tasks: T[], outside?: GraphOutside | null): { statusOf: StatusOf; verdicts: Map<T, Readiness> } {
  const statusOf = statusLookup([...tasks, ...(outside?.tasks ?? [])], outside?.searched);
  const parentStatusOf = parentStatusLookup(statusOf);
  return { statusOf, verdicts: new Map(tasks.map((t) => [t, readinessOf(t, { statusOf, parentStatusOf, viewer: null })])) };
}

/** What still holds a plan task back, one label each ("ct-12", "PR #42 to
 *  merge"), against the lookup `planVerdicts` built. */
export function openBlockerLabels(task: GraphTask, statusOf: StatusOf, words: WaitLabelOptions = {}): string[] {
  return blockersHoldingBack(task, statusOf).map((b) => blockerLabel(b, words));
}
