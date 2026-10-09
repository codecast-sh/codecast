// Which of a plan's tasks can start now, for `cast plan orchestrate`,
// `autopilot`, `status`, `wave` and the workflow runner's `ready_tasks`.
// Readiness itself is graph.ts's (task-graph.md TG1), the same rule `cast task
// ready` applies on the server, judged by shared/tasks planVerdicts, which the
// plan's fenced task list reads too.
//
// Backlog counts as `open` (work not started) but is never ready: TG1 readies
// only `open` tasks, so parked work waits until someone moves it to open.
import { blockerGatesPickup, failedWaitAdvice, isFailedWait, notReadyLabel, planVerdicts, UNKNOWN_BLOCKER_STATUS, type Blocker, type GraphOutside, type GraphTask, type Readiness, type StatusOf, type WaitLabelOptions } from "@codecast/shared/tasks";

export interface PlanReadiness<T> {
  statusOf: StatusOf;
  verdicts: Map<T, Readiness>;
  /** Not started: open or backlog. */
  open: T[];
  ready: T[];
  /** Open tasks held back by a blocker or a wait. */
  blocked: T[];
  /** Open tasks that will become ready without anyone touching them: a
   *  subtask whose parent is being worked, or a task whose every blocker can
   *  still clear by itself (a task being worked or due to be, a wait still
   *  waiting). */
  waiting: T[];
  /** Open tasks nothing will release by itself: held by a failed wait, a
   *  blocker that could not be read (another workspace), parked backlog or a
   *  blocker that is stuck itself, or a subtask whose parent could not be
   *  read. Someone has to re-plan them. */
  stuck: T[];
  /** Backlog: never scheduled until someone moves it to open. */
  parked: T[];
  /** Ephemeral steps another session or person filed (TG9). They are their
   *  owner's bookkeeping, so orchestrate and autopilot never spawn for them. */
  ephemeral: T[];
}

export function planReadiness<T extends GraphTask & { _id?: unknown; short_id?: string }>(tasks: T[], outside?: GraphOutside | null): PlanReadiness<T> {
  const { statusOf, verdicts } = planVerdicts(tasks, outside);
  const inPlan = new Set<unknown>(tasks);
  // Whether a task gets to ready with nobody touching it. A plan blocker
  // moves only if it does; one outside the plan moves while open, since
  // anyone may take it.
  const moves = new Map<T, boolean>();
  const willMove = (t: T): boolean => {
    if (moves.has(t)) return moves.get(t)!;
    // The cycle guard, not a redundant write: a blocker chain can loop back
    // onto `t` (TG4 rejects an edge that closes a loop, but one stored through
    // a task that has since closed survives), and `clears` recurses along it.
    // The provisional `false` makes that recursion read "this one does not
    // move by itself" and stop; the real answer replaces it below.
    moves.set(t, false);
    const v = verdicts.get(t)!;
    const result = v.ready || v.reason === "parent_active" || v.reason === "ephemeral" || (v.reason === "blocked" && (v.blockers ?? []).every(clears));
    moves.set(t, result);
    return result;
  };
  const clears = (b: Blocker): boolean => {
    if (b.kind !== "task") return b.state === "waiting";
    if (!("status" in b) || !blockerGatesPickup(b.status)) return true;
    if (b.status !== "open") return false;
    const row = statusOf(b.ref);
    return !inPlan.has(row) || willMove(row as T);
  };
  const notReady = (t: T) => { const v = verdicts.get(t)!; return v.ready ? null : v.reason; };
  return {
    statusOf,
    verdicts,
    open: tasks.filter((t) => t.status === "open" || t.status === "backlog"),
    ready: tasks.filter((t) => verdicts.get(t)!.ready),
    blocked: tasks.filter((t) => notReady(t) === "blocked"),
    waiting: tasks.filter((t) => { const r = notReady(t); return (r === "blocked" || r === "parent_active") && willMove(t); }),
    stuck: tasks.filter((t) => { const r = notReady(t); return (r === "blocked" || r === "parent_unknown") && !willMove(t); }),
    parked: tasks.filter((t) => t.status === "backlog"),
    ephemeral: tasks.filter((t) => notReady(t) === "ephemeral"),
  };
}

/** The line a plan surface prints for work it will not schedule: backlog,
 *  and ephemeral steps left to whoever filed them. */
export function parkedNote({ parked, ephemeral }: Pick<PlanReadiness<unknown>, "parked" | "ephemeral">): string | null {
  const parts = [
    parked.length ? `${parked.length} in backlog: move to open to schedule` : "",
    ephemeral.length ? `${ephemeral.length} ephemeral: left to whoever filed ${ephemeral.length === 1 ? "it" : "them"}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join("; ") : null;
}

/** Why each stuck task will not move ("ct-4: blocked by PR #42 to merge
 *  (failed: closed without merging)"), for a plan that stalled on them. */
export function stuckNote<T extends GraphTask & { short_id?: string }>(r: Pick<PlanReadiness<T>, "stuck" | "verdicts">, words: WaitLabelOptions = {}): string | null {
  const lines = r.stuck.map((t) => {
    const v = r.verdicts.get(t)!;
    return v.ready ? "" : `${t.short_id}: ${notReadyLabel(t, v, words)}`;
  }).filter(Boolean);
  return lines.length ? lines.join("; ") : null;
}

/** What to do about each stuck task: remove or replace its failed waits
 *  (failedWaitAdvice, the words the wake and the compaction block use), or
 *  read the blocker it cannot see where its graph is. */
export function stuckAdvice<T extends GraphTask & { short_id?: string }>(r: Pick<PlanReadiness<T>, "stuck" | "verdicts">): string[] {
  return r.stuck.flatMap((t) => {
    const v = r.verdicts.get(t)!;
    const blockers = v.ready ? [] : v.blockers ?? [];
    const id = t.short_id ?? "";
    const failed = blockers.filter(isFailedWait);
    if (failed.length) return [`${id}: ${failedWaitAdvice(id, failed)}`];
    const unread = blockers.some((b) => b.kind === "task" && "status" in b && b.status === UNKNOWN_BLOCKER_STATUS);
    return unread ? [`${id}: a blocker this workspace cannot read; cast task show ${id} names it`] : [];
  });
}
