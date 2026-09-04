// Comments on code.
//
// One table (review_comments) now holds every comment anchored to a file in a
// repository: the ones GitHub sends us on a pull request, and the ones written
// here from a source page, a commit page or a diff. A comment written here is a
// codecast object first — it records the session, task, plan or doc it came
// from — and a GitHub comment second: when the file it points at is part of an
// open pull request, it is mirrored there so the reviewer sees it where they
// already work.

import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery, internalAction } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import {
  canAccessConversation,
  canAccessPullRequest,
  isTeamMember,
  requireAccessibleTask,
} from "./lib/access";
import { findConversationByAnyRef } from "./conversationSessionLookup";
import { recordExternalEvent } from "./externalEvents";
import { resolveTeamForRepository } from "./githubWebhooks";
import { commitUrl } from "./lib/gitRefs";

const GITHUB_API_BASE = "https://api.github.com";
const SUMMARY_LENGTH = 140;

type Ctx = { db: any; scheduler?: any };

/**
 * May this caller read this comment?
 *
 * A comment inherits its reach from whatever it is anchored to, strongest link
 * first: its author always sees it, a pull request comment follows the pull
 * request, a session comment follows the session, and a bare repository comment
 * follows membership of the team that installed the App on that repository.
 */
async function canAccessComment(
  ctx: Ctx,
  userId: Id<"users">,
  comment: Doc<"review_comments">,
): Promise<boolean> {
  if (comment.author_user_id && String(comment.author_user_id) === String(userId)) return true;

  if (comment.pull_request_id) {
    const pr = await ctx.db.get(comment.pull_request_id);
    if (pr && (await canAccessPullRequest(ctx, userId, pr))) return true;
  }
  if (comment.conversation_id) {
    const conversation = await ctx.db.get(comment.conversation_id);
    if (conversation && (await canAccessConversation(ctx, userId, conversation))) return true;
  }
  if (comment.repository) {
    const teamId = await resolveTeamForRepository(ctx, comment.repository);
    if (teamId && (await isTeamMember(ctx, userId, teamId))) return true;
  }
  return false;
}

/** The team a repository's comments belong to, or a failure the caller can act on. */
async function requireRepositoryTeam(
  ctx: Ctx,
  userId: Id<"users">,
  repository: string,
): Promise<Id<"teams">> {
  const teamId = await resolveTeamForRepository(ctx, repository);
  if (!teamId) throw new Error(`No GitHub App installation covers ${repository}`);
  if (!(await isTeamMember(ctx, userId, teamId))) throw new Error("Forbidden: team membership required");
  return teamId;
}

async function filterAccessible(
  ctx: Ctx,
  userId: Id<"users">,
  comments: Doc<"review_comments">[],
): Promise<Doc<"review_comments">[]> {
  const out: Doc<"review_comments">[] = [];
  for (const comment of comments) {
    if (await canAccessComment(ctx, userId, comment)) out.push(comment);
  }
  return out.sort((a, b) => a.created_at - b.created_at);
}

/** Open pull requests in this repository whose file list contains this path. */
async function openPRsTouchingFile(
  ctx: Ctx,
  repository: string,
  filePath: string | undefined,
): Promise<Doc<"pull_requests">[]> {
  if (!filePath) return [];
  const prs: Doc<"pull_requests">[] = await ctx.db
    .query("pull_requests")
    .withIndex("by_repository", (q: any) => q.eq("repository", repository))
    .collect();
  return prs.filter(
    (pr) => pr.state === "open" && (pr.files ?? []).some((f: any) => f.filename === filePath),
  );
}

