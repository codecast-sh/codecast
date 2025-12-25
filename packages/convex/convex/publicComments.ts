import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

export const addPublicComment = mutation({
  args: {
    conversation_id: v.id("conversations"),
    content: v.string(),
    parent_comment_id: v.optional(v.id("public_comments")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized - must be logged in to comment");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (!conversation.share_token) {
      throw new Error("Cannot comment on non-public conversations");
    }

    const commentId = await ctx.db.insert("public_comments", {
      conversation_id: args.conversation_id,
      user_id: userId,
      content: args.content,
      parent_comment_id: args.parent_comment_id,
      created_at: Date.now(),
    });

    return commentId;
  },
});

export const getPublicComments = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !conversation.share_token) {
      return [];
    }

    const comments = await ctx.db
      .query("public_comments")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();

    const commentsWithUsers = await Promise.all(
      comments.map(async (comment) => {
        const user = await ctx.db.get(comment.user_id);
        return {
          ...comment,
          user: {
            _id: user?._id,
            name: user?.name,
            image: user?.image,
            github_username: user?.github_username,
            github_avatar_url: user?.github_avatar_url,
          },
        };
      })
    );

    return commentsWithUsers.sort((a, b) => a.created_at - b.created_at);
  },
});

export const deletePublicComment = mutation({
  args: {
    comment_id: v.id("public_comments"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const comment = await ctx.db.get(args.comment_id);
    if (!comment) {
      throw new Error("Comment not found");
    }

    const conversation = await ctx.db.get(comment.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    const isAuthor = comment.user_id.toString() === userId.toString();
    const isConversationOwner = conversation.user_id.toString() === userId.toString();

    if (!isAuthor && !isConversationOwner) {
      throw new Error("Unauthorized: can only delete your own comments or moderate as conversation owner");
    }

    await ctx.db.delete(args.comment_id);

    return true;
  },
});
