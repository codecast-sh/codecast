// Links that do not block (docs/architecture/task-graph.md TG5): the task a
// task was found while working on, the task that replaced it, and see-also
// links. found_during and superseded_by are task short ids on the row;
// related is mirrored on both rows like blocks. Every change writes
// task_history (TG11).
//
// Superseding, marking a duplicate and dropping one all move the old task's
// dependents to the replacement (redirectDependents): a dropped blocker would
// otherwise release them silently.

import { v } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canAccessTask, isSameWorkspace, requireSameWorkspace, workspaceForResource, type AuthorizedWorkspace } from "./lib/access";
import { assertDependencyEdges, dependentRefs, GRAPH_LINK_CAP, openUpstream, requireTaskByRef, taskByRef, taskLookups, writeEdges } from "./lib/taskGraph";
import { bySystem, byUser, recordTaskChange, type TaskChangeBy } from "./lib/taskHistory";
import { patchTask } from "./lib/taskWrite";
import { insertTaskComment, moveTaskStatus, openDirectSubtasks, reconcilePlanMembership, releaseBoundSessions, taskAncestorIds } from "./tasks";
import { cliCaller, isTaskUnblocked, onBlockedAgain, onUnblocked, pendingReleases, releaseDependents, SENDER, tellReleased, unblockBy } from "./taskWaits";
import { isTerminalTaskStatus, parseStoredList, taskBlockerEntries, type StatusOf, type TitledTaskBlocker } from "@codecast/shared/tasks";

/** A linked task as every surface prints it. */
export type LinkRef = { short_id: string; title: string; status: string };

const linkRef = (t: Doc<"tasks">): LinkRef => ({ short_id: t.short_id, title: t.title, status: t.status });

/** Every ref that names `t` in an edge: its short id, or the `_id` a plan's older rows used. */
const refsOf = (t: Doc<"tasks">) => new Set([t.short_id, String(t._id)]);

/** Who a status move is by: a session's agent when it carries a conversation. */
const actorBy = (userId: Id<"users">, conversationId?: Id<"conversations">): TaskChangeBy =>
  conversationId ? { user_id: userId, actor_type: "agent", conversation_id: conversationId } : byUser(userId);

/** How many tasks "found here" lists. */
const FOUND_HERE_LIMIT = 50;

type ReadCtx = Pick<QueryCtx, "db">;
type Ctx = MutationCtx;

/** The name a comment `userId` writes is signed with. */
async function authorName(ctx: ReadCtx, userId: Id<"users">): Promise<string> {
  return (await ctx.db.get(userId))?.name || "unknown";
}

/** Leave a note on a task as `userId`, from `by`'s session, signed by `by`'s
 *  person (codecast's for a system write). */
async function noteOn(ctx: Ctx, userId: Id<"users">, by: TaskChangeBy, taskId: Id<"tasks">, text: string): Promise<void> {
  const author = by.user_id ? await authorName(ctx, by.user_id) : SENDER;
  await insertTaskComment(ctx, taskId, { author, text, comment_type: "note", conversation_id: by.conversation_id }, userId);
}

/** The task `ref` names when it is readable and in `task`'s workspace. A link
 *  out of the workspace is never followed, same as readiness (graphOutside). */
async function readableLink(ctx: ReadCtx, userId: Id<"users">, task: Doc<"tasks">, ref: string | undefined): Promise<Doc<"tasks"> | null> {
  if (!ref) return null;
  const t = await taskByRef(ctx, ref);
  return t && isSameWorkspace(t, workspaceForResource(task)) && (await canAccessTask(ctx, userId, t)) ? t : null;
}

// ---------------------------------------------------------------------------
// found_during
// ---------------------------------------------------------------------------

/**
 * found_during for a task being created. An explicit ref wins ("none" sets
 * nothing); otherwise it is the task the creating session is bound to
 * (conversations.active_task_id), unless the new task is that task's own
 * decomposition: a subtask anywhere under it, or a step of its plan.
 */
