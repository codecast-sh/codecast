import { internalMutation, mutation } from "./_generated/server";
import { v } from "convex/values";

export const clearRateLimits = internalMutation({
  args: {},
  handler: async (ctx) => {
    const limits = await ctx.db.query("rate_limits").collect();
    for (const limit of limits) {
      await ctx.db.delete(limit._id);
    }
    return `Cleared ${limits.length} rate limit records`;
  },
});

// One-time cleanup mutation to delete orphan tables
// Run with: npx convex run cleanup:deleteOrphanTables
export const deleteOrphanTables = internalMutation({
  args: {},
  handler: async (ctx) => {
    const orphanTables = [
      "activity",
      "activityChunk",
      "contacts",
      "credentials",
      "emailDrafts",
      "integrations",
      "jobs",
      "reminders",
      "tasks",
      "typingPresence",
      "userCalendarPrefs",
    ];

    for (const tableName of orphanTables) {
      try {
        // @ts-ignore - accessing tables not in schema
        const docs = await ctx.db.query(tableName).collect();
        for (const doc of docs) {
          // @ts-ignore
          await ctx.db.delete(doc._id);
        }
        console.log(`Deleted ${docs.length} documents from ${tableName}`);
      } catch (e) {
        console.log(`Table ${tableName} doesn't exist or error: ${e}`);
      }
    }

    return "Done";
  },
});

export const clearUserConversations = mutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    // Just get conversation IDs without loading full docs
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .take(50);

    let deleted = 0;
    for (const conv of convos) {
      // Check if has messages (just get first, don't load content)
      const hasMsg = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .first();

      if (!hasMsg) {
        await ctx.db.delete(conv._id);
        deleted++;
      }
    }

    const hasMore = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();

    return { deleted, hasMore: !!hasMore };
  },
});

export const clearUserMessages = mutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    // Get one conversation
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();

    if (!conv) return { deleted: 0, hasMore: false };

    // Get message IDs only (not full content) by using a projection-like query
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .take(100);

    for (const msg of msgs) {
      await ctx.db.delete(msg._id);
    }

    return { deleted: msgs.length, hasMore: msgs.length > 0 };
  },
});

// Force delete conversations without checking for messages - deletes 50 at a time
export const forceDeleteConversations = mutation({
  args: { user_id: v.id("users") },
  handler: async (ctx, args) => {
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .take(50);

    for (const conv of convos) {
      await ctx.db.delete(conv._id);
    }

    const hasMore = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .first();

    return { deleted: convos.length, hasMore: !!hasMore };
  },
});

// Delete conversations by agent type
export const deleteConversationsByType = mutation({
  args: {
    user_id: v.id("users"),
    agent_type: v.union(v.literal("claude_code"), v.literal("codex"), v.literal("cursor"), v.literal("cowork")),
  },
  handler: async (ctx, args) => {
    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .filter((q) => q.eq(q.field("agent_type"), args.agent_type))
      .take(100);

    for (const conv of convos) {
      await ctx.db.delete(conv._id);
    }

    return { deleted: convos.length };
  },
});

export const deleteConversationBySessionId = mutation({
  args: { session_id: v.string() },
  handler: async (ctx, args) => {
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
      .first();
    if (!conv) return { found: false, deleted: 0 };
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
      .take(500);
    for (const m of msgs) await ctx.db.delete(m._id);
    await ctx.db.delete(conv._id);
    return { found: true, deleted: msgs.length };
  },
});

// Delete all Cursor conversations and their messages (uses auth)
export const deleteCursorConversationsWithMessages = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", identity.email))
      .first();
    if (!user) throw new Error("User not found");

    const convos = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", user._id))
      .filter((q) => q.eq(q.field("agent_type"), "cursor"))
      .take(100);

    let messagesDeleted = 0;
    for (const conv of convos) {
      const msgs = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conv._id))
        .take(1000);

      for (const msg of msgs) {
        await ctx.db.delete(msg._id);
        messagesDeleted++;
      }
      await ctx.db.delete(conv._id);
    }

    return { conversationsDeleted: convos.length, messagesDeleted };
  },
});
