// Records the deploys personal flow runs made before their end recorded them
// (lib/runDeploy.ts, deploys.md DP11): every ended run in a `user:` workspace,
// by the same rule, through the same function, the run's end applies
// (runDeploys.record). A run whose recorded deploy no longer matches how it
// ended (it was resumed) has that deploy updated. Dry by default: a dry run counts what
// it would record. Idempotent: a run that already has its deploy is counted and
// left. No deploy trigger fires for what it records. `auto` drains page by page.
//   packages/convex/run.sh personalDeploysBackfill:run '{"auto":true}'
//   packages/convex/run.sh personalDeploysBackfill:run '{"dryRun":false,"auto":true}'
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./functions";
import { recordRunDeploy } from "./lib/runDeploy";

export type PersonalDeploysPage = {
  dryRun: boolean;
  scanned: number;
  live: number;
  failed: number;
  already: number;
  updated: number;
  landed: number;
  no_repository: number;
  team_repository: number;
  other: number;
  done: boolean;
  cursor: string;
};

export async function backfillPage(ctx: { db: any }, args: { dryRun: boolean; cursor: string | null; numItems: number }): Promise<PersonalDeploysPage> {
  // Every `user:` key sorts between "user:" and "user;" (the next character).
  const page = await ctx.db.query("workflow_runs")
    .withIndex("by_workspace_updated", (q: any) => q.gt("workspace", "user:").lt("workspace", "user;"))
    .paginate({ cursor: args.cursor, numItems: args.numItems });
  const out = { live: 0, failed: 0, already: 0, updated: 0, landed: 0, no_repository: 0, team_repository: 0, other: 0 };
  for (const run of page.page as Doc<"workflow_runs">[]) {
    if (run.status !== "completed" && run.status !== "failed") continue;
    const r = await recordRunDeploy(ctx, run, { dry: args.dryRun, quiet: true });
    if ("recorded" in r) out[r.recorded]++;
    else if ("already" in r) out.already++;
    else if ("updated" in r) out.updated++;
    else if (r.skipped === "landed") out.landed++;
    else if (r.skipped === "no repository") out.no_repository++;
    else if (r.skipped === "team repository") out.team_repository++;
    else out.other++;
  }
  return { dryRun: args.dryRun, scanned: page.page.length, ...out, done: page.isDone, cursor: page.continueCursor };
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
    // Each recorded run reads its workspace's recent deploys and merges: a small page keeps a call under its read limit.
    const numItems = args.numItems ?? 50;
    const result = await backfillPage(ctx, { dryRun, cursor: args.cursor ?? null, numItems });
    if (args.auto && !result.done) await ctx.scheduler.runAfter(0, internal.personalDeploysBackfill.run, { dryRun, numItems, cursor: result.cursor, auto: true });
    console.log(JSON.stringify({ personalDeploysBackfill: result }));
    return result;
  },
});
