import type { Cursor } from './cursor';
import type { Partition, Scope } from './scope';

export type TaskTag = { taskId: string; weight: number };

/** One event in a scope's append-only log. */
export interface Activity {
  id: string;
  scope: Scope;
  partition: Partition;
  kind: string;
  /** One line: what a read shows for it. */
  summary: string;
  data?: Record<string, unknown>;
  at: Cursor;
  /** For display only; compare `at` through the store. */
  atMs: number;
  actor?: { agentId?: string; runId?: string; name?: string };
  /** The host document behind it (a message, a call). */
  ref?: { table: string; id: string };
  tasks?: TaskTag[];
  focusedTaskId?: string;
}

/** An activity to append. `at` defaults to the store's now; pass one from the store's `cursorAt` to backdate. */
export type NewActivity = Omit<Activity, 'id' | 'at' | 'atMs'> & { at?: Cursor };

/** A summary in a scope's tree. Level 0 is a leaf (a summary of raw activities). */
export interface Block {
  id: string;
  scope: Scope;
  partition: Partition;
  level: number;
  /** Position at its level; null for a legacy leaf not yet numbered. */
  index: number | null;
  start: Cursor;
  end: Cursor;
  startMs: number;
  endMs: number;
  content: string;
  /** Raw activities under it. */
  count: number;
  /** The activity kinds under it, recorded when it was written. */
  kinds?: string[];
  tasks?: TaskTag[];
  createdAtMs: number;
}

/** A leaf to append: bounds are the cursors of its first and last activity, exactly as the store returned them. */
export interface NewLeaf {
  start: Cursor;
  end: Cursor;
  content: string;
  count: number;
  kinds?: string[];
  tasks?: TaskTag[];
}

/** Every task tagged on any of several rows, each at its highest weight. */
export function mergeTaskTags(lists: ReadonlyArray<readonly TaskTag[] | null | undefined>): TaskTag[] | undefined {
  const byTask = new Map<string, TaskTag>();
  for (const t of lists.flatMap((l) => l ?? [])) {
    const seen = byTask.get(t.taskId);
    if (!seen || t.weight > seen.weight) byTask.set(t.taskId, { ...t });
  }
  return byTask.size > 0 ? [...byTask.values()] : undefined;
}

/** Every kind in any of the lists, sorted, once each. */
export function mergeKinds(lists: ReadonlyArray<readonly string[] | null | undefined>): string[] | undefined {
  const all = new Set(lists.flatMap((l) => l ?? []));
  return all.size > 0 ? [...all].sort() : undefined;
}
