// The server behind `cast pr`.
//
// One resolver decides which pull request a caller meant, and every read and
// write here goes through it. That is the point of the file: the CLI can send
// "123", "owner/repo#123", a URL, a session, or a branch name, and the answer
// is the same object in all five cases.
//
// Everything else this command does already exists. The state folding lives in
// lib/gitRefs, the shepherd binding and its standing trigger live in
// prShepherd, and commenting lives in codeComments. This file resolves, shapes
// for a terminal, and calls those.
//
// Access is team membership, the same rule pull_requests and gitEvents use. A
// session binding is stricter: you may bind only a session you own, so nobody
// can point somebody else's agent at their pull request.

import { v } from "convex/values";
import { action, internalQuery, mutation, query } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { api, internal } from "./_generated/api";
import { verifyApiToken } from "./apiTokens";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { bindShepherd } from "./prShepherd";
import { foldShepherdState, normalizeRepository, prUrl, PASSING_CONCLUSIONS, type CheckEntry } from "./lib/gitRefs";
import { parsePrRef, codecastPrUrl } from "@codecast/shared/contracts";

const EVENT_LIMIT = 10;
const LIST_LIMIT = 20;

// Every read and write takes the same locator. `ref` is what the caller typed;
// the rest is what the CLI already knew about the shell it ran in.
const locatorArgs = {
  ref: v.optional(v.string()),
  repository: v.optional(v.string()),
  number: v.optional(v.number()),
  session: v.optional(v.string()),
  branch: v.optional(v.string()),
};

type Locator = {
  ref?: string;
  repository?: string;
  number?: number;
  session?: string;
  branch?: string;
};

type PR = Doc<"pull_requests">;

async function requireCaller(ctx: any, apiToken: string): Promise<Id<"users">> {
  const auth = await verifyApiToken(ctx, apiToken);
  if (!auth) throw new Error("Unauthorized");
  return auth.userId as Id<"users">;
}

/** The teams the caller belongs to. A pull request is readable in exactly these. */
async function callerTeams(ctx: any, userId: Id<"users">): Promise<Id<"teams">[]> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  return memberships.map((m: any) => m.team_id);
}

/** Every pull request in the caller's teams. */
async function pullRequestsForCaller(ctx: any, teams: Id<"teams">[]): Promise<PR[]> {
  const rows: PR[] = [];
  for (const team of teams) {
    const teamRows = await ctx.db
      .query("pull_requests")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", team))
      .collect();
    rows.push(...teamRows);
  }
  return rows;
}

const newestFirst = (a: PR, b: PR) => b.updated_at - a.updated_at;

/** Prefer an open pull request over a closed one, then the most recently changed. */
const openFirst = (a: PR, b: PR) => {
  const rank = (pr: PR) => (pr.state === "open" ? 0 : 1);
  return rank(a) - rank(b) || b.updated_at - a.updated_at;
};

/**
 * Which pull request the caller meant.
 *
 * A number wins outright. Without one, the session's binding answers, and
 * failing that the branch the caller is standing on. Every branch of this
 * filters to the caller's teams before it picks, so an unresolved caller
 * matches nothing rather than everything.
 */
