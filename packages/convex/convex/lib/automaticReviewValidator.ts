// What codecast's automatic review of a pull request said about one head (lib/automaticReview.ts), as the approval
// status stores it (pull_requests.approval.automatic) and settle takes it. A leaf: schema.ts imports it.
import { v } from "convex/values";

export const automaticReviewValidator = v.object({
  /** The head the diff it read ends at: the answer holds for this head alone. */
  head_sha: v.string(),
  /** The model's answer; absent when it gave none (`failed`). */
  mechanism: v.optional(v.boolean()),
  verdict: v.optional(v.union(v.literal("ship"), v.literal("changes"), v.literal("rejected"))),
  /** The model's reason, or why no answer came (the diff was too large, GitHub or the model failed, no budget). */
  reason: v.string(),
  /** No answer: a person reads it whole. */
  failed: v.optional(v.boolean()),
  cost_usd: v.optional(v.number()),
  at: v.number(),
});
