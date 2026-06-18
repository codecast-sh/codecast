import { mutation, query, internalMutation } from "./functions";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { Id } from "./_generated/dataModel";
import { internal, api } from "./_generated/api";
import { canTeamMemberAccess } from "./privacy";
import { enqueuePendingMessage } from "./pendingMessages";

export const addComment = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
    content: v.string(),
    parent_comment_id: v.optional(v.id("comments")),
    pr_id: v.optional(v.id("pull_requests")),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    client_id: v.optional(v.string()),
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

    const isOwner = conversation.user_id.toString() === userId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, userId, conversation))) {
        throw new Error("Unauthorized: not allowed to comment on this conversation");
      }
    }

    // Dedup on client_id so a dispatch-outbox retry (the optimistic store flow)
    // can't insert the same comment twice.
    if (args.client_id) {
      const dupe = (await ctx.db
        .query("comments")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
        .collect())
        .find((c) => c.client_id === args.client_id);
      if (dupe) return dupe._id;
    }

    const commentId = await ctx.db.insert("comments", {
      conversation_id: args.conversation_id,
      message_id: args.message_id,
      user_id: userId,
      content: args.content,
      parent_comment_id: args.parent_comment_id,
      created_at: Date.now(),
      pr_id: args.pr_id,
      file_path: args.file_path,
      line_number: args.line_number,
      client_id: args.client_id,
    });

    const actor = await ctx.db.get(userId);
    const actorName = actor?.name || actor?.github_username || actor?.email || "Someone";

    await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
      user_id: userId,
      entity_type: "conversation",
      entity_id: args.conversation_id.toString(),
      reason: "commenter",
    });

    const mentionRegex = /@(\w+)/g;
    const mentions = Array.from(args.content.matchAll(mentionRegex)).map(match => match[1]);

    if (conversation.team_id && mentions.length > 0) {
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", conversation.team_id))
        .collect();
      const teamMembers = await Promise.all(memberships.map((m: any) => ctx.db.get(m.user_id)));
      const validMembers = teamMembers.filter((u: any): u is NonNullable<typeof u> => u !== null);

      for (const mention of mentions) {
        const mentionedUser = validMembers.find(
          u => u.github_username === mention || u.name === mention
        );

        if (mentionedUser && mentionedUser._id.toString() !== userId.toString()) {
          await ctx.runMutation(internal.notificationRouter.ensureSubscribed, {
            user_id: mentionedUser._id,
            entity_type: "conversation",
            entity_id: args.conversation_id.toString(),
            reason: "mentioned",
          });
          await ctx.runMutation(internal.notificationRouter.emit, {
            event_type: "mention",
            actor_user_id: userId,
            entity_type: "conversation",
            entity_id: args.conversation_id.toString(),
            message: `${actorName} mentioned you in a comment`,
            conversation_id: args.conversation_id,
            comment_id: commentId,
            direct_recipient_id: mentionedUser._id,
          });
        }
      }
    }

    if (args.parent_comment_id) {
      const parentComment = await ctx.db.get(args.parent_comment_id);
      if (parentComment && parentComment.user_id.toString() !== userId.toString()) {
        await ctx.runMutation(internal.notificationRouter.emit, {
          event_type: "comment_reply",
          actor_user_id: userId,
          entity_type: "conversation",
          entity_id: args.conversation_id.toString(),
          message: `${actorName} replied to your comment`,
          conversation_id: args.conversation_id,
          comment_id: commentId,
          direct_recipient_id: parentComment.user_id,
        });
      }
    } else if (conversation.user_id.toString() !== userId.toString()) {
      await ctx.runMutation(internal.notificationRouter.emit, {
        event_type: "conversation_comment",
        actor_user_id: userId,
        entity_type: "conversation",
        entity_id: args.conversation_id.toString(),
        message: `${actorName} commented on your conversation`,
        conversation_id: args.conversation_id,
        comment_id: commentId,
        direct_recipient_id: conversation.user_id,
      });
    }

    let prIdToSync = args.pr_id;
    if (!prIdToSync) {
      const prs = await ctx.db
        .query("pull_requests")
        .collect();

      const linkedPR = prs.find(pr =>
        pr.linked_session_ids.some(id => id.toString() === args.conversation_id.toString())
      );

      if (linkedPR) {
        prIdToSync = linkedPR._id;
      }
    }

    if (prIdToSync) {
      const pr = await ctx.db.get(prIdToSync);
      const user = await ctx.db.get(userId);

      if (pr && user?.github_access_token) {
        await ctx.scheduler.runAfter(0, internal.githubApi.postCommentToGitHub, {
          repository: pr.repository,
          pr_number: pr.number,
          content: args.content,
          file_path: args.file_path,
          line_number: args.line_number,
          github_access_token: user.github_access_token,
          comment_id: commentId,
        });
      }
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

    const isOwner = conversation.user_id.toString() === userId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, userId, conversation))) {
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

export const getConversationCommentSummary = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];

    const isOwner = conversation.user_id.toString() === userId.toString();
    if (!isOwner) {
      if (!(await canTeamMemberAccess(ctx, userId, conversation))) {
        return [];
      }
    }

    const comments = await ctx.db
      .query("comments")
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
            github_username: user?.github_username,
            github_avatar_url: user?.github_avatar_url,
          },
        };
      })
    );

    return commentsWithUsers.sort((a, b) => a.created_at - b.created_at);
  },
});