export async function resolvePullRequest(
  ctx: any,
  userId: Id<"users">,
  locator: Locator,
): Promise<PR | null> {
  const parsed = locator.ref ? parsePrRef(locator.ref) : null;
  // A person types the repository, so its case is whatever they typed. Rows are
  // stored under one spelling, and every index below is a byte comparison.
  const repository = normalizeRepository(parsed?.repository ?? locator.repository);
  const number = parsed?.number ?? locator.number;

  const teams = await callerTeams(ctx, userId);
  const teamSet = new Set(teams.map(String));
  const mine = (pr: PR) => teamSet.has(String(pr.team_id));

  if (number != null && repository) {
    const rows = await ctx.db
      .query("pull_requests")
      .withIndex("by_repository_number", (q: any) => q.eq("repository", repository).eq("number", number))
      .collect();
    return rows.filter(mine).sort(newestFirst)[0] ?? null;
  }

  if (number != null) {
    const matches = (await pullRequestsForCaller(ctx, teams)).filter((pr) => pr.number === number);
    return matches.sort(openFirst)[0] ?? null;
  }

  if (locator.session) {
    const conversation = await findConversationByAnyRef(ctx, locator.session, userId);
    if (conversation) {
      const shepherded = await ctx.db
        .query("pull_requests")
        .withIndex("by_shepherd_conversation", (q: any) =>
          q.eq("shepherd_conversation_id", conversation._id))
        .collect();
      const bound = shepherded.filter(mine).sort(openFirst)[0];
      if (bound) return bound;

      const linked = (await pullRequestsForCaller(ctx, teams)).filter((pr) =>
        (pr.linked_session_ids ?? []).some((id: any) => String(id) === String(conversation._id)));
      const hit = linked.sort(openFirst)[0];
      if (hit) return hit;
    }
  }

  if (locator.branch && repository) {
    const rows: PR[] = await ctx.db
      .query("pull_requests")
      .withIndex("by_repository", (q: any) => q.eq("repository", repository))
      .collect();
    const onBranch = rows.filter((pr) => mine(pr) && pr.head_ref === locator.branch);
    return onBranch.sort(openFirst)[0] ?? null;
  }

  return null;
}

// ── shaping ──────────────────────────────────────────────────────────────────

/**
 * Green, red and still running, counted from the check runs on the head commit.
 * The verdicts come from foldChecksState's rule, so the table's counts and the
 * folded checks_state can never tell different stories.
 */
export function countChecks(checks: CheckEntry[] | undefined | null): {
  green: number;
  red: number;
  pending: number;
} {
  let green = 0;
  let red = 0;
  let pending = 0;
  for (const check of checks ?? []) {
    if (check.status !== "completed" || !check.conclusion) pending++;
    else if (PASSING_CONCLUSIONS.has(check.conclusion)) green++;
    else red++;
  }
  return { green, red, pending };
}

/**
 * The folded shepherd state, and the one rule for when a pull request has one:
 * a session is bound and still turned on. A released or paused pull request
 * reports nothing, because the state is what a shepherd sees and nobody is
 * watching. The table, `show` and `watch` all read this, so they cannot tell
 * different stories about the same row.
 */
const shepherdState = (pr: PR) =>
  pr.shepherd_conversation_id && pr.shepherd_enabled
    ? (pr.shepherd_state ?? foldShepherdState(pr))
    : null;

/** The session shepherding this pull request, when it has one. */
const shepherdSessionFor = async (ctx: any, pr: PR) =>
  pr.shepherd_conversation_id ? await ctx.db.get(pr.shepherd_conversation_id) : null;

/**
 * The compact row `ls` and `watch` return. `session` is the already loaded
 * shepherd session, so `fullRow` does not read the same document twice.
 */
async function compactRow(ctx: any, pr: PR, session?: any) {
  const counts = countChecks(pr.checks);
  const shepherdSession = session !== undefined ? session : await shepherdSessionFor(ctx, pr);
  return {
    id: String(pr._id),
    repository: pr.repository,
    number: pr.number,
    title: pr.title ?? null,
    state: pr.state,
    draft: pr.draft ?? false,
    head_ref: pr.head_ref ?? null,
    base_ref: pr.base_ref ?? null,
    head_sha: pr.head_sha ?? null,
    shepherd_state: shepherdState(pr),
    shepherd_enabled: pr.shepherd_enabled ?? false,
    checks_state: pr.checks_state ?? null,
    checks_green: counts.green,
    checks_red: counts.red,
    checks_pending: counts.pending,
    review_decision: pr.review_decision ?? null,
    unresolved_review_count: pr.unresolved_review_count ?? 0,
    mergeable_state: pr.mergeable_state ?? null,
    session_short_id: shepherdSession?.short_id ?? null,
    updated_at: pr.updated_at,
    url: prUrl(pr.repository, pr.number),
    codecast_url: codecastPrUrl(pr.repository, pr.number),
  };
}

