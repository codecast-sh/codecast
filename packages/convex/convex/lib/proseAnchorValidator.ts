import { v } from "convex/values";

// Where a prose comment points (shared/comments/proseAnchor.ts ProseAnchor):
// the commented text, its neighbours' text and the block's index.
export const proseAnchorValidator = v.object({
  text: v.string(),
  before: v.optional(v.string()),
  after: v.optional(v.string()),
  index: v.number(),
});