export const updateGitHubCommentId = mutation({
  args: {
    comment_id: v.id("comments"),
    github_comment_id: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.comment_id, {
      github_comment_id: args.github_comment_id,
    });

    return true;
  },
});

// ── Ask the agent to reply in a comment thread ───────────────────────────────
// Opt-in: a teammate presses "Ask agent to reply". We drop a placeholder agent
// comment (status "thinking") so the UI reacts instantly, then spawn a HIDDEN
// fork of the conversation (full transcript, reusing the normal fork machinery)
// and deliver the comment thread to it as one structured prompt biased toward a
// short reply. The fork is marked is_subagent so it never shows in the feed — it
// "only lives in this thread." When its agent answers, addMessages schedules
// mirrorAgentReply, which copies the reply back into the placeholder comment.

function buildAgentThreadPrompt(
  entries: Array<{ name: string; content: string; isAgent: boolean }>,
  anchorSnippet: string | undefined,
  followUp: boolean,
): string {
  const lines: string[] = [];
  if (followUp) {
    lines.push(
      "New replies arrived in the same COMMENT THREAD you're already in. " +
        "Continue the conversation — answer the latest, concisely.",
    );
  } else {
    lines.push(
      "A teammate asked you to reply inside a COMMENT THREAD on this conversation. " +
        "These are side-channel comments between teammates (and you), not the main task.",
    );
    if (anchorSnippet) {
      lines.push("");
      lines.push("The thread is anchored to this message in the transcript:");
      lines.push(`> ${anchorSnippet}`);
    }
  }
  lines.push("");
  lines.push(followUp ? "New comments since your last reply:" : "Comment thread so far (oldest first):");
  for (const e of entries) {
    if (!e.content.trim()) continue;
    lines.push(`- ${e.isAgent ? "You (earlier)" : e.name}: ${e.content.trim()}`);
  }
  lines.push("");
  lines.push(
    "Write a reply to post back into this thread. Keep it concise and conversational — " +
      "a short, direct comment a colleague would send in chat, not a report. " +
      "Lead with the answer; skip preamble and restating the question. " +
      "Markdown is fine. Don't run tools unless the thread truly requires it.",
  );
  return lines.join("\n");
}