/** Everything `show` prints, in one shape. */
async function fullRow(ctx: any, pr: PR) {
  const shepherdSession = await shepherdSessionFor(ctx, pr);
  const compact = await compactRow(ctx, pr, shepherdSession);
  const trigger = pr.shepherd_task_id ? await ctx.db.get(pr.shepherd_task_id) : null;

  return {
    ...compact,
    base_sha: pr.base_sha ?? null,
    author_github_username: pr.author_github_username ?? null,
    behind_by: pr.behind_by ?? null,
    mergeable: pr.mergeable ?? null,
    checks: pr.checks ?? [],
    requested_reviewers: pr.requested_reviewers ?? [],
    additions: pr.additions ?? null,
    deletions: pr.deletions ?? null,
    changed_files: pr.changed_files ?? null,
    shepherd: {
      session_id: pr.shepherd_conversation_id ? String(pr.shepherd_conversation_id) : null,
      session_short_id: shepherdSession?.short_id ?? null,
      session_title: shepherdSession?.title ?? null,
      enabled: pr.shepherd_enabled ?? false,
      state: compact.shepherd_state,
      state_at: pr.shepherd_state_at ?? null,
      last_wake_at: pr.shepherd_last_wake_at ?? null,
      last_wake_reason: pr.shepherd_last_wake_reason ?? null,
      wake_count: pr.shepherd_wake_count ?? 0,
      trigger_short_id: trigger?.short_id ?? null,
    },
  };
}

async function eventsFor(ctx: any, pr: PR, limit: number) {
  const rows = await ctx.db
    .query("external_events")
    .withIndex("by_pr_created", (q: any) => q.eq("pr_id", pr._id))
    .order("desc")
    .take(limit);
  return rows.map((event: any) => ({
    id: String(event._id),
    kind: event.kind,
    title: event.title,
    summary: event.summary ?? null,
    actor_login: event.actor_login ?? null,
    url: event.url ?? null,
    sha: event.sha ?? null,
    created_at: event.created_at,
  }));
}

// ── reads ────────────────────────────────────────────────────────────────────

export const ls = query({
  args: {
    api_token: v.string(),
    repository: v.optional(v.string()),
    state: v.optional(v.string()),
    mine: v.optional(v.boolean()),
    shepherded: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const user = await ctx.db.get(userId);
    const rows = await pullRequestsForCaller(ctx, await callerTeams(ctx, userId));

    const wanted = rows.filter((pr) => {
      if (args.repository && pr.repository !== normalizeRepository(args.repository)) return false;
      if (args.state && pr.state !== args.state) return false;
      if (args.mine && pr.author_github_username !== user?.github_username) return false;
      if (args.shepherded && !pr.shepherd_conversation_id) return false;
      return true;
    });

    wanted.sort(newestFirst);
    const page = wanted.slice(0, args.limit ?? LIST_LIMIT);
    return {
      pull_requests: await Promise.all(page.map((pr) => compactRow(ctx, pr))),
      total: wanted.length,
    };
  },
});

export const resolve = query({
  args: { api_token: v.string(), ...locatorArgs },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const pr = await resolvePullRequest(ctx, userId, args);
    return { pull_request: pr ? await compactRow(ctx, pr) : null };
  },
});

