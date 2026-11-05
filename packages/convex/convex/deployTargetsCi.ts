// Deploy targets: CI on main per commit, main's order, and GitHub statuses as
// deploys (docs/architecture/deploys.md DP10, DP11). Written by the webhook drain
// (githubWebhooks.ts) and the backfill in deployTargets.ts.

import type { Doc, Id } from "./_generated/dataModel";
import { normalizeRepository } from "./lib/gitRefs";
import { resolveTeamForRepository } from "./githubWebhooks";
import { recordDeployMarker } from "./deploys";
import { commitCiState, type CommitCiRun, type CommitCiState } from "@codecast/shared/contracts/deployTargets";

export const teamKey = (teamId: Id<"teams">) => `team:${teamId}`;

// ── CI on main, per commit ───────────────────────────────────────────────────

export type CommitCiInput = {
  repository: string;
  sha: string;
  name: string;
  kind: "workflow" | "suite";
  run_id?: string;
  status: string;
  conclusion?: string;
  url?: string;
  started_at: number;
};

/**
 * One workflow run or check suite on the default branch, as the commit's CI
 * row for that workflow or app: written once per run, updated as it moves,
 * and a rerun (a newer start) takes the row over. Returns false for a repository
 * no team's installation routes.
 */
export async function recordCommitCi(ctx: any, row: CommitCiInput, teamId?: Id<"teams"> | null): Promise<boolean> {
  const repository = normalizeRepository(row.repository);
  const team = teamId ?? (await resolveTeamForRepository(ctx, repository));
  if (!team) return false;
  const sha = row.sha.toLowerCase();
  const now = Date.now();
  const rows: Doc<"commit_ci">[] = await ctx.db.query("commit_ci").withIndex("by_repository_sha", (q: any) => q.eq("repository", repository).eq("sha", sha)).take(50);
  const same = rows.find((r) => r.name === row.name && r.kind === row.kind);
  const fields = {
    ...(row.run_id ? { run_id: row.run_id } : {}),
    status: row.status,
    ...(row.conclusion ? { conclusion: row.conclusion } : {}),
    ...(row.url ? { url: row.url } : {}),
    started_at: row.started_at,
    updated_at: now,
  };
  if (same) {
    // An older run's late delivery does not speak over a newer run of the same workflow.
    if (row.started_at < same.started_at) return true;
    if (same.status === "completed" && row.status !== "completed" && same.run_id === row.run_id) return true;
    await ctx.db.patch(same._id, { ...fields, ...(row.conclusion ? {} : { conclusion: undefined }) });
  } else {
    await ctx.db.insert("commit_ci", { workspace: teamKey(team), team_id: team, repository, sha, name: row.name, kind: row.kind, ...fields });
  }
  return true;
}

/** A workflow_run payload on its repository's default branch as a commit CI row, whatever its status. */
export function workflowRunCi(payload: any): CommitCiInput | null {
  const run = payload?.workflow_run;
  const repository = normalizeRepository(payload?.repository?.full_name);
  const defaultBranch = payload?.repository?.default_branch;
  if (!run?.head_sha || !repository || !defaultBranch || run.head_branch !== defaultBranch) return null;
  if (String(run.event ?? "").startsWith("pull_request")) return null;
  const headRepository = normalizeRepository(run.head_repository?.full_name);
  if (headRepository && headRepository !== repository) return null;
  const name = payload?.workflow?.name ?? run.name ?? run.path;
  if (!name) return null;
  const started = Date.parse(run.run_started_at ?? run.created_at ?? "");
  return {
    repository,
    sha: run.head_sha,
    name,
    kind: "workflow",
    ...(run.id != null ? { run_id: String(run.id) } : {}),
    status: String(run.status ?? "queued"),
    ...(run.conclusion ? { conclusion: String(run.conclusion) } : {}),
    ...(run.html_url ? { url: run.html_url } : {}),
    started_at: Number.isFinite(started) ? started : Date.now(),
  };
}

/** A check_suite payload from an app other than Actions (whose workflow runs speak for it) on the default branch. */
export function checkSuiteCi(payload: any): CommitCiInput | null {
  const suite = payload?.check_suite;
  const repository = normalizeRepository(payload?.repository?.full_name);
  const defaultBranch = payload?.repository?.default_branch;
  if (!suite?.head_sha || !repository || !defaultBranch || suite.head_branch !== defaultBranch) return null;
  const app = suite.app?.slug ?? suite.app?.name;
  if (!app || app === "github-actions") return null;
  // Apps that report by commit status instead (Railway, GitGuardian) leave a suite queued forever: it says nothing.
  if (suite.status === "queued" || suite.status === "requested") return null;
  const started = Date.parse(suite.created_at ?? suite.updated_at ?? "");
  return {
    repository,
    sha: suite.head_sha,
    name: suite.app?.name ?? app,
    kind: "suite",
    ...(suite.id != null ? { run_id: String(suite.id) } : {}),
    status: String(suite.status ?? "queued"),
    ...(suite.conclusion ? { conclusion: String(suite.conclusion) } : {}),
    started_at: Number.isFinite(started) ? started : Date.now(),
  };
}

