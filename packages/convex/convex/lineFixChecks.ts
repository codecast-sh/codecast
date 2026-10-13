// The CI result of a commit a problem's page names as its fix (line-journeys.md
// LJ8.3, "Already fixed on main"): a run found main already carries the fix
// and the person's act is to close the problem as fixed, which is only safe
// once that commit's checks are green. The commit is read in the project's
// repositories (lineWorkspace projectRepositories), through the workspace's
// GitHub installation for each, and its checks fold to one word the way a pull
// request's do (foldChecksState). When the problem came from a red CI run, the
// checks that run failed are read first and answered for on their own: whether
// the fix commit makes them pass is the question; any other red is apart, under
// "other checks". Read only; nothing is stored.
import { v } from "convex/values";
import { action, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { canAccessProject } from "./lib/access";
import { commitUrl, foldChecksState, PASSING_CONCLUSIONS, type CheckEntry } from "./lib/gitRefs";
import { projectRepositories } from "./lineWorkspace";
import { cardBranch } from "./lineTrial";

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
  /** The checks the problem's own CI run failed (`failed_run`), as they ended on this commit: the fix's verdict.
   *  `ok` null while running or when the commit did not run it. Absent when no run was named or it could not be read. */
  named?: Array<{ name: string; ok: boolean | null; url: string | null }>;
};

/** A GitHub Actions run a finding links to: its repository and run id. */
export function actionsRun(url: string | null | undefined): { repository: string; run_id: string } | null {
  const m = /github\.com\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)/.exec(url ?? "");
  return m ? { repository: m[1], run_id: m[2] } : null;
}

/** The commit's checks with those the problem's run failed taken out and answered for on their own. Pure. */
export function namedChecks(checks: ReadonlyArray<CheckEntry>, failedJobs: ReadonlyArray<string>): { named: NonNullable<FixCommitChecks["named"]>; others: CheckEntry[] } {
  const want = new Set(failedJobs);
  const named = failedJobs.map((name) => {
    const c = checks.find((x) => x.name === name);
    // A skipped check proves nothing about the test: only a run that ended answers.
    return { name, ok: !c || c.status !== "completed" || !c.conclusion || c.conclusion === "skipped" ? null : c.conclusion === "success", url: c?.url ?? null };
  });
  return { named, others: checks.filter((c) => !want.has(c.name)) };
}

export const fixRepositories = internalQuery({
  args: { project_id: v.id("projects"), user_id: v.id("users") },
  handler: async (ctx, args): Promise<string[]> => {
    const project = await ctx.db.get(args.project_id);
    if (!project || !(await canAccessProject(ctx, args.user_id, project))) return [];
    return await projectRepositories(ctx, project, []);
  },
});

/** The branch a problem's run built its fix on and the repository it lives in, read from the run itself: the worktree
 *  its building station ran in names the branch, and the checkout of the run's directory names the repository
 *  (lineTrial cardBranch). Null when the run is not one of this project's problems or names neither. */
export const runFixBranch = internalQuery({
  args: { project_id: v.id("projects"), user_id: v.id("users"), run_id: v.id("workflow_runs") },
  handler: async (ctx, args): Promise<{ repository: string; name: string } | null> => {
    const project = await ctx.db.get(args.project_id);
    const run = await ctx.db.get(args.run_id);
    const task = run?.task_id ? await ctx.db.get(run.task_id) : null;
    if (!project || !task || String(task.project_id ?? "") !== String(args.project_id) || !(await canAccessProject(ctx, args.user_id, project))) return null;
    const found = await cardBranch(ctx as never, run, new Map());
    return found ? { repository: found.repository, name: found.name } : null;
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
  args: { project_id: v.id("projects"), sha: v.string(), failed_run: v.optional(v.string()) },
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
      const run = actionsRun(args.failed_run);
      const jobs = run && run.repository.toLowerCase() === repository.toLowerCase()
        ? await ctx.runAction(internal.githubApi.listRunJobs, { repository, run_id: run.run_id, github_access_token: token }).catch(() => null)
        : null;
      const failedJobs = (jobs ?? []).filter((j: { conclusion: string | null }) => j.conclusion && !PASSING_CONCLUSIONS.has(j.conclusion) && j.conclusion !== "skipped").map((j: { name: string }) => j.name);
      if (!failedJobs.length) return { ...summarizeChecks(checks), repository, sha: args.sha, url: commitUrl(repository, args.sha) };
      // The run's own failures answer first; the word and the lists below are the other checks'.
      const { named, others } = namedChecks(checks, failedJobs);
      return { ...summarizeChecks(others), named, repository, sha: args.sha, url: commitUrl(repository, args.sha) };
    }
    return unknown;
  },
});

