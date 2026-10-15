// Model spend by project and hour (momentsSchema model_spend_hours). Every
// call settles here beside the team's budget, charged to the projects it
// served, so a project reads its own model spend rather than its workspace's
// month. A leaf: modelCalls and lineTrial both import it.

import type { Doc, Id } from "../_generated/dataModel";
import type { BudgetPurpose } from "@codecast/shared/contracts/modelCall";

export const HOUR_MS = 3_600_000;
const billionths = (n: number) => Math.round(n * 1e9) / 1e9;

/** Charges one call's cost to the hour it settled in, split evenly among the projects it served (none: one unattributed row). */
export async function recordModelSpend(ctx: { db: any }, workspace: string, projectIds: readonly Id<"projects">[], purpose: BudgetPurpose, usd: number, now: number, calls = 1): Promise<void> {
  if (!(usd > 0) && !calls) return;
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const targets: Array<Id<"projects"> | undefined> = projectIds.length ? [...new Set(projectIds)] : [undefined];
  const share = usd / targets.length;
  for (const project_id of targets) {
    const row: Doc<"model_spend_hours"> | null = await ctx.db
      .query("model_spend_hours")
      .withIndex(project_id ? "by_project_hour" : "by_workspace_hour", (q: any) => (project_id ? q.eq("project_id", project_id).eq("hour", hour) : q.eq("workspace", workspace).eq("hour", hour)))
      .filter((q: any) => (project_id ? q.eq(q.field("workspace"), workspace) : q.eq(q.field("project_id"), undefined)))
      .first();
    if (row) {
      await ctx.db.patch(row._id, { usd: billionths(row.usd + share), calls: row.calls + calls, by_purpose: { ...row.by_purpose, [purpose]: billionths(row.by_purpose[purpose] + share) } });
    } else {
      await ctx.db.insert("model_spend_hours", {
        workspace,
        ...(project_id ? { project_id } : {}),
        hour,
        usd: billionths(share),
        calls,
        by_purpose: { judge: 0, grouping: 0, call: 0, [purpose]: billionths(share) },
      });
    }
  }
}

/** A project's model spend from the hour holding `since` on, by purpose. */
export async function projectModelSpend(ctx: { db: any }, projectId: Id<"projects">, since: number): Promise<{ usd: number; calls: number; by_purpose: Record<BudgetPurpose, number>; first_hour: number | null }> {
  const rows: Doc<"model_spend_hours">[] = await ctx.db
    .query("model_spend_hours")
    .withIndex("by_project_hour", (q: any) => q.eq("project_id", projectId).gte("hour", Math.floor(since / HOUR_MS) * HOUR_MS))
    .collect();
  const by_purpose: Record<BudgetPurpose, number> = { judge: 0, grouping: 0, call: 0 };
  let usd = 0;
  let calls = 0;
  for (const r of rows) {
    usd += r.usd;
    calls += r.calls;
    for (const p of Object.keys(by_purpose) as BudgetPurpose[]) by_purpose[p] += r.by_purpose[p];
  }
  return { usd, calls, by_purpose, first_hour: rows.length ? Math.min(...rows.map((r) => r.hour)) : null };
}