/** Each commit's CI, read from its rows. */
export async function ciOf(ctx: any, repository: string, sha: string): Promise<{ state: CommitCiState; url: string | null; runs: CommitCiRun[] }> {
  const rows: Doc<"commit_ci">[] = await ctx.db.query("commit_ci").withIndex("by_repository_sha", (q: any) => q.eq("repository", repository).eq("sha", sha.toLowerCase())).take(50);
  const runs = rows.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion ?? null, url: r.url ?? null, at: r.started_at }));
  const state = commitCiState(runs);
  const red = runs.find((r) => r.status === "completed" && r.conclusion && !["success", "neutral", "skipped", "cancelled", "stale"].includes(r.conclusion));
  return { state, url: red?.url ?? runs.find((r) => r.url)?.url ?? null, runs };
}


// ── main's order ─────────────────────────────────────────────────────────────

/**
 * A push to the default branch orders its commits on main: each a millisecond
 * after the one before, from the push's time. A commit already ordered keeps
 * its place (a redelivery, the same commit pushed again).
 */
export async function stampMainOrder(ctx: any, commitIds: Id<"commits">[], at: number): Promise<number> {
  let stamped = 0;
  for (const [i, id] of commitIds.entries()) {
    const c = await ctx.db.get(id);
    if (!c || c.main_at != null) continue;
    await ctx.db.patch(id, { main_at: at + i });
    stamped++;
  }
  return stamped;
}

// ── GitHub: a target that deploys on push (DP11) ─────────────────────────────

const STATUS_TO_DEPLOY: Record<string, "running" | "live" | "failed" | undefined> = {
  pending: "running",
  queued: "running",
  in_progress: "running",
  success: "live",
  failure: "failed",
  error: "failed",
};

/**
 * A commit status (`status` webhook) or a deployment status on a repository's
 * default branch, as a deploy of every target whose reader names its context
 * or environment: pending is running, success is live, failure is failed.
 */
export async function recordGithubDeployStatus(
  ctx: any,
  e: { repository: string; sha: string; context: string; state: string; url?: string; at: number; on_default_branch: boolean; actor?: string; description?: string },
): Promise<string[]> {
  const status = STATUS_TO_DEPLOY[e.state];
  if (!status || !e.on_default_branch) return [];
  const repository = normalizeRepository(e.repository);
  const rows: Doc<"deploy_targets">[] = (await ctx.db.query("deploy_targets").withIndex("by_repository_name", (q: any) => q.eq("repository", repository)).take(50))
    .filter((r: Doc<"deploy_targets">) => !r.retired_at && r.live.kind === "github-status" && r.live.context === e.context);
  const out: string[] = [];
  for (const t of rows) {
    const deploy = await recordDeployMarker(ctx, {
      workspace: t.workspace,
      ...(t.team_id ? { team_id: t.team_id } : {}),
      target: t.name,
      sha: e.sha.toLowerCase(),
      repository,
      source: `github: ${e.context}`,
      ...(e.url ? { url: e.url } : {}),
      status,
      // What GitHub says about a failure ("Deployment failed", "crashed"), as the deploy's note.
      ...(status === "failed" && e.description ? { note: e.description } : {}),
      ...(e.actor ? { started_by: { kind: "source" as const, name: e.actor } } : {}),
      at: e.at,
    });
    if (deploy) out.push(deploy);
  }
  return out;
}

/** A `status` webhook payload as a deploy status, when it is on the default branch. */
export function statusEventOf(payload: any): Parameters<typeof recordGithubDeployStatus>[1] | null {
  const repository = payload?.repository?.full_name;
  const defaultBranch = payload?.repository?.default_branch;
  if (!repository || !payload?.sha || !payload?.context || !payload?.state) return null;
  const branches: string[] = (payload.branches ?? []).map((b: any) => b?.name).filter(Boolean);
  const at = Date.parse(payload.updated_at ?? payload.created_at ?? "");
  return {
    repository,
    sha: payload.sha,
    context: payload.context,
    state: payload.state,
    ...(payload.target_url ? { url: payload.target_url } : {}),
    ...(payload.description ? { description: String(payload.description).slice(0, 500) } : {}),
    at: Number.isFinite(at) ? at : Date.now(),
    // GitHub lists the branches whose head holds the commit (up to ten); a status on main's commit names main.
    on_default_branch: !!defaultBranch && branches.includes(defaultBranch),
  };
}

/** A `deployment_status` webhook payload as a deploy status: the deployment's environment is the context. */
export function deploymentStatusEventOf(payload: any): Parameters<typeof recordGithubDeployStatus>[1] | null {
  const repository = payload?.repository?.full_name;
  const dep = payload?.deployment;
  const st = payload?.deployment_status;
  if (!repository || !dep?.sha || !dep?.environment || !st?.state) return null;
  const at = Date.parse(st.updated_at ?? st.created_at ?? "");
  const ref = String(dep.ref ?? "");
  return {
    repository,
    sha: dep.sha,
    context: dep.environment,
    state: st.state,
    ...(st.log_url || st.target_url ? { url: st.log_url ?? st.target_url } : {}),
    ...(st.description ? { description: String(st.description).slice(0, 500) } : {}),
    at: Number.isFinite(at) ? at : Date.now(),
    on_default_branch: ref === payload?.repository?.default_branch || ref === dep.sha,
    ...(dep.creator?.login ? { actor: dep.creator.login } : {}),
  };
}
