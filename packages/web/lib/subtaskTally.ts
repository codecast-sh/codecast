import { directChildren, subtaskProgressOf, type ProgressInput } from "@codecast/shared/tasks";

const cache = new WeakMap<object, { children: Map<string, ProgressInput[]>; tallies: Map<string, string> }>();

function taskIndex(tasks: Record<string, ProgressInput>) {
  let index = cache.get(tasks);
  if (!index) {
    const children = new Map<string, ProgressInput[]>();
    for (const id in tasks) {
      if (!Object.hasOwn(tasks, id)) continue;
      const row = tasks[id];
      if (!row.parent_id) continue;
      const parent = String(row.parent_id);
      let siblings = children.get(parent);
      if (!siblings) children.set(parent, siblings = []);
      siblings.push(row);
    }
    index = { children, tallies: new Map() };
    cache.set(tasks, index);
  }
  return index;
}

export function taskChildren<T extends ProgressInput>(taskId: string, tasks: Record<string, T>): T[] {
  return directChildren(taskIndex(tasks).children.get(taskId) ?? [], taskId) as T[];
}

export function subtaskTally(taskId: string, tasks: Record<string, ProgressInput>): string {
  const { tallies } = taskIndex(tasks);
  const cached = tallies.get(taskId);
  if (cached !== undefined) return cached;
  const progress = subtaskProgressOf(taskChildren(taskId, tasks));
  const tally = progress.total > 0 ? `${progress.done}/${progress.total}` : "";
  tallies.set(taskId, tally);
  return tally;
}
