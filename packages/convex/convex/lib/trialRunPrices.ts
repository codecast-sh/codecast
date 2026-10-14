import type { Id } from "../_generated/dataModel";

/**
 * A trial run's price row, opened when the run is created so the trial's run
 * count (max_runs) is exact before the run is ever priced
 * (lineTrial.priceRunsTick prices it). A leaf so workflow_runs can call it.
 */
export async function openRunPrice(ctx: { db: any }, run_id: Id<"workflow_runs">, project_id: Id<"projects">, run_created_at: number): Promise<void> {
  const had = await ctx.db.query("trial_run_prices").withIndex("by_run", (q: any) => q.eq("run_id", run_id)).first();
  if (had) return;
  await ctx.db.insert("trial_run_prices", { project_id, run_id, run_created_at, sessions: 0, usd: 0, tokens: 0, unpriced_tokens: 0, at: 0, settled: false });
}