export const create = mutation({
  args: {
    api_token: v.optional(v.string()),
    repository: v.string(),
    ref: v.optional(v.string()),
    // Absent means the comment is on the pull request itself, not on a line
    // of its diff. GitHub calls that an issue comment; the mirror already
    // branches on it.
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    line_end: v.optional(v.number()),
    side: v.optional(v.string()),
    content: v.string(),
    pull_request_id: v.optional(v.id("pull_requests")),
    // Any session reference: a conversation id, a session uuid, a short id.
    conversation_ref: v.optional(v.string()),
    task_id: v.optional(v.id("tasks")),
    plan_id: v.optional(v.id("plans")),
    doc_id: v.optional(v.id("docs")),
    parent_id: v.optional(v.id("review_comments")),
    client_id: v.optional(v.string()),
    author_kind: v.optional(v.union(v.literal("user"), v.literal("agent"))),
    mirror: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const teamId = await requireRepositoryTeam(ctx, userId, args.repository);

    let conversationId: Id<"conversations"> | undefined;
    if (args.conversation_ref) {
      const conversation = await findConversationByAnyRef(ctx, args.conversation_ref, userId);
      conversationId = conversation?._id;
    }

    if (args.task_id) await requireAccessibleTask(ctx, userId, args.task_id);

    // A reply belongs where its parent does, whatever the caller said.
    let pullRequestId = args.pull_request_id;
    let parentRef: string | undefined;
    if (args.parent_id) {
      const parent = await ctx.db.get(args.parent_id);
      if (!parent || !(await canAccessComment(ctx, userId, parent))) throw new Error("Parent comment not found");
      pullRequestId = pullRequestId ?? parent.pull_request_id;
      parentRef = parent.ref;
    }
    if (pullRequestId) {
      const pr = await ctx.db.get(pullRequestId);
      if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) throw new Error("Pull request not found");
    }

    const now = Date.now();
    const commentId = await ctx.db.insert("review_comments", {
      pull_request_id: pullRequestId,
      repository: args.repository,
      ref: args.ref ?? parentRef,
      file_path: args.file_path,
      line_number: args.line_number,
      line_end: args.line_end,
      side: args.side,
      parent_id: args.parent_id,
      conversation_id: conversationId,
      task_id: args.task_id,
      plan_id: args.plan_id,
      doc_id: args.doc_id,
      author_user_id: userId,
      author_kind: args.author_kind ?? "user",
      content: args.content,
      resolved: false,
      created_at: now,
      updated_at: now,
      client_id: args.client_id,
      codecast_origin: true,
    });

    const where = args.file_path
      ? (args.line_number ? `${args.file_path}:${args.line_number}` : args.file_path)
      : "the pull request";
    await recordExternalEvent(ctx, {
      source: "codecast",
      team_id: teamId,
      repository: args.repository,
      kind: "code_comment",
      actor_user_id: userId,
      title: `Comment on ${where}`,
      summary: args.content.slice(0, SUMMARY_LENGTH),
      url: args.ref ? commitUrl(args.repository, args.ref) : undefined,
      sha: args.ref,
      comment_id: commentId,
      pr_id: pullRequestId,
      conversation_id: conversationId,
      task_ids: args.task_id ? [args.task_id] : undefined,
      plan_ids: args.plan_id ? [args.plan_id] : undefined,
      meta: { file_path: args.file_path, line_number: args.line_number },
      dedupe_key: `code_comment:${commentId}`,
    });

    // Mirroring is the default: a comment nobody on GitHub can see is a comment
    // the reviewer will never answer.
    if (args.mirror !== false) {
      const targets = pullRequestId
        ? [await ctx.db.get(pullRequestId)]
        : await openPRsTouchingFile(ctx, args.repository, args.file_path);
      const target = targets.filter(Boolean)[0] as Doc<"pull_requests"> | undefined;
      if (target && target.state === "open") {
        if (!pullRequestId) await ctx.db.patch(commentId, { pull_request_id: target._id });
        await ctx.scheduler.runAfter(0, internal.codeComments.mirrorToGitHub, {
          comment_id: commentId,
          pr_id: target._id,
        });
      }
    }

    return { comment_id: commentId };
  },
});

/**
 * Post a codecast comment onto its pull request.
 *
 * The GitHub comment id comes back into our row, which is what lets the inbound
 * webhook recognize the comment as ours and not ingest it a second time. That
 * is why nothing is written into the visible body: an identity marker in the
 * text would be read by every human who opens the thread.
 */
export const mirrorToGitHub = internalAction({
  args: {
    comment_id: v.id("review_comments"),
    pr_id: v.id("pull_requests"),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const comment = await ctx.runQuery(internal.codeComments.getComment, { comment_id: args.comment_id });
    const pr = await ctx.runQuery(internal.prShepherd.getPR, { pr_id: args.pr_id });
    if (!comment || !pr) return { ok: false, reason: "not_found" };
    if (comment.github_comment_id) return { ok: false, reason: "already_mirrored" };

    const token: string | null = await ctx.runAction(internal.prShepherd.tokenForPR, { pr_id: args.pr_id });
    if (!token) return { ok: false, reason: "no_token" };

    const [owner, repo] = pr.repository.split("/");
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };

    // A line comment needs a commit to anchor to; without a line there is
    // nothing to anchor and the comment goes on the conversation instead.
    const anchored = !!(comment.file_path && comment.line_number && pr.head_sha);
    const url = anchored
      ? `${GITHUB_API_BASE}/repos/${owner}/${repo}/pulls/${pr.number}/comments`
      : `${GITHUB_API_BASE}/repos/${owner}/${repo}/issues/${pr.number}/comments`;
    // GitHub anchors a multi line comment with start_line..line, so a range has
    // to be sent as both ends or it lands on one line and loses what it was
    // pointing at. Stored rows always read line_number = start, line_end = end.
    const side = comment.side ?? "RIGHT";
    const isRange = comment.line_end != null && comment.line_end !== comment.line_number;
    const body = anchored
      ? {
          body: comment.content,
          commit_id: pr.head_sha,
          path: comment.file_path,
          line: isRange ? comment.line_end : comment.line_number,
          side,
          ...(isRange ? { start_line: comment.line_number, start_side: side } : {}),
        }
      : { body: comment.content };

    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!response.ok) {
      const text = await response.text();
      console.error(`[codeComments] mirror failed: ${response.status} ${text}`);
      return { ok: false, reason: `github ${response.status}` };
    }

    const data = await response.json();
    await ctx.runMutation(internal.codeComments.recordMirror, {
      comment_id: args.comment_id,
      github_comment_id: data.id,
      html_url: data.html_url,
      pr_id: args.pr_id,
    });
    return { ok: true };
  },
});