export const show = query({
  args: { api_token: v.string(), ...locatorArgs },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const pr = await resolvePullRequest(ctx, userId, args);
    if (!pr) return { pull_request: null };

    const comments = await ctx.db
      .query("review_comments")
      .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", pr._id))
      .collect();
    const open = comments
      .filter((comment: any) => !comment.resolved)
      .sort((a: any, b: any) => a.created_at - b.created_at)
      .slice(0, 20);
    const unresolved = [];
    for (const comment of open) {
      // A comment an agent wrote through the CLI carries no GitHub username,
      // only the session that wrote it. Name that session, the way codecast
      // names an agent everywhere else, instead of leaving the author blank.
      let author = comment.author_github_username ?? null;
      if (!author && comment.conversation_id) {
        const conversation = await ctx.db.get(comment.conversation_id);
        author = conversation?.short_id ?? null;
      }
      unresolved.push({
        id: String(comment._id),
        author,
        file_path: comment.file_path ?? null,
        line_number: comment.line_number ?? null,
        content: comment.content,
        url: comment.html_url ?? null,
      });
    }

    const sessions = [];
    const seen = new Set<string>();
    const sessionIds = [
      ...(pr.shepherd_conversation_id ? [pr.shepherd_conversation_id] : []),
      ...(pr.linked_session_ids ?? []),
    ];
    for (const id of sessionIds) {
      if (seen.has(String(id))) continue;
      seen.add(String(id));
      const conversation = await ctx.db.get(id);
      if (!conversation) continue;
      sessions.push({
        id: String(conversation._id),
        short_id: conversation.short_id ?? null,
        title: conversation.title ?? null,
        shepherd: String(id) === String(pr.shepherd_conversation_id),
      });
    }

    const tasks = [];
    for (const id of pr.task_ids ?? []) {
      const task = await ctx.db.get(id);
      if (!task) continue;
      tasks.push({ id: String(task._id), short_id: task.short_id, title: task.title, status: task.status });
    }

    return {
      pull_request: await fullRow(ctx, pr),
      unresolved_comments: unresolved,
      sessions,
      tasks,
      events: await eventsFor(ctx, pr, EVENT_LIMIT),
    };
  },
});

export const events = query({
  args: { api_token: v.string(), ...locatorArgs, limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const pr = await resolvePullRequest(ctx, userId, args);
    if (!pr) return { pull_request: null, events: [] };
    return {
      pull_request: await compactRow(ctx, pr),
      events: await eventsFor(ctx, pr, args.limit ?? 30),
    };
  },
});

/**
 * The reactive query behind `cast pr watch`. It answers with the compact rows
 * only, because the CLI diffs whole frames: a query that returned the timeline
 * too would re-push the entire history on every check run.
 */
export const watchPRs = query({
  args: {
    api_token: v.string(),
    repository: v.optional(v.string()),
    pr_ids: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const rows = await pullRequestsForCaller(ctx, await callerTeams(ctx, userId));
    const wantedIds = args.pr_ids ? new Set(args.pr_ids) : null;

    const watched = rows.filter((pr) => {
      if (wantedIds) return wantedIds.has(String(pr._id));
      if (args.repository && pr.repository !== normalizeRepository(args.repository)) return false;
      // Without an explicit set, a closed pull request has nothing left to
      // report, and leaving it in makes every watcher carry dead rows forever.
      return pr.state === "open";
    });
    watched.sort(newestFirst);

    return { pull_requests: await Promise.all(watched.map((pr) => compactRow(ctx, pr))) };
  },
});

// ── the shepherd binding ─────────────────────────────────────────────────────

export const shepherd = mutation({
  args: {
    api_token: v.string(),
    ...locatorArgs,
    action: v.union(v.literal("on"), v.literal("off"), v.literal("status")),
    // The session to bind. A caller may point only their own agent at a pull
    // request, never somebody else's.
    bind_session: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const pr = await resolvePullRequest(ctx, userId, args);
    if (!pr) return { pull_request: null };

    if (args.action === "status") {
      return { pull_request: await fullRow(ctx, pr), changed: false };
    }

    let conversationId: Id<"conversations"> | undefined;
    if (args.action === "on") {
      if (!args.bind_session) throw new Error("Naming a session is required to start shepherding");
      const conversation = await findConversationByAnyRef(ctx, args.bind_session, userId);
      if (!conversation) throw new Error(`No session of yours matches "${args.bind_session}"`);
      conversationId = conversation._id as Id<"conversations">;
    }

    // prShepherd owns the binding: it arms or retires the standing trigger and
    // refreshes the session card in the same write.
    const previous = pr.shepherd_conversation_id;
    await bindShepherd(ctx, pr, conversationId, args.action === "on");
    if (conversationId && previous && String(previous) !== String(conversationId)) {
      // A pull request shepherds one session at a time, so a rebind has to
      // clear the card it left behind.
      await ctx.db.patch(previous, { pr_status: undefined });
    }

    return { pull_request: await fullRow(ctx, (await ctx.db.get(pr._id)) as PR), changed: true };
  },
});

