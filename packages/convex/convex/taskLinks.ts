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
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { canAccessTask, isSameWorkspace, requireSameWorkspace, resolveSessionConversation, workspaceForResource, type AuthorizedWorkspace } from "./lib/access";
import { notFound } from "./lib/auth";
import { assertDependencyEdges, taskByRef } from "./lib/taskGraph";
import { recordTaskChange, type TaskChangeBy } from "./lib/taskHistory";
import { insertTaskComment, moveTaskStatus, openDirectSubtasks, taskAncestorIds } from "./tasks";
import { isTaskUnblocked, onUnblocked } from "./taskWaits";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";

/** A linked task as every surface prints it. */
export type LinkRef = { short_id: string; title: string; status: string };

const linkRef = (t: Doc<"tasks">): LinkRef => ({ short_id: t.short_id, title: t.title, status: t.status });

/** How many tasks "found here" lists. */
const FOUND_HERE_LIMIT = 50;

/** The task `ref` names, when `userId` may read it; not found otherwise. */
async function requireLinkTask(ctx: any, userId: Id<"users">, ref: string): Promise<Doc<"tasks">> {
  const t = await taskByRef(ctx, ref.trim());
  if (!t || !(await canAccessTask(ctx, userId, t))) notFound(`Task not found: ${ref}`);
  return t!;
}

/** The task `ref` names when it is readable and in `task`'s workspace. A link
 *  out of the workspace is never followed, same as readiness (graphOutside). */
async function readableLink(ctx: any, userId: Id<"users">, task: Doc<"tasks">, ref: string | undefined): Promise<Doc<"tasks"> | null> {
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
  ctx: any,
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
    const source = await requireLinkTask(ctx, userId, explicit);
    requireSameWorkspace(source, o.workspace, "found-during task");
    return source.short_id;
  }
  const bound = o.conversation?.active_task_id;
  if (!bound) return undefined;
  const source: Doc<"tasks"> | null = await ctx.db.get(bound);
  if (!source || !isSameWorkspace(source, o.workspace) || !(await canAccessTask(ctx, userId, source))) return undefined;
  if (o.plan_id && source.plan_id === o.plan_id) return undefined;
  if (o.parent_id && (o.parent_id === source._id || (await taskAncestorIds(ctx, { parent_id: o.parent_id })).includes(String(source._id)))) return undefined;
  return source.short_id;
}

/** What was found while working on `task`, readable by `userId`. */
export async function foundHere(ctx: any, userId: Id<"users">, task: Doc<"tasks">): Promise<LinkRef[]> {
  const rows: Doc<"tasks">[] = await ctx.db
    .query("tasks")
    .withIndex("by_found_during", (q: any) => q.eq("found_during", task.short_id))
    .take(FOUND_HERE_LIMIT);
  const out: LinkRef[] = [];
  for (const t of rows) {
    if (isSameWorkspace(t, workspaceForResource(task)) && (await canAccessTask(ctx, userId, t))) out.push(linkRef(t));
  }
  return out;
}

/** Every link of `task`, resolved for `userId`, for `cast task show`,
 *  `cast task context` and the web. A link the reader cannot follow is left
 *  out; the raw ids stay on the row. */
export async function taskLinksOf(ctx: any, userId: Id<"users">, task: Doc<"tasks">) {
  const one = async (ref: string | undefined) => {
    const t = await readableLink(ctx, userId, task, ref);
    return t ? linkRef(t) : null;
  };
  const related = await Promise.all((task.related ?? []).map(one));
  return {
    found_during: await one(task.found_during),
    found_here: await foundHere(ctx, userId, task),
    superseded_by: await one(task.superseded_by),
    related: related.filter((r): r is LinkRef => !!r),
  };
}

// ---------------------------------------------------------------------------
// Moving dependents (supersede, duplicate)
// ---------------------------------------------------------------------------

/**
 * Move every open task waiting on `from` to wait on `to` instead, keeping the
 * blocks mirror on both. Returns the short ids moved; the replacement's own
 * edge to `from` just goes and is not among them. A move that would close a
 * loop (`to` already waits on the dependent) throws with the path, so the
 * whole supersede or duplicate write is refused rather than half applied.
 * `from`'s dependents come from its blocks mirror, which create, update and
 * addDep keep; a dependent naming `from` by `_id` (a plan's older rows) moves
 * too, and a mirror entry whose task no longer waits on `from` is dropped.
 * A dependent the move leaves unblocked (`to` already closed, or `to` itself
 * losing its last blocker) is told, as a drop of `from` would have told it.
 */
