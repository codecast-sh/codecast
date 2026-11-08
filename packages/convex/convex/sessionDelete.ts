import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { killConversation } from "./conversations";
import { CONVERSATION_ROW_TABLES, conversationRowEffects } from "./lib/conversationRows";
import { isRegulatedTeam } from "./lib/accessLog";
import { mayDeleteRegulated, startDeletion } from "./regulatedDeletion";

// Deleting a session removes it for everyone: the agent is torn down like a
// kill, the conversation row goes at once (the change-tracked db emits the
// sync-log delete, so every client drops it), and every row keyed by the
// conversation is purged in budgeted passes afterwards. A tombstone keeps the
// daemon from recreating it from the transcript still on the owner's machine.

const PURGE_BUDGET = 1000;

export const purgeConversationRows = internalMutation({
  args: { conversation_id: v.string() },
  handler: async (ctx, args) => {
    let budget = PURGE_BUDGET;
    for (const [table, index] of CONVERSATION_ROW_TABLES) {
      if (budget <= 0) break;
      const rows = await (ctx.db as any)
        .query(table)
        .withIndex(index, (q: any) => q.eq("conversation_id", args.conversation_id))
        .take(budget);
      for (const row of rows) {
        await conversationRowEffects(ctx, table, row);
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
 *  that runs it may delete it; a seated role session refuses. In a team whose
 *  data is regulated, a team admin may too, and the delete is permanent
 *  everywhere its content went (regulatedDeletion.ts), logged as it goes. */
export async function deleteSessionAsOwner(ctx: any, userId: Id<"users">, conversationId: Id<"conversations">) {
  const conv = await ctx.db.get(conversationId);
  if (!conv) return { deleted: 0 };
  const regulatedTeam = conv.team_id && (await isRegulatedTeam(ctx, conv.team_id)) ? conv.team_id : null;
  const allowed = regulatedTeam ? await mayDeleteRegulated(ctx, userId, conv.user_id, regulatedTeam) : conv.user_id === userId;
  if (!allowed) throw new Error("Only the session's owner can delete it");
  if (conv.persistent) throw new Error("A role's standing session cannot be deleted");
  const ownerId: Id<"users"> = conv.user_id;

  await killConversation(ctx, ownerId, { conversation_id: conversationId, mark_completed: true }, { cause: "delete" });

  // Subagent transcripts are part of the session's content; spawned worker
  // sessions are their own conversations and stay.
  const queue: any[] = [conv];
  const purged: string[] = [];
  while (queue.length) {
    const row = queue.shift();
    const children = await ctx.db
      .query("conversations")
      .withIndex("by_parent_conversation_id", (q: any) => q.eq("parent_conversation_id", row._id))
      .collect();
    for (const child of children) {
      if (child.user_id === ownerId && (child.is_subagent || child.parent_message_uuid)) queue.push(child);
    }
    if (row.session_id) {
      await ctx.db.insert("deleted_sessions", {
        user_id: ownerId,
        session_id: row.session_id,
        conversation_id: String(row._id),
        deleted_at: Date.now(),
      });
    }
    await ctx.db.delete(row._id);
    purged.push(String(row._id));
  }
  if (regulatedTeam) {
    const team = await ctx.db.get(regulatedTeam);
    await startDeletion(ctx, {
      team, actorId: userId, kind: "session", targetId: String(conv._id), targetLabel: conv.title ?? undefined, shortId: conv.short_id,
      roots: purged.map((id) => ({ plan: "conversation" as const, id })),
    });
  } else {
    for (const id of purged) await ctx.scheduler.runAfter(0, internal.sessionDelete.purgeConversationRows, { conversation_id: id });
  }
  return { deleted: purged.length };
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