// ── review threads ───────────────────────────────────────────────────────────
//
// Resolving is codeComments' job, the same as commenting. What this adds is
// naming the thread: a caller reads `cast pr threads`, then says "that one"
// with a short id or the file and line it sits on.

/** The short form of a comment id: its last 8 characters, as triggers do. */
const shortCommentId = (id: string) => String(id).slice(-8);

async function commentRows(ctx: any, pr: PR): Promise<any[]> {
  const rows = await ctx.db
    .query("review_comments")
    .withIndex("by_pull_request", (q: any) => q.eq("pull_request_id", pr._id))
    .collect();
  return rows.sort((a: any, b: any) => a.created_at - b.created_at);
}

/** Who wrote a comment: the GitHub login, or the session an agent wrote it from. */
async function commentAuthor(ctx: any, comment: any): Promise<string | null> {
  if (comment.author_github_username) return comment.author_github_username;
  if (comment.conversation_id) {
    const conversation = await ctx.db.get(comment.conversation_id);
    return conversation?.short_id ?? null;
  }
  return null;
}

async function threadRow(ctx: any, comment: any) {
  return {
    id: String(comment._id),
    short_id: shortCommentId(comment._id),
    file_path: comment.file_path ?? null,
    line_number: comment.line_number ?? null,
    author: await commentAuthor(ctx, comment),
    resolved: !!comment.resolved,
    // One line is all a list needs; `cast pr show` carries the whole comment.
    first_line: String(comment.content ?? "").split("\n")[0],
    url: comment.html_url ?? null,
    created_at: comment.created_at,
  };
}

export const threads = query({
  args: { api_token: v.string(), ...locatorArgs, all: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const pr = await resolvePullRequest(ctx, userId, args);
    if (!pr) return { pull_request: null, threads: [] };

    const rows = await commentRows(ctx, pr);
    const wanted = args.all ? rows : rows.filter((c: any) => !c.resolved);
    return {
      pull_request: await compactRow(ctx, pr),
      threads: await Promise.all(wanted.map((c: any) => threadRow(ctx, c))),
      resolved_count: rows.filter((c: any) => c.resolved).length,
      total: rows.length,
    };
  },
});

/** A convex id is 32 characters of lowercase and digits; nothing else is. */
const looksLikeId = (text: string) => /^[a-z0-9]{32}$/.test(text);
const looksLikeShortId = (text: string) => /^[a-z0-9]{8}$/.test(text);

/** "src/auth.ts:12" and "src/auth.ts" both name a place in the diff. */
export function parseCommentLocation(selector: string): { file: string; line?: number } | null {
  const text = selector.trim();
  if (!text || looksLikeId(text)) return null;
  const withLine = text.match(/^(.+):(\d+)$/);
  if (withLine) return { file: withLine[1], line: Number(withLine[2]) };
  // A bare word with no slash or dot is more likely a mistyped id than a path.
  if (!text.includes("/") && !text.includes(".")) return null;
  return { file: text };
}

/**
 * The comment a caller named. A full id or its last 8 characters name exactly
 * one; a file and line can cover several, so an unresolved thread wins over a
 * settled one and a genuine tie comes back for the caller to break.
 */
