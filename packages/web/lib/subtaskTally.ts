import { directChildren, subtaskProgressOf, type ProgressInput } from "@codecast/shared/tasks";

const cache = new WeakMap<object, Map<string, string>>();

export function subtaskTally(taskId: string, tasks: Record<string, ProgressInput>): string {
  let tallies = cache.get(tasks);
  if (!tallies) {
    tallies = new Map();
    cache.set(tasks, tallies);
  }
  const cached = tallies.get(taskId);
  if (cached !== undefined) return cached;
  const candidates: ProgressInput[] = [];
  for (const id in tasks) {
    if (!Object.hasOwn(tasks, id)) continue;
    const row = tasks[id];
    if (row.parent_id && String(row.parent_id) === taskId) candidates.push(row);
  }
  const progress = subtaskProgressOf(directChildren(candidates, taskId));
  const tally = progress.total > 0 ? `${progress.done}/${progress.total}` : "";
  tallies.set(taskId, tally);
  return tally;
}
