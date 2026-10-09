import { directChildren, subtaskProgressOf, type ProgressInput } from "@codecast/shared/tasks";

const cache = new WeakMap<object, { children: Map<string, ProgressInput[]>; tallies: Map<string, string> }>();

export function subtaskTally(taskId: string, tasks: Record<string, ProgressInput>): string {
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
  const { children, tallies } = index;
  const cached = tallies.get(taskId);
  if (cached !== undefined) return cached;
  const progress = subtaskProgressOf(directChildren(children.get(taskId) ?? [], taskId));
  const tally = progress.total > 0 ? `${progress.done}/${progress.total}` : "";
  tallies.set(taskId, tally);
  return tally;
}
