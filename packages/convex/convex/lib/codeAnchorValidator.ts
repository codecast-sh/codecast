import { v } from "convex/values";

// The text a line comment was written on (shared/comments/codeAnchor.ts), so
// readers can find the passage again after the code moves.
export const codeAnchorValidator = v.object({
  before: v.array(v.string()),
  lines: v.array(v.string()),
  after: v.array(v.string()),
});
