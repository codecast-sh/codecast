// What "a session holds a task" means, everywhere: the owner wake
// (taskWaits ownerOf, through lib/taskOwner.boundSessionsOf) and the exact
// "blocker" stamp (lib/parkedWake isTaskHeld). A session bound to the task by
// active_task_id that is not killed and not only reviewing it. A completed
// session counts: a wake resumes it. A leaf, so functions.ts's wrapper can
// import it.

export function holdsTask(conv: { active_task_id?: unknown; review_of_task_id?: unknown; inbox_killed_at?: unknown } | null | undefined, taskId: unknown): boolean {
  return !!conv && String(conv.active_task_id ?? "") === String(taskId) && String(conv.review_of_task_id ?? "") !== String(taskId) && !conv.inbox_killed_at;
}