export async function foundDuringForCreate(
  ctx: ReadCtx,
  userId: Id<"users">,
  o: {
    explicit?: string;
    conversation?: { active_task_id?: Id<"tasks"> } | null;
    workspace: AuthorizedWorkspace;
    parent_id?: Id<"tasks">;
    plan_id?: Id<"plans">;
  },
): Promise<string | undefined> {
  const explicit = o.explicit?.trim();
  if (explicit) {
    if (explicit.toLowerCase() === "none") return undefined;
    const source = await requireTaskByRef(ctx, userId, explicit);
    requireSameWorkspace(source, o.workspace, "found-during task");
    return source.short_id;
  }
  const bound = o.conversation?.active_task_id;
  if (!bound) return undefined;
  const source = await ctx.db.get(bound);
  // A dropped task is no longer worked on, even while a session is still bound to it.
  if (!source || source.status === "dropped" || !isSameWorkspace(source, o.workspace) || !(await canAccessTask(ctx, userId, source))) return undefined;
  if (o.plan_id && source.plan_id === o.plan_id) return undefined;
  if (o.parent_id && (o.parent_id === source._id || (await taskAncestorIds(ctx, { parent_id: o.parent_id })).includes(String(source._id)))) return undefined;
  return source.short_id;
}

/** What was found while working on `task`, readable by `userId`. */
export async function foundHere(ctx: ReadCtx, userId: Id<"users">, task: Doc<"tasks">): Promise<LinkRef[]> {
  const rows = await ctx.db
    .query("tasks")
    .withIndex("by_found_during", (q) => q.eq("found_during", task.short_id))
    .take(FOUND_HERE_LIMIT);
  const out: LinkRef[] = [];
  for (const t of rows) {
    if (isSameWorkspace(t, workspaceForResource(task)) && (await canAccessTask(ctx, userId, t))) out.push(linkRef(t));
  }
  return out;
}

/** Each task in `blocked_by` as readiness reads it (taskBlockerEntries, under
 *  graphOutside's rule): missing when it is gone, status unknown when it sits
 *  outside the task's workspace, else with its title. Done ones are listed too. */
async function blockerLinks(ctx: ReadCtx, task: Doc<"tasks">): Promise<TitledTaskBlocker[]> {
  const { statusOf } = await taskLookups(ctx, task);
  return taskBlockerEntries(task, statusOf).map(({ blocker: b }): TitledTaskBlocker => {
    const row = "missing" in b ? null : statusOf(b.ref);
    return row && "title" in row ? { ...b, title: (row as Doc<"tasks">).title } : b;
  });
}

/** Every link of `task`, resolved for `userId`, for `cast task show`,
 *  `cast task context` and the web. A link the reader cannot follow is left
 *  out; the raw ids stay on the row. Blocks and related stop at the task
 *  page's cap (GRAPH_LINK_CAP), so both readers list the same tasks. */
export async function taskLinksOf(ctx: ReadCtx, userId: Id<"users">, task: Doc<"tasks">) {
  const one = async (ref: string | undefined) => {
    const t = await readableLink(ctx, userId, task, ref);
    return t ? linkRef(t) : null;
  };
  // A blocks entry is a mirror; it counts only while that task still waits on this one.
  const self = refsOf(task);
  const dependent = async (ref: string) => {
    const t = await readableLink(ctx, userId, task, ref);
    return t && (t.blocked_by ?? []).some((r) => self.has(r)) ? linkRef(t) : null;
  };
  const related = await Promise.all((task.related ?? []).slice(0, GRAPH_LINK_CAP).map(one));
  const blocks = await Promise.all((task.blocks ?? []).slice(0, GRAPH_LINK_CAP).map(dependent));
  return {
    blocked_by: await blockerLinks(ctx, task),
    blocks: blocks.filter((r): r is LinkRef => !!r),
    found_during: await one(task.found_during),
    found_here: await foundHere(ctx, userId, task),
    superseded_by: await one(task.superseded_by),
    related: related.filter((r): r is LinkRef => !!r),
  };
}

// ---------------------------------------------------------------------------
// Moving dependents (supersede, duplicate)
// ---------------------------------------------------------------------------

/** `ref`'s task when it is an open dependent `userId` may move in `workspace`. */
async function movableDependent(ctx: ReadCtx, userId: Id<"users">, ref: string, workspace: AuthorizedWorkspace): Promise<Doc<"tasks"> | null> {
  const d = await taskByRef(ctx, ref);
  return d && isSameWorkspace(d, workspace) && (await canAccessTask(ctx, userId, d)) && !isTerminalTaskStatus(d.status) ? d : null;
}