export type CommitLive = {
  /** The repository holding the commit; null when no repository of the project has it, or none is readable. */
  repository: string | null;
  /** The first deploy whose code contains the commit, of those given; null when none does. */
  first: { sha: string; at: number } | null;
  /** The newest deploy given, the one "not deployed" is said against. */
  newest: { sha: string; at: number } | null;
};

/** The earliest of `deploys` (oldest first) that contains the commit, asking `carries` as few times as it can: a
 *  deploy line moves forward on one branch, so once one carries it every later one does. Null when the newest does not. */
export async function firstCarrying<D>(deploys: ReadonlyArray<D>, carries: (d: D) => Promise<boolean>): Promise<D | null> {
  if (!deploys.length || !(await carries(deploys[deploys.length - 1]))) return null;
  let lo = 0, hi = deploys.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (await carries(deploys[mid])) hi = mid; else lo = mid + 1;
  }
  return deploys[lo];
}

/** Whether a commit a problem names is in production, and since which recorded deploy (line-journeys.md LJ8.3: a
 *  finding that says a change must not reach production, or is not there yet). Ancestry, read from GitHub: a deploy
 *  carries the commit when its code contains it. Read only. */
export const commitLive = action({
  args: { project_id: v.id("projects"), sha: v.string(), deploys: v.array(v.object({ sha: v.string(), at: v.number() })) },
  handler: async (ctx, args): Promise<CommitLive> => {
    const deploys = [...args.deploys].filter((d) => /^[0-9a-f]{7,40}$/i.test(d.sha)).sort((a, b) => a.at - b.at).slice(-200);
    const newest = deploys.at(-1) ?? null;
    const none: CommitLive = { repository: null, first: null, newest };
    const userId = await getAuthUserId(ctx);
    if (!userId || !/^[0-9a-f]{7,40}$/i.test(args.sha)) return none;
    const repos: string[] = await ctx.runQuery(internal.lineFixChecks.fixRepositories, { project_id: args.project_id, user_id: userId as Id<"users"> });
    for (const repository of repos) {
      const access = await ctx.runQuery(internal.repos.repoAccess, { repository, user_id: userId as Id<"users"> });
      if (!access?.installation_id) continue;
      const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: access.installation_id });
      const status = (head: string) => ctx.runAction(internal.githubApi.compare, { repository, base: args.sha, head, github_access_token: token }).then((c: { status: string }) => c.status, () => null);
      // A repository that does not hold the commit cannot compare it: try the next.
      if (!newest || (await status(args.sha)) == null) continue;
      const first = await firstCarrying(deploys, async (d) => { const s = await status(d.sha); return s === "ahead" || s === "identical"; });
      return { repository, first, newest };
    }
    return none;
  },
});

export type FixBranchFile = { filename: string; status: string; additions: number; deletions: number; patch?: string; patch_truncated?: boolean };