export async function redirectDependents(
  ctx: any,
  userId: Id<"users">,
  by: TaskChangeBy,
  from: Doc<"tasks">,
  to: Doc<"tasks">,
  cause: string,
): Promise<string[]> {
  const workspace = workspaceForResource(from);
  const fromRefs = new Set([from.short_id, String(from._id)]);
  const prior = from.blocks ?? [];
  const moved: string[] = [];
  const touched: Id<"tasks">[] = [];
  const kept: string[] = [];
  for (const ref of prior) {
    const d = await taskByRef(ctx, ref);
    if (!d || !isSameWorkspace(d, workspace) || !(await canAccessTask(ctx, userId, d)) || isTerminalTaskStatus(d.status)) {
      kept.push(ref);
      continue;
    }
    const before = d.blocked_by ?? [];
    if (!before.some((r) => fromRefs.has(r))) continue;
    const rest = before.filter((r) => !fromRefs.has(r));
    const self = d._id === to._id;
    const next = self || rest.includes(to.short_id) ? rest : [...rest, to.short_id];
    if (next.includes(to.short_id) && !before.includes(to.short_id)) {
      await assertDependencyEdges(ctx, { short_id: d.short_id, _id: String(d._id), blocked_by: next }, workspace, { blocked_by: [to.short_id] });
    }
    await ctx.db.patch(d._id, { blocked_by: next, updated_at: Date.now() });
    await recordTaskChange(ctx, d._id, by, [["blocked_by", before, next]]);
    touched.push(d._id);
    if (!self) moved.push(d.short_id);
  }
  if (kept.length !== prior.length) await ctx.db.patch(from._id, { blocks: kept, updated_at: Date.now() });
  const fresh: Doc<"tasks"> = (await ctx.db.get(to._id)) ?? to;
  const toBlocks = fresh.blocks ?? [];
  const added = moved.filter((s) => !toBlocks.includes(s));
  if (added.length) await ctx.db.patch(to._id, { blocks: [...toBlocks, ...added], updated_at: Date.now() });
  // An open `from` was blocking each of them, so unblocked now means released.
  if (!isTerminalTaskStatus(from.status)) {
    for (const id of touched) {
      const d: Doc<"tasks"> | null = await ctx.db.get(id);
      if (d && (await isTaskUnblocked(ctx, d))) await onUnblocked(ctx, d, cause);
    }
  }
  return moved;
}

// ---------------------------------------------------------------------------
// Supersede
// ---------------------------------------------------------------------------

/**
 * Replace `oldRef` with `newRef`: move its dependents to the replacement,
 * set superseded_by, and drop it with a note naming the replacement. A done
 * task is not superseded (its dependents were released by real work); a
 * dropped one can be, which re-blocks its dependents on the replacement. The
 * replacement may be done (its dependents are then told they are unblocked)
 * but not dropped: nothing should wait on abandoned work.
 */
export async function supersedeCore(
  ctx: any,
  userId: Id<"users">,
  by: TaskChangeBy,
  oldRef: string,
  newRef: string,
  note?: string,
): Promise<{ short_id: string; superseded_by: string; moved: string[] }> {
  const old = await requireLinkTask(ctx, userId, oldRef);
  const replacement = await requireLinkTask(ctx, userId, newRef);
  requireSameWorkspace(replacement, workspaceForResource(old), "replacement task");
  if (old._id === replacement._id) throw new Error("A task can't supersede itself");
  if (old.status === "done") throw new Error(`${old.short_id} is done; supersede replaces work that is still open`);
  if (replacement.superseded_by) {
    throw new Error(`${replacement.short_id} was itself superseded by ${replacement.superseded_by}; supersede with that task instead`);
  }
  if (replacement.status === "dropped") throw new Error(`${replacement.short_id} is dropped; supersede with work that is still going to happen`);
  if (old.superseded_by === replacement.short_id) return { short_id: old.short_id, superseded_by: replacement.short_id, moved: [] };
  // Dropping a parent never strands its subtasks (guardParentClose's rule).
  const subtasks = await openDirectSubtasks(ctx, old._id);
  if (subtasks.length) {
    throw new Error(`${old.short_id} has open subtasks (${subtasks.map((c) => c.short_id).join(", ")}); move them under ${replacement.short_id} or close them first`);
  }

  const moved = await redirectDependents(ctx, userId, by, old, replacement, `${old.short_id} superseded by ${replacement.short_id}`);
  // Redirect first: the drop below then releases nobody (afterStatusMove).
  const current: Doc<"tasks"> = (await ctx.db.get(old._id)) ?? old;
  await recordTaskChange(ctx, old._id, by, [["superseded_by", old.superseded_by, replacement.short_id]]);
  await moveTaskStatus(ctx, current, "dropped", {
    actorUserId: userId,
    actorType: by.actor_type,
    conversationId: by.conversation_id,
    extra: { superseded_by: replacement.short_id },
  });
  const author = (await ctx.db.get(userId))?.name || "unknown";
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
  ctx: any,
  userId: Id<"users">,
  by: TaskChangeBy,
  aRef: string,
  bRef: string,
  op: "add" | "remove",
): Promise<{ success: true }> {
  const a = await requireLinkTask(ctx, userId, aRef);
  const b = op === "add" ? await requireLinkTask(ctx, userId, bRef) : await readableLink(ctx, userId, a, bRef.trim());
  const bId = b?.short_id ?? bRef.trim();
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

async function cliCaller(ctx: any, args: { api_token: string; conversation_id?: string }) {
  const auth = await verifyApiToken(ctx, args.api_token);
  if (!auth) throw new Error("Unauthorized");
  const conv = args.conversation_id ? await resolveSessionConversation(ctx, auth.userId, args.conversation_id) : null;
  const by: TaskChangeBy = { user_id: auth.userId, actor_type: "user", ...(conv ? { conversation_id: conv._id } : {}) };
  return { userId: auth.userId as Id<"users">, by };
}

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
    return await supersedeCore(ctx, userId, by, args.short_id, args.by, args.note);
  },
});

/** `cast task relate <a> <b>`. */
export const relate = mutation({
  args: { api_token: v.string(), short_id: v.string(), other: v.string(), conversation_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await relateCore(ctx, userId, by, args.short_id, args.other, "add");
  },
});

/** `cast task unrelate <a> <b>`. */
export const unrelate = mutation({
  args: { api_token: v.string(), short_id: v.string(), other: v.string(), conversation_id: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { userId, by } = await cliCaller(ctx, args);
    return await relateCore(ctx, userId, by, args.short_id, args.other, "remove");
  },
});

/** The task page's "Found here" list. Enrich only: the page renders without it. */
export const webFoundHere = query({
  args: { short_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const task = await taskByRef(ctx, args.short_id);
    if (!task || !(await canAccessTask(ctx, userId, task))) return [];
    return await foundHere(ctx, userId, task);
  },
});
