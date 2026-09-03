import { mutation, query, action, internalAction, internalQuery, internalMutation } from "./functions";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { internal, api } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessConversation, canAccessCommit } from "./lib/access";
import { isConversationTeamVisible } from "./privacy";

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
    files: v.optional(v.array(v.object({
      filename: v.string(),
      status: v.string(),
      additions: v.number(),
      deletions: v.number(),
      changes: v.number(),
      patch: v.optional(v.string()),
    }))),
  },
  handler: async (ctx, args) => {
    // Public mutation that writes into a caller-supplied conversation's
    // timeline and schedules team-activity and insight generation against it.
    // Without these checks anyone could fabricate commits in another user's
    // session and trigger billed work on it.
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    if (args.conversation_id) {
      const conversation = await ctx.db.get(args.conversation_id);
      if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) {
        throw new Error("No access to that conversation");
      }
    }

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
      files: args.files,
    });

    if (args.conversation_id) {
      const conversation = await ctx.db.get(args.conversation_id);
      if (conversation) {
        if (conversation.team_id && await isConversationTeamVisible(ctx, conversation)) {
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

        await ctx.scheduler.runAfter(0, internal.sessionInsights.generateSessionInsight, {
          conversation_id: args.conversation_id,
          reason: "commit",
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
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not authenticated");
    const target = await ctx.db.get(args.conversation_id);
    if (!target || !(await canAccessConversation(ctx, userId, target))) {
      throw new Error("No access to that conversation");
    }

    const commit = await ctx.db
      .query("commits")
      .withIndex("by_sha", (q) => q.eq("sha", args.commit_sha))
      .first();

    if (!commit) {
      throw new Error(`Commit with sha ${args.commit_sha} not found`);
    }
    // Repointing a commit that already belongs to a conversation requires
    // access to the one it is leaving, not just the one it is joining.
    if (commit.conversation_id) {
      const current = await ctx.db.get(commit.conversation_id);
      if (current && !(await canAccessConversation(ctx, userId, current))) {
        throw new Error("No access to that commit");
      }
    }

    await ctx.db.patch(commit._id, {
      conversation_id: args.conversation_id,
    });

    return commit._id;
  },
});

// `commits` rows carry files[].patch — the actual source diff — so every read
// below must be authenticated. NOTE: the table has no user_id/team_id column,
// and syncRepositoryCommits creates rows with no conversation_id, so a row's
// owner is only reachable when conversation_id is set. Rows without one cannot
// be attributed and are withheld (fail closed). Giving `commits` an owner
// column is the real fix; until then these read as "signed in, and either the
// row is yours by conversation or it is not served".
async function accessibleCommits<
  T extends { conversation_id?: Id<"conversations">; team_id?: Id<"teams"> },
>(
  ctx: Parameters<typeof canAccessCommit>[0],
  userId: Id<"users">,
  commits: T[],
): Promise<T[]> {
  // A repository's commits arrive in long runs that share one session or one
  // team, so the verdict is cached per provenance pair instead of being derived
  // again for every row.
  const verdict = new Map<string, boolean>();
  const out: T[] = [];
  for (const c of commits) {
    const key = `${c.conversation_id ?? ""}|${c.team_id ?? ""}`;
    if (!verdict.has(key)) verdict.set(key, await canAccessCommit(ctx, userId, c));
    if (verdict.get(key)) out.push(c);
  }
  return out;
}

export const getCommitsForConversation = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return [];

    const commits = await ctx.db
      .query("commits")
      .withIndex("by_conversation_id", (q) =>
        q.eq("conversation_id", args.conversation_id)
      )
      .collect();

    return commits.sort((a, b) => b.timestamp - a.timestamp);
  },
});

export const getCommitBySha = query({
  args: {
    sha: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const commit = await ctx.db
      .query("commits")
      .withIndex("by_sha", (q) => q.eq("sha", args.sha))
      .first();
    if (!commit) return null;
    return (await accessibleCommits(ctx, userId, [commit]))[0] ?? null;
  },
});

export const getCommitsByRepository = query({
  args: {
    repository: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const commits = await ctx.db
      .query("commits")
      .withIndex("by_repository", (q) => q.eq("repository", args.repository))
      .collect();

    commits.sort((a, b) => b.timestamp - a.timestamp);
    const allowed = await accessibleCommits(ctx, userId, commits);

    if (args.limit) {
      return allowed.slice(0, args.limit);
    }

    return allowed;
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
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const limit = args.limit ?? 100;

    const commits = await ctx.db
      .query("commits")
      .withIndex("by_timestamp")
      .order("desc")
      .take(limit * 2);

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

    return (await accessibleCommits(ctx, userId, filtered)).slice(0, limit);
  },
});

export const getUserGitHubToken = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const user = await ctx.db.get(userId);
    return user?.github_access_token || null;
  },
});

function extractRepoFromRemoteUrl(remoteUrl: string): string | null {
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  const httpsMatch = remoteUrl.match(/https?:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  return null;
}

export const getUserActiveRepositories = internalQuery({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];

    // Take limited conversations to avoid byte limit - most recent 200 should cover active repos
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .order("desc")
      .take(200);

    const repos = new Set<string>();
    for (const conv of conversations) {
      if (conv.git_remote_url) {
        const repo = extractRepoFromRemoteUrl(conv.git_remote_url);
        if (repo) repos.add(repo);
      }
    }

    return Array.from(repos);
  },
});

