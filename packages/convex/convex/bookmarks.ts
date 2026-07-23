import { mutation, query } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { verifyApiToken } from "./apiTokens";
import { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { requireUser } from "./lib/auth";
import { readLocalViewRevision, runLocalCommand } from "./localFirstCommands";
import {
  BOOKMARKS_GRANT_KEY,
  BOOKMARKS_VIEW_CONTRACT_ID,
  BOOKMARKS_VIEW_KEY,
  bookmarksCoverageTarget,
  projectBookmark,
  revisionCoverage,
} from "./smallViewContracts";
import {
  deleteBookmarkWithRevision,
  insertBookmarkWithRevision,
} from "./bookmarkViewWrites";

type BookmarkReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type BookmarkFailure = {
  status: "rejected";
  code: string;
  message: string;
};
type BookmarkTarget = {
  conversation: Doc<"conversations">;
  message: Doc<"messages">;
  existing: Doc<"bookmarks"> | null;
};

async function validateBookmarkTarget(
  ctx: BookmarkReadCtx,
  userId: Id<"users">,
  conversationId: Id<"conversations">,
  messageId: Id<"messages">,
): Promise<{ ok: true; value: BookmarkTarget } | { ok: false; failure: BookmarkFailure }> {
  const conversation = await ctx.db.get(conversationId);
  if (!conversation) {
    return {
      ok: false,
      failure: { status: "rejected", code: "MISSING", message: "Conversation not found" },
    };
  }
  if (String(conversation.user_id) !== String(userId)) {
    return {
      ok: false,
      failure: {
        status: "rejected",
        code: "FORBIDDEN",
        message: "Can only bookmark messages in your own conversations",
      },
    };
  }
  const message = await ctx.db.get(messageId);
  if (!message) {
    return {
      ok: false,
      failure: { status: "rejected", code: "MISSING", message: "Message not found" },
    };
  }
  if (String(message.conversation_id) !== String(conversationId)) {
    return {
      ok: false,
      failure: {
        status: "rejected",
        code: "INVALID_RELATION",
        message: "Bookmark message does not belong to the conversation",
      },
    };
  }

  const candidates = await ctx.db
    .query("bookmarks")
    .withIndex("by_message_id", (q) => q.eq("message_id", messageId))
    .collect();
  const existing = candidates.find((bookmark) =>
    String(bookmark.user_id) === String(userId)) ?? null;
  if (existing && String(existing.conversation_id) !== String(conversationId)) {
    return {
      ok: false,
      failure: {
        status: "rejected",
        code: "INVALID_RELATION",
        message: "Existing bookmark is bound to a different conversation",
      },
    };
  }
  return { ok: true, value: { conversation, message, existing } };
}

export const createFromCLI = mutation({
  args: {
    api_token: v.string(),
    session_id: v.string(),
    message_index: v.number(),
    name: v.optional(v.string()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    let conversation: Doc<"conversations"> | null = null;

    try {
      conversation = await ctx.db.get(args.session_id as Id<"conversations">);
    } catch {
      // ID format invalid, try other lookups
    }

    if (!conversation) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_session_id", (q) => q.eq("session_id", args.session_id))
        .first();
    }

    if (!conversation) {
      const userConvs = await ctx.db
        .query("conversations")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .order("desc")
        .take(200);
      conversation = userConvs.find((c) => c._id.toString().startsWith(args.session_id)) ?? null;
    }

    if (!conversation) {
      return { error: "Conversation not found" };
    }

    if (conversation.user_id.toString() !== result.userId.toString()) {
      return { error: "Can only bookmark messages in your own conversations" };
    }

    const messages = await ctx.db
      .query("messages")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
      .collect();

    const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
    const message = sortedMessages[args.message_index - 1];

    if (!message) {
      return { error: `Message ${args.message_index} not found (conversation has ${sortedMessages.length} messages)` };
    }

    if (args.name) {
      const existing = await ctx.db
        .query("bookmarks")
        .withIndex("by_user_name", (q) => q.eq("user_id", result.userId).eq("name", args.name!))
        .first();
      if (existing) {
        return { error: `Bookmark named "${args.name}" already exists` };
      }
    }

    const bookmark = (await insertBookmarkWithRevision(ctx, {
      user_id: result.userId,
      conversation_id: conversation._id,
      message_id: message._id,
      name: args.name,
      note: args.note,
      created_at: Date.now(),
    })).result;

    const shareToken = conversation.share_token || conversation.session_id;
    const bookmarkUrl = `https://codecast.sh/share/${shareToken}#msg-${args.message_index}`;

    return {
      bookmark_id: bookmark,
      name: args.name,
      conversation_id: conversation._id,
      session_id: conversation.session_id,
      message_index: args.message_index,
      url: bookmarkUrl,
    };
  },
});

export const listFromCLI = mutation({
  args: {
    api_token: v.string(),
    project_path: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    const limit = args.limit ?? 20;

    const bookmarks = await ctx.db
      .query("bookmarks")
      .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
      .order("desc")
      .take(limit);

    const enrichedResults: Array<{
      id: Id<"bookmarks">;
      name: string | undefined;
      note: string | undefined;
      session_id: string | undefined;
      conversation_title: string;
      message_index: number;
      message_preview: string;
      message_role: string;
      project_path: string | undefined;
      url: string;
      created_at: string;
    }> = [];

    for (const bookmark of bookmarks) {
      const conversation = await ctx.db.get(bookmark.conversation_id);
      const message = await ctx.db.get(bookmark.message_id);
      if (!conversation || !message) continue;

      if (args.project_path && conversation.project_path !== args.project_path) {
        continue;
      }

      const messages = await ctx.db
        .query("messages")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
        .collect();
      const sortedMessages = messages.sort((a, b) => a.timestamp - b.timestamp);
      const messageIndex = sortedMessages.findIndex((m) => m._id.toString() === message._id.toString()) + 1;

      const shareToken = conversation.share_token || conversation.session_id;

      enrichedResults.push({
        id: bookmark._id,
        name: bookmark.name,
        note: bookmark.note,
        session_id: conversation.session_id?.slice(0, 7),
        conversation_title: conversation.title || "New Session",
        message_index: messageIndex,
        message_preview: message.content?.slice(0, 100) || "",
        message_role: message.role,
        project_path: conversation.project_path,
        url: `https://codecast.sh/share/${shareToken}#msg-${messageIndex}`,
        created_at: new Date(bookmark.created_at).toISOString(),
      });
    }

    return { bookmarks: enrichedResults, count: enrichedResults.length };
  },
});

export const deleteFromCLI = mutation({
  args: {
    api_token: v.string(),
    name: v.optional(v.string()),
    bookmark_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const result = await verifyApiToken(ctx, args.api_token);
    if (!result) {
      return { error: "Unauthorized" };
    }

    let bookmark: Doc<"bookmarks"> | null = null;
    if (args.name) {
      bookmark = await ctx.db
        .query("bookmarks")
        .withIndex("by_user_name", (q) => q.eq("user_id", result.userId).eq("name", args.name!))
        .first();
    } else if (args.bookmark_id) {
      bookmark = await ctx.db
        .query("bookmarks")
        .withIndex("by_user_id", (q) => q.eq("user_id", result.userId))
        .filter((q) => q.eq(q.field("_id"), args.bookmark_id as any))
        .first();
    }

    if (!bookmark) {
      return { error: "Bookmark not found" };
    }

    await deleteBookmarkWithRevision(ctx, bookmark);
    return { success: true };
  },
});

export const toggleBookmark = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      throw new Error("Unauthorized");
    }

    const validated = await validateBookmarkTarget(
      ctx,
      authUserId,
      args.conversation_id,
      args.message_id,
    );
    if (!validated.ok) throw new Error(validated.failure.message);

    if (validated.value.existing) {
      await deleteBookmarkWithRevision(ctx, validated.value.existing);
      return false;
    }

    await insertBookmarkWithRevision(ctx, {
      user_id: authUserId,
      conversation_id: args.conversation_id,
      message_id: args.message_id,
      created_at: Date.now(),
    });

    return true;
  },
});

