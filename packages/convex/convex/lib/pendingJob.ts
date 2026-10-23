import type { Id } from "../_generated/dataModel";

/** A scheduled job while it has not started; null once it ran, failed or was canceled. */
export async function pendingJob(
  ctx: { db: any },
  id: Id<"_scheduled_functions"> | undefined,
): Promise<{ scheduledTime: number } | null> {
  if (!id) return null;
  const job = await ctx.db.system.get(id);
  return job?.state?.kind === "pending" ? job : null;
}
