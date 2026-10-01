// Which of a plan's tasks can start now: open (or backlog) and every
// blocked_by dependency done or dropped. One definition for `cast plan
// orchestrate`, `autopilot`, `status` and the workflow runner's `ready_tasks`.
export interface PlanReadiness<T> {
  resolvedIds: Set<string>;
  open: T[];
  ready: T[];
  blocked: T[];
}

export function resolvedTaskIds(tasks: any[]): Set<string> {
  return new Set(
    tasks.filter((t) => t.status === "done" || t.status === "dropped").flatMap((t) => [t._id, t.short_id]),
  );
}

export function isUnblocked(task: any, resolvedIds: Set<string>): boolean {
  return !task.blocked_by?.length || task.blocked_by.every((d: string) => resolvedIds.has(d));
}

export function planReadiness<T extends { status?: string; blocked_by?: string[] }>(tasks: T[]): PlanReadiness<T> {
  const resolvedIds = resolvedTaskIds(tasks);
  const open = tasks.filter((t) => t.status === "open" || t.status === "backlog");
  return {
    resolvedIds,
    open,
    ready: open.filter((t) => isUnblocked(t, resolvedIds)),
    blocked: open.filter((t) => !isUnblocked(t, resolvedIds)),
  };
}
