import { v } from "convex/values";
import { mutation, query, action, internalQuery, internalMutation } from "./functions";
import { api, internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireUser, requireUserOrToken } from "./lib/auth";
import { requireAccessiblePullRequest } from "./lib/access";
import type { Doc } from "./_generated/dataModel";
import { githubSentence } from "./prCli";
import { pendingRowsFor, withoutOthersPending } from "./codeComments";
import { sendNotesToSession } from "./reviewNotes";
import { codecastPrUrl } from "@codecast/shared/contracts";

async function requireReviewAccess(ctx: any, userId: any, reviewId: any) {
  const review = await ctx.db.get(reviewId);
  if (!review) throw new Error("Review not found");
  await requireAccessiblePullRequest(ctx, userId, review.pull_request_id);
  return review;
}

async function requireReviewCommentAccess(ctx: any, userId: any, commentId: any) {
  const comment = await ctx.db.get(commentId);
  if (!comment) throw new Error("Review comment not found");
  await requireAccessiblePullRequest(ctx, userId, comment.pull_request_id);
  return comment;
}

export const createReview = mutation({
  args: {
    pull_request_id: v.id("pull_requests"),
    reviewer_user_id: v.id("users"),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("commented")
    ),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (String(args.reviewer_user_id) !== String(userId)) {
      throw new Error("Forbidden: reviewer must be the authenticated user");
    }
    await requireAccessiblePullRequest(ctx, userId, args.pull_request_id);
    const reviewId = await ctx.db.insert("reviews", {
      pull_request_id: args.pull_request_id,
      reviewer_user_id: args.reviewer_user_id,
      state: args.state,
      body: args.body,
      submitted_at: Date.now(),
    });
    return reviewId;
  },
});

export const addReviewComment = mutation({
  args: {
    review_id: v.id("reviews"),
    file_path: v.string(),
    line_number: v.number(),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const review = await requireReviewAccess(ctx, userId, args.review_id);

    const commentId = await ctx.db.insert("review_comments", {
      review_id: args.review_id,
      pull_request_id: review.pull_request_id,
      file_path: args.file_path,
      line_number: args.line_number,
      content: args.content,
      resolved: false,
      created_at: Date.now(),
      codecast_origin: true,
    });
    return commentId;
  },
});

