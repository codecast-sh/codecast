// A priority's stored session count (prioritiesSchema.ts session_count) when
// one of its sessions is deleted: the priorities pass recounts on its next
// apply, and this keeps the count true until then.
import type { Id } from "../_generated/dataModel";

export async function dropPrioritySession(ctx: { db: any }, conv: { priority_id?: Id<"priorities"> }): Promise<void> {
  if (!conv.priority_id) return;
  const priority = await ctx.db.get(conv.priority_id);
  if (priority?.session_count) await ctx.db.patch(priority._id, { session_count: priority.session_count - 1 });
}
