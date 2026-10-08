// Links that do not block (docs/architecture/task-graph.md TG5): the task a
// task was found while working on, the task that replaced it, and see-also
// links. found_during and superseded_by are task short ids on the row;
// related is mirrored on both rows like blocks. Every change writes
// task_history (TG11).
//
// Superseding and marking a duplicate both move the old task's dependents to
// the replacement (redirectDependents): a dropped blocker would otherwise
// release them silently.

import { v } from "convex/values";
import { mutation, type MutationCtx } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { canAccessTask, isSameWorkspace, requireSameWorkspace, workspaceForResource, type AuthorizedWorkspace } from "./lib/access";
import { assertDependencyEdges, dependentRefs, readinessLookups, requireTaskByRef, taskByRef } from "./lib/taskGraph";
import { byUser, recordTaskChange, type TaskChangeBy } from "./lib/taskHistory";
import { insertTaskComment, moveTaskStatus, openDirectSubtasks, taskAncestorIds } from "./tasks";
import { cliCaller, isTaskUnblocked, onBlockedAgain, onUnblocked, unblockBy } from "./taskWaits";
import { isTerminalTaskStatus, parseStoredList, taskBlockerEntries } from "@codecast/shared/tasks";

/** A linked task as every surface prints it. */
export type LinkRef = { short_id: string; title: string; status: string };

const linkRef = (t: Doc<"tasks">): LinkRef => ({ short_id: t.short_id, title: t.title, status: t.status });

/** How many tasks "found here" lists. */
const FOUND_HERE_LIMIT = 50;

type ReadCtx = Pick<QueryCtx, "db">;
type Ctx = MutationCtx;