/** A task dependents are moved onto, with what it waits on (openUpstream). */
type MoveTarget = { ref: string; upstream: ReadonlySet<string> };

/** Rewrite a dependent's blocked_by with its history. When the move adds an
 *  edge to `onto`, a dependent `onto` already waits on would close a loop and
 *  is refused with the path. Returns whether it was unblocked before
 *  (`before` answers for a row whose move already landed). */
async function rewire(
  ctx: Ctx,
  by: TaskChangeBy,
  d: Doc<"tasks">,
  next: string[],
  workspace: AuthorizedWorkspace,
  onto?: MoveTarget,
  before?: StatusOf,
): Promise<boolean> {
  if (onto?.upstream.has(d.short_id)) {
    await assertDependencyEdges(ctx, { short_id: d.short_id, _id: String(d._id), blocked_by: next }, workspace, { blocked_by: [onto.ref] });
  }
  const wasFree = await isTaskUnblocked(ctx, d, before);
  await writeEdges(ctx, d, "blocked_by", next, by);
  return wasFree;
}

/** Tell each rewired dependent whose state the move flipped: released, or
 *  behind open work again (it may have started meanwhile). */
async function tellFlipped(ctx: Ctx, by: TaskChangeBy, rewired: [Id<"tasks">, boolean][], cause: string, waitsOn: string): Promise<void> {
  const who = unblockBy(by, `moved:${cause}@${Date.now()}`);
  for (const [id, wasFree] of rewired) {
    const d = await ctx.db.get(id);
    if (!d) continue;
    const free = await isTaskUnblocked(ctx, d);
    if (free && !wasFree) await onUnblocked(ctx, d, cause, who);
    else if (!free && wasFree) await onBlockedAgain(ctx, d, `${cause}, so it waits on ${waitsOn}`, who);
  }
}

/** Add tasks to a task's blocks mirror (by short id, unless it already
 *  names them in either form: TG4) or remove refs from it, from the row as it
 *  stands now; nothing is written when nothing changes. A system write, so
 *  no access check (patchDepMirror's is for a caller's own edge). */
async function editBlocks(ctx: Ctx, by: TaskChangeBy, taskId: Id<"tasks">, edit: { add: Doc<"tasks">[] } | { remove: Iterable<string> }): Promise<void> {
  const row = await ctx.db.get(taskId);
  if (!row) return;
  const prior = row.blocks ?? [];
  let next: string[];
  if ("add" in edit) {
    next = [...prior];
    for (const t of edit.add) if (!next.some((r) => refsOf(t).has(r))) next.push(t.short_id);
  } else {
    const named = new Set(edit.remove);
    next = prior.filter((r) => !named.has(r));
  }
  await writeEdges(ctx, row, "blocks", next, by);
}

/**
 * Refuse a task as the one others are moved onto (a replacement or a
 * canonical) when it is dropped or was itself replaced: nothing should wait
 * on abandoned work. `verb` finishes the hint, e.g. "supersede with".
 */
export function requireLiveReplacement(t: Doc<"tasks">, verb: string): void {
  const problem = replacementProblem(t, verb);
  if (problem) throw new Error(problem);
}

function replacementProblem(t: Doc<"tasks">, verb: string): string | null {
  // superseded_by only stands on a dropped task (a reopen clears it), but a
  // reopen keeps duplicate_of: open work under a mark still accepts what
  // moves onto it, and hands it on when it is dropped (dropDuplicate).
  const next = t.superseded_by ?? (isTerminalTaskStatus(t.status) ? t.duplicate_of : undefined);
  if (next) return `${t.short_id} was itself ${t.superseded_by ? "superseded by" : "marked a duplicate of"} ${next}; ${verb} that task instead`;
  if (t.status === "dropped") return `${t.short_id} is dropped; ${verb} work that is still going to happen`;
  return null;
}

