import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    rationale: v.string(),
    alternatives: v.optional(v.array(v.string())),
    session_id: v.optional(v.string()),
    message_index: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    project_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const user = await ctx.db.get(result.userId);
    if (!user) {
      return { error: "User not found" };
    }

    let conversationId = undefined;
    if (args.session_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id!))
        .first();
      if (conv) {
        conversationId = conv._id;
      }
    }

    const now = Date.now();
    const id = await ctx.db.insert("decisions", {
      user_id: result.userId,
      team_id: user.team_id,
      project_path: args.project_path,
      title: args.title,
      rationale: args.rationale,
      alternatives: args.alternatives,
      session_id: args.session_id,
      conversation_id: conversationId,
      message_index: args.message_index,
      tags: args.tags,
      created_at: now,
      updated_at: now,
    });

    return { id, success: true };
  },
});

export const list = mutation({
  args: {
    api_token: v.string(),
    project_path: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    offset: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const limit = args.limit ?? 20;
    const offset = args.offset ?? 0;

    let decisions;
    if (args.search) {
      const searchResults = await ctx.db
        .query("decisions")
        .withSearchIndex("search_decisions", (q) =>
          q.search("title", args.search!).eq("user_id", result.userId)
        )
        .take(limit + offset);
      decisions = searchResults.slice(offset, offset + limit);
    } else if (args.project_path) {
      decisions = await ctx.db
        .query("decisions")
        .withIndex("by_user_project", (q) =>
          q.eq("user_id", result.userId).eq("project_path", args.project_path!)
        )
        .order("desc")
        .take(limit + offset);
      decisions = decisions.slice(offset);
    } else {
      decisions = await ctx.db
        .query("decisions")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .order("desc")
        .take(limit + offset);
      decisions = decisions.slice(offset);
    }

    if (args.tags && args.tags.length > 0) {
      decisions = decisions.filter((d) =>
        args.tags!.some((tag) => d.tags?.includes(tag))
      );
    }

    const formatted = decisions.map((d) => ({
      id: d._id,
      title: d.title,
      rationale: d.rationale,
      alternatives: d.alternatives,
      tags: d.tags,
      session_id: d.session_id,
      message_index: d.message_index,
      project_path: d.project_path,
      created_at: new Date(d.created_at).toISOString(),
    }));

    return { decisions: formatted, count: formatted.length };
  },
});

export const get = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const decision = await ctx.db
      .query("decisions")
      .filter((q) => q.eq(q.field("_id"), args.decision_id as any))
      .first();

    if (!decision || decision.user_id.toString() !== result.userId.toString()) {
      return { error: "Decision not found" };
    }

    return {
      id: decision._id,
      title: decision.title,
      rationale: decision.rationale,
      alternatives: decision.alternatives,
      tags: decision.tags,
      session_id: decision.session_id,
      message_index: decision.message_index,
      project_path: decision.project_path,
      created_at: new Date(decision.created_at).toISOString(),
    };
  },
});

export const remove = mutation({
  args: {
    api_token: v.string(),
    decision_id: v.id("decisions"),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const decision = await ctx.db.get(args.decision_id);
    if (!decision || decision.user_id.toString() !== result.userId.toString()) {
      return { error: "Decision not found" };
    }

    await ctx.db.delete(args.decision_id);
    return { success: true };
  },
});