/** The name a comment `userId` writes is signed with. */
async function authorName(ctx: ReadCtx, userId: Id<"users">): Promise<string> {
  return (await ctx.db.get(userId))?.name || "unknown";
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
  if (!source || !isSameWorkspace(source, o.workspace) || !(await canAccessTask(ctx, userId, source))) return undefined;
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

/** A task in `blocked_by` with its live state, read by readiness's own rule
 *  (graphOutside): `missing` when it is gone, status unknown when it sits
 *  outside the task's workspace. Done ones are listed too. */
export type BlockerLink = LinkRef | { short_id: string; status: string; missing?: true };

async function blockerLinks(ctx: ReadCtx, task: Doc<"tasks">): Promise<BlockerLink[]> {
  const { statusOf } = await readinessLookups(ctx, [task]);
  return taskBlockerEntries(task, statusOf).map(({ blocker: b }): BlockerLink => {
    if ("missing" in b) return { short_id: b.ref, status: "missing", missing: true };
    const row = statusOf(b.ref);
    return row && "title" in row ? linkRef(row as Doc<"tasks">) : { short_id: b.ref, status: b.status };
  });
}

/** Every link of `task`, resolved for `userId`, for `cast task show`,
 *  `cast task context` and the web. A link the reader cannot follow is left
 *  out; the raw ids stay on the row. */
export async function taskLinksOf(ctx: ReadCtx, userId: Id<"users">, task: Doc<"tasks">) {
  const one = async (ref: string | undefined) => {
    const t = await readableLink(ctx, userId, task, ref);
    return t ? linkRef(t) : null;
  };
  const related = await Promise.all((task.related ?? []).map(one));
  const blocks = await Promise.all((task.blocks ?? []).map(one));
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

/** Rewrite a dependent's blocked_by with its history, refusing an edge to
 *  `added` that would close a loop. Returns whether it was unblocked before. */
async function rewire(ctx: Ctx, by: TaskChangeBy, d: Doc<"tasks">, next: string[], workspace: AuthorizedWorkspace, added?: string): Promise<boolean> {
  if (added) await assertDependencyEdges(ctx, { short_id: d.short_id, _id: String(d._id), blocked_by: next }, workspace, { blocked_by: [added] });
  const wasFree = await isTaskUnblocked(ctx, d);
  await ctx.db.patch(d._id, { blocked_by: next, updated_at: Date.now() });
  await recordTaskChange(ctx, d._id, by, [["blocked_by", d.blocked_by ?? [], next]]);
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

const refsOf = (t: Doc<"tasks">) => new Set([t.short_id, String(t._id)]);

/**
 * Refuse a task as the one others are moved onto (a replacement or a
 * canonical) when it is dropped or was itself replaced: nothing should wait
 * on abandoned work. `verb` finishes the hint, e.g. "supersede with".
 */
export function requireLiveReplacement(t: Doc<"tasks">, verb: string): void {
  const next = t.superseded_by ?? t.duplicate_of;
  if (next) throw new Error(`${t.short_id} was itself ${t.superseded_by ? "superseded by" : "marked a duplicate of"} ${next}; ${verb} that task instead`);
  if (t.status === "dropped") throw new Error(`${t.short_id} is dropped; ${verb} work that is still going to happen`);
}

/**
 * Move every open task waiting on `from` to wait on `to` instead, keeping the
 * blocks mirror on both. Returns the short ids moved; the replacement's own
 * edge to `from` just goes and is not among them. A move that would close a
 * loop (`to` already waits on the dependent) throws with the path, so the
 * whole supersede or duplicate write is refused rather than half applied.
 * `from`'s dependents are dependentRefs; a dependent naming `from` (or `to`)
 * by `_id` counts too, and a mirror entry whose task no longer waits on
 * `from` is dropped. A dependent the move releases (`to` already closed) is
 * told, as a drop of `from` would have told it, and so is one it blocks
 * again (`from` was already dropped).
 */
export async function redirectDependents(
  ctx: Ctx,
  userId: Id<"users">,
  by: TaskChangeBy,
  from: Doc<"tasks">,
  to: Doc<"tasks">,
  cause: string,
): Promise<string[]> {
  const workspace = workspaceForResource(from);
  const [fromRefs, toRefs] = [refsOf(from), refsOf(to)];
  const prior = from.blocks ?? [];
  const moved: string[] = [];
  const rewired: [Id<"tasks">, boolean][] = [];
  const settled = new Set<string>();
  for (const ref of await dependentRefs(ctx, from)) {
    const d = await movableDependent(ctx, userId, ref, workspace);
    if (!d) continue;
    settled.add(ref);
    const before = d.blocked_by ?? [];
    if (!before.some((r) => fromRefs.has(r))) continue;
    const rest = before.filter((r) => !fromRefs.has(r));
    const self = d._id === to._id;
    const gains = !self && !rest.some((r) => toRefs.has(r));
    rewired.push([d._id, await rewire(ctx, by, d, gains ? [...rest, to.short_id] : rest, workspace, gains ? to.short_id : undefined)]);
    if (!self) moved.push(d.short_id);
  }
  const kept = prior.filter((r) => !settled.has(r));
  if (kept.length !== prior.length) await ctx.db.patch(from._id, { blocks: kept, updated_at: Date.now() });
  const fresh = (await ctx.db.get(to._id)) ?? to;
  const toBlocks = fresh.blocks ?? [];
  const added = moved.filter((s) => !toBlocks.includes(s));
  if (added.length) await ctx.db.patch(to._id, { blocks: [...toBlocks, ...added], updated_at: Date.now() });
  await tellFlipped(ctx, by, rewired, cause, to.short_id);
  return moved;
}

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
    .collect();
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
  const restored: string[] = [];
  const leftTo: string[] = [];
  const rewired: [Id<"tasks">, boolean][] = [];
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
      wasFree = await rewire(ctx, by, d, next, workspace, from.short_id);
    } catch (e) {
      // Refused before any write: a reopen never fails on a dependent's loop.
      await insertTaskComment(ctx, d._id, {
        author: await authorName(ctx, userId),
        text: `Still waits on ${to.short_id}: ${cause}, but waiting on ${from.short_id} again was refused. ${(e as Error).message}`,
        comment_type: "note",
        conversation_id: by.conversation_id,
      }, userId);
      continue;
    }
    rewired.push([d._id, wasFree]);
    restored.push(d.short_id);
    if (!keepTo) leftTo.push(ref);
  }
  if (restored.length) {
    const fromBlocks = ((await ctx.db.get(from._id)) ?? from).blocks ?? [];
    await ctx.db.patch(from._id, { blocks: [...fromBlocks, ...restored.filter((s) => !fromBlocks.includes(s))], updated_at: Date.now() });
    if (leftTo.length) await ctx.db.patch(to._id, { blocks: (to.blocks ?? []).filter((r) => !leftTo.includes(r)), updated_at: Date.now() });
  }
  await tellFlipped(ctx, by, rewired, cause, from.short_id);
  return restored;
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
 * A superseded or duplicate task was reopened (afterStatusMove, after the
 * status patch; `task` is the row before it). Its dependents wait on it again,
 * and superseded_by goes, since it would keep the task off every frontier.
 */
export async function reopenLinkedTask(ctx: Ctx, task: Doc<"tasks">, userId: Id<"users">, conversationId?: Id<"conversations">): Promise<void> {
  if (!task.superseded_by && !task.duplicate_of) return;
  const by: TaskChangeBy = { user_id: userId, actor_type: conversationId ? "agent" : "user", ...(conversationId ? { conversation_id: conversationId } : {}) };
  if (task.superseded_by) {
    await ctx.db.patch(task._id, { superseded_by: undefined, updated_at: Date.now() });
    await recordTaskChange(ctx, task._id, by, [["superseded_by", task.superseded_by, ""]]);
    await restoreFromLink(ctx, userId, by, task, "superseded_by", `${task.short_id} was reopened`);
  }
  if (task.duplicate_of) await restoreFromLink(ctx, userId, by, task, "duplicate_of", `${task.short_id} was reopened`);
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
  const author = await authorName(ctx, userId);
  const tail = moved.length ? ` Its dependents now wait on it: ${moved.join(", ")}.` : "";
  await insertTaskComment(ctx, old._id, {
    author,
    text: `Superseded by ${replacement.short_id}.${note?.trim() ? ` ${note.trim()}` : ""}${tail}`,
    comment_type: "note",
    conversation_id: by.conversation_id,
  }, userId);
  return { short_id: old.short_id, superseded_by: replacement.short_id, moved };
}

// ---------------------------------------------------------------------------
// Related (mirrored)
// ---------------------------------------------------------------------------

/** Add or remove a see-also link on both rows. Removing tolerates a far side
 *  that is gone or unreadable: that is what removal is for. */
export async function relateCore(
  ctx: Ctx,
  userId: Id<"users">,
  aRef: string,
  bRef: string,
  op: "add" | "remove",
  by: TaskChangeBy = byUser(userId),
): Promise<{ success: true }> {
  const a = await requireTaskByRef(ctx, userId, aRef);
  const b = op === "add" ? await requireTaskByRef(ctx, userId, bRef) : await readableLink(ctx, userId, a, bRef.trim());
  const bId = b?.short_id ?? bRef.trim();
  if (!b && !(a.related ?? []).includes(bId)) throw new Error(`${a.short_id} is not related to ${bRef.trim()}`);
  if (op === "add") {
    requireSameWorkspace(b!, workspaceForResource(a), "related task");
    if (a._id === b!._id) throw new Error("A task can't relate to itself");
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
