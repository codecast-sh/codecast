import { v } from "convex/values";
import { internalMutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireUser } from "./lib/auth";
import { normalizeRepository } from "./lib/gitRefs";
import {
  canAccessConversation,
  canAccessPullRequest,
  requireTeamMembership,
} from "./lib/access";

/**
 * A merge is the one pull request moment the team feed carries, and it must be
 * recorded exactly once no matter which path saw the merge: the periodic sync,
 * the state patch, or the closed webhook. All three call this, so the rule for
 * "did it just merge" lives in one place.
 */
export async function recordPRMergedActivity(
  ctx: any,
  pr: {
    _id: any;
    team_id: any;
    number: number;
    title: string;
    repository: string;
    head_ref?: string;
    author_github_username: string;
  },
  previousState: string | undefined,
  nextState: string,
): Promise<boolean> {
  if (previousState === "merged" || nextState !== "merged") return false;
  const actorUserId = await resolveActorUserIdForTeam(ctx, pr.team_id, pr.author_github_username);
  if (!actorUserId) return false;
  await ctx.scheduler.runAfter(0, internal.teamActivity.recordTeamActivity, {
    team_id: pr.team_id,
    actor_user_id: actorUserId,
    event_type: "pr_merged" as const,
    title: `Merged PR #${pr.number}: ${pr.title}`,
    description: pr.repository,
    related_pr_id: pr._id,
    metadata: {
      git_branch: pr.head_ref,
    },
  });
  return true;
}

async function resolveActorUserIdForTeam(
  ctx: any,
  teamId: any,
  githubUsername: string
) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_github_username", (q: any) => q.eq("github_username", githubUsername))
    .first();

  if (!user) return null;

  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) => q.eq("user_id", user._id).eq("team_id", teamId))
    .first();

  return membership ? user._id : null;
}

