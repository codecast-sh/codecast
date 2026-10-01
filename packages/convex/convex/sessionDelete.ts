import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { killConversation } from "./conversations";

// Deleting a session removes it for everyone: the agent is torn down like a
// kill, the conversation row goes at once (the change-tracked db emits the
// sync-log delete, so every client drops it), and every row keyed by the
// conversation is purged in budgeted passes afterwards. A tombstone keeps the
// daemon from recreating it from the transcript still on the owner's machine.

// Every table whose rows belong to one conversation, with the index leading on
// conversation_id. Docs and anchors are left alone: a doc is its author's own
// object, and an anchor is a role seat (seated sessions refuse deletion).
const PURGE_TABLES: ReadonlyArray<readonly [string, string]> = [
  ["messages", "by_conversation_id"],
  ["conversation_images", "by_conversation_id"],
  ["conversation_summaries", "by_conversation_id"],
  ["session_insights", "by_conversation_id"],
  ["conversation_context", "by_conversation_id"],
  ["conversation_git_diffs", "by_conversation_id"],
  ["file_changes", "by_conversation_id"],
  ["file_change_bodies", "by_conversation_change_key"],
  ["file_touches", "by_conversation"],
  ["comments", "by_conversation_id"],
  ["public_comments", "by_conversation_id"],
  ["review_comments", "by_conversation"],
  ["composer_suggestions", "by_conversation_id"],
  ["pending_messages", "by_conversation_id"],
  ["pending_permissions", "by_conversation_status"],
  ["session_decisions", "by_conversation_status"],
  ["session_owners", "by_conversation"],
  ["session_migrations", "by_conversation"],
  ["collab_grants", "by_conversation"],
  ["share_redemptions", "by_conversation_user"],
  ["entity_conversations", "by_conversation"],
  ["commits", "by_conversation_id"],
  ["pull_request_sessions", "by_conversation"],
  ["call_agent_feeds", "by_conversation"],
  ["call_session_links", "by_conversation"],
  ["external_events", "by_conversation_created"],
  ["delivery_attempts", "by_conversation_sequence"],
  ["execution_bindings", "by_conversation_epoch"],
  ["conversation_execution_heads", "by_conversation"],
  ["managed_sessions", "by_conversation_id"],
];

const PURGE_BUDGET = 1000;

export const purgeConversationRows = internalMutation({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    let budget = PURGE_BUDGET;
    for (const [table, index] of PURGE_TABLES) {
      if (budget <= 0) break;
      const rows = await (ctx.db as any)
        .query(table)
        .withIndex(index, (q: any) => q.eq("conversation_id", args.conversation_id))
        .take(budget);
      for (const row of rows) {
        if (table === "conversation_images" && row.storage_id) {
          await ctx.storage.delete(row.storage_id).catch(() => {});
        }
        await ctx.db.delete(row._id);
      }
      budget -= rows.length;
    }
    if (budget <= 0) {
      await ctx.scheduler.runAfter(0, internal.sessionDelete.purgeConversationRows, args);
    }
    return { deleted: PURGE_BUDGET - budget, done: budget > 0 };
  },
});

/** Delete one session and its nested subagent transcripts. Only the account
 *  that runs it may delete it; a seated role session refuses. */
export async function deleteSessionAsOwner(ctx: any, userId: Id<"users">, conversationId: Id<"conversations">) {
  const conv = await ctx.db.get(conversationId);
  if (!conv) return { deleted: 0 };
  if (conv.user_id !== userId) throw new Error("Only the session's owner can delete it");
  if (conv.persistent) throw new Error("A role's standing session cannot be deleted");

  await killConversation(ctx, userId, { conversation_id: conversationId, mark_completed: true });

  // Subagent transcripts are part of the session's content; spawned worker
  // sessions are their own conversations and stay.
  const queue: any[] = [conv];
  let deleted = 0;
  while (queue.length) {
    const row = queue.shift();
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", row._id))
      .collect();
    for (const child of children) {
      if (child.user_id === userId && (child.is_subagent || child.parent_message_uuid)) queue.push(child);
    }
    if (row.session_id) {
      await ctx.db.insert("deleted_sessions", {
        user_id: userId,
        session_id: row.session_id,
        conversation_id: String(row._id),
        deleted_at: Date.now(),
      });
    }
    await ctx.db.delete(row._id);
    await ctx.scheduler.runAfter(0, internal.sessionDelete.purgeConversationRows, { conversation_id: String(row._id) });
    deleted++;
  }
  return { deleted };
}

export const deleteSession = mutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    return deleteSessionAsOwner(ctx, userId, args.conversation_id);
  },
});

// Support path: delete a session on its owner's behalf (packages/convex/run.sh).
export const adminDeleteSession = internalMutation({
  args: { conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const conv = await ctx.db.get(args.conversation_id);
    if (!conv) return { deleted: 0 };
    return deleteSessionAsOwner(ctx, conv.user_id, args.conversation_id);
  },
});
