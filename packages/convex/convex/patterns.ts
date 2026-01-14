import { mutation } from "./_generated/server";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";

export const create = mutation({
  args: {
    api_token: v.string(),
    name: v.string(),
    description: v.string(),
    content: v.string(),
    source_session_id: v.optional(v.string()),
    source_range: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
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

    const existing = await ctx.db
      .query("patterns")
      .withIndex("by_user_name", (q) =>
        q.eq("user_id", result.userId).eq("name", args.name)
      )
      .first();

    if (existing) {
      return { error: "Pattern with this name already exists" };
    }

    let conversationId = undefined;
    if (args.source_session_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.source_session_id!))
        .first();
      if (conv) {
        conversationId = conv._id;
      }
    }

    const now = Date.now();
    const id = await ctx.db.insert("patterns", {
      user_id: result.userId,
      team_id: user.team_id,
      name: args.name,
      description: args.description,
      content: args.content,
      source_session_id: args.source_session_id,
      source_conversation_id: conversationId,
      source_range: args.source_range,
      tags: args.tags,
      usage_count: 0,
      created_at: now,
      updated_at: now,
    });

    return { id, success: true };
  },
});

export const list = mutation({
  args: {
    api_token: v.string(),
    search: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
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

    let patterns;
    if (args.search) {
      const searchResults = await ctx.db
        .query("patterns")
        .withSearchIndex("search_patterns", (q) =>
          q.search("name", args.search!).eq("user_id", result.userId)
        )
        .take(limit + offset);
      patterns = searchResults.slice(offset, offset + limit);
    } else {
      patterns = await ctx.db
        .query("patterns")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .order("desc")
        .take(limit + offset);
      patterns = patterns.slice(offset);
    }

    if (args.tags && args.tags.length > 0) {
      patterns = patterns.filter((p) =>
        args.tags!.some((tag) => p.tags?.includes(tag))
      );
    }

    const formatted = patterns.map((p) => ({
      id: p._id,
      name: p.name,
      description: p.description,
      tags: p.tags,
      source_session_id: p.source_session_id,
      source_range: p.source_range,
      usage_count: p.usage_count,
      created_at: new Date(p.created_at).toISOString(),
    }));

    return { patterns: formatted, count: formatted.length };
  },
});

export const get = mutation({
  args: {
    api_token: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const pattern = await ctx.db
      .query("patterns")
      .withIndex("by_user_name", (q) =>
        q.eq("user_id", result.userId).eq("name", args.name)
      )
      .first();

    if (!pattern) {
      return { error: "Pattern not found" };
    }

    await ctx.db.patch(pattern._id, {
      usage_count: pattern.usage_count + 1,
    });

    return {
      id: pattern._id,
      name: pattern.name,
      description: pattern.description,
      content: pattern.content,
      tags: pattern.tags,
      source_session_id: pattern.source_session_id,
      source_range: pattern.source_range,
      usage_count: pattern.usage_count + 1,
      created_at: new Date(pattern.created_at).toISOString(),
    };
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    name: v.string(),
    description: v.optional(v.string()),
    content: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const pattern = await ctx.db
      .query("patterns")
      .withIndex("by_user_name", (q) =>
        q.eq("user_id", result.userId).eq("name", args.name)
      )
      .first();

    if (!pattern) {
      return { error: "Pattern not found" };
    }

    const updates: Record<string, unknown> = { updated_at: Date.now() };
    if (args.description !== undefined) updates.description = args.description;
    if (args.content !== undefined) updates.content = args.content;
    if (args.tags !== undefined) updates.tags = args.tags;

    await ctx.db.patch(pattern._id, updates);
    return { success: true };
  },
});

export const remove = mutation({
  args: {
    api_token: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const pattern = await ctx.db
      .query("patterns")
      .withIndex("by_user_name", (q) =>
        q.eq("user_id", result.userId).eq("name", args.name)
      )
      .first();

    if (!pattern) {
      return { error: "Pattern not found" };
    }

    await ctx.db.delete(pattern._id);
    return { success: true };
  },
});