/**
 * Move every open task waiting on `from` to wait on `to` instead, keeping the
 * blocks mirror on both. Returns the short ids moved; the replacement's own
 * edge to `from` just goes and is not among them. A move that would close a
 * loop (`to` already waits on the dependent) throws with the path, so a
 * person's supersede or duplicate mark is refused rather than half applied.
 * With `onLoop: "leave"` (a drop, which any writer may make and none can
 * answer a loop) that dependent stays on `from` with a note naming the path
 * (or the loop check's cap), and the drop's release tells it as any drop would.
 * `from`'s dependents are dependentRefs; a dependent naming `from` (or `to`)
 * by `_id` counts too, and a mirror entry whose task no longer waits on
 * `from` is dropped. A dependent the move releases (`to` already closed) is
 * told, as a drop of `from` would have told it, and so is one it blocks
 * again (`from` was already dropped). `fromWas` is `from`'s status before a
 * status move that already landed, so a dependent is judged as it stood.
 */
export async function redirectDependents(
  ctx: Ctx,
  userId: Id<"users">,
  by: TaskChangeBy,
  from: Doc<"tasks">,
  to: Doc<"tasks">,
  cause: string,
  o: { fromWas?: string; onLoop?: "refuse" | "leave" } = {},
): Promise<string[]> {
  const workspace = workspaceForResource(from);
  const [fromRefs, toRefs] = [refsOf(from), refsOf(to)];
  const { fromWas } = o;
  const asItStood: StatusOf | undefined = fromWas ? (r) => (fromRefs.has(r) ? { short_id: from.short_id, status: fromWas } : undefined) : undefined;
  const moved: Doc<"tasks">[] = [];
  const rewired: [Id<"tasks">, boolean][] = [];
  const settled = new Set<string>();
  let onto: MoveTarget | undefined;
  for (const ref of await dependentRefs(ctx, from)) {
    const d = await movableDependent(ctx, userId, ref, workspace);
    if (!d) continue;
    const before = d.blocked_by ?? [];
    if (!before.some((r) => fromRefs.has(r))) {
      settled.add(ref);
      continue;
    }
    const rest = before.filter((r) => !fromRefs.has(r));
    const self = d._id === to._id;
    const gains = !self && !rest.some((r) => toRefs.has(r));
    try {
      if (gains) onto ??= { ref: to.short_id, upstream: await openUpstream(ctx, to, workspace) };
      rewired.push([d._id, await rewire(ctx, by, d, gains ? [...rest, to.short_id] : rest, workspace, gains ? onto : undefined, asItStood)]);
    } catch (e) {
      // Refused before any write (a loop, or too much upstream to check one);
      // its mirror entry stays, so the drop releases it.
      if (o.onLoop !== "leave") throw e;
      await noteOn(ctx, userId, by, d._id, `Released from ${from.short_id} rather than moved to ${to.short_id} (${cause}): ${(e as Error).message}`);
      continue;
    }
    settled.add(ref);
    if (!self) moved.push(d);
  }
  await editBlocks(ctx, by, from._id, { remove: settled });
  await editBlocks(ctx, by, to._id, { add: moved });
  await tellFlipped(ctx, by, rewired, cause, to.short_id);
  return moved.map((d) => d.short_id);
}

/** How many of a dependent's newest history rows a reopen reads for the move
 *  it undoes. A move further back than that is left in place. */
const MOVE_HISTORY_SCAN = 200;

/** What a dependent waited on just before the newest move of its edge from
 *  `fromRefs` to `toRefs`, read back from its blocked_by history, and whether
 *  that move is still its newest blocked_by change. */
async function blockersBeforeMove(
  ctx: ReadCtx,
  taskId: Id<"tasks">,
  fromRefs: Set<string>,
  toRefs: Set<string>,
): Promise<{ old: string[]; newest: boolean } | null> {
  const rows = await ctx.db
    .query("task_history")
    .withIndex("by_task_id", (q) => q.eq("task_id", taskId))
    .order("desc")
    .take(MOVE_HISTORY_SCAN);
  let newest = true;
  for (const h of rows) {
    if (h.field !== "blocked_by") continue;
    const [old, next] = [parseStoredList(h.old_value), parseStoredList(h.new_value)];
    if (old.some((r) => fromRefs.has(r)) && !next.some((r) => fromRefs.has(r)) && next.some((r) => toRefs.has(r))) return { old, newest };
    newest = false;
  }
  return null;
}

