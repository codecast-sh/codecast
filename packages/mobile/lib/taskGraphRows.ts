// The task screen's graph (docs/architecture/task-graph.md TG12), read-only:
// Blocked by lists every task blocker and wait with its state, cleared ones
// kept and marked, in the order and words of the shared graph module; the
// non-blocking links name their task.
import {
  blockerEntriesOf,
  blockerStateLabel,
  checksWaitPr,
  isCleared,
  isTerminalTaskStatus,
  isUnblocked,
  isWaitKind,
  prWords,
  waitStateWord,
  waitSubject,
  waitWordFails,
  type GraphTask,
  type StatusOf,
  type WaitKind,
  type WaitState,
} from '@codecast/shared/tasks';
import { findEntityInStore } from '@codecast/web/lib/liveEntities';
import { storeStatusOf, storeTitleOf, type BoardTask } from '@codecast/web/lib/taskBlockers';

type TaskRows = Record<string, any> | null | undefined;

export type BlockerRow =
  /** `status` is the blocker's task status, `unknown` when the phone does not
   *  hold it, or `missing` when the id names no task; `stateLabel` is the
   *  shared words for those two ("status unknown", "not found"). */
  | { key: string; kind: 'task'; ref: string; status: string; stateLabel?: string; title?: string; cleared: boolean }
  /** `label` is what the wait is ON and nothing more (`waitSubject`): "PR
   *  codecast-sh/codecast#42", "sd-4", "Thu 09:00" — the phone has no
   *  checkout, so a PR is always named in full (`prWords(null)`), the way the
   *  server and another checkout's CLI name it. `word` is the shared word
   *  after it (`waitStateWord`): its settled note, "to merge", "in 2h",
   *  "checks failing"; empty once the task closed on a pending wait. Subject
   *  and predicate split the way the task page splits them between its pill
   *  and the word beside it, so one line never carries two predicates. `pr`
   *  names the PR whose checks a live checks wait reads, for the screen to
   *  feed; `failing` is set when the word reads red (`waitWordFails`): the
   *  wait failed, or its checks are red, which keeps it waiting (TG2). */
  | { key: string; kind: WaitKind; label: string; state: WaitState; word: string; cleared: boolean; pr?: PrKey; failing?: true };

export type PrKey = { repository: string; number: number };

export type LinkedTask = { ref: string; title?: string };

/** `unblocked` is the shared verdict (`isUnblocked`): nothing in Blocked by
 *  still holds the task. */
export type TaskGraphView = { blockedBy: BlockerRow[]; unblocked: boolean; foundDuring: LinkedTask | null; supersededBy: LinkedTask | null };

/** A ref resolves the way the web reads it (storeStatusOf): the held row,
 *  else the row's `graph_status` snapshot, else `graph_missing` (not found),
 *  else unknown. A checks wait reads its PR's `checks_state` from the held
 *  `pullRequests` rows. */
export function taskGraphView(task: BoardTask & { found_during?: string | null }, tasks: TaskRows, now = Date.now(), pullRequests?: TaskRows): TaskGraphView {
  const statusOf = storeStatusOf(tasks, task);
  const checksOf = (pr: PrKey): string | undefined =>
    (findEntityInStore({ pullRequests }, 'pr', `${pr.repository}#${pr.number}`) as { checks_state?: string } | undefined)?.checks_state;
  // A title comes from the same answer as the status (storeTitleOf), so a row
  // the workspace rule refuses (storeStatusOf, graphOutside) is nameless here
  // too and a line never mixes a real title with "status unknown".
  const titleOf = storeTitleOf(statusOf);
  const link = (ref: string | null | undefined): LinkedTask | null => (ref ? { ref, title: titleOf(ref) } : null);
  return {
    blockedBy: blockerRows(task, statusOf, titleOf, checksOf, now),
    // A closed task is held by nothing by definition, so it says nothing —
    // the web suppresses the word the same way (TaskRelations).
    unblocked: !isTerminalTaskStatus(task.status) && isUnblocked(task, statusOf),
    foundDuring: link(task.found_during),
    supersededBy: link(task.superseded_by),
  };
}

function blockerRows(
  task: GraphTask,
  statusOf: StatusOf,
  titleOf: (ref: string) => string | undefined,
  checksOf: (pr: PrKey) => string | undefined,
  now: number,
): BlockerRow[] {
  const closed = isTerminalTaskStatus(task.status);
  // The phone holds no checkout, so it knows no repository to read a bare
  // "#42" in: every PR is named in full, the shared rule for exactly this case
  // (`prWords`), which the CLI's `checkoutWords` and convex's `storedWords`
  // both honour.
  const words = { now, ...prWords(null) };
  return blockerEntriesOf(task, statusOf).map((b): BlockerRow => {
    const cleared = isCleared(b);
    if (b.kind !== 'task') {
      // Whether this row needs its PR's checks read is the shared rule
      // (`checksWaitPr`), the same one the web's WaitLine asks.
      const target = checksWaitPr(b, { closed });
      const pr = target ? { repository: target.repository, number: target.pr_number } : undefined;
      const checks = pr && checksOf(pr);
      const word = waitStateWord(b, { now, closed, checks }) ?? b.state;
      // A kind added after this bundle shipped (an OTA lags the server) has no
      // shared words, so it reads by its own name and the state beside it.
      const label = isWaitKind(b.kind) ? waitSubject(b, words) : b.kind;
      const row: BlockerRow = { key: `wait:${b.id}`, kind: b.kind, label, state: b.state, word, cleared };
      return { ...row, ...(pr ? { pr } : {}), ...(waitWordFails(b, { closed, checks }) ? { failing: true as const } : {}) };
    }
    const stateLabel = blockerStateLabel(b);
    if ('missing' in b) return { key: `task:${b.ref}`, kind: 'task', ref: b.ref, status: 'missing', stateLabel, cleared };
    return { key: `task:${b.ref}`, kind: 'task', ref: b.ref, status: b.status, stateLabel, title: titleOf(b.ref), cleared };
  });
}
