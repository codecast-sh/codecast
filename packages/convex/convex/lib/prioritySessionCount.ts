// A priority's stored session count (prioritiesSchema.ts session_count) when
// one of its sessions is deleted: the priorities pass recounts on its next
// apply, and this keeps the count true until then. Its title and summary may
// tell of the deleted session, so it needs a rewrite before teammates see it.
import type { Id } from "../_generated/dataModel";

export async function dropPrioritySession(ctx: { db: any }, conv: { priority_id?: Id<"priorities"> }): Promise<void> {
  if (!conv.priority_id) return;
  const priority = await ctx.db.get(conv.priority_id);
  if (!priority) return;
  await ctx.db.patch(priority._id, { needs_rewrite: true, ...(priority.session_count ? { session_count: priority.session_count - 1 } : {}) });
}

/** A mapped session changed who can see it: its priority's text may tell of it, so teammates wait for a rewrite. */
export async function flagPriorityRewrite(ctx: { db: any }, conv: { priority_id?: Id<"priorities"> }): Promise<void> {
  if (!conv.priority_id) return;
  const priority = await ctx.db.get(conv.priority_id);
  if (priority && !priority.needs_rewrite) await ctx.db.patch(priority._id, { needs_rewrite: true });
}

/** A session moved between priorities outside a pass (lib/priorityLinks): each stored count follows. One without a count yet is counted on read. */
export async function moveSessionCount(ctx: { db: any }, from: Id<"priorities"> | undefined, to: Id<"priorities"> | undefined): Promise<void> {
  if (String(from ?? "") === String(to ?? "")) return;
  for (const [id, delta] of [[from, -1], [to, 1]] as const) {
    const priority = id ? await ctx.db.get(id) : null;
    if (priority?.session_count !== undefined) await ctx.db.patch(priority._id, { session_count: Math.max(0, priority.session_count + delta) });
  }
}
