// The plan header's progress, counted from the tasks the same payload lists.
// `cast plan show` reads /cli/plans/get, which carries the task rows and no
// tally, so the header said "no tasks" above a list of them.

export function planProgressLabel(plan: { tasks?: Array<{ status?: string }> | null; task_total?: number; task_done?: number }): string {
  const total = plan.tasks ? plan.tasks.length : plan.task_total ?? 0;
  if (!total) return "no tasks";
  const done = plan.tasks ? plan.tasks.filter((t) => t.status === "done").length : plan.task_done ?? 0;
  return `${done}/${total} tasks done`;
}
