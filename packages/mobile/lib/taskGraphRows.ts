// The task screen's graph (docs/architecture/task-graph.md TG12), read-only:
// Blocked by lists every task blocker and wait with its state, cleared ones
// kept and marked, in the order and words of the shared graph module; the
// non-blocking links name their task.
import {
  blockerEntriesOf,
  blockerStateLabel,
  isCleared,
  isTerminalTaskStatus,
  isUnblocked,
  waitLabel,
  waitStateWord,
  type GraphTask,
  type StatusOf,
  type WaitKind,
  type WaitState,
} from '@codecast/shared/tasks';
import { lookup } from '@codecast/web/lib/liveEntities';
import { storeStatusOf, type BoardTask } from '@codecast/web/lib/taskBlockers';

type TaskRows = Record<string, any> | null | undefined;

export type BlockerRow =
  /** `status` is the blocker's task status, `unknown` when the phone does not
   *  hold it, or `missing` when the id names no task; `stateLabel` is the
   *  shared words for those two ("status unknown", "not found"). */
  | { key: string; kind: 'task'; ref: string; status: string; stateLabel?: string; title?: string; cleared: boolean }
  /** `word` is the shared word after a wait (`waitStateWord`): its settled
   *  note, "to merge", "in 2h"; empty once the task closed on a pending wait. */
  | { key: string; kind: WaitKind; label: string; state: WaitState; word: string; cleared: boolean };

export type LinkedTask = { ref: string; title?: string };

/** `unblocked` is the shared verdict (`isUnblocked`): nothing in Blocked by
 *  still holds the task. */
export type TaskGraphView = { blockedBy: BlockerRow[]; unblocked: boolean; foundDuring: LinkedTask | null; supersededBy: LinkedTask | null };

/** A ref resolves the way the web reads it (storeStatusOf): the held row,
 *  else the row's `graph_status` snapshot, else `graph_missing` (not found),
 *  else unknown. */
export function taskGraphView(task: BoardTask & { found_during?: string | null }, tasks: TaskRows, now = Date.now()): TaskGraphView {
  const statusOf = storeStatusOf(tasks, task);
  const titleOf = (ref: string): string | undefined => lookup(tasks, ref)?.title;
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
    // A kind added after this bundle shipped (an OTA lags the server) reads by its name and state.
    if (b.kind !== 'task') {
      const word = waitStateWord(b, { now, closed: isTerminalTaskStatus(task.status) }) ?? b.state;
      return { key: `wait:${b.id}`, kind: b.kind, label: waitLabel(b, { now }) ?? b.kind, state: b.state, word, cleared };
    }
    const stateLabel = blockerStateLabel(b);
    if ('missing' in b) return { key: `task:${b.ref}`, kind: 'task', ref: b.ref, status: 'missing', stateLabel, cleared };
    return { key: `task:${b.ref}`, kind: 'task', ref: b.ref, status: b.status, stateLabel, title: titleOf(b.ref), cleared };
  });
}
