// Draft writes for the task graph (docs/architecture/task-graph.md TG12): the
// store actions addBlocker/removeBlocker/removeBlocks, addWait/removeWait and
// relateTasks/unrelateTasks paint here, and their same-named side effects in
// convex/dispatch.ts make the real write. A mirrored edge lives on two rows
// (blocked_by on one, blocks on the other; related on both), so both are
// painted in the same draft. Every copy of a row is written: the tasks
// collection can hold a row under its stub key and its real id at once.
import type { TaskWait, WaitTarget } from "@codecast/shared/tasks";

type Rows = Record<string, any>;

/** Every copy of the one task `shortId` names: a LOOKUP, never a list. */
function copiesOf(tasks: Rows, shortId: string): any[] {
  return Object.values(tasks).filter((t) => t?.short_id === shortId);
}

function editList(tasks: Rows, shortId: string, field: string, value: string, on: boolean, now: number): void {
  for (const t of copiesOf(tasks, shortId)) {
    const list: string[] = t[field] ?? [];
    if (list.includes(value) === on) continue;
    t[field] = on ? [...list, value] : list.filter((v) => v !== value);
    t.updated_at = now;
  }
}

/** `shortId` waits on (or stops waiting on) task `blocker`, with its mirror. */
export function setBlockerEdge(tasks: Rows, shortId: string, blocker: string, on: boolean, now = Date.now()): void {
  editList(tasks, shortId, "blocked_by", blocker, on, now);
  editList(tasks, blocker, "blocks", shortId, on, now);
}

/** A see-also link between two tasks, on both rows. */
export function setRelatedEdge(tasks: Rows, a: string, b: string, on: boolean, now = Date.now()): void {
  editList(tasks, a, "related", b, on, now);
  editList(tasks, b, "related", a, on, now);
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

/** A fresh client id for a wait, in the server's id alphabet. */
export function newWaitId(now = Date.now()): string {
  return `w${now.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`;
}

/** Paint a wait as waiting; the server may meet it at once, and its row says so. */
export function addWaitDraft(tasks: Rows, shortId: string, input: TaskWaitInput, createdBy?: string, now = Date.now()): void {
  for (const t of copiesOf(tasks, shortId)) {
    const waits: TaskWait[] = t.waits ?? [];
    if (waits.some((w) => w.id === input.id)) continue;
    const wait = { ...input.target, id: input.id, state: "waiting", created_at: now, ...(createdBy ? { created_by: createdBy } : {}) } as TaskWait;
    t.waits = [...waits, wait];
    t.updated_at = now;
  }
}

export function removeWaitDraft(tasks: Rows, shortId: string, waitId: string, now = Date.now()): void {
  for (const t of copiesOf(tasks, shortId)) {
    if (!(t.waits ?? []).some((w: TaskWait) => w.id === waitId)) continue;
    t.waits = t.waits.filter((w: TaskWait) => w.id !== waitId);
    t.updated_at = now;
  }
}
