import { v } from "convex/values";
import { internalMutation, internalAction, internalQuery } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

export const storeWebhookEvent = internalMutation({
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

    if (args.event_type === "pull_request") {
      if (args.action === "opened") {
        void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPROpenedEvent, {
          event_id: eventId,
        });
      } else if (args.action === "synchronize") {
        void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPRSynchronizeEvent, {
          event_id: eventId,
        });
      } else if (args.action === "closed") {
        void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPRClosedEvent, {
          event_id: eventId,
        });
      }
    } else if (args.event_type === "push") {
      void ctx.scheduler.runAfter(0, internal.githubWebhooks.processPushEvent, {
        event_id: eventId,
      });
    }

    // Match agent task triggers
    let repository: string | undefined;
    try {
      const p = JSON.parse(args.payload);
      repository = p.repository?.full_name;
    } catch {}
    void ctx.scheduler.runAfter(0, internal.agentTasks.matchTaskTriggers, {
      event_type: args.event_type,
      action: args.action,
      repository,
    });

    return { success: true, duplicate: false };
  },
});

export const processPROpenedEvent = internalAction({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string; comment_posted?: boolean; files_synced?: boolean }> => {
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

    const result = await ctx.runMutation(internal.githubWebhooks.matchPRToConversation, {
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

    let filesSynced = false;
    if (result.pr_id) {
      let token = result.github_access_token;

      const installation = result.team_id ? await ctx.runQuery(internal.githubWebhooks.getInstallationForRepository, {
        repository: repositoryFullName,
        team_id: result.team_id,
      }) : null;

      if (installation) {
        try {
          const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
            installation_id: installation.installation_id,
          });
          token = tokenResult.token;
        } catch (error) {
          console.error("Failed to get installation token, falling back to user token:", error);
        }
      }

      if (token) {
        try {
          const filesData = await ctx.runAction(internal.githubApi.getPRFiles, {
            repository: repositoryFullName,
            pr_number: prNumber,
            github_access_token: token,
          });

          await ctx.runMutation(api.pull_requests.updatePRFiles, {
            pr_id: result.pr_id,
            files: filesData.files,
            additions: filesData.additions,
            deletions: filesData.deletions,
            changed_files: filesData.changed_files,
            commits_count: filesData.commits_count,
            base_ref: filesData.base_ref,
          });
          filesSynced = true;
        } catch (error) {
          console.error("Failed to fetch PR files:", error);
        }
      }
    }

    if (result.matched_conversation_id && result.pr_id) {
      const postResult: { posted: boolean; reason?: string } = await ctx.runMutation(internal.githubWebhooks.postPRCommentIfNeeded, {
        pr_id: result.pr_id,
        conversation_id: result.matched_conversation_id,
        repository: repositoryFullName,
        pr_number: prNumber,
      });

      return { success: true, comment_posted: postResult.posted, files_synced: filesSynced };
    }

    return { success: true, comment_posted: false, files_synced: filesSynced };
  },
});