/**
 * Undo redirectDependents(from -> to) for a task that is back: every open
 * task that move took off `from` waits on it again. It drops `to` only when
 * it did not wait on `to` before the move and nothing has rewired it since:
 * a later move (another duplicate folded into the same canonical) may be why
 * it waits on `to` now, so a doubt keeps the edge. A dependent that never
 * moved, or was rewired by hand off `to` since, is left alone, and so is one
 * whose edge back to `from` would close a loop (it is told). Returns the
 * short ids moved back.
 */
export async function restoreDependents(
  ctx: Ctx,
  userId: Id<"users">,
  by: TaskChangeBy,
  from: Doc<"tasks">,
  to: Doc<"tasks">,
  cause: string,
): Promise<string[]> {
  const workspace = workspaceForResource(from);
  const [fromRefs, toRefs] = [refsOf(from), refsOf(to)];
  const restored: Doc<"tasks">[] = [];
  const leftTo: string[] = [];
  const rewired: [Id<"tasks">, boolean][] = [];
  let onto: MoveTarget | undefined;
  for (const ref of to.blocks ?? []) {
    const d = await movableDependent(ctx, userId, ref, workspace);
    if (!d || d._id === from._id) continue;
    const now = d.blocked_by ?? [];
    if (!now.some((r) => toRefs.has(r)) || now.some((r) => fromRefs.has(r))) continue;
    const before = await blockersBeforeMove(ctx, d._id, fromRefs, toRefs);
    if (!before) continue;
    const keepTo = !before.newest || before.old.some((r) => toRefs.has(r));
    const next = [...(keepTo ? now : now.filter((r) => !toRefs.has(r))), from.short_id];
    let wasFree: boolean;
    try {
      onto ??= { ref: from.short_id, upstream: await openUpstream(ctx, from, workspace) };
      wasFree = await rewire(ctx, by, d, next, workspace, onto);
    } catch (e) {
      // Refused before any write: a reopen never fails on a dependent's loop.
      await noteOn(ctx, userId, by, d._id, `Still waits on ${to.short_id}: ${cause}, but waiting on ${from.short_id} again was refused. ${(e as Error).message}`);
      continue;
    }
    rewired.push([d._id, wasFree]);
    restored.push(d);
    if (!keepTo) leftTo.push(ref);
  }
  await editBlocks(ctx, by, from._id, { add: restored });
  await editBlocks(ctx, by, to._id, { remove: leftTo });
  await tellFlipped(ctx, by, rewired, cause, from.short_id);
  return restored.map((d) => d.short_id);
}

/** Move back what `task`'s `link` moved to the task it names (restoreDependents). */
async function restoreFromLink(ctx: Ctx, userId: Id<"users">, by: TaskChangeBy, task: Doc<"tasks">, link: "superseded_by" | "duplicate_of", cause: string) {
  const ref = task[link];
  const replacement = ref ? await taskByRef(ctx, ref) : null;
  const current = await ctx.db.get(task._id);
  if (!replacement || !current || !(await canAccessTask(ctx, userId, replacement))) return;
  await restoreDependents(ctx, userId, by, current, replacement, cause);
}

/**
 * A superseded or duplicate task was reopened (after the status patch; `task`
 * is the row before it). Its dependents wait on it again, and superseded_by
 * goes, since it would keep the task off every frontier.
 */
async function reopenLinkedTask(ctx: Ctx, task: Doc<"tasks">, userId: Id<"users">, by: TaskChangeBy): Promise<void> {
  if (!task.superseded_by && !task.duplicate_of) return;
  if (task.superseded_by) {
    await ctx.db.patch(task._id, { superseded_by: undefined, updated_at: Date.now() });
    await recordTaskChange(ctx, task._id, by, [["superseded_by", task.superseded_by, ""]]);
    await restoreFromLink(ctx, userId, by, task, "superseded_by", `${task.short_id} was reopened`);
  }
  if (task.duplicate_of) await restoreFromLink(ctx, userId, by, task, "duplicate_of", `${task.short_id} was reopened`);
}

/**
 * A duplicate is dropped: what still waits on it moves to its canonical, as
 * the mark itself did, rather than being released (TG5). That covers a
 * dependent added after the mark and one a reopen gave back. Runs after the
 * status patch and before releaseDependents, which then finds nobody. A
 * canonical that is gone, unreadable, dropped or replaced itself leaves the
 * release to happen, and so does a dependent the move would loop.
 */
