// Draft writes for the task graph (docs/architecture/task-graph.md TG12): the
// store actions addBlocker/removeBlocker/removeBlocks, addWait/removeWait and
// relateTasks/unrelateTasks paint here, and their same-named side effects in
// convex/dispatch.ts make the real write. A mirrored edge lives on two rows
// (blocked_by on one, blocks on the other; related on both), so both are
// painted in the same draft. Every copy of a row is written: the tasks
// collection can hold a row under its stub key and its real id at once.
// updated_at is left to the server's echo: a client stamp would be a field
// lock on the collection's version key that the echo never matches.
import type { TaskWait, WaitTarget } from "@codecast/shared/tasks";

type Rows = Record<string, any>;

/** Every copy of the one task `shortId` names: a LOOKUP, never a list. */
function copiesOf(tasks: Rows, shortId: string): any[] {
  return Object.values(tasks).filter((t) => t?.short_id === shortId);
}

function editList(tasks: Rows, shortId: string, field: string, value: string, on: boolean): void {
  for (const t of copiesOf(tasks, shortId)) {
    const list: string[] = t[field] ?? [];
    if (list.includes(value) === on) continue;
    t[field] = on ? [...list, value] : list.filter((v) => v !== value);
  }
}

/** `shortId` waits on (or stops waiting on) task `blocker`, with its mirror. */
export function setBlockerEdge(tasks: Rows, shortId: string, blocker: string, on: boolean): void {
  editList(tasks, shortId, "blocked_by", blocker, on);
  editList(tasks, blocker, "blocks", shortId, on);
}

/** The edge removed from the blocker's side: an older plan row names the
 *  blocker in `blocked_by` by its `_id`, which goes too (as removeDepCore does). */
export function removeBlocksEdge(tasks: Rows, blocker: string, dependent: string): void {
  setBlockerEdge(tasks, dependent, blocker, false);
  for (const b of copiesOf(tasks, blocker)) editList(tasks, dependent, "blocked_by", String(b._id), false);
}

/** A see-also link between two tasks, on both rows. */
export function setRelatedEdge(tasks: Rows, a: string, b: string, on: boolean): void {
  editList(tasks, a, "related", b, on);
  editList(tasks, b, "related", a, on);
}

/** What the web sends to set a wait: the client's id for it (so the synced
 *  row replaces the painted one) and its target as parsed. A bare `#42`
 *  carries an empty repository, which the server resolves from the task. */
export type TaskWaitInput = { id: string; target: WaitTarget };

/** What a wait waits on, without its lifecycle: how a removed wait is set again. */
export function waitTargetOf(w: TaskWait): WaitTarget {
  if (w.kind === "decision") return { kind: w.kind, decision: w.decision };
  if (w.kind === "time") return { kind: w.kind, at: w.at };
  return { kind: w.kind, repository: w.repository, pr_number: w.pr_number };
}

/** Paint a wait as waiting; the server may meet it at once, and its row says
 *  so. `waits` is unprotected (clientSyncRegistry): the server stamps its own
 *  created_at and resolves the target, so its set replaces this one. */
export function addWaitDraft(tasks: Rows, shortId: string, input: TaskWaitInput, createdBy?: string, now = Date.now()): void {
  for (const t of copiesOf(tasks, shortId)) {
    const waits: TaskWait[] = t.waits ?? [];
    if (waits.some((w) => w.id === input.id)) continue;
    const wait = { ...input.target, id: input.id, state: "waiting", created_at: now, ...(createdBy ? { created_by: createdBy } : {}) } as TaskWait;
    t.waits = [...waits, wait];
  }
}

export function removeWaitDraft(tasks: Rows, shortId: string, waitId: string): void {
  for (const t of copiesOf(tasks, shortId)) {
    if (!(t.waits ?? []).some((w: TaskWait) => w.id === waitId)) continue;
    t.waits = t.waits.filter((w: TaskWait) => w.id !== waitId);
  }
}
