import type { Id } from "../_generated/dataModel";

/** Whether an experiment is switched on for this person (users.experiments). */
export async function hasExperiment(
  ctx: { db: any },
  userId: Id<"users">,
  name: string,
): Promise<boolean> {
  const user = await ctx.db.get(userId);
  return !!user?.experiments?.includes(name);
}
