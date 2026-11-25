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