export const findComment = query({
  args: { api_token: v.string(), ...locatorArgs, selector: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const pr = await resolvePullRequest(ctx, userId, args);
    if (!pr) return { pull_request: null, comment_id: null, matches: [] };

    const rows = await commentRows(ctx, pr);
    const selector = args.selector.trim();
    const shaped = async (list: any[]) => await Promise.all(list.map((c: any) => threadRow(ctx, c)));

    const byId = rows.filter(
      (c: any) =>
        (looksLikeId(selector) && String(c._id) === selector) ||
        (looksLikeShortId(selector) && shortCommentId(c._id) === selector),
    );
    if (byId.length) {
      return { pull_request: await compactRow(ctx, pr), comment_id: String(byId[0]._id), matches: await shaped(byId) };
    }

    const location = parseCommentLocation(selector);
    if (!location) {
      return { pull_request: await compactRow(ctx, pr), comment_id: null, matches: [] };
    }

    const atLocation = rows.filter(
      (c: any) =>
        c.file_path === location.file &&
        (location.line === undefined || c.line_number === location.line),
    );
    // An unresolved thread is what somebody means by "resolve src/auth.ts:12";
    // a settled one is only reachable when nothing there is still open.
    const open = atLocation.filter((c: any) => !c.resolved);
    const candidates = open.length ? open : atLocation;
    return {
      pull_request: await compactRow(ctx, pr),
      comment_id: candidates.length === 1 ? String(candidates[0]._id) : null,
      matches: await shaped(candidates),
    };
  },
});

// ── acting on GitHub ─────────────────────────────────────────────────────────
//
// Reviewing, merging and closing all leave a mark on GitHub under somebody's
// name, so the identity the call carries is the whole question here.
//
// A review is a person's judgement. It goes out under the caller's own GitHub
// token or it does not go out at all: posting it as the app would put the
// codecast bot's name on an opinion a person formed, which is a different
// claim than the one they made. A merge or a close is an operation rather
// than an opinion, so those fall back to the installation token when the
// caller has not connected GitHub, and say whose name they went out under.
//
// Nothing here writes the result into our own tables. GitHub sends the merge,
// the close and the review back as webhooks, and githubWebhooks already
// records each one and stands the shepherd down. A second writer here would
// race that one and duplicate the row.

/** The caller, the pull request they named, and the token to act with. */
export const actorFor = internalQuery({
  args: { api_token: v.string(), ...locatorArgs },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const pr = await resolvePullRequest(ctx, userId, args);
    if (!pr) return null;
    const user = await ctx.db.get(userId);
    return {
      user_id: String(userId),
      github_token: (user as any)?.github_access_token ?? null,
      github_username: (user as any)?.github_username ?? null,
      pr: {
        id: String(pr._id),
        repository: pr.repository,
        number: pr.number,
        title: pr.title ?? null,
        state: pr.state,
        head_ref: pr.head_ref ?? null,
        url: prUrl(pr.repository, pr.number),
      },
    };
  },
});

const NO_MATCH = "No pull request matched that reference";

/**
 * GitHub's own words, with the action boundary's wrapping taken off.
 *
 * An error thrown inside an action reaches its caller as text carrying
 * "Uncaught Error:" and a stack frame from the far side, and some deployments
 * prefix a [CONVEX ...] tag as well. None of that belongs in front of somebody
 * who typed `cast pr review`; "Can not approve your own pull request" does.
 */
export function githubSentence(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // Everything before the first stack frame is the message.
  let text = raw.split(/\n\s+at\s/)[0];
  text = text.replace(/^\[CONVEX[^\]]*\]\s*/, "");
  text = text.replace(/^\[Request ID:[^\]]*\]\s*/, "");
  text = text.replace(/^Server Error\s*/, "");
  // The last "Uncaught Error:" wins: nesting adds them at the front.
  const marker = text.lastIndexOf("Uncaught Error:");
  if (marker !== -1) text = text.slice(marker + "Uncaught Error:".length);
  return text.trim() || raw.trim();
}

const failureText = githubSentence;

