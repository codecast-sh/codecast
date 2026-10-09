// Draft writes for the task graph (docs/architecture/task-graph.md TG12): the
// store actions addBlocker/removeBlocker/removeBlocks, addWait/removeWait and
// relateTasks/unrelateTasks paint here, and their same-named side effects in
// convex/dispatch.ts make the real write. A mirrored edge lives on two rows
// (blocked_by on one, blocks on the other; related on both), so both are
// painted in the same draft. Every copy of a row is written: the tasks
// collection can hold a row under its stub key and its real id at once.
// updated_at is left to the server's echo: a client stamp would be a field
// lock on the collection's version key that the echo never matches.
import { sameWaitTarget, waitIsReplaceable, type TaskWait, type WaitTarget } from "@codecast/shared/tasks";

type Rows = Record<string, any>;

/** Every copy of the one task `shortId` names: the collection can hold the
 *  same row under its optimistic stub key and its real `_id` at once, so a
 *  `lookup` by one ref would miss the other. Scoped to one id, so this is not
 *  the collection enumeration `useWorkspaceCollection` owns. */
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

/** `shortId` stops waiting on `blocker` under every form `blocked_by` names
 *  it by: `forms` (what the row lists, when the store lacks the blocker) and
 *  the short id and `_id` of any row the store holds for it. The server's
 *  removeDepCore drops every form on the one call. */
export function removeBlockerEdge(tasks: Rows, shortId: string, blocker: string, forms: readonly string[] = []): void {
  const all = new Set([blocker, ...forms]);
  for (const t of Object.values(tasks)) {
    if (t && (all.has(t.short_id) || all.has(String(t._id)))) all.add(t.short_id).add(String(t._id));
  }
  for (const f of all) setBlockerEdge(tasks, shortId, f, false);
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

/** Whether wait `w` is on `target`, deliberately stricter than the server's
 *  `sameWaitTarget` (which addWaitCore uses alone, and under which an empty
 *  repository matches that number in any repository): a bare `#42` matches
 *  only another unresolved `#42`, because which repository it names is the
 *  server's to say. Being stricter only ever paints a wait the server may
 *  refuse, and addWaitCore refuses a wait carrying a client id that lands on
 *  an existing one, so the draft rolls back instead of holding a copy. */
export function waitIsOn(w: TaskWait, target: WaitTarget): boolean {
  const bare = (t: WaitTarget) => "repository" in t && !t.repository;
  return bare(w) === bare(target) && sameWaitTarget(w, target);
}

/** A wait painted before the server checked it, holding the replaceable
 *  waits it took the place of until the server's set replaces it. */
type PaintedWait = TaskWait & { displaced?: TaskWait[] };

/** Paint a wait as waiting, in place of a replaceable one on the same target
 *  (waitIsReplaceable, addWaitCore's rule); the server may meet it at once,
 *  and its row says so. `waits` is unprotected (clientSyncRegistry): the server stamps its own
 *  created_at and resolves the target, so its set replaces this one. */
export function addWaitDraft(tasks: Rows, shortId: string, input: TaskWaitInput, createdBy?: string, now = Date.now()): void {
  for (const t of copiesOf(tasks, shortId)) {
    const waits: TaskWait[] = t.waits ?? [];
    if (waits.some((w) => w.id === input.id)) continue;
    const displaced = waits.filter((w) => waitIsReplaceable(w) && waitIsOn(w, input.target));
    const wait: PaintedWait = {
      ...input.target, id: input.id, state: "waiting", created_at: now,
      ...(createdBy ? { created_by: createdBy } : {}),
      ...(displaced.length ? { displaced } : {}),
    } as PaintedWait;
    t.waits = [...waits.filter((w) => !displaced.includes(w)), wait];
  }
}

/** The server refused wait `waitId`: take the painted one off and put back
 *  what it displaced. Nothing changes once the server's set has replaced it,
 *  since a refused id never reaches that set. */
export function rollbackWaitDraft(tasks: Rows, shortId: string, waitId: string): void {
  for (const t of copiesOf(tasks, shortId)) {
    const waits: PaintedWait[] = t.waits ?? [];
    const painted = waits.find((w) => w.id === waitId);
    if (!painted) continue;
    const back = (painted.displaced ?? []).filter((d) => !waits.some((w) => w.id === d.id));
    t.waits = [...waits.filter((w) => w !== painted), ...back];
  }
}

export function removeWaitDraft(tasks: Rows, shortId: string, waitId: string): void {
  for (const t of copiesOf(tasks, shortId)) {
    if (!(t.waits ?? []).some((w: TaskWait) => w.id === waitId)) continue;
    t.waits = t.waits.filter((w: TaskWait) => w.id !== waitId);
  }
}
