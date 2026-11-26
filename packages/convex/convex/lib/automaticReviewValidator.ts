// What codecast's automatic review of a pull request said about one head (lib/automaticReview.ts), as the approval
// status stores it (pull_requests.approval.automatic) and settle takes it. A leaf: schema.ts imports it.
import { v } from "convex/values";

export const automaticReviewValidator = v.object({
  /** The head the diff it read ends at: the answer holds for this head alone. */
  head_sha: v.string(),
  /** An evaluation claimed this head and is calling the model; any other waits (changeApprovals.claimAutomaticReview). */
  pending: v.optional(v.boolean()),
  /** The model's answer; absent when it gave none (`failed`) or none came yet (`pending`). */
  mechanism: v.optional(v.boolean()),
  /** The model's reason, or why no answer came (no mechanism file, a binary or too large a diff, a failure, no budget). */
  reason: v.string(),
  /** No answer: a person reads it whole. */
  failed: v.optional(v.boolean()),
  cost_usd: v.optional(v.number()),
  at: v.number(),
});
