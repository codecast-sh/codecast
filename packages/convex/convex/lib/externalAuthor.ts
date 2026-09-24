import { v } from "convex/values";

// Who really did something that arrived from Slack, when that person could not
// be matched to a codecast account and the row's `user_id` is the workspace's
// bridge identity. A snapshot at sync time: the UI shows this name and face,
// never the bridge's. Chat messages and chat reactions both carry it.
export const externalAuthorValidator = v.object({
  name: v.string(),
  handle: v.optional(v.string()),
  avatar_url: v.optional(v.string()),
  is_bot: v.optional(v.boolean()),
});
