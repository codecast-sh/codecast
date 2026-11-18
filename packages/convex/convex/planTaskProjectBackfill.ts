// Sets project_id on open tasks under a plan that sits in a project, for tasks
// created before they inherited the plan's project at create (lib/planFiling).
// A task already in some project keeps it. Dry by default: a dry run counts,
// per workspace, the tasks it would move. `auto` drains page by page and logs
// each page; drive pages by hand to collect the counts.
//   packages/convex/run.sh planTaskProjectBackfill:run '{}'
//   packages/convex/run.sh planTaskProjectBackfill:run '{"dryRun":false,"auto":true}'
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./functions";
import { workspaceForResource } from "./lib/access";
import { workspaceKey } from "./lib/accessKeys";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";

export type PlanTaskBackfillPage = {
  dryRun: boolean;
  plans_scanned: number;
  /** Per workspace key: plans with a project and open tasks moved into it. */
  by_workspace: Record<string, { plans: number; tasks: number }>;
  tasks: number;
  done: boolean;
  cursor: string;
};

export async function backfillPage(
  ctx: { db: any },
  args: { dryRun: boolean; cursor: string | null; numItems: number },
): Promise<PlanTaskBackfillPage> {
  const page = await ctx.db.query("plans").paginate({ cursor: args.cursor, numItems: args.numItems });
  const by_workspace: PlanTaskBackfillPage["by_workspace"] = {};
  let tasks = 0;
  const now = Date.now();
  for (const plan of page.page) {
    if (!plan.project_id) continue;
    const missing = (await ctx.db.query("tasks").withIndex("by_plan_id", (q: any) => q.eq("plan_id", plan._id)).collect())
      .filter((t: any) => !t.project_id && !isTerminalTaskStatus(t.status));
    if (!missing.length) continue;
    const key = workspaceKey(workspaceForResource(plan));
    const slot = (by_workspace[key] ??= { plans: 0, tasks: 0 });
    slot.plans++;
    slot.tasks += missing.length;
    tasks += missing.length;
    if (!args.dryRun) for (const t of missing) await ctx.db.patch(t._id, { project_id: plan.project_id, updated_at: now });
  }
  return { dryRun: args.dryRun, plans_scanned: page.page.length, by_workspace, tasks, done: page.isDone, cursor: page.continueCursor };
}

export const run = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const numItems = args.numItems ?? 100;
    const result = await backfillPage(ctx, { dryRun, cursor: args.cursor ?? null, numItems });
    if (args.auto && !result.done) {
      await ctx.scheduler.runAfter(0, internal.planTaskProjectBackfill.run, { dryRun, numItems, auto: true, cursor: result.cursor });
    }
    console.log(JSON.stringify({ planTaskProjectBackfill: result }));
    return result;
  },
});
