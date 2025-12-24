import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

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
    const commentId = await ctx.db.insert("review_comments", {
      review_id: args.review_id,
      file_path: args.file_path,
      line_number: args.line_number,
      content: args.content,
      resolved: false,
      created_at: Date.now(),
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
