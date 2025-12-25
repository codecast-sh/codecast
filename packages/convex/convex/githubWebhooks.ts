import { v } from "convex/values";
import { mutation, internalMutation, internalAction, internalQuery, action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

export const storeWebhookEvent = mutation({
  args: {
    delivery_id: v.string(),
    event_type: v.string(),
    action: v.optional(v.string()),
    payload: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("github_webhook_events")
      .withIndex("by_delivery_id", (q) => q.eq("delivery_id", args.delivery_id))
      .first();

    if (existing) {
      return { success: true, duplicate: true };
    }

    const eventId = await ctx.db.insert("github_webhook_events", {
      delivery_id: args.delivery_id,
      event_type: args.event_type,
      action: args.action,
      payload: args.payload,
      processed: false,
      created_at: Date.now(),
    });

    if (args.event_type === "pull_request" && args.action === "opened") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPROpenedEvent, {
        event_id: eventId,
      });
    }

    return { success: true, duplicate: false };
  },
});

export const processPROpenedEvent = internalAction({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string; comment_posted?: boolean }> => {
    const event = await ctx.runQuery(internal.githubWebhooks.getWebhookEvent, {
      event_id: args.event_id,
    });

    if (!event || event.processed) {
      return { success: false, reason: "Event not found or already processed" };
    }

    const payload = JSON.parse(event.payload) as any;
    const pr = payload.pull_request;
    const repository = payload.repository;

    const repositoryFullName: string = repository.full_name;
    const prNumber: number = pr.number;
    const headRef: string = pr.head.ref;

    const result: { matched_conversation_id: Id<"conversations"> | null; pr_id: Id<"pull_requests"> | null } = await ctx.runMutation(internal.githubWebhooks.matchPRToConversation, {
      event_id: args.event_id,
      repository: repositoryFullName,
      pr_number: prNumber,
      head_ref: headRef,
      github_pr_id: pr.id,
      title: pr.title,
      body: pr.body || "",
      author_username: pr.user.login,
      created_at: new Date(pr.created_at).getTime(),
      updated_at: new Date(pr.updated_at).getTime(),
    });

    if (result.matched_conversation_id && result.pr_id) {
      const postResult: { posted: boolean; reason?: string } = await ctx.runMutation(internal.githubWebhooks.postPRCommentIfNeeded, {
        pr_id: result.pr_id,
        conversation_id: result.matched_conversation_id,
        repository: repositoryFullName,
        pr_number: prNumber,
      });

      return { success: true, comment_posted: postResult.posted };
    }

    return { success: true, comment_posted: false };
  },
});

export const getWebhookEvent = internalQuery({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.event_id);
  },
});

export const matchPRToConversation = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
    repository: v.string(),
    pr_number: v.number(),
    head_ref: v.string(),
    github_pr_id: v.number(),
    title: v.string(),
    body: v.string(),
    author_username: v.string(),
    created_at: v.number(),
    updated_at: v.number(),
  },
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .filter((q) => q.eq(q.field("git_branch"), args.head_ref))
      .collect();

    const teamId = conversations[0]?.team_id;

    if (!teamId) {
      await ctx.db.patch(args.event_id, { processed: true });
      return { matched_conversation_id: null, pr_id: null };
    }

    const prId = await ctx.db.insert("pull_requests", {
      team_id: teamId,
      github_pr_id: args.github_pr_id,
      repository: args.repository,
      number: args.pr_number,
      title: args.title,
      body: args.body,
      state: "open",
      author_github_username: args.author_username,
      head_ref: args.head_ref,
      linked_session_ids: conversations.map((c) => c._id),
      pr_comment_posted: false,
      created_at: args.created_at,
      updated_at: args.updated_at,
    });

    await ctx.db.patch(args.event_id, { processed: true });

    return {
      matched_conversation_id: conversations[0]?._id || null,
      pr_id: prId,
    };
  },
});

export const postPRCommentIfNeeded = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    conversation_id: v.id("conversations"),
    repository: v.string(),
    pr_number: v.number(),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || pr.pr_comment_posted) {
      return { posted: false, reason: "Already posted or PR not found" };
    }

    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) {
      return { posted: false, reason: "Conversation not found" };
    }

    const user = await ctx.db.get(conversation.user_id);
    if (!user?.github_access_token) {
      return { posted: false, reason: "No GitHub access token available" };
    }

    if (user.pr_auto_comment_enabled === false) {
      return { posted: false, reason: "Auto-commenting disabled in user settings" };
    }

    const conversationUrl = `https://codecast.sh/c/${args.conversation_id}`;
    const commentBody = `## 🎙️ Codecast Conversation\n\n**${conversation.title || "Untitled Conversation"}**\n\nThis PR was created during a Codecast session.\n\n[View full conversation →](${conversationUrl})`;

    try {
      void ctx.scheduler.runAfter(0, api.githubApi.postPRComment, {
        repository: args.repository,
        pr_number: args.pr_number,
        comment_body: commentBody,
        github_access_token: user.github_access_token,
      });

      await ctx.db.patch(args.pr_id, {
        pr_comment_posted: true,
      });

      return { posted: true };
    } catch (error) {
      console.error("Failed to post PR comment:", error);
      return { posted: false, reason: `Error: ${error}` };
    }
  },
});
