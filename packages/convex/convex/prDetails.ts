import { v } from "convex/values";
import { action, internalMutation } from "./functions";
import { api, internal } from "./_generated/api";
import { patchPullRequest } from "./prShepherd";

export const apply = internalMutation({
  args: {
    pr_id: v.id("pull_requests"),
    head_sha: v.optional(v.string()),
    started_at: v.number(),
    commits: v.optional(v.array(v.object({
      sha: v.string(), message: v.string(),
      author_login: v.optional(v.string()), author_name: v.optional(v.string()),
      author_avatar_url: v.optional(v.string()), committed_at: v.optional(v.number()), url: v.optional(v.string()),
    }))),
    checks: v.optional(v.array(v.object({
      name: v.string(), status: v.string(), updated_at: v.number(),
      conclusion: v.optional(v.string()), url: v.optional(v.string()), external_id: v.optional(v.string()),
      suite_id: v.optional(v.string()), event: v.optional(v.string()), app: v.optional(v.string()),
    }))),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const pr = await ctx.db.get(args.pr_id);
    if (!pr || pr.head_sha !== args.head_sha) return false;
    const patch: Record<string, unknown> = {};
    if (args.commits) {
      patch.commits = args.commits;
      patch.commits_count = args.commits.length === 250 ? Math.max(pr.commits_count ?? 0, 250) : args.commits.length;
    }
    if (args.checks) {
      const recent = (pr.checks ?? []).filter((check) => check.updated_at >= args.started_at);
      patch.checks = [
        ...args.checks.filter((check) => !recent.some((entry) =>
          (!!entry.external_id && entry.external_id === check.external_id) || (entry.name === check.name && entry.suite_id === check.suite_id),
        )).map((check) => {
          const previous = pr.checks?.find((entry) => entry.external_id === check.external_id);
          return { ...check, event: previous?.event ?? check.event };
        }),
        ...recent,
      ];
    }
    await patchPullRequest(ctx, args.pr_id, patch);
    return true;
  },
});

export const refresh = action({
  args: { pr_id: v.id("pull_requests"), section: v.union(v.literal("commits"), v.literal("checks")) },
  handler: async (ctx, args): Promise<void> => {
    const pr = await ctx.runQuery(api.pull_requests.webGet, { id: args.pr_id });
    if (!pr) throw new Error("Pull request not found or access denied.");
    const token = await ctx.runAction(internal.prShepherd.tokenForPR, { pr_id: args.pr_id });
    if (!token) throw new Error("Connect GitHub for this repository to load pull request details.");
    const started_at = Date.now();
    const request = { repository: pr.repository, github_access_token: token };
    let details;
    if (args.section === "commits") {
      const commits = await ctx.runAction(internal.githubApi.listPRCommits, { ...request, pr_number: pr.number });
      details = { commits };
    } else {
      const sha = pr.head_sha ?? (await ctx.runAction(internal.githubApi.getPull, { ...request, number: pr.number }))?.head_sha;
      if (!sha) throw new Error("GitHub has not returned the pull request's head commit. Try again.");
      details = { checks: await ctx.runAction(internal.githubApi.listPRChecks, { ...request, sha }) };
    }
    const applied = await ctx.runMutation(internal.prDetails.apply, {
      pr_id: args.pr_id, head_sha: pr.head_sha, started_at, ...details,
    });
    if (!applied) throw new Error("The pull request changed while loading. Try again.");
  },
});
