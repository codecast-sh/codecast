/**
 * The order of the ready frontier (docs/architecture/task-graph.md TG7): what
 * `cast task ready` lists first and what `--claim` takes. Pure; the caller
 * passes each task's place in its plan and the clock.
 */

import { TASK_PRIORITIES } from "./statuses";

/** A ready task nobody has touched for this many days folds out of the frontier. */
export const STALE_TASK_DAYS = 30;
export const STALE_TASK_MS = STALE_TASK_DAYS * 24 * 60 * 60 * 1000;

/** "untouched 30+ days": how every surface names a stale task. */
export const STALE_TASK_WORDS = `untouched ${STALE_TASK_DAYS}+ days`;

export type FrontierTask = {
  priority?: string | null;
  updated_at?: number | null;
  created_at?: number | null;
  _creationTime?: number;
};

/** Untouched for `STALE_TASK_MS`: the frontier folds it into a count. */
export function isStaleTask(t: FrontierTask, now: number): boolean {
  return now - (t.updated_at ?? t.created_at ?? t._creationTime ?? now) >= STALE_TASK_MS;
}

const rank = (priority: string | null | undefined): number => {
  const i = TASK_PRIORITIES.indexOf((priority ?? "none") as (typeof TASK_PRIORITIES)[number]);
  return i < 0 ? TASK_PRIORITIES.length : i;
};

/**
 * The frontier in the order work should be taken: live tasks before stale
 * ones, then priority, then plan order (`planPosition`, the task's index in
 * its plan; a task in no plan sorts after every plan step), then oldest.
 */
export function frontierOrder<T extends FrontierTask>(
  tasks: readonly T[],
  opts: { now: number; planPosition?: (t: T) => number | undefined },
): T[] {
  const key = (t: T) => [
    isStaleTask(t, opts.now) ? 1 : 0,
    rank(t.priority),
    opts.planPosition?.(t) ?? Number.MAX_SAFE_INTEGER,
    t.created_at ?? t._creationTime ?? 0,
  ];
  const keyed = tasks.map((t) => ({ t, k: key(t) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i] - b.k[i];
    return 0;
  });
  return keyed.map((x) => x.t);
}
