import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";

export const addCommit = mutation({
  args: {
    conversation_id: v.optional(v.id("conversations")),
    sha: v.string(),
    message: v.string(),
    author_name: v.string(),
    author_email: v.string(),
    timestamp: v.number(),
    files_changed: v.number(),
    insertions: v.number(),
    deletions: v.number(),
    repository: v.optional(v.string()),
    pr_number: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("commits")
      .withIndex("by_sha", (q) => q.eq("sha", args.sha))
      .first();

    if (existing) {
      return existing._id;
    }

    const commitId = await ctx.db.insert("commits", {
      conversation_id: args.conversation_id,
      sha: args.sha,
      message: args.message,
      author_name: args.author_name,
      author_email: args.author_email,
      timestamp: args.timestamp,
      files_changed: args.files_changed,
      insertions: args.insertions,
      deletions: args.deletions,
      repository: args.repository,
      pr_number: args.pr_number,
    });

    if (args.conversation_id) {
      const conversation = await ctx.db.get(args.conversation_id);
      if (conversation?.team_id && conversation.is_private === false) {
        await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
          team_id: conversation.team_id,
          actor_user_id: conversation.user_id,
          event_type: "commit_pushed" as const,
          title: args.message.split('\n')[0],
          description: args.repository,
          related_conversation_id: args.conversation_id,
          related_commit_sha: args.sha,
          metadata: {
            files_changed: args.files_changed,
            insertions: args.insertions,
            deletions: args.deletions,
          },
        });
      }
    }

    return commitId;
  },
});

export const linkCommitToSession = mutation({
  args: {
    commit_sha: v.string(),
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const commit = await ctx.db
      .query("commits")
      .withIndex("by_sha", (q) => q.eq("sha", args.commit_sha))
      .first();

    if (!commit) {
      throw new Error(`Commit with sha ${args.commit_sha} not found`);
    }

    await ctx.db.patch(commit._id, {
      conversation_id: args.conversation_id,
    });

    return commit._id;
  },
});

export const getCommitsForConversation = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const commits = await ctx.db
      .query("commits")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .collect();

    return commits.sort((a, b) => b.timestamp - a.timestamp);
  },
});

export const getCommitsForTimeline = query({
  args: {
    start_time: v.optional(v.number()),
    end_time: v.optional(v.number()),
    repository: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let query = ctx.db.query("commits").withIndex("by_timestamp");

    const commits = await query.collect();

    let filtered = commits;

    if (args.start_time !== undefined) {
      filtered = filtered.filter((c) => c.timestamp >= args.start_time!);
    }

    if (args.end_time !== undefined) {
      filtered = filtered.filter((c) => c.timestamp <= args.end_time!);
    }

    if (args.repository) {
      filtered = filtered.filter((c) => c.repository === args.repository);
    }

    filtered.sort((a, b) => b.timestamp - a.timestamp);

    if (args.limit) {
      filtered = filtered.slice(0, args.limit);
    }

    return filtered;
  },
});
