// Which of a plan's tasks can start now, for `cast plan orchestrate`,
// `autopilot`, `status`, `wave` and the workflow runner's `ready_tasks`.
// Readiness itself is graph.ts's (task-graph.md TG1), the same rule `cast task
// ready` applies on the server.
//
// Blockers and parents outside the plan resolve from `outside`, the rows
// plans.get read for them (`graph_outside`). A ref it did not look up (an
// older server, or a caller that passes no `outside`) stays unknown: a blocker
// blocks and a subtask waits (parent_unknown), never reads as cleared.
//
// Backlog counts as `open` (work not started) but is never ready: TG1 readies
// only `open` tasks, so parked work waits until someone moves it to open.
import { parentStatusLookup, readinessOf, statusLookup, type GraphTask, type StatusOf } from "@codecast/shared/tasks";

type RefRow = { _id?: unknown; short_id?: string | null; status?: string | null };

/** plans.get's `graph_outside`: the rows the plan's blockers and parents name
 *  outside it, and every ref it looked up. */
export type GraphOutside = { tasks: RefRow[]; searched: string[] };

export interface PlanReadiness<T> {
  statusOf: StatusOf;
  /** Not started: open or backlog. */
  open: T[];
  ready: T[];
  /** Open tasks held back by a blocker or a wait. */
  blocked: T[];
  /** Backlog: never scheduled until someone moves it to open. */
  parked: T[];
}

export function planReadiness<T extends GraphTask & { _id?: unknown; short_id?: string }>(tasks: T[], outside?: GraphOutside | null): PlanReadiness<T> {
  const statusOf = statusLookup([...tasks, ...(outside?.tasks ?? [])], outside?.searched);
  const parentStatusOf = parentStatusLookup(statusOf);
  const verdicts = new Map(tasks.map((t) => [t, readinessOf(t, { statusOf, parentStatusOf, viewer: null })]));
  return {
    statusOf,
    open: tasks.filter((t) => t.status === "open" || t.status === "backlog"),
    ready: tasks.filter((t) => verdicts.get(t)!.ready),
    blocked: tasks.filter((t) => { const r = verdicts.get(t)!; return !r.ready && r.reason === "blocked"; }),
    parked: tasks.filter((t) => t.status === "backlog"),
  };
}

/** The line a plan surface prints when backlog is all that is left to start. */
export function parkedNote(parked: readonly unknown[]): string | null {
  return parked.length ? `${parked.length} in backlog: move to open to schedule` : null;
}
