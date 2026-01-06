import { v } from "convex/values";
import { mutation, query, action } from "./_generated/server";
import { api } from "./_generated/api";

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
    const review = await ctx.db.get(args.review_id);
    if (!review) {
      throw new Error(`Review with id ${args.review_id} not found`);
    }

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
    const comments = await ctx.db
      .query("review_comments")
      .withIndex("by_review", (q) =>
        q.eq("review_id", args.review_id)
      )
      .collect();
    return comments;
  },
});

export const getPendingReviews = query({
  args: {
    user_id: v.id("users"),
  },
  handler: async (ctx, args) => {
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
    const comments = await ctx.db
      .query("review_comments")
      .withIndex("by_pull_request", (q) =>
        q.eq("pull_request_id", args.pull_request_id)
      )
      .collect();
    return comments.sort((a, b) => a.created_at - b.created_at);
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
    const pr = await ctx.db.get(args.pull_request_id);
    if (!pr) {
      throw new Error(`Pull request with id ${args.pull_request_id} not found`);
    }

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
    const allComments = await ctx.db
      .query("review_comments")
      .withIndex("by_pull_request", (q) =>
        q.eq("pull_request_id", args.pull_request_id)
      )
      .collect();

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
