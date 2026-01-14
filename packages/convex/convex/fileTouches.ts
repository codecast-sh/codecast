import { mutation, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { verifyApiToken } from "./apiTokens";
import { Doc, Id } from "./_generated/dataModel";

export const recordTouch = internalMutation({
  args: {
    conversation_id: v.id("conversations"),
    user_id: v.id("users"),
    file_path: v.string(),
    operation: v.union(
      v.literal("read"),
      v.literal("edit"),
      v.literal("write"),
      v.literal("delete"),
      v.literal("glob"),
      v.literal("grep")
    ),
    line_range: v.optional(v.string()),
    message_index: v.number(),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("file_touches", args);
  },
});

export const findByFile = mutation({
  args: {
    api_token: v.string(),
    file_path: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const limit = args.limit ?? 20;

    const touches = await ctx.db
      .query("file_touches")
      .withIndex("by_user_file", (q) =>
        q.eq("user_id", result.userId).eq("file_path", args.file_path)
      )
      .order("desc")
      .take(limit);

    const conversationIds = [...new Set(touches.map((t) => t.conversation_id))];
    const conversations = await Promise.all(
      conversationIds.map((id) => ctx.db.get(id))
    );
    const convMap = new Map(
      conversations.filter(Boolean).map((c) => [c!._id.toString(), c])
    );

    const results = touches.map((t) => {
      const conv = convMap.get(t.conversation_id.toString());
      return {
        conversation_id: t.conversation_id,
        session_id: conv?.session_id,
        title: conv?.title || "Untitled",
        operation: t.operation,
        line_range: t.line_range,
        message_index: t.message_index,
        timestamp: new Date(t.timestamp).toISOString(),
      };
    });

    return { touches: results, count: results.length };
  },
});

export const findSimilar = mutation({
  args: {
    api_token: v.string(),
    file_path: v.optional(v.string()),
    session_id: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const limit = args.limit ?? 10;

    if (args.file_path) {
      const touches = await ctx.db
        .query("file_touches")
        .withIndex("by_user_file", (q) =>
          q.eq("user_id", result.userId).eq("file_path", args.file_path!)
        )
        .order("desc")
        .take(100);

      const conversationIds = [...new Set(touches.map((t) => t.conversation_id))];
      const conversations = await Promise.all(
        conversationIds.slice(0, limit).map((id) => ctx.db.get(id))
      );

      const results = conversations.filter(Boolean).map((c) => ({
        conversation_id: c!._id,
        session_id: c!.session_id,
        title: c!.title || "Untitled",
        project_path: c!.project_path,
        updated_at: new Date(c!.updated_at).toISOString(),
        message_count: c!.message_count,
        match_type: "file",
        match_detail: args.file_path,
      }));

      return { sessions: results, count: results.length };
    }

    if (args.session_id) {
      const allConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .order("desc")
        .take(500);

      const sourceConv = allConvs.find(
        (c) => c._id.toString().startsWith(args.session_id!) ||
               c.session_id?.startsWith(args.session_id!)
      ) ?? null;

      if (!sourceConv) {
        if (allConvs.length > 0) {
          return { error: `Session "${args.session_id}" not found in ${allConvs.length} conversations. Sample: ${allConvs[0]._id.toString().slice(0, 10)}` };
        }
        return { error: `No conversations found for user` };
      }

      const sourceTouches = await ctx.db
        .query("file_touches")
        .withIndex("by_conversation", (q) => q.eq("conversation_id", sourceConv._id))
        .collect();

      const sourceFiles = [...new Set(sourceTouches.map((t) => t.file_path))];

      if (sourceFiles.length === 0) {
        const sameProject = await ctx.db
          .query("conversations")
          .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
          .filter((q) => q.eq(q.field("project_path"), sourceConv!.project_path))
          .order("desc")
          .take(limit + 1);

        const results = sameProject
          .filter((c) => c._id.toString() !== sourceConv!._id.toString())
          .slice(0, limit)
          .map((c) => ({
            conversation_id: c._id,
            session_id: c.session_id,
            title: c.title || "Untitled",
            project_path: c.project_path,
            updated_at: new Date(c.updated_at).toISOString(),
            message_count: c.message_count,
            match_type: "project",
            match_detail: c.project_path,
          }));

        return { sessions: results, count: results.length };
      }

      const relatedConvIds = new Map<string, { count: number; files: string[] }>();
      for (const filePath of sourceFiles.slice(0, 20)) {
        const touches = await ctx.db
          .query("file_touches")
          .withIndex("by_user_file", (q) =>
            q.eq("user_id", result.userId).eq("file_path", filePath)
          )
          .take(50);

        for (const t of touches) {
          const convId = t.conversation_id.toString();
          if (convId === sourceConv._id.toString()) continue;

          const existing = relatedConvIds.get(convId) || { count: 0, files: [] };
          existing.count++;
          if (!existing.files.includes(filePath)) {
            existing.files.push(filePath);
          }
          relatedConvIds.set(convId, existing);
        }
      }

      const sortedConvIds = Array.from(relatedConvIds.entries())
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit);

      const conversations: Array<Doc<"conversations"> | null> = await Promise.all(
        sortedConvIds.map(([id]) => ctx.db.get(id as Id<"conversations">))
      );

      const results = conversations.filter(Boolean).map((c, i) => ({
        conversation_id: c!._id,
        session_id: c!.session_id,
        title: c!.title || "Untitled",
        project_path: c!.project_path,
        updated_at: new Date(c!.updated_at).toISOString(),
        message_count: c!.message_count,
        match_type: "files",
        match_detail: `${sortedConvIds[i][1].files.length} shared files`,
      }));

      return { sessions: results, count: results.length };
    }

    return { sessions: [], count: 0, error: "Must specify file_path or session_id" };
  },
});

