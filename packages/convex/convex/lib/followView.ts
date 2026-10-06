import { v } from "convex/values";

// The in-page half of a leader's view (FollowView in
// @codecast/shared/contracts/follow): one validator for the table, the
// report and the read, so the three cannot drift.
export const followViewValidator = v.object({
  panel: v.optional(v.string()),
  diff: v.optional(v.object({ file: v.string(), line: v.optional(v.number()), base: v.optional(v.string()) })),
  scroll: v.optional(v.object({ key: v.string(), offset: v.number() })),
});
