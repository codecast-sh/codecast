// A CI source's history read back from GitHub. The workflow_run webhook keeps
// each finished run on the default branch from the moment it is connected
// (ingest.recordCiRun), which would leave the failure rate and run time
// series empty for days after a team connects CI. `forTeam` reads the last
// CI_RUNS_DAYS of finished default-branch runs from the Actions runs API, for
// every repository the team's installations cover that was pushed in that
// window, and merges them into the source's kept runs. It runs when the
// github-ci source is created, and `forAll` runs it once for every existing
// one.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { workspaceKey as makeWorkspaceKey } from "./lib/accessKeys";
import { GITHUB_CI_SOURCE_NAME } from "@codecast/shared/contracts/ingest";
import { CI_RUNS_DAYS, CI_RUNS_KEPT, withCiRuns, type CiRunFact } from "@codecast/shared/contracts/volumeWatch";
import { normalizeRepository } from "./lib/gitRefs";
import { defaultBranchCiRun } from "./githubWebhooks";
import { patchSourceStats } from "./ingest";

const GITHUB_API = "https://api.github.com";
const DAY = 86_400_000;
/** Repositories read per installation, newest push first. */
const REPOS_MAX = 40;
/** Pages of 100 runs read per repository. */
const RUN_PAGES_MAX = 6;

type Repo = { full_name: string; default_branch: string; pushed_at: number };

async function gh(token: string, path: string): Promise<any | null> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  return res.ok ? await res.json() : null;
}

/** The repositories an installation covers that were pushed since `since`, newest first. */
export function recentRepos(listed: readonly any[], since: number): Repo[] {
  return listed
    .filter((r) => !r?.archived)
    .map((r) => ({ full_name: String(r?.full_name ?? ""), default_branch: String(r?.default_branch ?? ""), pushed_at: Date.parse(r?.pushed_at ?? "") }))
    .filter((r) => r.full_name && r.default_branch && Number.isFinite(r.pushed_at) && r.pushed_at >= since)
    .sort((a, b) => b.pushed_at - a.pushed_at)
    .slice(0, REPOS_MAX);
}

/** One page of the Actions runs API as the github-ci source keeps it: the same rule the webhook applies (defaultBranchCiRun). */
export function runFacts(repo: Pick<Repo, "full_name" | "default_branch">, runs: readonly any[]): CiRunFact[] {
  const out: CiRunFact[] = [];
  for (const run of runs) {
    const ci = defaultBranchCiRun({ workflow_run: run, repository: { full_name: repo.full_name, default_branch: repo.default_branch } });
    if (ci) out.push({ at: ci.at, ok: ci.ok, ...(ci.duration_ms !== undefined ? { duration_ms: ci.duration_ms } : {}) });
  }
  return out;
}

export const teamInstallations = internalQuery({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<number[]> => {
    const rows: Doc<"github_app_installations">[] = await ctx.db.query("github_app_installations").withIndex("by_team_id", (q) => q.eq("team_id", args.team_id)).collect();
    return rows.filter((r) => !r.suspended_at).map((r) => r.installation_id);
  },
});

export const ciSourceTeams = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<"teams">[]> => {
    const rows: Doc<"event_sources">[] = await ctx.db.query("event_sources").collect();
    return [...new Set(rows.filter((r) => r.name === GITHUB_CI_SOURCE_NAME && r.provider === "github" && r.team_id).map((r) => r.team_id as Id<"teams">))];
  },
});

/** Read runs merged into the team's github-ci source; a team without one keeps nothing. */
export const keep = internalMutation({
  args: { team_id: v.id("teams"), runs: v.array(v.object({ at: v.number(), ok: v.boolean(), duration_ms: v.optional(v.number()) })) },
  handler: async (ctx, args): Promise<number> => {
    const workspace = makeWorkspaceKey({ type: "team", teamId: args.team_id });
    const source = await ctx.db.query("event_sources").withIndex("by_workspace_name", (q) => q.eq("workspace", workspace).eq("name", GITHUB_CI_SOURCE_NAME)).first();
    if (!source || source.provider !== "github" || source.status === "paused") return 0;
    const next = await patchSourceStats(ctx, source, (s) => ({ ci_runs: withCiRuns(s.ci_runs, args.runs) }));
    return next.ci_runs?.length ?? 0;
  },
});

export const forTeam = internalAction({
  args: { team_id: v.id("teams") },
  handler: async (ctx, args): Promise<{ repositories: number; runs: number; kept: number }> => {
    const since = Date.now() - CI_RUNS_DAYS * DAY;
    const sinceDay = new Date(since).toISOString().slice(0, 10);
    const facts: CiRunFact[] = [];
    let repositories = 0;
    for (const installation_id of await ctx.runQuery(internal.ciBackfill.teamInstallations, { team_id: args.team_id })) {
      const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id });
      const listed: any[] = [];
      for (let page = 1; page <= 3; page++) {
        const body = await gh(token, `/installation/repositories?per_page=100&page=${page}`);
        const batch: any[] = Array.isArray(body?.repositories) ? body.repositories : [];
        listed.push(...batch);
        if (batch.length < 100) break;
      }
      for (const repo of recentRepos(listed, since)) {
        // A person's repository on a shared install reaches the team only once they share it there (routingTeamForInstallation).
        if (!(await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, { repository: normalizeRepository(repo.full_name), team_id: args.team_id }))) continue;
        repositories++;
        const branch = encodeURIComponent(repo.default_branch);
        for (let page = 1; page <= RUN_PAGES_MAX; page++) {
          const body = await gh(token, `/repos/${repo.full_name}/actions/runs?branch=${branch}&status=completed&exclude_pull_requests=true&created=%3E%3D${sinceDay}&per_page=100&page=${page}`);
          const runs: any[] = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
          facts.push(...runFacts(repo, runs));
          if (runs.length < 100) break;
        }
      }
    }
    const newest = facts.sort((a, b) => a.at - b.at).slice(-CI_RUNS_KEPT);
    const kept = newest.length ? await ctx.runMutation(internal.ciBackfill.keep, { team_id: args.team_id, runs: newest }) : 0;
    return { repositories, runs: newest.length, kept };
  },
});

/** Every existing github-ci source read back once, a few seconds apart. */
export const forAll = internalAction({
  args: {},
  handler: async (ctx): Promise<number> => {
    const teams = await ctx.runQuery(internal.ciBackfill.ciSourceTeams, {});
    for (const [i, team_id] of teams.entries()) await ctx.scheduler.runAfter(i * 5_000, internal.ciBackfill.forTeam, { team_id });
    return teams.length;
  },
});
