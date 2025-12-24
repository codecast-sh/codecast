import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const create = mutation({
  args: {
    team_id: v.id("teams"),
    github_pr_id: v.number(),
    repository: v.string(),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.union(
      v.literal("open"),
      v.literal("closed"),
      v.literal("merged")
    ),
    author_github_username: v.string(),
    linked_session_ids: v.array(v.id("conversations")),
  },
  handler: async (ctx, args) => {
    const prId = await ctx.db.insert("pull_requests", {
      team_id: args.team_id,
      github_pr_id: args.github_pr_id,
      repository: args.repository,
      number: args.number,
      title: args.title,
      body: args.body,
      state: args.state,
      author_github_username: args.author_github_username,
      linked_session_ids: args.linked_session_ids,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    return prId;
  },
});
