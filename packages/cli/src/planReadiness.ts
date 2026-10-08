// Which of a plan's tasks can start now, for `cast plan orchestrate`,
// `autopilot`, `status`, `wave` and the workflow runner's `ready_tasks`.
// Readiness itself is graph.ts's (task-graph.md TG1), the same rule `cast task
// ready` applies on the server, judged by shared/tasks planVerdicts, which the
// plan's fenced task list reads too.
//
// Backlog counts as `open` (work not started) but is never ready: TG1 readies
// only `open` tasks, so parked work waits until someone moves it to open.
import { planVerdicts, type GraphOutside, type GraphTask, type NotReadyReason, type StatusOf } from "@codecast/shared/tasks";

export { openBlockerLabels, type GraphOutside } from "@codecast/shared/tasks";

export interface PlanReadiness<T> {
  statusOf: StatusOf;
  /** Not started: open or backlog. */
  open: T[];
  ready: T[];
  /** Open tasks held back by a blocker or a wait. */
  blocked: T[];
  /** Open tasks that will become ready without anyone touching them: blocked,
   *  or a subtask whose parent is being worked (or was not looked up). */
  waiting: T[];
  /** Backlog: never scheduled until someone moves it to open. */
  parked: T[];
}

export function planReadiness<T extends GraphTask & { _id?: unknown; short_id?: string }>(tasks: T[], outside?: GraphOutside | null): PlanReadiness<T> {
  const { statusOf, verdicts } = planVerdicts(tasks, outside);
  const heldBy = (reasons: readonly NotReadyReason[]) => tasks.filter((t) => { const r = verdicts.get(t)!; return !r.ready && reasons.includes(r.reason); });
  return {
    statusOf,
    open: tasks.filter((t) => t.status === "open" || t.status === "backlog"),
    ready: tasks.filter((t) => verdicts.get(t)!.ready),
    blocked: heldBy(["blocked"]),
    waiting: heldBy(["blocked", "parent_active", "parent_unknown"]),
    parked: tasks.filter((t) => t.status === "backlog"),
  };
}

/** The line a plan surface prints when backlog is all that is left to start. */
export function parkedNote(parked: readonly unknown[]): string | null {
  return parked.length ? `${parked.length} in backlog: move to open to schedule` : null;
}
