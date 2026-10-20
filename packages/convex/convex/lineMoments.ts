// The moment a codecast judge read, for the line app (line-workspace.md LW1,
// learning-loop.md LL8): a finding carries its moment (mo-N), and the web
// shows that moment with every judge's run on it, and its kept body. The
// viewer reads a moment when its workspace key grants them access; the CLI's
// reads (moments.ts showForCli, bodyForCli) resolve a workspace instead.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { workspaceGrantsAccess } from "./lib/access";
import { judgeRunRow, liveBodyKey, momentRefs, momentView, readKeptBody, type JudgeRunRow } from "./lib/momentBody";
import type { MomentRecord } from "@codecast/shared/contracts/moments";

/** The moment `ref` names, when this viewer may read it. */
async function readableMoment(ctx: any, userId: Id<"users"> | null, ref: string): Promise<Doc<"moments"> | null> {
  if (!userId) return null;
  const m: Doc<"moments"> | null = await ctx.db.query("moments").withIndex("by_short_id", (q: any) => q.eq("short_id", ref.trim())).first();
  if (!m || !(await workspaceGrantsAccess(ctx, userId, m.workspace))) return null;
  return m;
}

export type WebJudgeRun = JudgeRunRow;

/** One moment as the line shows it: its row, its source, the event refs that triggered it, and every judge's run on it. `_id` is its short id. */
export const momentForWeb = query({
  args: { moment: v.string() },
  handler: async (ctx, args) => {
    const m = await readableMoment(ctx, await getAuthUserId(ctx), args.moment);
    if (!m) return null;
    const source = await ctx.db.get(m.source_id);
    const runs: Doc<"judge_runs">[] = await ctx.db.query("judge_runs").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect();
    // `kept` is the stored key only: the client reads body_expires_at against its own clock (a cached query's would go stale).
    // An agent judge's reviews of it, each with whether its session's transcript is kept (agentReviews.webTranscript opens it).
    const reviews: Doc<"agent_reviews">[] = await ctx.db.query("agent_reviews").withIndex("by_moment", (q: any) => q.eq("moment_id", m._id)).collect();
    return {
      ...momentView(m), _id: m.short_id, source: source?.name ?? null, refs: momentRefs(m), runs: runs.sort((a, b) => a.at - b.at).map(judgeRunRow),
      reviews: reviews.sort((a, b) => a.created_at - b.created_at).map((r) => ({ review: r.short_id, judge: r.judge, status: r.status, findings: r.findings ?? null, took_ms: r.took_ms ?? null, transcript: !!r.transcript_key })),
    };
  },
});

/** The R2 key of a moment's kept body, when the viewer may read it and it is still kept. */
export const bodyKeyForWeb = internalQuery({
  args: { user_id: v.id("users"), moment: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const m = await readableMoment(ctx, args.user_id, args.moment);
    return liveBodyKey(m, Date.now());
  },
});

/** A codecast-kept moment's body (its blocks and refs, as the judge read them). Null when the body stays on the host or its 30 days are up. */
export const momentBodyForWeb = action({
  args: { moment: v.string() },
  handler: async (ctx, args): Promise<MomentRecord | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const key: string | null = await ctx.runQuery(internal.lineMoments.bodyKeyForWeb, { user_id: userId, moment: args.moment });
    return readKeptBody(key);
  },
});
