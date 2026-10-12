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
import { judgeRunRow, readKeptBody, type JudgeRunRow } from "./lib/momentBody";
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
    return {
      _id: m.short_id,
      short_id: m.short_id,
      kind: m.kind,
      subject: m.subject,
      status: m.status,
      events: m.events,
      first_event_at: m.first_event_at,
      event_at: m.event_at,
      ...(m.extracted_at ? { extracted_at: m.extracted_at, gap_ms: m.gap_ms } : {}),
      ...(m.extractor_version ? { extractor_version: m.extractor_version } : {}),
      storage: m.storage ?? "host",
      kept: !!m.body_key && (m.body_expires_at ?? 0) > Date.now(),
      ...(m.body_expires_at ? { body_expires_at: m.body_expires_at } : {}),
      ...(m.blocks !== undefined ? { blocks: m.blocks } : {}),
      ...(m.error ? { error: m.error } : {}),
      source: source?.name ?? null,
      refs: (m.refs_json ? JSON.parse(m.refs_json) : {}) as Record<string, string>,
      runs: runs.sort((a, b) => a.at - b.at).map(judgeRunRow),
    };
  },
});

/** The R2 key of a moment's kept body, when the viewer may read it and it is still kept. */
export const bodyKeyForWeb = internalQuery({
  args: { user_id: v.id("users"), moment: v.string() },
  handler: async (ctx, args): Promise<string | null> => {
    const m = await readableMoment(ctx, args.user_id, args.moment);
    return m?.body_key && (m.body_expires_at ?? 0) > Date.now() ? m.body_key : null;
  },
});

/** A codecast-kept moment's body (its blocks and refs, as the judge read them). Null when the body stays on the host or is past 30 days. */
export const momentBodyForWeb = action({
  args: { moment: v.string() },
  handler: async (ctx, args): Promise<MomentRecord | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const key: string | null = await ctx.runQuery(internal.lineMoments.bodyKeyForWeb, { user_id: userId, moment: args.moment });
    return readKeptBody(key);
  },
});
