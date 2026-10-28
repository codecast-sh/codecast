// Stamps session_decisions.team_id (lib/decisionTeam.ts) on the rows the
// Decisions page and Flows' For you read through by_team_status_created: every
// open decision, and the answered ones asked in the last 14 days (the Answered
// tab reaches back 7 days by answer, so twice that by ask). askCore stamps new
// rows; this covers the ones asked before it did. Dry by default: a dry run
// counts what it would stamp. `auto` drains page by page, open rows then
// answered ones.
//   packages/convex/run.sh decisionTeamBackfill:run '{"auto":true}'
//   packages/convex/run.sh decisionTeamBackfill:run '{"dryRun":false,"auto":true}'
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation } from "./functions";
import { decisionTeamFor } from "./lib/decisionTeam";

const ANSWERED_REACH_MS = 14 * 24 * 60 * 60 * 1000;

export type BackfillPage = { dryRun: boolean; status: "pending" | "answered"; scanned: number; stamped: number; team: number; personal: number; done: boolean; cursor: string };

export async function backfillPage(
  ctx: { db: any },
  args: { dryRun: boolean; status: "pending" | "answered"; since: number; cursor: string | null; numItems: number },
): Promise<BackfillPage> {
  const page = await ctx.db.query("session_decisions")
    .withIndex("by_status_created", (q: any) => (args.status === "pending" ? q.eq("status", "pending") : q.eq("status", "answered").gte("created_at", args.since)))
    .paginate({ cursor: args.cursor, numItems: args.numItems });
  let stamped = 0, team = 0, personal = 0;
  for (const row of page.page as Doc<"session_decisions">[]) {
    const stamp = await decisionTeamFor(ctx, row);
    if (stamp) team++; else personal++;
    if (String(stamp ?? "") === String(row.team_id ?? "")) continue;
    if (!args.dryRun) await ctx.db.patch(row._id, { team_id: stamp });
    stamped++;
  }
  return { dryRun: args.dryRun, status: args.status, scanned: page.page.length, stamped, team, personal, done: page.isDone, cursor: page.continueCursor };
}

export const run = internalMutation({
  args: {
    dryRun: v.optional(v.boolean()),
    status: v.optional(v.union(v.literal("pending"), v.literal("answered"))),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
    since: v.optional(v.number()),
    auto: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const dryRun = args.dryRun ?? true;
    const status = args.status ?? "pending";
    const numItems = args.numItems ?? 200;
    // Fixed on the first page, so every continuation reads the same range.
    const since = args.since ?? Date.now() - ANSWERED_REACH_MS;
    const result = await backfillPage(ctx, { dryRun, status, since, cursor: args.cursor ?? null, numItems });
    if (args.auto) {
      const next = !result.done ? { status, cursor: result.cursor } : status === "pending" ? { status: "answered" as const, cursor: undefined } : null;
      if (next) await ctx.scheduler.runAfter(0, internal.decisionTeamBackfill.run, { dryRun, numItems, since, auto: true, ...next });
    }
    console.log(JSON.stringify({ decisionTeamBackfill: result }));
    return result;
  },
});
