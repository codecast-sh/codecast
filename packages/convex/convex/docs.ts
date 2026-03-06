import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { verifyApiToken } from "./apiTokens";
import { getAuthUserId } from "@convex-dev/auth/server";

export const create = mutation({
  args: {
    api_token: v.string(),
    title: v.string(),
    content: v.string(),
    doc_type: v.optional(v.string()),
    source: v.optional(v.string()),
    source_file: v.optional(v.string()),
    project_path: v.optional(v.string()),
    project_id: v.optional(v.string()),
    conversation_id: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const user = await ctx.db.get(auth.userId);
    const team_id = user?.active_team_id || user?.team_id;
    const now = Date.now();

    // Check for existing doc by source_file (for upsert on plan sync)
    if (args.source_file) {
      const existing = await ctx.db
        .query("docs")
        .withIndex("by_source_file", (q) => q.eq("source_file", args.source_file!))
        .first();
      if (existing && existing.user_id === auth.userId) {
        await ctx.db.patch(existing._id, {
          title: args.title,
          content: args.content,
          updated_at: now,
        });
        return { id: existing._id, updated: true };
      }
    }

    let conversation_id = undefined;
    if (args.conversation_id) {
      const conv = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.conversation_id!))
        .first();
      if (conv) conversation_id = conv._id;
    }

    const id = await ctx.db.insert("docs", {
      user_id: auth.userId,
      team_id,
      title: args.title,
      content: args.content,
      doc_type: (args.doc_type || "note") as any,
      source: (args.source || "human") as any,
      source_file: args.source_file,
      project_path: args.project_path,
      project_id: args.project_id as any,
      conversation_id,
      labels: args.labels,
      created_at: now,
      updated_at: now,
    });

    return { id, updated: false };
  },
});

export const list = query({
  args: {
    api_token: v.string(),
    doc_type: v.optional(v.string()),
    project_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    let docs;
    if (args.doc_type) {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_user_type", (q) =>
          q.eq("user_id", auth.userId).eq("doc_type", args.doc_type as any)
        )
        .collect();
    } else if (args.project_id) {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q) => q.eq("user_id", auth.userId))
        .collect();
    }

    // Exclude archived
    docs = docs.filter((d) => !d.archived_at);

    const limit = args.limit || 50;
    // Sort by updated_at desc
    docs.sort((a, b) => b.updated_at - a.updated_at);
    return docs.slice(0, limit);
  },
});

export const get = query({
  args: {
    api_token: v.string(),
    id: v.id("docs"),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== auth.userId) return null;
    return doc;
  },
});

export const update = mutation({
  args: {
    api_token: v.string(),
    id: v.id("docs"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    doc_type: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
    project_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token);
    if (!auth) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== auth.userId) throw new Error("Doc not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.content) updates.content = args.content;
    if (args.doc_type) updates.doc_type = args.doc_type;
    if (args.labels) updates.labels = args.labels;
    if (args.pinned !== undefined) updates.pinned = args.pinned;
    if (args.archived !== undefined) updates.archived_at = args.archived ? Date.now() : undefined;
    if (args.project_id !== undefined) updates.project_id = args.project_id || undefined;

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});

export const search = query({
  args: {
    api_token: v.string(),
    query: v.string(),
    doc_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new Error("Unauthorized");

    const results = await ctx.db
      .query("docs")
      .withSearchIndex("search_docs", (q) => {
        let search = q.search("title", args.query).eq("user_id", auth.userId);
        if (args.doc_type) search = search.eq("doc_type", args.doc_type as any);
        return search;
      })
      .take(args.limit || 20);

    return results.filter((d) => !d.archived_at);
  },
});

// --- Web-facing queries ---

export const webList = query({
  args: {
    doc_type: v.optional(v.string()),
    project_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    let docs;
    if (args.doc_type) {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_user_type", (q) =>
          q.eq("user_id", userId).eq("doc_type", args.doc_type as any)
        )
        .collect();
    } else if (args.project_id) {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_project_id", (q) => q.eq("project_id", args.project_id as any))
        .collect();
    } else {
      docs = await ctx.db
        .query("docs")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
    }

    docs = docs.filter((d) => !d.archived_at);
    docs.sort((a, b) => b.updated_at - a.updated_at);
    return docs.slice(0, args.limit || 50);
  },
});

export const webGet = query({
  args: {
    id: v.id("docs"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== userId) return null;
    return doc;
  },
});

export const webSearch = query({
  args: {
    query: v.string(),
    doc_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const results = await ctx.db
      .query("docs")
      .withSearchIndex("search_docs", (q) => {
        let search = q.search("title", args.query).eq("user_id", userId);
        if (args.doc_type) search = search.eq("doc_type", args.doc_type as any);
        return search;
      })
      .take(args.limit || 20);

    return results.filter((d) => !d.archived_at);
  },
});

export const webUpdate = mutation({
  args: {
    id: v.id("docs"),
    title: v.optional(v.string()),
    content: v.optional(v.string()),
    doc_type: v.optional(v.string()),
    labels: v.optional(v.array(v.string())),
    pinned: v.optional(v.boolean()),
    archived: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const doc = await ctx.db.get(args.id);
    if (!doc || doc.user_id !== userId) throw new Error("Doc not found");

    const updates: any = { updated_at: Date.now() };
    if (args.title) updates.title = args.title;
    if (args.content) updates.content = args.content;
    if (args.doc_type) updates.doc_type = args.doc_type;
    if (args.labels) updates.labels = args.labels;
    if (args.pinned !== undefined) updates.pinned = args.pinned;
    if (args.archived !== undefined) updates.archived_at = args.archived ? Date.now() : undefined;

    await ctx.db.patch(args.id, updates);
    return { success: true };
  },
});
