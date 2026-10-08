// The task screen's graph (docs/architecture/task-graph.md TG12), read-only:
// Blocked by lists every task blocker and wait with its state, cleared ones
// kept and marked, in the order and words of the shared graph module; the
// non-blocking links name their task.
import {
  blockerEntriesOf,
  blockerStateLabel,
  isCleared,
  isUnblocked,
  statusLookup,
  waitLabel,
  type GraphTask,
  type StatusOf,
  type WaitKind,
  type WaitState,
} from '@codecast/shared/tasks';

type TaskRow = { _id?: unknown; short_id?: string | null; status?: string | null; title?: string };

export type BlockerRow =
  /** `status` is the blocker's task status, `unknown` when the phone does not
   *  hold it, or `missing` when the id names no task; `stateLabel` is the
   *  shared words for those two ("status unknown", "not found"). */
  | { key: string; kind: 'task'; ref: string; status: string; stateLabel?: string; title?: string; cleared: boolean }
  | { key: string; kind: WaitKind; label: string; state: WaitState; note?: string; cleared: boolean };

export type LinkedTask = { ref: string; title?: string };

/** `unblocked` is the shared verdict (`isUnblocked`): nothing in Blocked by
 *  still holds the task. */
export type TaskGraphView = { blockedBy: BlockerRow[]; unblocked: boolean; foundDuring: LinkedTask | null; supersededBy: LinkedTask | null };

/** `graph_missing` is the refs the task detail looked up and found no task
 *  for (taskMining.webGetTaskDetail): they read as not found, not unknown. */
type GraphFields = GraphTask & { found_during?: string | null; graph_missing?: readonly string[] | null };

export function taskGraphView(task: GraphFields, tasks: Iterable<TaskRow>, now = Date.now()): TaskGraphView {
  const statusOf = statusLookup(tasks, task.graph_missing ?? []);
  const titleOf = (ref: string) => {
    const held = statusOf(ref);
    return held && typeof held === 'object' ? (held as TaskRow).title : undefined;
  };
  const link = (ref: string | null | undefined): LinkedTask | null => (ref ? { ref, title: titleOf(ref) } : null);
  return {
    blockedBy: blockerRows(task, statusOf, titleOf, now),
    unblocked: isUnblocked(task, statusOf),
    foundDuring: link(task.found_during),
    supersededBy: link(task.superseded_by),
  };
}

function blockerRows(task: GraphTask, statusOf: StatusOf, titleOf: (ref: string) => string | undefined, now: number): BlockerRow[] {
  return blockerEntriesOf(task, statusOf).map((b): BlockerRow => {
    const cleared = isCleared(b);
    if (b.kind !== 'task') return { key: `wait:${b.id}`, kind: b.kind, label: waitLabel(b, { now }), state: b.state, note: b.note, cleared };
    const stateLabel = blockerStateLabel(b);
    if ('missing' in b) return { key: `task:${b.ref}`, kind: 'task', ref: b.ref, status: 'missing', stateLabel, cleared };
    return { key: `task:${b.ref}`, kind: 'task', ref: b.ref, status: b.status, stateLabel, title: titleOf(b.ref), cleared };
  });
}