export type FixBranch = {
  /** The repository holding the branch; null when no repository of the project has it, or none is readable. */
  repository: string | null;
  branch: string;
  /** The default branch it would land on. */
  base: string | null;
  /** Commits on the branch the base lacks, and commits on the base since the branch left it. */
  ahead: number;
  behind: number;
  head_sha: string | null;
  /** What the branch changes against where it left the base: the diff a review reads. */
  files: FixBranchFile[];
  additions: number;
  deletions: number;
  /** The branch's files the base changed too since the branch left it: where a rebase or merge can conflict. */
  on_both: string[];
  /** The branch's own commits, oldest first, each by its subject line: what the change says it does. */
  commits: Array<{ sha: string; subject: string }>;
  /** The branch head's checks, folded as a pull request's are. */
  checks: Pick<FixCommitChecks, "state" | "failing" | "running" | "passed">;
  url: string | null;
};

/** The branch's files the base also changed since they parted. Pure. */
export function filesOnBoth(branch: ReadonlyArray<{ filename: string }>, base: ReadonlyArray<{ filename: string }>): string[] {
  const moved = new Set(base.map((f) => f.filename));
  return branch.map((f) => f.filename).filter((f) => moved.has(f));
}

/** A fix branch a run handed off for review, read whole for the review (line-journeys.md "Built fixes to review"): its
 *  diff against where it left the default branch, how far the default branch moved since, which of its files moved there
 *  too, and its head's checks. Read only; nothing is stored. */
export const fixBranch = action({
  // `run_id`: the run that built it. Its own record names the branch and the repository, which a project with no
  // checkout path of its own cannot; `branch` is the caller's reading, used when the run names none.
  args: { project_id: v.id("projects"), branch: v.optional(v.string()), run_id: v.optional(v.id("workflow_runs")) },
  handler: async (ctx, args): Promise<FixBranch> => {
    const userId = await getAuthUserId(ctx);
    const fromRun = userId && args.run_id ? await ctx.runQuery(internal.lineFixChecks.runFixBranch, { project_id: args.project_id, user_id: userId as Id<"users">, run_id: args.run_id }) : null;
    const branch = fromRun?.name ?? args.branch ?? "";
    const none: FixBranch = { repository: null, branch, base: null, ahead: 0, behind: 0, head_sha: null, files: [], additions: 0, deletions: 0, on_both: [], commits: [], checks: { state: "unknown", failing: [], running: [], passed: 0 }, url: null };
    if (!userId || !/^[\w./-]+$/.test(branch)) return none;
    const repos: string[] = await ctx.runQuery(internal.lineFixChecks.fixRepositories, { project_id: args.project_id, user_id: userId as Id<"users"> });
    for (const repository of [...new Set([...(fromRun ? [fromRun.repository] : []), ...repos])]) {
      const access = await ctx.runQuery(internal.repos.repoAccess, { repository, user_id: userId as Id<"users"> });
      if (!access?.installation_id) continue;
      const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: access.installation_id });
      const meta = await ctx.runAction(internal.githubApi.getRepoMeta, { repository, github_access_token: token }).catch(() => null);
      const base = meta?.default_branch ?? "main";
      // A repository without the branch answers 404: try the next.
      const ours = await ctx.runAction(internal.githubApi.compare, { repository, base, head: branch, github_access_token: token }).catch(() => null);
      if (!ours) continue;
      const theirs = ours.behind_by > 0 ? await ctx.runAction(internal.githubApi.compare, { repository, base: branch, head: base, github_access_token: token }).catch(() => null) : null;
      const head = ours.commits.at(-1)?.sha ?? null;
      const checks = head ? await ctx.runAction(internal.githubApi.listPRChecks, { repository, sha: head, github_access_token: token }).catch(() => null) : null;
      const files: FixBranchFile[] = ours.files;
      return {
        repository, branch, base, ahead: ours.ahead_by, behind: ours.behind_by, head_sha: head, files,
        additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
        on_both: theirs ? filesOnBoth(files, theirs.files) : [],
        commits: ours.commits.map((c: { sha: string; message: string }) => ({ sha: c.sha, subject: c.message.split("\n")[0].trim() })),
        checks: checks ? summarizeChecks(checks) : none.checks,
        url: `https://github.com/${repository}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}`,
      };
    }
    return none;
  },
});