export const processPRSynchronizeEvent = internalAction({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string }> => {
    const event = await ctx.runQuery(internal.githubWebhooks.getWebhookEvent, {
      event_id: args.event_id,
    });

    if (!event || event.processed) {
      return { success: false, reason: "Event not found or already processed" };
    }

    const payload = JSON.parse(event.payload) as any;
    const pr = payload.pull_request;
    const repositoryFullName: string = payload.repository.full_name;
    const prNumber: number = pr.number;
    const githubPrId: number = pr.id;

    const prData = await ctx.runQuery(internal.githubWebhooks.getPRByGithubId, {
      github_pr_id: githubPrId,
    });

    if (!prData) {
      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: false, reason: "PR not found in database" };
    }

    let token: string | null = null;

    const installation = await ctx.runQuery(internal.githubWebhooks.getInstallationForRepository, {
      repository: repositoryFullName,
      team_id: prData.team_id as Id<"teams">,
    });

    if (installation) {
      try {
        const tokenResult = await ctx.runAction(internal.githubApp.getInstallationToken, {
          installation_id: installation.installation_id,
        });
        token = tokenResult.token;
      } catch (error) {
        console.error("Failed to get installation token:", error);
      }
    }

    if (!token) {
      token = await ctx.runQuery(internal.githubWebhooks.getTokenForPR, {
        pr_id: prData._id,
      });
    }

    if (!token) {
      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: false, reason: "No GitHub token available" };
    }

    try {
      const filesData = await ctx.runAction(internal.githubApi.getPRFiles, {
        repository: repositoryFullName,
        pr_number: prNumber,
        github_access_token: token,
      });

      await ctx.runMutation(api.pull_requests.updatePRFiles, {
        pr_id: prData._id,
        files: filesData.files,
        additions: filesData.additions,
        deletions: filesData.deletions,
        changed_files: filesData.changed_files,
        commits_count: filesData.commits_count,
        base_ref: filesData.base_ref,
      });

      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: true };
    } catch (error) {
      console.error("Failed to sync PR files on synchronize:", error);
      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: false, reason: `Error: ${error}` };
    }
  },
});

export const processPRClosedEvent = internalAction({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string }> => {
    const event = await ctx.runQuery(internal.githubWebhooks.getWebhookEvent, {
      event_id: args.event_id,
    });

    if (!event || event.processed) {
      return { success: false, reason: "Event not found or already processed" };
    }

    const payload = JSON.parse(event.payload) as any;
    const pr = payload.pull_request;
    const githubPrId: number = pr.id;
    const merged: boolean = pr.merged;
    const mergedAt: string | null = pr.merged_at;

    await ctx.runMutation(api.pull_requests.updatePRState, {
      github_pr_id: githubPrId,
      state: merged ? "merged" : "closed",
      merged_at: mergedAt ? new Date(mergedAt).getTime() : undefined,
    });

    await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
    return { success: true };
  },
});

export const processPushEvent = internalAction({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args): Promise<{ success: boolean; reason?: string; commits_created?: number }> => {
    const event = await ctx.runQuery(internal.githubWebhooks.getWebhookEvent, {
      event_id: args.event_id,
    });

    if (!event || event.processed) {
      return { success: false, reason: "Event not found or already processed" };
    }

    const payload = JSON.parse(event.payload) as any;
    const repository: string = payload.repository?.full_name;
    const commits: any[] = payload.commits || [];
    const ref: string = payload.ref || "";

    if (!repository || commits.length === 0) {
      await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
      return { success: true, reason: "No commits in push event", commits_created: 0 };
    }

    const branchName = ref.replace("refs/heads/", "");

    let commitsCreated = 0;
    for (const commit of commits) {
      const sha = commit.id;
      const message = commit.message || "";
      const authorName = commit.author?.name || commit.author?.username || "Unknown";
      const authorEmail = commit.author?.email || "";
      const timestamp = commit.timestamp ? new Date(commit.timestamp).getTime() : Date.now();

      const added = commit.added?.length || 0;
      const removed = commit.removed?.length || 0;
      const modified = commit.modified?.length || 0;
      const filesChanged = added + removed + modified;

      const insertions = added + modified;
      const deletions = removed;

      const created = await ctx.runMutation(internal.githubWebhooks.createCommitFromPush, {
        sha,
        message,
        author_name: authorName,
        author_email: authorEmail,
        timestamp,
        files_changed: filesChanged,
        insertions,
        deletions,
        repository,
        branch: branchName,
      });

      if (created) {
        commitsCreated++;
      }
    }

    await ctx.runMutation(internal.githubWebhooks.markEventProcessed, { event_id: args.event_id });
    return { success: true, commits_created: commitsCreated };
  },
});