/** Retry-safe desired-state bookmark command with relation validation. */
export const setBookmarkV2 = mutation({
  args: {
    command_id: v.string(),
    conversation_id: v.id("conversations"),
    message_id: v.id("messages"),
    bookmarked: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    return runLocalCommand(ctx, {
      principalId: userId,
      commandId: args.command_id,
      commandName: "bookmarks.set/v2",
      arguments: {
        conversationId: args.conversation_id,
        messageId: args.message_id,
        bookmarked: args.bookmarked,
      },
    }, async () => {
      const validated = await validateBookmarkTarget(
        ctx,
        userId,
        args.conversation_id,
        args.message_id,
      );
      if (!validated.ok) return validated.failure;

      let bookmarkId = validated.value.existing?._id;
      if (args.bookmarked && !validated.value.existing) {
        bookmarkId = (await insertBookmarkWithRevision(ctx, {
          user_id: userId,
          conversation_id: validated.value.conversation._id,
          message_id: validated.value.message._id,
          created_at: Date.now(),
        }, "receipt")).result;
      } else if (!args.bookmarked && validated.value.existing) {
        await deleteBookmarkWithRevision(ctx, validated.value.existing, "receipt");
        bookmarkId = undefined;
      }
      return {
        status: "acknowledged" as const,
        result: {
          conversationId: validated.value.conversation._id,
          messageId: validated.value.message._id,
          bookmarked: args.bookmarked,
          ...(bookmarkId ? { bookmarkId } : {}),
        },
        // Positive coverage is required even when desired state already held.
        coverageViews: [bookmarksCoverageTarget(userId)],
      };
    });
  },
});

