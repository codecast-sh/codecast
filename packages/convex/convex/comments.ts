import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";

export const addComment = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
    content: v.string(),
    parent_comment_id: v.optional(v.id("comments")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Unauthorized");
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      throw new Error("Conversation not found");
    }

    if (conversation.team_id) {
      const user = await ctx.db.get(userId);
      if (!user || user.team_id?.toString() !== conversation.team_id.toString()) {
        throw new Error("Unauthorized: not a member of this team");
      }
    }

    const commentId = await ctx.db.insert("comments", {
      conversation_id: args.conversation_id,
      message_id: args.message_id,
      user_id: userId,
      content: args.content,
      parent_comment_id: args.parent_comment_id,
      created_at: Date.now(),
    });

    const actor = await ctx.db.get(userId);
    const actorName = actor?.name || actor?.github_username || actor?.email || "Someone";

    const mentionRegex = /@(\w+)/g;
    const mentions = Array.from(args.content.matchAll(mentionRegex)).map(match => match[1]);

    if (conversation.team_id && mentions.length > 0) {
      const teamMembers = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("team_id"), conversation.team_id))
        .collect();

      for (const mention of mentions) {
        const mentionedUser = teamMembers.find(
          u => u.github_username === mention || u.name === mention
        );

        if (mentionedUser && mentionedUser._id.toString() !== userId.toString()) {
          await ctx.db.insert("notifications", {
            recipient_user_id: mentionedUser._id,
            type: "mention",
            actor_user_id: userId,
            comment_id: commentId,
            conversation_id: args.conversation_id,
            message: `${actorName} mentioned you in a comment`,
            read: false,
            created_at: Date.now(),
          });
        }
      }
    }

    if (args.parent_comment_id) {
      const parentComment = await ctx.db.get(args.parent_comment_id);
      if (parentComment && parentComment.user_id.toString() !== userId.toString()) {
        await ctx.db.insert("notifications", {
          recipient_user_id: parentComment.user_id,
          type: "comment_reply",
          actor_user_id: userId,
          comment_id: commentId,
          conversation_id: args.conversation_id,
          message: `${actorName} replied to your comment`,
          read: false,
          created_at: Date.now(),
        });
      }
    } else if (conversation.user_id.toString() !== userId.toString()) {
      await ctx.db.insert("notifications", {
        recipient_user_id: conversation.user_id,
        type: "conversation_comment",
        actor_user_id: userId,
        comment_id: commentId,
        conversation_id: args.conversation_id,
        message: `${actorName} commented on your conversation`,
        read: false,
        created_at: Date.now(),
      });
    }

    return commentId;
  },
});

export const getComments = query({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return [];
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return [];
    }

    if (conversation.team_id) {
      const user = await ctx.db.get(userId);
      if (!user || user.team_id?.toString() !== conversation.team_id.toString()) {
        return [];
      }
    }

    let comments;
    if (args.message_id) {
      comments = await ctx.db
        .query("comments")
        .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
        .collect();
    } else {
      comments = await ctx.db
        .query("comments")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .filter((q) => q.eq(q.field("message_id"), undefined))
        .collect();
    }

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

export const getCommentCount = query({
  args: {
    message_id: v.id("messages"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return 0;
    }

    const comments = await ctx.db
      .query("comments")
      .withIndex("by_message_id", (q) => q.eq("message_id", args.message_id))
      .collect();

    return comments.length;
  },
});

export const updateComment = mutation({
  args: {
    comment_id: v.id("comments"),
    content: v.string(),
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

    if (comment.user_id.toString() !== userId.toString()) {
      throw new Error("Unauthorized: can only edit your own comments");
    }

    await ctx.db.patch(args.comment_id, {
      content: args.content,
    });

    return args.comment_id;
  },
});

export const deleteComment = mutation({
  args: {
    comment_id: v.id("comments"),
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

    if (comment.user_id.toString() !== userId.toString()) {
      throw new Error("Unauthorized: can only delete your own comments");
    }

    await ctx.db.delete(args.comment_id);

    return true;
  },
});
