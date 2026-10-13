// The CI result of a commit a problem's page names as its fix (line-journeys.md
// LJ8.3, "Already fixed on main"): a run found main already carries the fix
// and the person's act is to close the problem as fixed, which is only safe
// once that commit's checks are green. The commit is read in the project's
// repositories (lineWorkspace projectRepositories), through the workspace's
// GitHub installation for each, and its checks fold to one word the way a pull
// request's do (foldChecksState). Read only; nothing is stored.
import { v } from "convex/values";
import { action, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessProject } from "./lib/access";
import { commitUrl, foldChecksState, PASSING_CONCLUSIONS, type CheckEntry } from "./lib/gitRefs";
import { projectRepositories } from "./lineWorkspace";

export type FixCommitChecks = {
  /** "success" | "failure" | "pending" | "none" (no checks ran), or "unknown" when no repository of the project has the commit or none is connected. */
  state: string;
  repository: string | null;
  sha: string;
  url: string | null;
  /** The checks that did not pass, by name; and those still running. */
  failing: string[];
  running: string[];
  passed: number;
};

export const fixRepositories = internalQuery({
  args: { project_id: v.id("projects"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<string[]> => {
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, args.user_id, project))) return [];
    return await projectRepositories(ctx, project, []);
  },
});

/** One word for a commit's checks, and the names behind it. Pure. */
export function summarizeChecks(checks: ReadonlyArray<CheckEntry>): Pick<FixCommitChecks, "state" | "failing" | "running" | "passed"> {
  const failing = checks.filter((c) => c.status === "completed" && c.conclusion && !PASSING_CONCLUSIONS.has(c.conclusion)).map((c) => c.name);
  const running = checks.filter((c) => c.status !== "completed" || !c.conclusion).map((c) => c.name);
  const passed = checks.filter((c) => c.status === "completed" && c.conclusion === "success").length;
  return { state: foldChecksState([...checks]), failing, running, passed };
}

export const fixCommitChecks = action({
  args: { project_id: v.id("projects"), sha: v.string() },
  handler: async (ctx, args): Promise<FixCommitChecks> => {
    const unknown: FixCommitChecks = { state: "unknown", repository: null, sha: args.sha, url: null, failing: [], running: [], passed: 0 };
    const userId = await getAuthUserId(ctx);
    if (!userId || !/^[0-9a-f]{7,40}$/i.test(args.sha)) return unknown;
    const repos: string[] = await ctx.runQuery(internal.lineFixChecks.fixRepositories, { project_id: args.project_id, user_id: userId as Id<"users"> });
    for (const repository of repos) {
      const access = await ctx.runQuery(internal.repos.repoAccess, { repository, user_id: userId as Id<"users"> });
      if (!access?.installation_id) continue;
      const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: access.installation_id });
      // A repository that does not hold the commit answers 404 or 422: try the next.
      const checks = await ctx.runAction(internal.githubApi.listPRChecks, { repository, sha: args.sha, github_access_token: token }).catch(() => null);
      if (!checks) continue;
      return { ...summarizeChecks(checks), repository, sha: args.sha, url: commitUrl(repository, args.sha) };
    }
    return unknown;
  },
});