export const createCommitFromPush = internalMutation({
  args: {
    sha: v.string(),
    message: v.string(),
    author_name: v.string(),
    author_email: v.string(),
    timestamp: v.number(),
    files_changed: v.number(),
    insertions: v.number(),
    deletions: v.number(),
    repository: v.string(),
    branch: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const existing = await ctx.db
      .query("commits")
      .withIndex("by_sha", (q) => q.eq("sha", args.sha))
      .first();

    if (existing) {
      return false;
    }

    await ctx.db.insert("commits", {
      sha: args.sha,
      message: args.message,
      author_name: args.author_name,
      author_email: args.author_email,
      timestamp: args.timestamp,
      files_changed: args.files_changed,
      insertions: args.insertions,
      deletions: args.deletions,
      repository: args.repository,
    });

    return true;
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

export const getPRByGithubId = internalQuery({
  args: {
    github_pr_id: v.number(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", args.github_pr_id))
      .first();
  },
});

export const getTokenForPR = internalQuery({
  args: {
    pr_id: v.id("pull_requests"),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || pr.linked_session_ids.length === 0) {
      return null;
    }

    for (const sessionId of pr.linked_session_ids) {
      const conversation = await ctx.db.get(sessionId);
      if (conversation) {
        const user = await ctx.db.get(conversation.user_id);
        if (user?.github_access_token) {
          return user.github_access_token;
        }
      }
    }

    const teamMembers = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("team_id"), pr.team_id))
      .collect();

    for (const member of teamMembers) {
      if (member.github_access_token) {
        return member.github_access_token;
      }
    }

    return null;
  },
});

export const getInstallationForRepository = internalQuery({
  args: {
    repository: v.string(),
    team_id: v.optional(v.id("teams")),
  },
  handler: async (ctx, args) => {
    const [owner] = args.repository.split("/");

    if (args.team_id) {
      const teamId = args.team_id;
      const installations = await ctx.db
        .query("github_app_installations")
        .withIndex("by_team_id", (q) => q.eq("team_id", teamId))
        .collect();

      for (const installation of installations) {
        if (installation.account_login === owner) {
          if (installation.repository_selection === "all") {
            return installation;
          }
          if (installation.repositories?.some((r) => r.full_name === args.repository)) {
            return installation;
          }
        }
      }
    }

    const byOwner = await ctx.db
      .query("github_app_installations")
      .withIndex("by_account_login", (q) => q.eq("account_login", owner))
      .collect();

    for (const installation of byOwner) {
      if (installation.repository_selection === "all") {
        return installation;
      }
      if (installation.repositories?.some((r) => r.full_name === args.repository)) {
        return installation;
      }
    }

    return null;
  },
});

export const markEventProcessed = internalMutation({
  args: {
    event_id: v.id("github_webhook_events"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.event_id, { processed: true });
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
      .withIndex("by_git_branch", (q) => q.eq("git_branch", args.head_ref))
      .take(50);

    let teamId = conversations[0]?.team_id;

    if (!teamId) {
      const [owner] = args.repository.split("/");
      const installation = await ctx.db
        .query("github_app_installations")
        .withIndex("by_account_login", (q) => q.eq("account_login", owner))
        .first();

      if (installation) {
        teamId = installation.team_id;
      }
    }

    if (!teamId) {
      await ctx.db.patch(args.event_id, { processed: true });
      return { matched_conversation_id: null, pr_id: null, github_access_token: null, team_id: null };
    }

    let githubAccessToken: string | null = null;
    for (const conversation of conversations) {
      const user = await ctx.db.get(conversation.user_id);
      if (user?.github_access_token) {
        githubAccessToken = user.github_access_token;
        break;
      }
    }

    if (!githubAccessToken) {
      const teamMembers = await ctx.db
        .query("users")
        .filter((q) => q.eq(q.field("team_id"), teamId))
        .take(20);

      for (const member of teamMembers) {
        if (member.github_access_token) {
          githubAccessToken = member.github_access_token;
          break;
        }
      }
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
      github_access_token: githubAccessToken,
      team_id: teamId,
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

export const processCommentWebhooks = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 10;
    const events = await ctx.db
      .query("github_webhook_events")
      .withIndex("by_processed", (q) => q.eq("processed", false))
      .take(limit);

    const results = [];

    for (const event of events) {
      try {
        const payload = JSON.parse(event.payload);
        let processed = false;

        if (event.event_type === "pull_request_review_comment" && event.action === "created") {
          processed = await handleReviewCommentCreated(ctx, payload);
        } else if (event.event_type === "pull_request_review_comment" && event.action === "edited") {
          processed = await handleReviewCommentEdited(ctx, payload);
        } else if (event.event_type === "pull_request_review_comment" && event.action === "deleted") {
          processed = await handleReviewCommentDeleted(ctx, payload);
        } else if (event.event_type === "issue_comment" && event.action === "created") {
          processed = await handleIssueCommentCreated(ctx, payload);
        } else if (event.event_type === "issue_comment" && event.action === "edited") {
          processed = await handleIssueCommentEdited(ctx, payload);
        } else if (event.event_type === "issue_comment" && event.action === "deleted") {
          processed = await handleIssueCommentDeleted(ctx, payload);
        }

        if (processed) {
          await ctx.db.patch(event._id, { processed: true });
          results.push({ event_id: event._id, status: "processed" });
        } else {
          results.push({ event_id: event._id, status: "skipped" });
        }
      } catch (error) {
        results.push({
          event_id: event._id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { processed: results.length, results };
  },
});

async function handleReviewCommentCreated(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;
  const pullRequest = payload.pull_request;

  if (comment.body?.includes("codecast_comment_id:")) {
    return false;
  }

  const repository = pullRequest.base.repo.full_name;
  const prNumber = pullRequest.number;

  const pr = await ctx.db
    .query("pull_requests")
    .withIndex("by_repository", (q: any) => q.eq("repository", repository))
    .filter((q: any) => q.eq(q.field("number"), prNumber))
    .first();

  if (!pr) {
    return false;
  }

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (existing) {
    return false;
  }

  await ctx.db.insert("review_comments", {
    pull_request_id: pr._id,
    github_comment_id: comment.id,
    file_path: comment.path,
    line_number: comment.line || comment.original_line,
    content: comment.body,
    resolved: false,
    created_at: new Date(comment.created_at).getTime(),
    updated_at: new Date(comment.updated_at).getTime(),
    author_github_username: comment.user.login,
    codecast_origin: false,
  });

  return true;
}

async function handleReviewCommentEdited(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.patch(existing._id, {
    content: comment.body,
    updated_at: new Date(comment.updated_at).getTime(),
  });

  return true;
}

async function handleReviewCommentDeleted(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.delete(existing._id);

  return true;
}

async function handleIssueCommentCreated(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;
  const issue = payload.issue;

  if (!issue.pull_request) {
    return false;
  }

  if (comment.body?.includes("codecast_comment_id:")) {
    return false;
  }

  const repository = payload.repository.full_name;
  const prNumber = issue.number;

  const pr = await ctx.db
    .query("pull_requests")
    .withIndex("by_repository", (q: any) => q.eq("repository", repository))
    .filter((q: any) => q.eq(q.field("number"), prNumber))
    .first();

  if (!pr) {
    return false;
  }

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (existing) {
    return false;
  }

  await ctx.db.insert("review_comments", {
    pull_request_id: pr._id,
    github_comment_id: comment.id,
    content: comment.body,
    resolved: false,
    created_at: new Date(comment.created_at).getTime(),
    updated_at: new Date(comment.updated_at).getTime(),
    author_github_username: comment.user.login,
    codecast_origin: false,
  });

  return true;
}

async function handleIssueCommentEdited(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.patch(existing._id, {
    content: comment.body,
    updated_at: new Date(comment.updated_at).getTime(),
  });

  return true;
}

async function handleIssueCommentDeleted(ctx: any, payload: any): Promise<boolean> {
  const comment = payload.comment;

  const existing = await ctx.db
    .query("review_comments")
    .withIndex("by_github_comment_id", (q: any) => q.eq("github_comment_id", comment.id))
    .first();

  if (!existing) {
    return false;
  }

  await ctx.db.delete(existing._id);

  return true;
}