export const create = internalMutation({
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
      repository: normalizeRepository(args.repository),
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

/**
 * The quiet upsert for a pull request learned from GitHub's LIST api rather
 * than from a webhook: the backfill that runs when the App lands on an account
 * or gains repositories (githubApp.backfillInstallationPulls). It records no
 * "opened" activity and fires no trigger, because the pull request was opened
 * in the past and only became visible to this workspace now; the webhook path
 * (githubWebhooks.matchPRToConversation) owns those moments. A merge seen here
 * still lands in the feed, since it is the one event a list can prove.
 */
export const syncPRFromGitHub = internalMutation({
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
    author_avatar_url: v.optional(v.string()),
    head_ref: v.optional(v.string()),
    base_ref: v.optional(v.string()),
    head_sha: v.optional(v.string()),
    base_sha: v.optional(v.string()),
    draft: v.optional(v.boolean()),
    requested_reviewers: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
    merged_at: v.optional(v.number()),
    closed_at: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ pr_id: Id<"pull_requests">; created: boolean }> => {
    const existing = await ctx.db
      .query("pull_requests")
      .withIndex("by_github_pr_id", (q) => q.eq("github_pr_id", args.github_pr_id))
      .first();

    const fields = {
      title: args.title,
      body: args.body,
      state: args.state,
      author_github_username: args.author_github_username,
      author_avatar_url: args.author_avatar_url,
      head_ref: args.head_ref,
      base_ref: args.base_ref,
      head_sha: args.head_sha,
      base_sha: args.base_sha,
      draft: args.draft,
      requested_reviewers: args.requested_reviewers,
      updated_at: args.updated_at,
      merged_at: args.merged_at,
      closed_at: args.closed_at,
    };

    if (existing) {
      // A webhook may have moved the row past what the list says (a merge that
      // landed between the list call and this write); never rewind it.
      if (existing.updated_at > args.updated_at) return { pr_id: existing._id, created: false };
      const previousState = existing.state;
      await ctx.db.patch(existing._id, fields);
      await recordPRMergedActivity(
        ctx,
        { ...existing, ...args, _id: existing._id, team_id: existing.team_id },
        previousState,
        args.state,
      );
      return { pr_id: existing._id, created: false };
    }

    const prId = await ctx.db.insert("pull_requests", {
      ...fields,
      team_id: args.team_id,
      github_pr_id: args.github_pr_id,
      repository: normalizeRepository(args.repository),
      number: args.number,
      linked_session_ids: [],
      pr_comment_posted: false,
      created_at: args.created_at,
    });
    return { pr_id: prId, created: true };
  },
});

export const linkPRToSession = internalMutation({
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
    const userId = await requireUser(ctx);
    await requireTeamMembership(ctx, userId, args.team_id);
    let prs = await ctx.db
      .query("pull_requests")
      .withIndex("by_team_id", (q) => q.eq("team_id", args.team_id))
      .collect();

    if (args.repository) {
      const repository = normalizeRepository(args.repository);
      prs = prs.filter((pr) => pr.repository === repository);
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

/** The row for `owner/repo#number`, before any access check. */
async function pullRequestByNumber(ctx: any, repository: string, number: number) {
  return await ctx.db
    .query("pull_requests")
    .withIndex("by_repository", (q: any) => q.eq("repository", normalizeRepository(repository)))
    .filter((q: any) => q.eq(q.field("number"), number))
    .first();
}

export const getPRByNumber = query({
  args: {
    repository: v.string(),
    number: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const pr = await pullRequestByNumber(ctx, args.repository, args.number);
    return pr && (await canAccessPullRequest(ctx, userId, pr)) ? pr : undefined;
  },
});

/**
 * One pull request for a reference surface (an inline pill, a shared-object
 * card, `cast link`): by Convex id, or by repository and number — the two
 * halves of the `owner/repo#482` reference. Null, never a throw, when the row
 * is missing or not the caller's to see, so a reference degrades to the text
 * it was written as.
 */
export const webGet = query({
  args: {
    id: v.optional(v.id("pull_requests")),
    repository: v.optional(v.string()),
    number: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const pr = args.id
      ? await ctx.db.get(args.id)
      : args.repository && args.number !== undefined
        ? await pullRequestByNumber(ctx, args.repository, args.number)
        : null;
    if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) return null;
    return pr;
  },
});

export const getPRById = query({
  args: {
    pr_id: v.id("pull_requests"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const pr = await ctx.db.get(args.pr_id);
    if (!pr) return null;
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q) => q.eq("user_id", userId).eq("team_id", pr.team_id))
      .first();
    return membership ? pr : null;
  },
});

export const updatePRFiles = internalMutation({
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

export const updatePRState = internalMutation({
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

    await recordPRMergedActivity(ctx, pr, pr.state, args.state);

    return pr._id;
  },
});

export const getPRsForConversation = query({
  args: {
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation) return [];
    if (!(await canAccessConversation(ctx, userId, conversation))) return [];

    let prs;
    if (conversation.team_id) {
      prs = await ctx.db
        .query("pull_requests")
        .withIndex("by_team_id", (q) => q.eq("team_id", conversation.team_id!))
        .collect();
    } else {
      // Teamless conversation: a PR is only accessible when the caller belongs
      // to the PR's team (canAccessPullRequest), so scan just the caller's own
      // teams via by_team_id instead of the whole pull_requests table.
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
        .collect();
      prs = [];
      for (const m of memberships) {
        const teamPrs = await ctx.db
          .query("pull_requests")
          .withIndex("by_team_id", (q) => q.eq("team_id", m.team_id))
          .collect();
        prs.push(...teamPrs);
      }
    }
    const visible = [];
    for (const pr of prs) {
      if (
        pr.linked_session_ids.includes(args.conversation_id)
        && (await canAccessPullRequest(ctx, userId, pr))
      ) {
        visible.push(pr);
      }
    }
    return visible;
  },
});

export const getPRsForTimeline = query({
  args: {
    repository: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const userId = await requireUser(ctx);
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    let prs = (await Promise.all(memberships.map((membership) =>
      ctx.db
        .query("pull_requests")
        .withIndex("by_team_id", (q: any) => q.eq("team_id", membership.team_id))
        .collect()
    ))).flat();

    if (args.repository) {
      const repository = normalizeRepository(args.repository);
      prs = prs.filter((pr) => pr.repository === repository);
    }

    prs.sort((a, b) => b.updated_at - a.updated_at);
    return prs.slice(0, limit);
  },
});