async function dropDuplicate(ctx: Ctx, task: Doc<"tasks">, next: string | undefined, userId: Id<"users">, by: TaskChangeBy): Promise<void> {
  if (next !== "dropped" || isTerminalTaskStatus(task.status)) return;
  const current = await ctx.db.get(task._id);
  if (!current?.duplicate_of) return;
  const canonical = await readableLink(ctx, userId, current, current.duplicate_of);
  if (!canonical || canonical._id === current._id || replacementProblem(canonical, "move its dependents to")) return;
  const cause = `${current.short_id} duplicate of ${canonical.short_id}`;
  await redirectDependents(ctx, userId, by, current, canonical, cause, { fromWas: task.status, onLoop: "leave" });
}

/**
 * What a status move does to the tasks around it, for every writer that
 * moves a status (tasks.afterStatusMove and cascadeClose, an issue sync, an
 * org proposal): a dropped duplicate hands its dependents to its canonical
 * (TG5), a close releases the tasks it was the last open blocker of (TG2),
 * and a superseded or duplicate task reopened takes its dependents back
 * (TG5). `task` is the row before the move. A move with nobody behind it (an
 * issue sync) follows the task owner's access and records as the system.
 */
export async function afterStatusEdges(ctx: Ctx, task: Doc<"tasks">, next: string | undefined, release: Parameters<typeof releaseDependents>[3] = {}): Promise<void> {
  if (!next || next === task.status) return;
  const { actorUserId, conversationId } = release;
  const userId = actorUserId ?? task.user_id;
  const by = actorUserId ? actorBy(actorUserId, conversationId) : bySystem;
  await dropDuplicate(ctx, task, next, userId, by);
  await releaseDependents(ctx, task, next, release);
  if (isTerminalTaskStatus(task.status) && !isTerminalTaskStatus(next)) await reopenLinkedTask(ctx, task, userId, by);
}

/** A duplicate mark cleared on a task that stays open takes its dependents
 *  back; one that stays closed leaves them on the canonical, which is still
 *  open work, rather than release them. A reopen in the same write is
 *  reopenLinkedTask's. */
export async function afterDuplicateCleared(ctx: Ctx, userId: Id<"users">, task: Doc<"tasks">, finalStatus: string): Promise<void> {
  if (!task.duplicate_of || isTerminalTaskStatus(task.status) || isTerminalTaskStatus(finalStatus)) return;
  await restoreFromLink(ctx, userId, byUser(userId), task, "duplicate_of", `${task.short_id} is no longer a duplicate of ${task.duplicate_of}`);
}

// ---------------------------------------------------------------------------
// Supersede
// ---------------------------------------------------------------------------

/**
 * Replace `oldRef` with `newRef`: move its dependents to the replacement,
 * set superseded_by, and drop it with a note naming the replacement. A done
 * task is not superseded (its dependents were released by real work); a
 * dropped one can be, which re-blocks its dependents on the replacement and
 * tells each one that was released. Reopening it undoes the move. The
 * replacement may be done (its dependents are then told they are unblocked)
 * but not dropped or itself replaced (requireLiveReplacement). A task already
 * superseded by another is refused: reopen it first.
 */