export const listBookmarks = query({
  args: {},
  handler: async (ctx) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const bookmarks = await ctx.db
      .query("bookmarks")
      .withIndex("by_user_id", (q) => q.eq("user_id", authUserId))
      .collect();

    const enriched = await Promise.all(
      bookmarks.map(async (bookmark) => {
        const conversation = await ctx.db.get(bookmark.conversation_id);
        const message = await ctx.db.get(bookmark.message_id);
        if (!conversation || !message) return null;

        // Strip image markup so the preview reads as the actual text the user
        // bookmarked, not "[Image: …]" noise.
        const preview = (message.content || "")
          .replace(/\[Image[:\s][^\]]*\]/gi, "")
          .replace(/<image\b[^>]*\/?>\s*(?:<\/image>)?/gi, "")
          .trim()
          .slice(0, 140);

        return {
          _id: bookmark._id,
          conversation_id: bookmark.conversation_id,
          message_id: bookmark.message_id,
          created_at: bookmark.created_at,
          // Optional human label from the CLI (`cast bookmark --name`); shown as
          // the primary line when present so a named bookmark is self-describing.
          name: bookmark.name || null,
          note: bookmark.note || null,
          conversation_title: conversation.title || "New Session",
          conversation_updated_at: conversation.updated_at,
          conversation_message_count: conversation.message_count || 0,
          project_path: conversation.project_path,
          git_root: conversation.git_root,
          message_preview: preview,
          message_role: message.role,
          message_timestamp: message.timestamp,
        };
      })
    );

    // Newest bookmark first — the aggregate view reads as a recency stack.
    return enriched
      .filter((b): b is NonNullable<typeof b> => b !== null)
      .sort((a, b) => b.created_at - a.created_at);
  },
});

/** Complete canonical bookmark relation; enrichment remains in v1. */
export const listBookmarksV2 = query({
  args: {},
  handler: async (ctx) => {
    const contractId = BOOKMARKS_VIEW_CONTRACT_ID;
    const viewKey = BOOKMARKS_VIEW_KEY;
    const userId = await getAuthUserId(ctx);
    if (!userId) return { contractId, viewKey, access: "unauthenticated" as const };

    const [bookmarks, viewRevision] = await Promise.all([
      ctx.db
        .query("bookmarks")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect(),
      readLocalViewRevision(ctx, userId, contractId, viewKey),
    ]);
    const projected = bookmarks
      .map(projectBookmark)
      .sort((left, right) =>
        right.created_at - left.created_at
        || String(left._id).localeCompare(String(right._id)));
    return {
      contractId,
      viewKey,
      access: "granted" as const,
      grantKeys: [BOOKMARKS_GRANT_KEY],
      viewRevision,
      coverage: revisionCoverage(viewRevision),
      bookmarks: projected,
    };
  },
});

export const isBookmarked = query({
  args: {
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return false;
    }

    const bookmark = await ctx.db
      .query("bookmarks")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .filter((q) => q.eq(q.field("user_id"), authUserId))
      .first();

    return !!bookmark;
  },
});

export const getConversationBookmarks = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const authUserId = await getAuthUserId(ctx);
    if (!authUserId) {
      return [];
    }

    const bookmarks = await ctx.db
      .query("bookmarks")
      .withIndex("by_user_conversation", (q) =>
        q.eq("user_id", authUserId).eq("conversation_id", args.conversation_id)
      )
      .collect();

    return bookmarks.map((b) => b.message_id);
  },
});