export const review = action({
  args: {
    api_token: v.string(),
    ...locatorArgs,
    event: v.union(v.literal("APPROVE"), v.literal("REQUEST_CHANGES"), v.literal("COMMENT")),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const actor: any = await ctx.runQuery(internal.prCli.actorFor, {
      api_token: args.api_token,
      ref: args.ref,
      repository: args.repository,
      number: args.number,
      session: args.session,
      branch: args.branch,
    });
    if (!actor) return { error: NO_MATCH };

    if (!actor.github_token) {
      return {
        error:
          "A review goes out under your own GitHub account, and this one has no GitHub token. " +
          "Connect GitHub in codecast, or review on github.com.",
      };
    }

    try {
      const result: any = await ctx.runAction(api.githubApi.submitPRReview, {
        repository: actor.pr.repository,
        pr_number: actor.pr.number,
        event: args.event,
        body: args.body,
        github_access_token: actor.github_token,
      });
      return {
        repository: actor.pr.repository,
        number: actor.pr.number,
        state: result.state,
        url: result.review_url,
        as: actor.github_username,
      };
    } catch (error) {
      // GitHub refuses some reviews by rule, approving your own being the one
      // people meet first. Its sentence says exactly what happened.
      return { error: failureText(error) };
    }
  },
});

/** The caller's own token, or the app's, for an operation either may perform. */
async function operationToken(
  ctx: any,
  actor: any,
): Promise<{ token: string; as: string } | null> {
  if (actor.github_token) return { token: actor.github_token, as: actor.github_username ?? "you" };
  const installation: string | null = await ctx.runAction(internal.prShepherd.tokenForPR, {
    pr_id: actor.pr.id,
  });
  return installation ? { token: installation, as: "the codecast app" } : null;
}

const NO_TOKEN =
  "No GitHub token to act with: this account has not connected GitHub and the repository has no codecast installation.";

export const merge = action({
  args: {
    api_token: v.string(),
    ...locatorArgs,
    method: v.optional(v.union(v.literal("merge"), v.literal("squash"), v.literal("rebase"))),
    delete_branch: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<any> => {
    const actor: any = await ctx.runQuery(internal.prCli.actorFor, {
      api_token: args.api_token,
      ref: args.ref,
      repository: args.repository,
      number: args.number,
      session: args.session,
      branch: args.branch,
    });
    if (!actor) return { error: NO_MATCH };
    if (actor.pr.state !== "open") {
      return { error: `${actor.pr.repository}#${actor.pr.number} is already ${actor.pr.state}.` };
    }

    const acting = await operationToken(ctx, actor);
    if (!acting) return { error: NO_TOKEN };

    try {
      const result: any = await ctx.runAction(internal.githubApi.mergePullRequest, {
        repository: actor.pr.repository,
        pr_number: actor.pr.number,
        method: args.method ?? "squash",
        github_access_token: acting.token,
        delete_branch: args.delete_branch,
        head_ref: actor.pr.head_ref ?? undefined,
      });
      return {
        repository: actor.pr.repository,
        number: actor.pr.number,
        merged: result.merged,
        sha: result.sha,
        branch_deleted: result.branch_deleted,
        head_ref: actor.pr.head_ref,
        as: acting.as,
      };
    } catch (error) {
      return { error: failureText(error) };
    }
  },
});

export const close = action({
  args: { api_token: v.string(), ...locatorArgs },
  handler: async (ctx, args): Promise<any> => {
    const actor: any = await ctx.runQuery(internal.prCli.actorFor, {
      api_token: args.api_token,
      ref: args.ref,
      repository: args.repository,
      number: args.number,
      session: args.session,
      branch: args.branch,
    });
    if (!actor) return { error: NO_MATCH };
    if (actor.pr.state !== "open") {
      return { error: `${actor.pr.repository}#${actor.pr.number} is already ${actor.pr.state}.` };
    }

    const acting = await operationToken(ctx, actor);
    if (!acting) return { error: NO_TOKEN };

    try {
      await ctx.runAction(internal.githubApi.closePullRequest, {
        repository: actor.pr.repository,
        pr_number: actor.pr.number,
        github_access_token: acting.token,
      });
      return { repository: actor.pr.repository, number: actor.pr.number, state: "closed", as: acting.as };
    } catch (error) {
      return { error: failureText(error) };
    }
  },
});