export async function supersedeCore(
  ctx: Ctx,
  userId: Id<"users">,
  oldRef: string,
  newRef: string,
  note?: string,
  by: TaskChangeBy = byUser(userId),
): Promise<{ short_id: string; superseded_by: string; moved: string[] }> {
  const old = await requireTaskByRef(ctx, userId, oldRef);
  const replacement = await requireTaskByRef(ctx, userId, newRef);
  requireSameWorkspace(replacement, workspaceForResource(old), "replacement task");
  if (old._id === replacement._id) throw new Error("A task can't supersede itself");
  if (old.status === "done") throw new Error(`${old.short_id} is done; supersede replaces work that is still open`);
  requireLiveReplacement(replacement, "supersede with");
  if (old.superseded_by === replacement.short_id) return { short_id: old.short_id, superseded_by: replacement.short_id, moved: [] };
  // Its dependents already wait on the first replacement, and a reopen
  // gives back only what the newest superseded_by moved.
  if (old.superseded_by) throw new Error(`${old.short_id} is already superseded by ${old.superseded_by}; reopen it first, or supersede ${old.superseded_by}`);
  // Dropping a parent never strands its subtasks (guardParentClose's rule).
  const subtasks = await openDirectSubtasks(ctx, old._id);
  if (subtasks.some((c) => c._id === replacement._id)) {
    throw new Error(`${replacement.short_id} is a subtask of ${old.short_id}, the task it would replace; move it to the top level first`);
  }
  if (subtasks.length) {
    throw new Error(`${old.short_id} has open subtasks (${subtasks.map((c) => c.short_id).join(", ")}); move them under ${replacement.short_id} or close them first`);
  }

  const moved = await redirectDependents(ctx, userId, by, old, replacement, `${old.short_id} superseded by ${replacement.short_id}`);
  // Redirect first: the drop below then releases nobody (afterStatusMove).
  const current = (await ctx.db.get(old._id)) ?? old;
  await recordTaskChange(ctx, old._id, by, [["superseded_by", old.superseded_by, replacement.short_id]]);
  await moveTaskStatus(ctx, current, "dropped", {
    actorUserId: userId,
    actorType: by.actor_type,
    conversationId: by.conversation_id,
    extra: { superseded_by: replacement.short_id },
  });
  // A session bound to the old task moves on with it, as a close does.
  await releaseBoundSessions(ctx, old, by.conversation_id);
  const tail = moved.length ? ` Its dependents now wait on it: ${moved.join(", ")}.` : "";
  await noteOn(ctx, userId, by, old._id, `Superseded by ${replacement.short_id}.${note?.trim() ? ` ${note.trim()}` : ""}${tail}`);
  return { short_id: old.short_id, superseded_by: replacement.short_id, moved };
}

// ---------------------------------------------------------------------------
// Related (mirrored)
// ---------------------------------------------------------------------------

/** Add or remove a see-also link on both rows, at most GRAPH_LINK_CAP on a
 *  row (what readers list). Removing tolerates a far side that is gone, and
 *  clears its mirror entry wherever it sits now (another workspace, out of
 *  the caller's reach): only the entry naming `a` goes. */
export async function relateCore(
  ctx: Ctx,
  userId: Id<"users">,
  aRef: string,
  bRef: string,
  op: "add" | "remove",
  by: TaskChangeBy = byUser(userId),
): Promise<{ success: true }> {
  const a = await requireTaskByRef(ctx, userId, aRef);
  const b = op === "add" ? await requireTaskByRef(ctx, userId, bRef) : await taskByRef(ctx, bRef.trim());
  const bId = b?.short_id ?? bRef.trim();
  if (op === "remove" && !(a.related ?? []).includes(bId) && !(b?.related ?? []).includes(a.short_id)) {
    throw new Error(`${a.short_id} is not related to ${bRef.trim()}`);
  }
  if (op === "add") {
    requireSameWorkspace(b!, workspaceForResource(a), "related task");
    if (a._id === b!._id) throw new Error("A task can't relate to itself");
    for (const [t, other] of [[a, b!.short_id], [b!, a.short_id]] as const) {
      const prior = t.related ?? [];
      if (!prior.includes(other) && prior.length >= GRAPH_LINK_CAP) throw new Error(`${t.short_id} already has ${GRAPH_LINK_CAP} related tasks; unrelate one first`);
    }
  }
  const write = async (t: Doc<"tasks">, other: string) => {
    const prior = t.related ?? [];
    const next = op === "add" ? (prior.includes(other) ? prior : [...prior, other]) : prior.filter((r) => r !== other);
    if (next.length === prior.length) return;
    await ctx.db.patch(t._id, { related: next, updated_at: Date.now() });
    await recordTaskChange(ctx, t._id, by, [["related", prior, next]]);
  };
  await write(a, bId);
  if (b) await write(b, a.short_id);
  return { success: true };
}

// ---------------------------------------------------------------------------
// Edges across workspaces
// ---------------------------------------------------------------------------

/**
 * Tasks whose workspace key changed (a conversation's visibility moved:
 * lib/access recomputeWorkspaceForConversation, or the teamScopeSweep
 * reconciler): cut each dependency edge and parent link that now joins two
 * workspaces. Readiness never reads across one (graphOutside), so the
 * dependent would read its blocker as unknown and stay blocked for good, and
 * no release would reach it (releaseDependents); a subtask would read its
 * parent as unknown and never be ready.
 */
