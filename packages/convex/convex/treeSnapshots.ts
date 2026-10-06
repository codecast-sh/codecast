// Turn snapshots: the index that joins a working tree snapshot (a git commit
// the daemon took, cli/src/treeSnapshot.ts) to the conversation and turn it
// describes. The objects stay in the session's repository; this table only
// says which sha stands for the tree at the end of which turn.

import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthenticatedUserId } from "./pendingMessages";
import { requireUserOrToken } from "./lib/auth";
import { canAccessConversation } from "./lib/access";

const CHANGED_PATHS_CAP = 200;
const LIST_CAP = 500;

const snapshotRow = v.object({
  conversation_id: v.id("conversations"),
  sha: v.string(),
  tree_sha: v.string(),
  base_sha: v.string(),
  prev_sha: v.optional(v.string()),
  branch: v.optional(v.string()),
  depth: v.number(),
  changed_paths: v.array(v.string()),
  changed_count: v.number(),
  dirty: v.boolean(),
  checkout_key: v.string(),
  source: v.union(v.literal("turn"), v.literal("sweep")),
  taken_at: v.number(),
  turn_completed_at: v.optional(v.number()),
  took_ms: v.optional(v.number()),
  shared_sessions: v.optional(v.number()),
});

/**
 * The daemon records one or more rows after a snapshot: one per session that
 * shares the checkout. Idempotent on (conversation, sha, turn_completed_at):
 * a re-sent batch, or a sweep that found the tree unchanged since the turn,
 * writes nothing new. Only the sessions' runner may write (the daemon runs as
 * the owner of the sessions it watches).
 */
export const record = mutation({
  args: {
    api_token: v.string(),
    device_id: v.optional(v.string()),
    rows: v.array(snapshotRow),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthenticatedUserId(ctx, args.api_token);
    if (!userId) throw new Error("Authentication failed");
    let written = 0;
    for (const row of args.rows.slice(0, 50)) {
      const conversation = await ctx.db.get(row.conversation_id);
      if (!conversation || conversation.user_id.toString() !== userId.toString()) continue;
      const existing = await ctx.db
        .query("tree_snapshots")
        .withIndex("by_conversation_sha", (q) => q.eq("conversation_id", row.conversation_id).eq("sha", row.sha))
        .collect();
      if (existing.some((e) => (e.turn_completed_at ?? null) === (row.turn_completed_at ?? null))) continue;
      await ctx.db.insert("tree_snapshots", {
        ...row,
        changed_paths: row.changed_paths.slice(0, CHANGED_PATHS_CAP),
        device_id: args.device_id,
      });
      written++;
    }
    return { written };
  },
});

/** Every snapshot of one conversation, oldest first: what `cast diff --turns` and the diff pane read. */
export const listForConversation = query({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return [];
    const rows = await ctx.db
      .query("tree_snapshots")
      .withIndex("by_conversation_taken", (q) => q.eq("conversation_id", args.conversation_id))
      .order("desc")
      .take(LIST_CAP);
    return rows.reverse();
  },
});