export const getConversationTouches = mutation({
  args: {
    api_token: v.string(),
    conversation_id: v.string(),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const conv = await ctx.db
      .query("conversations")
      .filter((q) => {
        const idMatch = q.eq(q.field("_id"), args.conversation_id as any);
        const sessionMatch = q.eq(q.field("session_id"), args.conversation_id);
        return q.or(idMatch, sessionMatch);
      })
      .first();

    if (!conv) {
      const allConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .take(1000);

      const match = allConvs.find(
        (c) => c._id.toString().includes(args.conversation_id) ||
               c.session_id?.includes(args.conversation_id)
      );

      if (!match) {
        return { error: "Conversation not found" };
      }

      const touches = await ctx.db
        .query("file_touches")
        .withIndex("by_conversation", (q) => q.eq("conversation_id", match._id))
        .collect();

      const fileStats = new Map<string, { reads: number; edits: number; writes: number }>();
      for (const t of touches) {
        const stats = fileStats.get(t.file_path) || { reads: 0, edits: 0, writes: 0 };
        if (t.operation === "read") stats.reads++;
        else if (t.operation === "edit") stats.edits++;
        else if (t.operation === "write") stats.writes++;
        fileStats.set(t.file_path, stats);
      }

      const files = Array.from(fileStats.entries()).map(([path, stats]) => ({
        file_path: path,
        ...stats,
      }));

      return { files, count: files.length };
    }

    if (conv.user_id.toString() !== result.userId.toString()) {
      return { error: "Unauthorized" };
    }

    const touches = await ctx.db
      .query("file_touches")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", conv._id))
      .collect();

    const fileStats = new Map<string, { reads: number; edits: number; writes: number }>();
    for (const t of touches) {
      const stats = fileStats.get(t.file_path) || { reads: 0, edits: 0, writes: 0 };
      if (t.operation === "read") stats.reads++;
      else if (t.operation === "edit") stats.edits++;
      else if (t.operation === "write") stats.writes++;
      fileStats.set(t.file_path, stats);
    }

    const files = Array.from(fileStats.entries()).map(([path, stats]) => ({
      file_path: path,
      ...stats,
    }));

    return { files, count: files.length };
  },
});