export const clearMyGitHubData = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Not authenticated");
    }

    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();

    let commitsDeleted = 0;
    for (const conversation of conversations) {
      const commits = await ctx.db
        .query("commits")
        .withIndex("by_conversation_id", (q) => q.eq("conversation_id", conversation._id))
        .collect();
      for (const commit of commits) {
        await ctx.db.delete(commit._id);
        commitsDeleted++;
      }
    }

    return { commitsDeleted };
  },
});

// REMOVED: clearAllCommits — an argument-less public mutation that deleted the
// entire commits table for every user. Convex exports every public function, so
// it was callable by anyone with the deployment URL and had no caller in the
// repo. `clearMyGitHubData` above covers the legitimate case, scoped to the
// authenticated user's own conversations.

export const syncAllMyRepositories = action({
  args: {
    per_page: v.optional(v.number()),
  },
  returns: v.object({ repos_synced: v.number(), total_commits: v.number() }),
  handler: async (ctx, args): Promise<{ repos_synced: number; total_commits: number }> => {
    const token = await ctx.runQuery(internal.commits.getUserGitHubToken, {});
    if (!token) {
      throw new Error("GitHub account not connected");
    }

    const activeRepos = await ctx.runQuery(internal.commits.getUserActiveRepositories, {});

    if (activeRepos.length === 0) {
      return { repos_synced: 0, total_commits: 0 };
    }

    let totalCommits = 0;
    let reposSynced = 0;

    for (const repo of activeRepos) {
      try {
        const result = await ctx.runAction(api.githubApi.syncRepositoryCommits, {
          repository: repo,
          github_access_token: token,
          per_page: args.per_page ?? 30,
        });
        totalCommits += result.synced;
        reposSynced++;
      } catch (e) {
        console.error(`Failed to sync ${repo}:`, e);
      }
    }

    return { repos_synced: reposSynced, total_commits: totalCommits };
  },
});

export const getActiveRepositoriesForUser = internalQuery({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    // Take limited conversations to avoid byte limit - most recent 200 should cover active repos
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_user_id", (q) => q.eq("user_id", args.user_id))
      .order("desc")
      .take(200);

    const repos = new Set<string>();
    for (const conv of conversations) {
      if (conv.git_remote_url) {
        const repo = extractRepoFromRemoteUrl(conv.git_remote_url);
        if (repo) repos.add(repo);
      }
    }

    return Array.from(repos);
  },
});

// Internal only: this loads the target user's github_access_token and drives
// GitHub as them. No client calls it, and a public shape taking a raw user_id
// would let any caller spend any user's credential.
export const syncRepositoriesForUser = internalAction({
  args: {
    user_id: v.id("users"),
    per_page: v.optional(v.number()),
  },
  returns: v.object({ repos_synced: v.number(), total_commits: v.number(), repos: v.array(v.string()) }),
  handler: async (ctx, args): Promise<{ repos_synced: number; total_commits: number; repos: string[] }> => {
    const user = await ctx.runQuery(internal.commits.getUserById, { user_id: args.user_id });
    if (!user?.github_access_token) {
      throw new Error("User has no GitHub token");
    }

    const activeRepos = await ctx.runQuery(internal.commits.getActiveRepositoriesForUser, {
      user_id: args.user_id,
    });

    if (activeRepos.length === 0) {
      return { repos_synced: 0, total_commits: 0, repos: [] };
    }

    let totalCommits = 0;
    let reposSynced = 0;

    for (const repo of activeRepos) {
      try {
        const result = await ctx.runAction(api.githubApi.syncRepositoryCommits, {
          repository: repo,
          github_access_token: user.github_access_token,
          per_page: args.per_page ?? 100,
        });
        totalCommits += result.synced;
        reposSynced++;
      } catch (e) {
        console.error(`Failed to sync ${repo}:`, e);
      }
    }

    return { repos_synced: reposSynced, total_commits: totalCommits, repos: activeRepos };
  },
});

export const getUserById = internalQuery({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.user_id);
  },
});

// ── Filling in a commit that arrived without its diff ──
//
// A push webhook carries the message and the file names but no patch, so a
// commit ingested that way has no diff to show. repos.ensureCommitFiles is the
// read-through that fetches it; these two are its halves.

export const commitFilesState = internalQuery({
  args: { repository: v.string(), sha: v.string() },
  handler: async (ctx, args) => {
    const commit = await ctx.db
      .query("commits")
      .withIndex("by_sha", (q) => q.eq("sha", args.sha))
      .first();
    if (!commit || commit.repository !== args.repository) return null;
    return { commit_id: commit._id, has_files: (commit.files?.length ?? 0) > 0 };
  },
});

export const applyCommitFiles = internalMutation({
  args: {
    commit_id: v.id("commits"),
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
    author_login: v.optional(v.string()),
    author_avatar_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const commit = await ctx.db.get(args.commit_id);
    if (!commit) return { ok: false };

    // The counts from a push payload are often zero, so the real ones from the
    // commit endpoint replace them. Author identity is only filled in when the
    // row is missing it, since the ingest path may know better.
    const patch: Record<string, any> = {
      files: args.files,
      files_changed: args.files.length,
      insertions: args.additions,
      deletions: args.deletions,
    };
    if (!commit.author_login && args.author_login) patch.author_login = args.author_login;
    if (!commit.author_avatar_url && args.author_avatar_url) {
      patch.author_avatar_url = args.author_avatar_url;
    }
    await ctx.db.patch(args.commit_id, patch);
    return { ok: true };
  },
});
