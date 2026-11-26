import { v } from "convex/values";
import { internalMutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireUser } from "./lib/auth";
import { commitRecordedBy, isConversationLinkable, normalizeRepository } from "./lib/gitRefs";
import { patchPullRequest } from "./prShepherd";
import { pullRequestMoved } from "./lib/priorityLinks";
import { linkPullRequestSessions, pullRequestsLinkedToConversation, syncPullRequestSessions, SESSION_CARD_MAX_SESSIONS, SESSION_CARD_PR_FIELDS } from "./lib/prSessions";
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

/** The codecast user behind a GitHub login, when they are a member of the team. */
export async function resolveActorUserIdForTeam(
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
    await syncPullRequestSessions(ctx, (await ctx.db.get(prId))!);
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
    labels: v.optional(v.array(v.object({ name: v.string(), color: v.optional(v.string()) }))),
    assignees: v.optional(v.array(v.string())),
    created_at: v.number(),
    updated_at: v.number(),
    merged_at: v.optional(v.number()),
    closed_at: v.optional(v.number()),
    merge_commit_sha: v.optional(v.string()),
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
      labels: args.labels,
      assignees: args.assignees,
      updated_at: args.updated_at,
      merged_at: args.merged_at,
      closed_at: args.closed_at,
      ...(args.merge_commit_sha ? { merge_commit_sha: args.merge_commit_sha.toLowerCase() } : {}),
    };

    if (existing) {
      // A webhook may have moved the row past what the list says (a merge that
      // landed between the list call and this write); never rewind it.
      if (existing.updated_at > args.updated_at) return { pr_id: existing._id, created: false };
      const previousState = existing.state;
      await patchPullRequest(ctx, existing._id, fields);
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
    // One that arrives already merged or closed is evidence at once, as a merge seen live is (prShepherd patchPullRequest).
    if (args.state !== "open") {
      const row = await ctx.db.get(prId);
      if (row) await pullRequestMoved(ctx, row);
    }
    return { pr_id: prId, created: true };
  },
});

// A pull request carries at most this many commits' worth of session lookups.
const COMMIT_LINK_CAP = 100;

/**
 * Link, at the committed tier, every session whose own commit is on the pull
 * request: the session whose edit row names the sha, else the one the commit
 * row was attributed to. Only sessions the pull request may show are linked,
 * by the same rule a branch match uses (lib/gitRefs.isConversationLinkable).
 */
async function linkCommittingSessions(ctx: any, prId: Id<"pull_requests">, shas: string[]): Promise<Id<"conversations">[]> {
  const pr = await ctx.db.get(prId);
  if (!pr) throw new Error(`PR with id ${prId} not found`);
  const authorId = await resolveActorUserIdForTeam(ctx, pr.team_id, pr.author_github_username);
  const found = new Map<string, Id<"conversations">>();
  for (const sha of shas.slice(0, COMMIT_LINK_CAP)) {
    const commit = await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.eq("sha", sha)).first();
    const id = (await commitRecordedBy(ctx, sha)) ?? commit?.conversation_id;
    if (!id || found.has(String(id))) continue;
    const conv = await ctx.db.get(id);
    if (conv && (await isConversationLinkable(ctx, conv, { userId: authorId, teamId: pr.team_id }))) found.set(String(id), id);
  }
  const after = await linkPullRequestSessions(ctx, prId, [...found.values()], "committed");
  return after?.linked_session_ids ?? pr.linked_session_ids;
}

export const linkPRToSession = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    commit_shas: v.array(v.string()),
  },
  handler: async (ctx, args) => linkCommittingSessions(ctx, args.pr_id, args.commit_shas),
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
    .withIndex("by_repository_number", (q: any) => q.eq("repository", normalizeRepository(repository)).eq("number", number))
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

export const updatePRCommits = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    commits: v.array(v.object({
      sha: v.string(),
      message: v.string(),
      author_login: v.optional(v.string()),
      author_name: v.optional(v.string()),
      author_avatar_url: v.optional(v.string()),
      committed_at: v.optional(v.number()),
      url: v.optional(v.string()),
    })),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr) return;
    await ctx.db.patch(args.pr_id, { commits: args.commits, commits_count: args.commits.length });
    await linkCommittingSessions(ctx, args.pr_id, args.commits.map((c) => c.sha));
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

    await patchPullRequest(ctx, args.pr_id, updates);
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

    const previousState = pr.state;
    await patchPullRequest(ctx, pr._id, {
      state: args.state,
      merged_at: args.merged_at,
      updated_at: Date.now(),
    });

    await recordPRMergedActivity(ctx, pr, previousState, args.state);

    return pr._id;
  },
});

/** Fills pull_request_sessions from every row's linked_session_ids, a page at a time. */
export const backfillPullRequestSessions = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("pull_requests")
      .paginate({ cursor: args.cursor ?? null, numItems: 25 });
    for (const pr of page.page) await syncPullRequestSessions(ctx, pr);
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.pull_requests.backfillPullRequestSessions, {
        cursor: page.continueCursor,
      });
    }
    return { synced: page.page.length, done: page.isDone };
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

    const visible = [];
    for (const pr of await pullRequestsLinkedToConversation(ctx, args.conversation_id)) {
      if (await canAccessPullRequest(ctx, userId, pr)) visible.push(pr);
    }
    return visible;
  },
});

