// The one writer of a task's dependency edges. Kept out of lib/taskGraph.ts,
// which convex/functions.ts reaches (lib/parkedWake): a write that gains a
// dependent escalates the cards on its blocker (lib/cardWaiters), whose push
// goes through notificationRouter, a module that defines functions at load.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { bySystem, recordTaskChange, type TaskChangeBy } from "./taskHistory";
import { canAccessTask, isSameWorkspace, type AuthorizedWorkspace } from "./access";
import { escalateCardsOnTask } from "./cardWaiters";
import { taskByRef } from "./taskGraph";

/**
 * Set a task's blocked_by or blocks to `next` and stamp updated_at. A
 * blocked_by change is the task's own history (TG11); blocks only mirrors
 * other rows' blocked_by and records none. `task` is the row as read before
 * the write; a `next` it already holds writes nothing. Every edge any writer
 * adds ends here (an insert's blocked_by gets its blocks mirror here), so this
 * is where a task gaining a dependent escalates the open cards on it: on the
 * task whose blocks grew, or on each task blocked_by newly names. Whichever
 * side is written last sees both, and a repeat changes nothing.
 */
export async function writeEdges(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  task: Pick<Doc<"tasks">, "_id" | "blocked_by" | "blocks">,
  field: "blocked_by" | "blocks",
  next: string[],
  by: TaskChangeBy,
  now = Date.now(),
): Promise<void> {
  const prev = task[field] ?? [];
  if (prev.length === next.length && prev.every((r, i) => r === next[i])) return;
  await ctx.db.patch(task._id, { [field]: next, updated_at: now });
  if (field === "blocked_by") await recordTaskChange(ctx, task._id, by, [["blocked_by", prev, next]], now);
  const added = next.filter((r) => !prev.includes(r));
  if (!added.length) return;
  if (field === "blocks") return await escalateCardsOnTask(ctx, task._id, now);
  for (const ref of added) {
    const blocker = await taskByRef(ctx, ref);
    if (blocker) await escalateCardsOnTask(ctx, blocker._id, now);
  }
}

// create and update accept blocked_by/blocks as raw arrays, and plans
// insert whole graphs (createFromTemplate, fork); each accepted edge must
// also land on the referenced task's other side or the stored mirror drifts
// (addDep/removeDep already keep it for single edges). Same
// short-id resolution addDep uses, but an unresolvable, inaccessible or
// cross-workspace reference skips the mirror instead of rejecting a write
// the caller already made. The mirror may name `self` by its `_id` (a plan's
// older rows): that form is the same edge, so it is never added twice and
// is removed with the short id.
export async function patchDepMirror(
  ctx: any,
  userId: Id<"users">,
  self: { short_id: string; _id?: string; workspace: AuthorizedWorkspace },
  otherRef: string,
  mirrorField: "blocks" | "blocked_by",
  op: "add" | "remove",
  // Who made the edit: a blocked_by mirror is the other task's own history (TG11).
  by?: TaskChangeBy,
) {
  const other = await taskByRef(ctx, otherRef);
  if (!other || !(await canAccessTask(ctx, userId, other))) return;
  if (op === "add" && !isSameWorkspace(other, self.workspace)) return;
  const mirror: string[] = other[mirrorField] || [];
  const isSelf = (id: string) => id === self.short_id || (!!self._id && id === self._id);
  if (op === "add" ? mirror.some(isSelf) : !mirror.some(isSelf)) return;
  const next = op === "add"
    ? [...mirror, self.short_id]
    : mirror.filter((id: string) => !isSelf(id));
  await writeEdges(ctx, other, mirrorField, next, by ?? bySystem);
}
