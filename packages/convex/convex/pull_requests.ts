import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    team_id: v.id("teams"),
    github_pr_id: v.number(),
    repository: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged")
    ),
    author_github_username: v.string(),
    linked_session_ids: v.array(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const prId = await ctx.db.insert("pull_requests", {
      team_id: args.team_id,
      github_pr_id: args.github_pr_id,
      repository: args.repository,
      number: args.number,
      title: args.title,
      body: args.body,
      state: args.state,
      author_github_username: args.author_github_username,
      linked_session_ids: args.linked_session_ids,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    return prId;
  },
});

export const syncPRFromGitHub = mutation({
  args: {
    team_id: v.id("teams"),
    github_pr_id: v.number(),
    repository: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged")
    ),
    author_github_username: v.string(),
    head_ref: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
    merged_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", args.github_pr_id))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        title: args.title,
        body: args.body,
        state: args.state,
        author_github_username: args.author_github_username,
        head_ref: args.head_ref,
        updated_at: args.updated_at,
        merged_at: args.merged_at,
      });
      return existing._id;
    }

    const prId = await ctx.db.insert("pull_requests", {
      team_id: args.team_id,
      github_pr_id: args.github_pr_id,
      repository: args.repository,
      number: args.number,
      title: args.title,
      body: args.body,
      state: args.state,
      author_github_username: args.author_github_username,
      head_ref: args.head_ref,
      linked_session_ids: [],
      pr_comment_posted: false,
      created_at: args.created_at,
      updated_at: args.updated_at,
      merged_at: args.merged_at,
    });

    return prId;
  },
});

export const linkPRToSession = mutation({
  args: {
    pr_id: v.id("pull_requests"),
    commit_shas: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr) {
      throw new Error(`PR with id ${args.pr_id} not found`);
    }

    const sessionIds = new Set(pr.linked_session_ids);

    for (const sha of args.commit_shas) {
      const commit = await ctx.db
        .query("commits")
        .withIndex("by_sha", (q) => q.eq("sha", sha))
        .first();

      if (commit?.conversation_id) {
        sessionIds.add(commit.conversation_id);
      }
    }

    await ctx.db.patch(args.pr_id, {
      linked_session_ids: Array.from(sessionIds),
    });

    return Array.from(sessionIds);
  },
});

export const listPRsForTeam = query({
  args: {
    team_id: v.id("teams"),
    repository: v.optional(v.string()),
    state: v.optional(
      v.union(v.literal("open"), v.literal("closed"), v.literal("merged"))
    ),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let prs = await ctx.db
      .query("pull_requests")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();

    if (args.repository) {
      prs = prs.filter((pr) => pr.repository === args.repository);
    }

    if (args.state) {
      prs = prs.filter((pr) => pr.state === args.state);
    }

    prs.sort((a, b) => b.updated_at - a.updated_at);

    if (args.limit) {
      prs = prs.slice(0, args.limit);
    }

    return prs;
  },
});

export const getPRByNumber = query({
  args: {
    repository: v.string(),
    number: v.number(),
  },
  handler: async (ctx, args) => {
    const prs = await ctx.db
      .query("pull_requests")
      .withIndex("by_repository", (q) => q.eq("repository", args.repository))
      .collect();

    return prs.find((pr) => pr.number === args.number);
  },
});

export const getPRById = query({
  args: {
    pr_id: v.id("pull_requests"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.pr_id);
  },
});

export const updatePRFiles = mutation({
  args: {
    pr_id: v.id("pull_requests"),
    files: v.array(v.object({
      filename: v.string(),
      status: v.string(),
      additions: v.number(),
      deletions: v.number(),
      changes: v.number(),
      patch: v.optional(v.string()),
    })),
    additions: v.number(),
    deletions: v.number(),
    changed_files: v.number(),
    commits_count: v.number(),
    base_ref: v.optional(v.string()),
    state: v.optional(v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged")
    )),
    merged_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr) {
      throw new Error(`PR with id ${args.pr_id} not found`);
    }

    const updates: any = {
      files: args.files,
      additions: args.additions,
      deletions: args.deletions,
      changed_files: args.changed_files,
      commits_count: args.commits_count,
      files_synced_at: Date.now(),
      updated_at: Date.now(),
    };

    if (args.base_ref) {
      updates.base_ref = args.base_ref;
    }
    if (args.state) {
      updates.state = args.state;
    }
    if (args.merged_at) {
      updates.merged_at = args.merged_at;
    }

    await ctx.db.patch(args.pr_id, updates);
    return args.pr_id;
  },
});

export const updatePRState = mutation({
  args: {
    github_pr_id: v.number(),
    state: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged")
    ),
    merged_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", args.github_pr_id))
      .first();

    if (!pr) {
      return null;
    }

    await ctx.db.patch(pr._id, {
      state: args.state,
      merged_at: args.merged_at,
      updated_at: Date.now(),
    });

    return pr._id;
  },
});

export const getPRsForConversation = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const allPRs = await ctx.db.query("pull_requests").collect();
    return allPRs.filter((pr) =>
      pr.linked_session_ids.includes(args.conversation_id)
    );
  },
});