const SESSION_CARD_LINKS_PER_SESSION = 10;
const SESSION_CARD_LINKS_SCANNED = 30;
const SESSION_CARD_READ_BUDGET = 8 * 1024 * 1024;
const SESSION_CARD_MAX_PRS = 80;

/**
 * The pull requests the inbox cards draw as chips, for the sessions the
 * client names, best first (the ones it lists): each session's links out of
 * pull_request_sessions, with their tier, and each linked pull request as
 * the fields a chip draws (SESSION_CARD_PR_FIELDS), never its patches or the
 * other sessions it links. Only pull requests of the viewer's teams, and
 * their links, come back.
 */
export const sessionCardPRs = query({
  args: { conversation_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const ids = [...new Set(args.conversation_ids.slice(0, SESSION_CARD_MAX_SESSIONS))];
    const member = new Map<string, boolean>();
    const readable = async (pr: { team_id: Id<"teams"> }) => {
      const key = String(pr.team_id);
      if (!member.has(key)) member.set(key, await canAccessPullRequest(ctx, userId, pr));
      return member.get(key)!;
    };
    const links: { _id: Id<"pull_request_sessions">; pull_request_id: Id<"pull_requests">; conversation_id: Id<"conversations">; tier: "observed" | "committed" }[] = [];
    const pullRequests = new Map<string, Record<string, unknown>>();
    const denied = new Set<string>();
    let readBytes = 0;
    const utf8 = new TextEncoder();
    // The sessions this answer speaks for: the links of theirs it carries are
    // the links the client should hold. The client prunes only these, so a
    // session skipped for the caps never loses what it had.
    const answered: string[] = [];
    for (const raw of ids) {
      const id = ctx.db.normalizeId("conversations", raw);
      if (!id) continue;
      // No read of the conversation itself: it is patched on every message,
      // and having it in the read set re-ran this whole query each time. A
      // link is shown only for a pull request the viewer's team owns, which
      // is what getPRsForTimeline already shows with its linked sessions.
      const rows = await ctx.db
        .query("pull_request_sessions")
        .withIndex("by_conversation", (q) => q.eq("conversation_id", id))
        .order("desc")
        .take(SESSION_CARD_LINKS_SCANNED);
      // Past its first links, a session keeps its committed links before the
      // ones it only sat on the branch of; newest first within each.
      const kept = [...rows.filter((r) => r.tier === "committed"), ...rows.filter((r) => r.tier !== "committed")].slice(0, SESSION_CARD_LINKS_PER_SESSION);
      const fresh = new Set(kept.map((row) => String(row.pull_request_id)).filter((key) => !pullRequests.has(key) && !denied.has(key))).size;
      // Over the cap: this session waits (unanswered, so nothing of it is
      // pruned); a later one with fewer new pull requests may still fit.
      if (pullRequests.size + fresh > SESSION_CARD_MAX_PRS) continue;

      // A pull request row with its patches reaches 1 MB, and the whole read
      // is capped (16 MiB): past half of it, reading stops, and the session
      // it stopped in stays unanswered (its links so far are kept, none pruned).
      let stopped = false;
      for (const row of kept) {
        const key = String(row.pull_request_id);
        if (denied.has(key)) continue;
        if (!pullRequests.has(key)) {
          if (readBytes > SESSION_CARD_READ_BUDGET) { stopped = true; break; }
          const pr = await ctx.db.get(row.pull_request_id);
          if (pr) readBytes += utf8.encode(JSON.stringify(pr)).length;
          if (!pr || !(await readable(pr))) { denied.add(key); continue; }
          const slim: Record<string, unknown> = {};
          for (const field of SESSION_CARD_PR_FIELDS) if (pr[field] !== undefined) slim[field] = pr[field];
          pullRequests.set(key, slim);
        }
        links.push({ _id: row._id, pull_request_id: row.pull_request_id, conversation_id: row.conversation_id, tier: row.tier ?? "observed" });
      }
      if (stopped) break;
      // A session cut to its first links is answered for exactly those: the
      // client keeps what was sent and drops the rest, as the server does.
      answered.push(String(id));
    }
    return { links, pull_requests: [...pullRequests.values()], answered };
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
    // Each team's newest `limit`, merged: reading every PR a team has ran out of
    // memory or time on large teams (~900 failures in 6h, 2026-11-10).
    const repository = args.repository ? normalizeRepository(args.repository) : undefined;
    const prs = (await Promise.all(memberships.map((membership) => {
      const newest = ctx.db
        .query("pull_requests")
        .withIndex("by_team_updated", (q: any) => q.eq("team_id", membership.team_id))
        .order("desc");
      return (repository ? newest.filter((q: any) => q.eq(q.field("repository"), repository)) : newest).take(limit);
    }))).flat();

    prs.sort((a, b) => b.updated_at - a.updated_at);
    return prs.slice(0, limit);
  },
});