export const cutCrossedEdges = internalMutation({
  args: { task_ids: v.array(v.id("tasks")) },
  handler: async (ctx, { task_ids }) => {
    for (const id of task_ids) {
      const task = await ctx.db.get(id);
      if (!task) continue;
      const workspace = workspaceForResource(task);
      for (const ref of task.blocked_by ?? []) {
        const blocker = await taskByRef(ctx, ref);
        if (blocker && !isSameWorkspace(blocker, workspace)) await cutEdge(ctx, task._id, blocker._id);
      }
      for (const ref of await dependentRefs(ctx, task)) {
        const dependent = await taskByRef(ctx, ref);
        if (dependent && !isSameWorkspace(dependent, workspace)) await cutEdge(ctx, dependent._id, task._id);
      }
      const parent = task.parent_id ? await ctx.db.get(task.parent_id) : null;
      if (parent && !isSameWorkspace(parent, workspace)) await cutParent(ctx, task, parent);
      const children = await ctx.db.query("tasks").withIndex("by_parent_id", (q) => q.eq("parent_id", task._id)).collect();
      for (const child of children) if (!isSameWorkspace(child, workspace)) await cutParent(ctx, child, task);
    }
  },
});

/** Return a subtask to the top level, with its history and a note saying
 *  why, and keep its plan's task list in step (reconcilePlanMembership). */
async function cutParent(ctx: Ctx, child: Doc<"tasks">, parent: Doc<"tasks">): Promise<void> {
  const now = Date.now();
  await patchTask(ctx, child, { parent_id: undefined, updated_at: now });
  await recordTaskChange(ctx, child._id, bySystem, [["parent", child.parent_id, ""]], now);
  await reconcilePlanMembership(ctx, child._id, child.plan_id, false);
  if (!isTerminalTaskStatus(child.status)) {
    await insertTaskComment(ctx, child._id, {
      author: SENDER,
      text: `No longer a subtask of ${parent.short_id}: the two tasks are in different workspaces now, so this one could never be ready under it.`,
      comment_type: "note",
    });
  }
}

/** Remove the edge from both rows, with the dependent's history, a note
 *  saying why, and the release a removeDep would tell. */
async function cutEdge(ctx: Ctx, dependentId: Id<"tasks">, blockerId: Id<"tasks">): Promise<void> {
  const [dependent, blocker] = await Promise.all([ctx.db.get(dependentId), ctx.db.get(blockerId)]);
  if (!dependent || !blocker) return;
  const before = dependent.blocked_by ?? [];
  const next = before.filter((r) => !refsOf(blocker).has(r));
  await editBlocks(ctx, bySystem, blocker._id, { remove: refsOf(dependent) });
  if (next.length === before.length) return;
  const now = Date.now();
  const releases = await pendingReleases(ctx, dependent, { blocked_by: next });
  await writeEdges(ctx, dependent, "blocked_by", next, bySystem, now);
  if (!isTerminalTaskStatus(dependent.status)) {
    await insertTaskComment(ctx, dependent._id, {
      author: SENDER,
      text: `No longer waits on ${blocker.short_id}: the two tasks are in different workspaces now, so this one could never see it finish.`,
      comment_type: "note",
    });
  }
  await tellReleased(ctx, releases, bySystem);
}

// ---------------------------------------------------------------------------
// Entry points: CLI (api token), web (dispatch side effects call the cores)
// ---------------------------------------------------------------------------

/** `cast task supersede <old> <new>`. */
export const supersede = mutation({
  args: {
    api_token: v.string(),
    short_id: v.string(),
    by: v.string(),
    note: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await supersedeCore(ctx, userId, args.short_id, args.by, args.note, by);
  },
});

/** `cast task relate <a> <b>`. */
export const relate = mutation({
  args: { api_token: v.string(), short_id: v.string(), other: v.string(), conversation_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await relateCore(ctx, userId, args.short_id, args.other, "add", by);
  },
});

/** `cast task unrelate <a> <b>`. */
export const unrelate = mutation({
  args: { api_token: v.string(), short_id: v.string(), other: v.string(), conversation_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await relateCore(ctx, userId, args.short_id, args.other, "remove", by);
  },
});
