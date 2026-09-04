// TEMPORARY: the conversation doc diet sweep, split from debugTmp.ts because it
// is the one harness mutation that must bypass the write interceptor (see the
// rationale below), and the change-feed guard keys that bypass by file. Safe to
// delete together with debugTmp.ts once every row has been swept.
import { internalMutation as rawInternalMutation } from "./_generated/server";
import { v } from "convex/values";
import { setConvGitDiff, setConvStableContext } from "./conversations";

// TEMPORARY: conversation doc diet. Sheds the two legacy blobs the inbox scan
// paid for on every recompute but nothing reads — available_skills (dropped;
// user_skills is the source) and git_status (moved to the conversation_git_diffs
// side row). Paced: one page per mutation, resumable by cursor. Safe to delete
// once every row has been swept.
//
// Raw (un-wrapped) internalMutation on purpose: the wrapped one appends every
// conversation patch to the sync log, which bumps a shared sync_heads row and
// OCC-collides with the live addMessages firehose on every retry. Nothing a
// client renders changes here, so there is no delta worth logging.
export const dietConversationPage = rawInternalMutation({
  args: { cursor: v.union(v.string(), v.null()), numItems: v.number(), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("conversations").paginate({ cursor: args.cursor, numItems: args.numItems });
    let patched = 0;
    let bytesShed = 0;
    for (const conv of page.page) {
      const hasSkills = conv.available_skills !== undefined;
      const hasStatus = conv.git_status !== undefined;
      const hasStable = conv.stable_context !== undefined;
      if (!hasSkills && !hasStatus && !hasStable) continue;
      bytesShed += (conv.available_skills?.length ?? 0) + (conv.git_status?.length ?? 0) + (conv.stable_context?.length ?? 0);
      patched++;
      if (args.dryRun) continue;
      if (hasStatus && conv.git_status) {
        const row = await ctx.db
          .query("conversation_git_diffs")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
          .first();
        await setConvGitDiff(ctx, conv._id, row?.git_diff, row?.git_diff_staged, row?.git_status ?? conv.git_status);
      }
      if (hasStable && conv.stable_context) {
        const row = await ctx.db
          .query("conversation_context")
          .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
          .first();
        if (!row?.stable_context) await setConvStableContext(ctx, conv._id, conv.stable_context);
      }
      await ctx.db.patch(conv._id, { available_skills: undefined, git_status: undefined, stable_context: undefined });
    }
    return { scanned: page.page.length, patched, bytesShed, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});