export const askAgentInThread = mutation({
  args: {
    conversation_id: v.id("conversations"),
    message_id: v.optional(v.id("messages")),
    client_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) throw new Error("Conversation not found");

    const isOwner = conversation.user_id.toString() === userId.toString();
    if (!isOwner && !(await canTeamMemberAccess(ctx, userId, conversation))) {
      throw new Error("Unauthorized: not allowed to comment on this conversation");
    }

    // Dedup on client_id (optimistic store retry guard).
    const allInConv = await ctx.db
      .query("comments")
      .withIndex("by_conversation_id", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    if (args.client_id) {
      const dupe = allInConv.find((c) => c.client_id === args.client_id);
      if (dupe) return { comment_id: dupe._id, fork_conversation_id: dupe.fork_conversation_id };
    }

    // This thread's comments, oldest first.
    const threadComments = allInConv
      .filter((c) => (args.message_id ? c.message_id === args.message_id : !c.message_id))
      .sort((a, b) => a.created_at - b.created_at);

    // One fork per thread: find the warm fork from a prior agent reply in this
    // thread (its conversation must still exist), and reuse it. The first ask
    // pays the full-fork spin-up; later asks just message the live fork, which
    // already holds the parent transcript + the earlier back-and-forth.
    let existingForkId: Id<"conversations"> | undefined;
    let lastAgentAt = 0;
    for (const c of threadComments) {
      if (c.author_kind === "agent" && c.fork_conversation_id) {
        const f = await ctx.db.get(c.fork_conversation_id);
        if (f) { existingForkId = c.fork_conversation_id; lastAgentAt = Math.max(lastAgentAt, c.created_at); }
      }
    }
    const reuse = !!existingForkId;

    // Build the structured transcript. On reuse, only the comments since the last
    // agent reply are new to the fork; on first ask, the whole thread.
    const relevant = threadComments
      .filter((c) => c.content.trim().length > 0 && (!reuse || c.created_at > lastAgentAt));
    const nameCache = new Map<string, string>();
    const entries: Array<{ name: string; content: string; isAgent: boolean }> = [];
    for (const c of relevant) {
      const isAgent = c.author_kind === "agent";
      let name = "Teammate";
      if (!isAgent) {
        const key = c.user_id.toString();
        if (nameCache.has(key)) name = nameCache.get(key)!;
        else {
          const u = await ctx.db.get(c.user_id);
          name = u?.name || u?.github_username || u?.email || "Teammate";
          nameCache.set(key, name);
        }
      }
      entries.push({ name, content: c.content, isAgent });
    }

    let anchorSnippet: string | undefined;
    if (args.message_id) {
      const m = await ctx.db.get(args.message_id);
      anchorSnippet = (m?.content || "").replace(/\s+/g, " ").trim().slice(0, 240) || undefined;
    }

    const prompt = buildAgentThreadPrompt(entries, anchorSnippet, reuse);
    const now = Date.now();

    // Placeholder agent comment — the UI shows "thinking…" immediately.
    const commentId = await ctx.db.insert("comments", {
      conversation_id: args.conversation_id,
      message_id: args.message_id,
      user_id: userId,
      content: "",
      created_at: now,
      author_kind: "agent",
      agent_status: "thinking",
      client_id: args.client_id,
    });

    let forkId: Id<"conversations">;
    if (existingForkId) {
      // Reuse the warm fork: just point it at the new placeholder + send the
      // follow-up. comment_fork_prompt_at separates this reply from everything
      // already in the fork (history + the prior turns), so the mirror picks the
      // right message.
      forkId = existingForkId;
      await ctx.db.patch(forkId, {
        comment_fork_comment_id: commentId,
        comment_fork_prompt_at: now,
      });
    } else {
      // First ask: spawn the hidden fork (full transcript) via the normal fork
      // path, then tag it as a comment-fork and hide it from the feed.
      const fork = await ctx.runMutation(api.conversations.forkFromMessage, {
        conversation_id: args.conversation_id,
      });
      forkId = fork.conversation_id as Id<"conversations">;
      await ctx.db.patch(forkId, {
        is_subagent: true,
        parent_conversation_id: args.conversation_id,
        comment_fork_parent: args.conversation_id,
        comment_fork_message_id: args.message_id ? args.message_id.toString() : undefined,
        comment_fork_comment_id: commentId,
        comment_fork_prompt_at: now,
        title: "Comment thread reply",
      });
    }
    await ctx.db.patch(commentId, { fork_conversation_id: forkId });

    // Deliver the thread to the fork's agent. The fork owner is the asker, so the
    // asker's daemon picks it up (or queues until it's online).
    const forkConv = await ctx.db.get(forkId);
    if (forkConv) {
      await enqueuePendingMessage(ctx, forkConv, userId, { content: prompt });
    }

    return { comment_id: commentId, fork_conversation_id: forkId };
  },
});

// Scheduled (off the addMessages hot path) when a comment-fork produces an
// assistant message. Copies the agent's reply — the newest assistant message
// newer than the prompt, so the copied parent history never matches — into the
// placeholder comment.
export const mirrorAgentReply = internalMutation({
  args: { fork_conversation_id: v.id("conversations") },
  handler: async (ctx, args) => {
    const fork = await ctx.db.get(args.fork_conversation_id);
    if (!fork || !fork.comment_fork_comment_id) return;
    const comment = await ctx.db.get(fork.comment_fork_comment_id);
    if (!comment) return;

    const promptAt = fork.comment_fork_prompt_at ?? 0;
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_conversation_timestamp", (q) => q.eq("conversation_id", args.fork_conversation_id))
      .order("desc")
      .take(12);
    const reply = recent.find(
      (m) => m.role === "assistant" && (m.content || "").trim().length > 0 && m.timestamp > promptAt,
    );
    if (!reply) return;

    const content = reply.content || "";
    if (comment.content === content && comment.agent_status === "done") return;
    await ctx.db.patch(comment._id, { content, agent_status: "done" });
  },
});
