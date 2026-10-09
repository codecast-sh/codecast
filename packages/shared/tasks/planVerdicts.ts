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

/**
 * Who the plan's readiness is judged for (TG9: an ephemeral step leaves the
 * frontier of everyone but its owner, `ownsEphemeral`). `plans.get` sends it
 * as `graph_viewer`, so a client judges the rows the way the server's
 * `cast task ready --plan` does.
 *
 * Passed by the surfaces a CALLER reads about their own plan (`cast plan
 * show`, `context`, `status`, `wave`), so the session that filed an ephemeral
 * step is not told its own bookkeeping is left to whoever filed it. Left
 * out by the surfaces that decide what a FRESH session could be spawned for
 * (`orchestrate`, `autopilot`, the workflow runner): a spawned session is
 * never the owner, so there every ephemeral step reads as someone's own.
 */
export type ReadinessViewer = { viewer: string | null; viewerSession?: string | null };

/** Each task's verdict, and the lookup that decided it. */
export function planVerdicts<T extends GraphTask & RefRow>(tasks: T[], outside?: GraphOutside | null, who?: ReadinessViewer | null): { statusOf: StatusOf; verdicts: Map<T, Readiness> } {
  const statusOf = statusLookup([...tasks, ...(outside?.tasks ?? [])], outside?.searched);
  const parentStatusOf = parentStatusLookup(statusOf);
  const readiness = { statusOf, parentStatusOf, viewer: who?.viewer ?? null, viewerSession: who?.viewerSession ?? null };
  return { statusOf, verdicts: new Map(tasks.map((t) => [t, readinessOf(t, readiness)])) };
}

/** What still holds a plan task back, one label each ("ct-12", "PR #42 to
 *  merge"), against the lookup `planVerdicts` built. */
export function openBlockerLabels(task: GraphTask, statusOf: StatusOf, words: WaitLabelOptions = {}): string[] {
  return blockersHoldingBack(task, statusOf).map((b) => blockerLabel(b, words));
}