export const getComment = internalQuery({
  args: { comment_id: v.id("review_comments") },
  handler: async (ctx, args) => await ctx.db.get(args.comment_id),
});

export const recordMirror = internalMutation({
  args: {
    comment_id: v.id("review_comments"),
    github_comment_id: v.number(),
    html_url: v.optional(v.string()),
    pr_id: v.optional(v.id("pull_requests")),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.comment_id, {
      github_comment_id: args.github_comment_id,
      html_url: args.html_url,
      pull_request_id: args.pr_id,
      updated_at: Date.now(),
    });
  },
});

// ── Reads ──

export const listForFile = query({
  args: {
    api_token: v.optional(v.string()),
    repository: v.string(),
    file_path: v.string(),
    ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const rows = await ctx.db
      .query("review_comments")
      .withIndex("by_repository_file", (q) =>
        q.eq("repository", args.repository).eq("file_path", args.file_path))
      .collect();
    const matching = args.ref ? rows.filter((c) => c.ref === args.ref) : rows;
    return await filterAccessible(ctx, userId, matching);
  },
});

export const listForRef = query({
  args: {
    api_token: v.optional(v.string()),
    repository: v.string(),
    ref: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const rows = await ctx.db
      .query("review_comments")
      .withIndex("by_repository_file", (q) => q.eq("repository", args.repository))
      .collect();
    return await filterAccessible(ctx, userId, rows.filter((c) => c.ref === args.ref));
  },
});

export const listForPR = query({
  args: {
    api_token: v.optional(v.string()),
    pull_request_id: v.id("pull_requests"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const pr = await ctx.db.get(args.pull_request_id);
    if (!pr || !(await canAccessPullRequest(ctx, userId, pr))) return [];
    const rows = await ctx.db
      .query("review_comments")
      .withIndex("by_pull_request", (q) => q.eq("pull_request_id", args.pull_request_id))
      .collect();
    return rows.sort((a, b) => a.created_at - b.created_at);
  },
});

export const listForConversation = query({
  args: {
    api_token: v.optional(v.string()),
    conversation_id: v.id("conversations"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const conversation = await ctx.db.get(args.conversation_id);
    if (!conversation || !(await canAccessConversation(ctx, userId, conversation))) return [];
    const rows = await ctx.db
      .query("review_comments")
      .withIndex("by_conversation", (q) => q.eq("conversation_id", args.conversation_id))
      .collect();
    return rows.sort((a, b) => a.created_at - b.created_at);
  },
});

// ── Writes on an existing comment ──

async function requireOwnComment(ctx: Ctx, userId: Id<"users">, commentId: Id<"review_comments">) {
  const comment = await ctx.db.get(commentId);
  if (!comment || !(await canAccessComment(ctx, userId, comment))) throw new Error("Comment not found");
  return comment;
}

export const update = mutation({
  args: {
    api_token: v.optional(v.string()),
    comment_id: v.id("review_comments"),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const comment = await requireOwnComment(ctx, userId, args.comment_id);
    // A comment that came from GitHub belongs to whoever wrote it there.
    if (comment.author_kind === "github") throw new Error("Forbidden: edit this comment on GitHub");
    if (comment.author_user_id && String(comment.author_user_id) !== String(userId)) {
      throw new Error("Forbidden: only the author may edit a comment");
    }
    await ctx.db.patch(args.comment_id, { content: args.content, updated_at: Date.now() });
    return { ok: true };
  },
});

export const remove = mutation({
  args: {
    api_token: v.optional(v.string()),
    comment_id: v.id("review_comments"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const comment = await requireOwnComment(ctx, userId, args.comment_id);
    if (comment.author_user_id && String(comment.author_user_id) !== String(userId)) {
      throw new Error("Forbidden: only the author may delete a comment");
    }
    await ctx.db.delete(args.comment_id);
    return { ok: true };
  },
});

export const resolve = mutation({
  args: {
    api_token: v.optional(v.string()),
    comment_id: v.id("review_comments"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    await requireOwnComment(ctx, userId, args.comment_id);
    await ctx.db.patch(args.comment_id, {
      resolved: true,
      resolved_at: Date.now(),
      resolved_by: userId,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});

export const unresolve = mutation({
  args: {
    api_token: v.optional(v.string()),
    comment_id: v.id("review_comments"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    await requireOwnComment(ctx, userId, args.comment_id);
    await ctx.db.patch(args.comment_id, {
      resolved: false,
      resolved_at: undefined,
      resolved_by: undefined,
      updated_at: Date.now(),
    });
    return { ok: true };
  },
});