export const resolveComment = mutation({
  args: {
    comment_id: v.id("review_comments"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireReviewCommentAccess(ctx, userId, args.comment_id);
    await ctx.db.patch(args.comment_id, {
      resolved: true,
    });
  },
});

export const updateReviewState = mutation({
  args: {
    review_id: v.id("reviews"),
    state: v.union(
      v.literal("pending"),
      v.literal("approved"),
      v.literal("changes_requested"),
      v.literal("commented")
    ),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const review = await requireReviewAccess(ctx, userId, args.review_id);
    if (String(review.reviewer_user_id) !== String(userId)) {
      throw new Error("Forbidden: only the reviewer may update review state");
    }
    await ctx.db.patch(args.review_id, {
      state: args.state,
      submitted_at: Date.now(),
    });
  },
});

export const getReviewsForPR = query({
  args: {
    pull_request_id: v.id("pull_requests"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireAccessiblePullRequest(ctx, userId, args.pull_request_id);
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_pull_request", (q) =>
        q.eq("pull_request_id", args.pull_request_id)
      )
      .collect();
    return reviews;
  },
});

export const getReviewComments = query({
  args: {
    review_id: v.id("reviews"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireReviewAccess(ctx, userId, args.review_id);
    const comments = await ctx.db
      .query("review_comments")
      .withIndex("by_review", (q) =>
        q.eq("review_id", args.review_id)
      )
      .collect();
    return withoutOthersPending(comments, userId);
  },
});

export const getPendingReviews = query({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (String(args.user_id) !== String(userId)) return [];
    const reviews = await ctx.db
      .query("reviews")
      .withIndex("by_reviewer", (q) =>
        q.eq("reviewer_user_id", args.user_id)
      )
      .filter((q) => q.eq(q.field("state"), "pending"))
      .collect();
    return reviews;
  },
});

export const getCommentsForPR = query({
  args: {
    pull_request_id: v.id("pull_requests"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireAccessiblePullRequest(ctx, userId, args.pull_request_id);
    const comments = await ctx.db
      .query("review_comments")
      .withIndex("by_pull_request", (q) =>
        q.eq("pull_request_id", args.pull_request_id)
      )
      .collect();
    return withoutOthersPending(comments, userId).sort((a, b) => a.created_at - b.created_at);
  },
});

export const addCommentToPR = mutation({
  args: {
    pull_request_id: v.id("pull_requests"),
    author_user_id: v.id("users"),
    file_path: v.optional(v.string()),
    line_number: v.optional(v.number()),
    content: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (String(args.author_user_id) !== String(userId)) {
      throw new Error("Forbidden: comment author must be the authenticated user");
    }
    await requireAccessiblePullRequest(ctx, userId, args.pull_request_id);

    const commentId = await ctx.db.insert("review_comments", {
      pull_request_id: args.pull_request_id,
      file_path: args.file_path,
      line_number: args.line_number,
      content: args.content,
      resolved: false,
      created_at: Date.now(),
      codecast_origin: true,
      author_user_id: args.author_user_id,
    });
    return commentId;
  },
});

export const unresolveComment = mutation({
  args: {
    comment_id: v.id("review_comments"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireReviewCommentAccess(ctx, userId, args.comment_id);
    await ctx.db.patch(args.comment_id, {
      resolved: false,
    });
  },
});

export const getCommentsForFile = query({
  args: {
    pull_request_id: v.id("pull_requests"),
    file_path: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireAccessiblePullRequest(ctx, userId, args.pull_request_id);
    const allComments = withoutOthersPending(await ctx.db
      .query("review_comments")
      .withIndex("by_pull_request", (q) =>
        q.eq("pull_request_id", args.pull_request_id)
      )
      .collect(), userId);

    return allComments
      .filter((c) => c.file_path === args.file_path)
      .sort((a, b) => a.created_at - b.created_at);
  },
});

export const submitReview = action({
  args: {
    pull_request_id: v.id("pull_requests"),
    reviewer_user_id: v.id("users"),
    event: v.union(
      v.literal("APPROVE"),
      v.literal("REQUEST_CHANGES"),
      v.literal("COMMENT")
    ),
    body: v.optional(v.string()),
    github_access_token: v.string(),
  },
  handler: async (ctx, args): Promise<{
    success: boolean;
    review_id: string;
    github_review_id: number;
    github_review_url: string;
  }> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Unauthorized");
    if (String(args.reviewer_user_id) !== String(userId)) {
      throw new Error("Forbidden: reviewer must be the authenticated user");
    }
    const pr = await ctx.runQuery(api.pull_requests.getPRById, {
      pr_id: args.pull_request_id,
    });

    if (!pr) {
      throw new Error(`Pull request with id ${args.pull_request_id} not found`);
    }

    const githubResult = await ctx.runAction(api.githubApi.submitPRReview, {
      repository: pr.repository,
      pr_number: pr.number,
      event: args.event,
      body: args.body,
      github_access_token: args.github_access_token,
    });

    const state =
      args.event === "APPROVE" ? "approved" :
      args.event === "REQUEST_CHANGES" ? "changes_requested" :
      "commented";

    const reviewId = await ctx.runMutation(api.reviews.createReview, {
      pull_request_id: args.pull_request_id,
      reviewer_user_id: args.reviewer_user_id,
      state: state as "approved" | "changes_requested" | "commented",
      body: args.body,
    });

    return {
      success: true,
      review_id: reviewId,
      github_review_id: githubResult.review_id,
      github_review_url: githubResult.review_url,
    };
  },
});


// ── The batched review ──
//
// Notes accumulate as pending rows while the reviewer reads (codeComments.create
// with pending). They leave together: as one GitHub review under the reviewer's
// own account, or as one message to a session, or both. The reviewer's own
// token is required for GitHub, because a review is an opinion with a name on
// it and the app has none.

export const reviewerFor = internalQuery({
  args: { user_id: v.id("users"), pull_request_id: v.id("pull_requests") },
  handler: async (ctx, args) => {
    const user: any = await ctx.db.get(args.user_id);
    const pr = await ctx.db.get(args.pull_request_id);
    if (!user || !pr) return null;
    return {
      github_token: user.github_access_token ?? null,
      github_username: user.github_username ?? null,
      pr: {
        repository: pr.repository,
        number: pr.number,
        head_sha: pr.head_sha ?? null,
        state: pr.state,
        // The session that owns the pull request, when one is bound: the
        // review reaches it as a message the moment GitHub accepts it.
        owner_conversation_id: pr.shepherd_conversation_id ? String(pr.shepherd_conversation_id) : null,
      },
    };
  },
});

const EVENT_STATE = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes_requested",
  COMMENT: "commented",
} as const;

export const submitPending = action({
  args: {
    api_token: v.optional(v.string()),
    pull_request_id: v.id("pull_requests"),
    event: v.union(v.literal("APPROVE"), v.literal("REQUEST_CHANGES"), v.literal("COMMENT")),
    body: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<any> => {
    const userId = await ctx.runQuery(internal.reviews.callerId, { api_token: args.api_token });
    if (!userId) return { error: "Unauthorized" };
    return await submitReviewWithNotes(ctx, userId, args.pull_request_id, args.event, args.body);
  },
});

/**
 * The one review submission: the verdict, the summary, and every pending
 * note the reviewer holds on the pull request, as one GitHub review under
 * their own account. The page and `cast pr review` both come through here.
 */
export async function submitReviewWithNotes(
  ctx: any,
  userId: any,
  pullRequestId: any,
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  body: string | undefined,
): Promise<any> {
  {
    const args = { pull_request_id: pullRequestId, event, body };
    const reviewer: any = await ctx.runQuery(internal.reviews.reviewerFor, { user_id: userId, pull_request_id: args.pull_request_id });
    if (!reviewer) return { error: "Pull request not found" };
    if (!reviewer.github_token) {
      return { error: "A review goes out under your own GitHub account, and this one has no GitHub token. Connect GitHub in codecast, or review on github.com." };
    }
    if (reviewer.pr.state !== "open") return { error: `${reviewer.pr.repository}#${reviewer.pr.number} is ${reviewer.pr.state}.` };

    const notes: any[] = await ctx.runQuery(internal.codeComments.pendingRowsInternal, { user_id: userId, pull_request_id: args.pull_request_id });
    if (args.event === "COMMENT" && !args.body?.trim() && notes.length === 0) {
      return { error: "Nothing to submit: write a note or a summary first." };
    }

    const comments = notes
      .filter((n) => n.file_path && n.line_number != null)
      .map((n) => {
        const side = n.side ?? "RIGHT";
        const isRange = n.line_end != null && n.line_end !== n.line_number;
        return {
          path: n.file_path,
          body: n.content,
          line: isRange ? n.line_end : n.line_number,
          side,
          ...(isRange ? { start_line: n.line_number, start_side: side } : {}),
        };
      });

    try {
      const result: any = await ctx.runAction(api.githubApi.submitPRReview, {
        repository: reviewer.pr.repository,
        pr_number: reviewer.pr.number,
        event: args.event,
        body: args.body,
        commit_id: reviewer.pr.head_sha ?? undefined,
        comments,
        github_access_token: reviewer.github_token,
      });
      const posted: any[] = comments.length
        ? await ctx.runAction(internal.githubApi.listReviewComments, {
            repository: reviewer.pr.repository,
            pr_number: reviewer.pr.number,
            review_id: result.review_id,
            github_access_token: reviewer.github_token,
          })
        : [];
      const stamped = await ctx.runMutation(internal.codeComments.recordSubmittedReview, {
        user_id: userId,
        pull_request_id: args.pull_request_id,
        github_review_id: result.review_id,
        review_url: result.review_url,
        state: EVENT_STATE[args.event],
        body: args.body,
        commit_sha: reviewer.pr.head_sha ?? undefined,
        comments: posted,
      });
      // The owning session hears the whole review as one message: verdict,
      // summary and every note. The webhook echo of this review changes no
      // row we have not already written, so it does not wake the session a
      // second time.
      const delivered: any = reviewer.pr.owner_conversation_id
        ? await ctx.runMutation(internal.reviews.deliverSubmittedReview, {
            user_id: userId,
            pull_request_id: args.pull_request_id,
            conversation_ref: reviewer.pr.owner_conversation_id,
            note_ids: notes.map((n) => n._id),
            github_review_id: result.review_id,
            state: EVENT_STATE[args.event],
            body: args.body,
            review_url: result.review_url,
          })
        : null;
      return {
        repository: reviewer.pr.repository,
        number: reviewer.pr.number,
        state: EVENT_STATE[args.event],
        url: result.review_url,
        notes: notes.length,
        as: reviewer.github_username,
        ...stamped,
        delivered_to: delivered,
      };
    } catch (error) {
      return { error: githubSentence(error) };
    }
  }
}

/**
 * Hand a review GitHub just accepted to the session that owns the pull
 * request. Best effort: the review is already on GitHub, so a session that
 * cannot take a message (released, killed, not the reviewer's to send to)
 * costs the reviewer nothing but a line in the result.
 */
export const deliverSubmittedReview = internalMutation({
  args: {
    user_id: v.id("users"),
    pull_request_id: v.id("pull_requests"),
    conversation_ref: v.string(),
    note_ids: v.array(v.id("review_comments")),
    github_review_id: v.optional(v.number()),
    state: v.union(v.literal("approved"), v.literal("changes_requested"), v.literal("commented")),
    body: v.optional(v.string()),
    review_url: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const pr = await ctx.db.get(args.pull_request_id);
    if (!pr) return null;
    const rows: Doc<"review_comments">[] = [];
    for (const id of args.note_ids) {
      const row = await ctx.db.get(id);
      if (row) rows.push(row);
    }
    try {
      const sent = await sendNotesToSession(ctx, args.user_id, args.conversation_ref, rows, {
        repository: pr.repository,
        ref: pr.head_sha ?? undefined,
        pullRequest: { number: pr.number, url: args.review_url ?? codecastPrUrl(pr.repository, pr.number) },
        verdict: args.state,
        summary: args.body,
      });
      // GitHub's webhook for this same review may still be on its way, or may
      // have landed before our row was written. Either way the stamp tells its
      // delayed wake that the session has already heard the review.
      if (args.github_review_id != null) {
        const row = await ctx.db
          .query("reviews")
          .withIndex("by_github_review_id", (q) => q.eq("github_review_id", args.github_review_id))
          .first();
        if (row) await ctx.db.patch(row._id, { session_delivered_at: Date.now() });
      }
      return { conversation_id: String(sent.conversation_id), short_id: sent.short_id ?? null, notes: sent.sent };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  },
});

export const callerId = internalQuery({
  args: { api_token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    try {
      return await requireUserOrToken(ctx, args.api_token);
    } catch {
      return null;
    }
  },
});

/**
 * Hand the pending notes to a session as one message, the way `cast review
 * send` does, without submitting them to GitHub. The notes stay pending, so
 * the same batch can still go out as a review afterwards.
 */
export const handPendingToSession = mutation({
  args: {
    api_token: v.optional(v.string()),
    pull_request_id: v.id("pull_requests"),
    // Defaults to the pull request's shepherd.
    conversation_ref: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const pr = await requireAccessiblePullRequest(ctx, userId, args.pull_request_id);
    const ref = args.conversation_ref ?? (pr.shepherd_conversation_id ? String(pr.shepherd_conversation_id) : undefined);
    if (!ref) throw new Error("No session to hand the review to: bind a shepherd or name a session.");
    const rows = await pendingRowsFor(ctx, userId, args.pull_request_id);
    if (rows.length === 0) throw new Error("No pending notes on this pull request");
    return await sendNotesToSession(ctx, userId, ref, rows, {
      repository: pr.repository,
      ref: pr.head_sha ?? undefined,
      pullRequest: { number: pr.number, url: codecastPrUrl(pr.repository, pr.number) },
    });
  },
});
