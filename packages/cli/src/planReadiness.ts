// Which of a plan's tasks can start now, for `cast plan orchestrate`,
// `autopilot`, `status`, `wave` and the workflow runner's `ready_tasks`.
// Readiness itself is graph.ts's (task-graph.md TG1), the same rule `cast task
// ready` applies on the server.
//
// The plan payload is the whole world here. A blocker outside the plan was not
// looked up, so it blocks (status unknown) rather than reading as cleared. A
// parent outside the plan is not this plan's to drive, so a subtask under it
// is judged as an orphan; a parent inside the plan that is being worked keeps
// its subtasks out of the frontier.
//
// Backlog counts as `open` (work not started) but is never ready: TG1 readies
// only `open` tasks, so parked work waits until someone moves it to open.
import { readinessOf, statusLookup, type GraphTask, type StatusOf } from "@codecast/shared/tasks";

export interface PlanReadiness<T> {
  statusOf: StatusOf;
  /** Not started: open or backlog. */
  open: T[];
  ready: T[];
  /** Open tasks held back by a blocker or a wait. */
  blocked: T[];
}

export function planReadiness<T extends GraphTask & { _id?: unknown; short_id?: string }>(tasks: T[]): PlanReadiness<T> {
  const statusOf = statusLookup(tasks);
  const parentStatusOf = (id: string) => {
    const parent = statusOf(id);
    return parent && typeof parent === "object" ? parent.status ?? null : null;
  };
  const verdicts = new Map(tasks.map((t) => [t, readinessOf(t, { statusOf, parentStatusOf, viewer: null })]));
  return {
    statusOf,
    open: tasks.filter((t) => t.status === "open" || t.status === "backlog"),
    ready: tasks.filter((t) => verdicts.get(t)!.ready),
    blocked: tasks.filter((t) => { const r = verdicts.get(t)!; return !r.ready && r.reason === "blocked"; }),
  };
}
