// Red main routes to its culprit (docs/architecture/main-red.md). Every
// finished CI run on a push to a repository's default branch is judged here:
//   noteMainCiRun (the webhook drain) claims the run and schedules `judge`;
//   `judge` reads the run's jobs, the workflow file (which failed jobs only
//     aggregate others) and the failed jobs' logs from GitHub, reruns the failed
//     jobs of a first red attempt, and hands the verdict to `settle`;
//   `settle` records the run's facts: a flake (a rerun that went green, or an
//     unproven run whose next run passed), the jobs it fixed, main_green on the
//     first green run after a culprit, stale culprits expired. Then it places
//     reds in the branch's order: a red joins the open culprit owning a job it
//     failed, names a new culprit (main_red), or is history (the job passed
//     after it) or a baseline (no green is known to compare it with).
//   `recheck` reads a run whose verdict never came, `probeCandidates` asks
//     whether earlier commits still have runs going, and `release` ends a hold.
// Only CI is judged (a workflow that runs on pull requests too), only in a
// repository that declares deploy targets and is listed in MAIN_RED_REPOS, in
// the workspace pinned for it.
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { parseWorkspaceKey, workspaceGrantsAccess } from "./lib/accessKeys";
import { conversationFromSessionTrailer, normalizeRepository } from "./lib/gitRefs";
import { isFailedConclusion } from "./lib/ciRunRead";
import { announce, brief, linkScope, runThatMerged } from "./lib/mainRedBrief";
import { recordExternalEventOnce } from "./externalEvents";
import { commitBySha, mainCommitsAfter } from "./deployTargetsState";
import type { CiRun } from "./ingest";
import { MAIN_GREEN_EVENT, MAIN_RED_EVENT } from "@codecast/shared/contracts";
import { parseFailures, type CiFailure } from "@codecast/shared/contracts/ciFailures";
import {
  aggregateJobs, culpritOf, fixedBy, greenAfter, jobGone, lastGreenFor, parseWorkflowJobs, placeRed,
  type JobRef, type JudgedRun, type MainRedPayload,
} from "@codecast/shared/contracts/mainRed";

const GITHUB_API = "https://api.github.com";
const MINUTE = 60_000;
const DAY = 86_400_000;
/** How long a red waits for the runs before it to settle before it is placed with what has. */
export const HOLD_MS = 45 * MINUTE;
/** When a claimed run with no verdict is read back from GitHub, and how long one still running is waited on. */
export const RECHECK_MS = 45 * MINUTE;
const GIVE_UP_MS = 6 * 60 * MINUTE;
/** A row still judging this long after its claim was never judged; the webhook's retry comes after it. */
export const JUDGING_TIMEOUT_MS = 15 * MINUTE;
/** A culprit whose jobs have not run for this long, and an unproven run never decided, are let go. */
export const STALE_MS = 7 * DAY;
/** Failed jobs whose logs a red run reads, and the bytes one log may hold (the action's memory is 64MB). */
const LOGS_READ = 6;
const LOG_MAX_BYTES = 8 * 1024 * 1024;
/** Failures one run keeps for its brief, and the excerpt each keeps. */
const FAILURES_KEPT = 12;
const EXCERPT_KEPT = 1500;
/** Runs of one workflow read back to place a red, open culprits read per scope, red commits an event lists. */
const RUNS_SCANNED = 60;
const CULPRITS_READ = 50;
const RED_SHAS_KEPT = 50;
const CANDIDATES_KEPT = 100;
/**
 * Job conclusions that mean the job never ran. A job cancelled inside a finished run is not one: a person can only
 * cancel the whole run (NO_VERDICT drops that), so a cancelled job is one that hit its timeout-minutes, and failed.
 */
const NOT_RUN = new Set(["skipped", "neutral", "stale"]);
const jobFailed = (conclusion: string | null) => isFailedConclusion(conclusion) || conclusion === "cancelled";
/** Run conclusions that are no verdict. */
const NO_VERDICT = new Set(["cancelled", "skipped", "neutral", "stale", "action_required"]);

const failureValidator = v.object({
  job: v.string(),
  test: v.union(v.string(), v.null()),
  assertion: v.union(v.string(), v.null()),
  file: v.union(v.string(), v.null()),
  line: v.union(v.number(), v.null()),
  excerpt: v.string(),
});
const jobValidator = v.object({ name: v.string(), ok: v.boolean() });

const kept = (failing: readonly CiFailure[]): CiFailure[] =>
  failing.slice(0, FAILURES_KEPT).map((f) => ({ ...f, excerpt: f.excerpt.slice(-EXCERPT_KEPT) }));

/** One workflow's runs on one repository in one workspace. */
type Scope = Pick<Doc<"main_ci_runs">, "workspace" | "repository" | "workflow">;

function scopeRuns(ctx: any, s: Scope) {
  return ctx.db.query("main_ci_runs").withIndex("by_scope_seq", (q: any) => q.eq("workspace", s.workspace).eq("repository", s.repository).eq("workflow", s.workflow));
}

// ── the webhook's side ───────────────────────────────────────────────────────

/**
 * A pull request's finished run of a workflow marks it as CI: a workflow that also runs on pushes to the branch
 * is judged. Only a pull request from the repository itself counts: a fork's pull request can add a trigger to
 * any workflow, and must not make main's runs of a push-only one get rerun.
 */
export async function noteCiWorkflow(ctx: any, payload: any): Promise<void> {
  const run = payload?.workflow_run;
  const repository = normalizeRepository(payload?.repository?.full_name);
  if (!repository || !run?.path || !String(run.event ?? "").startsWith("pull_request") || run.status !== "completed") return;
  if (normalizeRepository(run.head_repository?.full_name) !== repository) return;
  const now = Date.now();
  const row = await ctx.db.query("ci_workflows").withIndex("by_repository_path", (q: any) => q.eq("repository", repository).eq("path", run.path)).first();
  if (!row) await ctx.db.insert("ci_workflows", { repository, path: run.path, seen_at: now });
  else if (row.seen_at < now - DAY) await ctx.db.patch(row._id, { seen_at: now });
}

/** Mark an attempt claimed: judge it now, and read it back from GitHub if no verdict has come by the recheck. */
async function claimAttempt(ctx: any, run: Id<"main_ci_runs">, attempt: number, ok: boolean): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.mainRed.judge, { run, attempt, ok, tries: 0 });
  await ctx.scheduler.runAfter(RECHECK_MS, internal.mainRed.recheck, { run, attempt });
}

/**
 * Where a workflow's runs are judged: the workspace pinned on its ci_workflows row, kept while that workspace still
 * declares a deploy target for the repository, else the oldest target's (then pinned), never the team a webhook
 * happens to route to: one repository's runs must not split between workspaces.
 */
async function judgingScope(ctx: any, wf: Doc<"ci_workflows">, targets: Doc<"deploy_targets">[]): Promise<{ workspace: string; team_id?: Id<"teams"> }> {
  if (wf.workspace && targets.some((t) => t.workspace === wf.workspace)) return { workspace: wf.workspace, ...(wf.team_id ? { team_id: wf.team_id } : {}) };
  const oldest = [...targets].sort((a, b) => a.published_at - b.published_at)[0]!;
  await ctx.db.patch(wf._id, { workspace: oldest.workspace, team_id: oldest.team_id });
  return { workspace: oldest.workspace, ...(oldest.team_id ? { team_id: oldest.team_id } : {}) };
}

/**
 * The repositories red main judges: the convex env var MAIN_RED_REPOS, owner/name comma-separated, empty by default.
 * Rerunning a red run's failed jobs reruns the jobs that need them too, so a push-only deploy job behind the tests
 * would send an old sha out again: a repository is listed once its CI is known to have no such job.
 */
export function mainRedRepos(list: string | undefined = process.env.MAIN_RED_REPOS): Set<string> {
  return new Set((list ?? "").split(",").map((r) => r.trim()).filter(Boolean).map(normalizeRepository));
}

/**
 * A finished default-branch run (defaultBranchCiRun) from a push, claimed for judging: one row per run, and a
 * delivery of an attempt already claimed does nothing. Only CI is judged, and only where a deploy target
 * declares the repository. Returns whether it claimed the run.
 */
export async function noteMainCiRun(ctx: any, ci: Omit<CiRun, "team_id"> | null, payload: any): Promise<boolean> {
  const run = payload?.workflow_run;
  if (!ci || !ci.run_id || !ci.sha || run?.event !== "push" || !run.path) return false;
  const repository = normalizeRepository(ci.repository);
  if (!mainRedRepos().has(repository)) return false;
  const targets: Doc<"deploy_targets">[] = (await ctx.db.query("deploy_targets").withIndex("by_repository_name", (q: any) => q.eq("repository", repository)).take(50))
    .filter((t: Doc<"deploy_targets">) => !t.retired_at);
  if (!targets.length) return false;
  const file = String(run.path).split("/").pop();
  if (targets.some((t) => t.workflow && t.workflow === file)) return false;
  const wf: Doc<"ci_workflows"> | null = await ctx.db.query("ci_workflows").withIndex("by_repository_path", (q: any) => q.eq("repository", repository).eq("path", run.path)).first();
  if (!wf) return false;

  const attempt = Number(run.run_attempt ?? 1);
  const sha = ci.sha.toLowerCase();
  const existing: Doc<"main_ci_runs"> | null = await ctx.db.query("main_ci_runs").withIndex("by_repository_run", (q: any) => q.eq("repository", repository).eq("run_id", ci.run_id)).first();
  const now = Date.now();
  if (existing && existing.attempt >= attempt) {
    // Claimed but never judged (the claim threw after writing the row): a later delivery or the retry judges it.
    if (existing.attempt !== attempt || existing.state !== "judging" || existing.updated_at > now - JUDGING_TIMEOUT_MS) return false;
    await ctx.db.patch(existing._id, { updated_at: now });
    await claimAttempt(ctx, existing._id, attempt, ci.ok);
    return true;
  }
  let id: Id<"main_ci_runs">;
  if (existing) {
    // A later attempt: the row keeps its state (rerunning) and the first attempt's failures until it settles.
    await ctx.db.patch(existing._id, { attempt, ...(ci.url ? { url: ci.url } : {}), updated_at: now });
    id = existing._id;
  } else {
    const scope = await judgingScope(ctx, wf, targets);
    const commit = await commitBySha(ctx, repository, sha);
    id = await ctx.db.insert("main_ci_runs", {
      ...scope,
      repository,
      branch: ci.branch ?? "main",
      workflow: ci.workflow,
      path: String(run.path),
      run_id: ci.run_id,
      attempt,
      sha,
      seq: commit?.main_at ?? ci.at,
      ...(ci.url ? { url: ci.url } : {}),
      state: "judging",
      jobs: [],
      failed: [],
      failing: [],
      at: ci.at,
      updated_at: now,
    });
  }
  await claimAttempt(ctx, id, attempt, ci.ok);
  return true;
}

/** A red-main step that threw inside the webhook drain, tried once more on its own. */
export const noteLater = internalMutation({
  args: { ci: v.any(), payload: v.any() },
  handler: async (ctx, args): Promise<void> => {
    await noteCiWorkflow(ctx, args.payload);
    await noteMainCiRun(ctx, args.ci, args.payload);
  },
});

/** What `noteLater` needs of a workflow_run payload, and nothing else. */
export function notePayload(payload: any): any {
  const r = payload?.workflow_run ?? {};
  return {
    repository: { full_name: payload?.repository?.full_name, default_branch: payload?.repository?.default_branch },
    workflow_run: { id: r.id, event: r.event, path: r.path, run_attempt: r.run_attempt, status: r.status, head_repository: { full_name: r.head_repository?.full_name } },
  };
}

// ── reading the run from GitHub ──────────────────────────────────────────────

async function gh(token: string, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
}

/** A response's text, or null past `max` bytes, read in chunks so a huge log never sits in memory whole. */
async function textUpTo(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

export const runRow = internalQuery({
  args: { run: v.id("main_ci_runs") },
  handler: async (ctx, args): Promise<Doc<"main_ci_runs"> | null> => await ctx.db.get(args.run),
});


/**
 * An installation token for the run's repository, with what the installation granted: the team's installation,
 * or for a personal workspace its owner's.
 */
async function tokenFor(ctx: any, row: Doc<"main_ci_runs">): Promise<{ token: string; permissions?: Record<string, string> } | null> {
  const ws = parseWorkspaceKey(row.workspace);
  const installation: any = row.team_id
    ? await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, { repository: row.repository, team_id: row.team_id })
    : ws?.type === "personal"
      ? await ctx.runQuery(internal.githubApp.getPersonalInstallationForRepo, { repository: row.repository, user_id: ws.userId })
      : null;
  if (!installation?.installation_id) return null;
  return await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: installation.installation_id });
}

/** Backoff before each retry of a judge that threw: a token mint or GitHub blip should not lose a red. */
export const JUDGE_RETRY_MS = [60_000, 5 * MINUTE];

/** Read one claimed attempt's jobs and failures, rerun the failed jobs of a first red attempt, and settle it. */
export const judge = internalAction({
  args: { run: v.id("main_ci_runs"), attempt: v.number(), ok: v.boolean(), tries: v.optional(v.number()) },
  handler: async (ctx, args): Promise<string> => {
    const row: Doc<"main_ci_runs"> | null = await ctx.runQuery(internal.mainRed.runRow, { run: args.run });
    if (!row || row.attempt !== args.attempt) return "stale";
    try {
      return await judgeAttempt(ctx, row, args.ok);
    } catch (err) {
      const error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
      await ctx.runMutation(internal.mainRed.judgeFailed, { run: args.run, attempt: args.attempt, ok: args.ok, tries: args.tries ?? 0, error });
      return "failed";
    }
  },
});

/** A judge that threw: logged on the row, retried with backoff, and after the last retry the run is lost. */
export const judgeFailed = internalMutation({
  args: { run: v.id("main_ci_runs"), attempt: v.number(), ok: v.boolean(), tries: v.number(), error: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.run);
    if (!row || row.attempt !== args.attempt) return;
    const now = Date.now();
    await ctx.db.patch(row._id, { judge_error: args.error, updated_at: now });
    if (args.tries < JUDGE_RETRY_MS.length) {
      await ctx.scheduler.runAfter(JUDGE_RETRY_MS[args.tries], internal.mainRed.judge, { run: row._id, attempt: args.attempt, ok: args.ok, tries: args.tries + 1 });
      return;
    }
    await loseRun(ctx, row, now);
  },
});

/** The workflow file at the run's commit, as the jobs it declares; null when GitHub cannot give it. */
async function workflowFile(token: string, row: Doc<"main_ci_runs">): Promise<ReturnType<typeof parseWorkflowJobs>> {
  const res = await gh(token, `/repos/${row.repository}/contents/${row.path.split("/").map(encodeURIComponent).join("/")}?ref=${row.sha}`);
  if (!res.ok) return null;
  const body = await res.json();
  if (body?.encoding !== "base64" || typeof body.content !== "string") return null;
  const bytes = Uint8Array.from(atob(body.content.replace(/\s/g, "")), (c) => c.charCodeAt(0));
  return parseWorkflowJobs(new TextDecoder().decode(bytes));
}

type RawJob = { id: string; name: string; conclusion: string | null; url?: string; started: number; completed: number };

function rawJobs(answer: any): RawJob[] {
  return (Array.isArray(answer?.jobs) ? answer.jobs : []).map((j: any) => ({
    id: String(j?.id ?? ""),
    name: String(j?.name ?? "job"),
    conclusion: j?.conclusion ?? null,
    ...(j?.html_url ? { url: String(j.html_url) } : {}),
    started: Date.parse(j?.started_at ?? ""),
    completed: Date.parse(j?.completed_at ?? ""),
  }));
}

async function judgeAttempt(ctx: any, row: Doc<"main_ci_runs">, ok: boolean): Promise<string> {
  const auth = await tokenFor(ctx, row);
  if (!auth) return "no installation";
  const { token, permissions } = auth;
  const base = `/repos/${row.repository}/actions/runs/${row.run_id}`;
  const answer = await gh(token, `${base}/jobs?filter=latest&per_page=100`);
  const body = answer.ok ? await answer.json() : null;
  const jobs = rawJobs(body);
  // Every job of the run, skipped ones included, when the page holds them all: what says a culprit's job left the workflow.
  const listed = body && jobs.length >= Number(body.total_count ?? jobs.length) ? jobs.map((j) => j.name) : null;
  const ranJobs = jobs.filter((j) => j.conclusion && !NOT_RUN.has(j.conclusion));
  const ran = ranJobs.map((j) => ({ name: j.name, ok: !jobFailed(j.conclusion) }));
  const failedJobs = jobs.filter((j) => jobFailed(j.conclusion));
  // Which failed jobs only aggregate others (`verify` behind a timed-out job among them): the workflow file at the
  // run's commit says, or timing when it cannot.
  const aggregates = failedJobs.length > 1 ? aggregateJobs(failedJobs, ranJobs, await workflowFile(token, row)) : new Set<string>();
  const own = failedJobs.filter((j) => !aggregates.has(j.name));
  // A red run with no failed job read (its jobs unreadable, or a workflow that failed before any job) fails as the workflow.
  const failed = own.length ? own.map((j) => j.name) : ok ? [] : [row.workflow];
  const settle = (verdict: "green" | "red" | "rerunning" | "unproven", failing: CiFailure[], extra: { reran?: boolean; rerun_refused?: string } = {}) =>
    ctx.runMutation(internal.mainRed.settle, {
      run: row._id, attempt: row.attempt, verdict, jobs: ran, failed, failing: kept(failing), reran: !!extra.reran,
      ...(listed ? { listed_jobs: listed } : {}),
      ...(extra.rerun_refused ? { rerun_refused: extra.rerun_refused } : {}),
    });
  if (ok) return await settle("green", []);
  const failing: CiFailure[] = [];
  for (const job of own.slice(0, LOGS_READ)) {
    const res = await gh(token, `/repos/${row.repository}/actions/jobs/${job.id}/logs`);
    const log = res.ok ? await textUpTo(res, LOG_MAX_BYTES) : null;
    if (log !== null) failing.push(...parseFailures(job.name, log));
    else failing.push({ job: job.name, test: null, assertion: null, file: null, line: null, excerpt: `Could not read the job's log (${res.ok ? "over 8MB" : `GitHub answered ${res.status}`}): ${job.url ?? ""}` });
  }
  if (!failing.length) failing.push({ job: failed[0]!, test: null, assertion: null, file: null, line: null, excerpt: answer.ok ? `${row.workflow} ended red with no failed job: ${row.url ?? ""}` : `Could not read the run's jobs (GitHub answered ${answer.status})` });
  if (row.attempt > 1) return await settle("red", failing, { reran: true });
  // A first red attempt is rerun once. Without the grant to, or with GitHub refusing, the red is unproven: the next run of its jobs decides.
  if (permissions && permissions.actions !== "write") return await settle("unproven", failing, { rerun_refused: `the GitHub App installation grants actions: ${permissions.actions ?? "none"}, not write` });
  const rerun = await gh(token, `${base}/rerun-failed-jobs`, { method: "POST" });
  if (rerun.ok) return await settle("rerunning", failing);
  let message = "";
  try {
    message = String((await rerun.json())?.message ?? "");
  } catch {
    // The status alone says it.
  }
  return await settle("unproven", failing, { rerun_refused: `GitHub refused the rerun (${rerun.status}${message ? `: ${message.slice(0, 200)}` : ""})` });
}

/** A claimed attempt with no verdict yet: a newer finished attempt is claimed, a run still going is waited on, and anything else is lost. */
export const recheck = internalAction({
  args: { run: v.id("main_ci_runs"), attempt: v.number() },
  handler: async (ctx, args): Promise<string> => {
    const row: Doc<"main_ci_runs"> | null = await ctx.runQuery(internal.mainRed.runRow, { run: args.run });
    if (!row || row.attempt !== args.attempt || (row.state !== "judging" && row.state !== "rerunning")) return "settled";
    const lost = () => ctx.runMutation(internal.mainRed.settle, { run: args.run, attempt: args.attempt, verdict: "lost", jobs: [], failed: [], failing: [], reran: false });
    const auth = await tokenFor(ctx, row);
    const res = auth ? await gh(auth.token, `/repos/${row.repository}/actions/runs/${row.run_id}`) : null;
    if (!res?.ok) return await lost();
    const run = await res.json();
    const attempt = Number(run.run_attempt ?? row.attempt);
    if (run.status !== "completed") {
      if (Date.now() - row.at > GIVE_UP_MS) return await lost();
      await ctx.scheduler.runAfter(RECHECK_MS, internal.mainRed.recheck, args);
      return "waiting";
    }
    const verdict = !!run.conclusion && !NO_VERDICT.has(run.conclusion);
    if (attempt > row.attempt && verdict) {
      await ctx.runMutation(internal.mainRed.reclaim, { run: args.run, from: row.attempt, attempt, ok: run.conclusion === "success" });
      return "reclaimed";
    }
    // The same attempt finished with a verdict but its judge never settled it: judge it, unless its retries already run.
    if (attempt === row.attempt && verdict && row.state === "judging") {
      if (row.judge_error) return "retrying";
      await ctx.scheduler.runAfter(0, internal.mainRed.judge, { run: args.run, attempt, ok: run.conclusion === "success", tries: 0 });
      return "rejudged";
    }
    return await lost();
  },
});

/** A newer attempt the webhook never delivered, found by `recheck`. */
export const reclaim = internalMutation({
  args: { run: v.id("main_ci_runs"), from: v.number(), attempt: v.number(), ok: v.boolean() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.run);
    if (!row || row.attempt !== args.from) return;
    await ctx.db.patch(row._id, { attempt: args.attempt, updated_at: Date.now() });
    await claimAttempt(ctx, row._id, args.attempt, args.ok);
  },
});

/** Ask GitHub which of a held red's candidate commits still have a run of its workflow queued or going. */
export const probeCandidates = internalAction({
  args: { run: v.id("main_ci_runs"), shas: v.array(v.string()) },
  handler: async (ctx, args): Promise<string> => {
    const row: Doc<"main_ci_runs"> | null = await ctx.runQuery(internal.mainRed.runRow, { run: args.run });
    if (row?.held_since == null) return "placed";
    const answer = (pending: string[], failed: boolean) => ctx.runMutation(internal.mainRed.probed, { run: args.run, pending, failed });
    const auth = await tokenFor(ctx, row).catch(() => null);
    if (!auth) return (await answer([], true), "failed");
    const pending: string[] = [];
    for (const sha of args.shas.slice(0, 20)) {
      const res = await gh(auth.token, `/repos/${row.repository}/actions/runs?head_sha=${sha}&event=push&per_page=30`).catch(() => null);
      if (!res?.ok) return (await answer([], true), "failed");
      const runs: any[] = (await res.json())?.workflow_runs ?? [];
      if (runs.some((r) => r.path === row.path && r.status !== "completed")) pending.push(sha);
    }
    await answer(pending, false);
    return pending.length ? "pending" : "settled";
  },
});

export const probed = internalMutation({
  args: { run: v.id("main_ci_runs"), pending: v.array(v.string()), failed: v.boolean() },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.run);
    if (row?.held_since == null) return;
    const now = Date.now();
    await ctx.db.patch(row._id, { candidates_probe: { at: now, answered: true, failed: args.failed, pending: args.pending } });
    await reevaluate(ctx, row, now, row);
  },
});

// ── the run's facts ──────────────────────────────────────────────────────────

const judgedOf = (r: Doc<"main_ci_runs">): JudgedRun => ({ sha: r.sha, seq: r.seq, workflow: r.workflow, verdict: r.state === "green" ? "green" : "red", jobs: r.jobs, failed: r.failed });
const settledVerdict = (r: Doc<"main_ci_runs">) => (r.state === "green" || r.state === "red") && r.held_since == null;

/**
 * The open culprits of a repository in a workspace, newest first: a backlog of old ones must not hide a new one.
 * Past the cap the oldest go unread, and the log says so.
 */
async function openCulprits(ctx: any, s: Pick<Scope, "workspace" | "repository">): Promise<Doc<"main_reds">[]> {
  const rows: Doc<"main_reds">[] = await ctx.db
    .query("main_reds")
    .withIndex("by_scope_status_created", (q: any) => q.eq("workspace", s.workspace).eq("repository", s.repository).eq("status", "red"))
    .order("desc")
    .take(CULPRITS_READ);
  if (rows.length === CULPRITS_READ) console.warn(`main_red: ${s.repository} in ${s.workspace} has ${CULPRITS_READ}+ open culprits; reading the newest ${CULPRITS_READ}`);
  return rows;
}

function flakeEvent(ctx: any, row: Doc<"main_ci_runs">, f: CiFailure, why: string) {
  return recordExternalEventOnce(ctx, {
    ...(row.team_id ? { team_id: row.team_id } : {}),
    workspace: row.workspace,
    source: "github",
    repository: row.repository,
    kind: "ci_flake",
    title: `Flaky on ${row.branch}: ${f.test ?? f.job} (${why})`,
    ...(f.assertion ? { summary: f.assertion } : {}),
    ...(row.url ? { url: row.url } : {}),
    sha: row.sha,
    branch: row.branch,
    dedupe_key: `ci_flake:${row.repository}:${row.run_id}:${f.job}:${f.test ?? ""}`,
  });
}

/**
 * Unproven runs before this one that failed jobs this run also ran: the jobs it failed again are a red (placed in
 * order, not rerun). One whose jobs all passed recovered: a flake or a fix the next commit made, which nothing can
 * tell apart, so it is never a flake and never reaches the quarantine list. One still waiting on a job this run
 * skipped waits on.
 */
async function decideUnproven(ctx: any, row: Doc<"main_ci_runs">, recent: Doc<"main_ci_runs">[], now: number): Promise<void> {
  for (const u of recent.filter((r) => r.state === "unproven" && r.seq < row.seq)) {
    if (!u.failed.every((j) => row.jobs.some((x) => x.name === j))) continue;
    const again = u.failed.filter((j) => row.failed.includes(j));
    if (again.length) {
      const patch = { state: "red" as const, failed: again, failing: u.failing.filter((f) => again.includes(f.job)), reran: false, held_since: now, updated_at: now };
      await ctx.db.patch(u._id, patch);
      Object.assign(u, patch);
      await ctx.scheduler.runAfter(HOLD_MS, internal.mainRed.release, { run: u._id });
    } else {
      await ctx.db.patch(u._id, { state: "recovered", failing: [], updated_at: now });
      u.state = "recovered";
    }
  }
}

/**
 * What a settled run says about the open culprits of its workspace: the jobs it ran and passed are fixed, a culprit
 * whose jobs all are is fixed, and a green run turns fixed culprits green (main_green). A culprit whose jobs stopped
 * running for a week, or left the workflow (missing from a run's complete job list), expires with no event.
 */
async function upkeepCulprits(ctx: any, row: Doc<"main_ci_runs">, listed: string[] | undefined, now: number): Promise<void> {
  const judged = judgedOf(row);
  for (const c of await openCulprits(ctx, row)) {
    const fixed = fixedBy(judged, c);
    const jobs = c.jobs.filter((j) => !fixed.some((f) => f.workflow === j.workflow && f.job === j.job));
    const ranOne = c.jobs.some((j) => j.workflow === row.workflow && row.jobs.some((x) => x.name === j.job));
    const seen = ranOne ? now : c.seen_at;
    const mine = c.jobs.filter((j) => j.workflow === row.workflow);
    const gone = !!listed && mine.length > 0 && mine.every((j) => jobGone(listed, j.job));
    if (gone || seen < now - STALE_MS) await ctx.db.patch(c._id, { status: "expired", updated_at: now });
    else if (!jobs.length) await ctx.db.patch(c._id, { status: "fixed", jobs: [], seen_at: seen, updated_at: now });
    else if (fixed.length || seen !== c.seen_at) await ctx.db.patch(c._id, { jobs, seen_at: seen, updated_at: now });
  }
  if (row.state !== "green") return;
  const fixedOnes: Doc<"main_reds">[] = await ctx.db
    .query("main_reds")
    .withIndex("by_scope_status_created", (q: any) => q.eq("workspace", row.workspace).eq("repository", row.repository).eq("status", "fixed"))
    .order("desc")
    .take(CULPRITS_READ);
  for (const c of fixedOnes) if (c.newest_red_seq < row.seq) await endRed(ctx, c, row, now);
}

/** Unproven runs no later run decided within a week are let go. */
async function expireUnproven(ctx: any, recent: Doc<"main_ci_runs">[], now: number): Promise<void> {
  for (const u of recent.filter((r) => r.state === "unproven" && r.updated_at < now - STALE_MS)) {
    await ctx.db.patch(u._id, { state: "lost", failing: [], updated_at: now });
    u.state = "lost";
  }
}

export const settle = internalMutation({
  args: {
    run: v.id("main_ci_runs"),
    attempt: v.number(),
    verdict: v.union(v.literal("green"), v.literal("red"), v.literal("rerunning"), v.literal("unproven"), v.literal("lost")),
    jobs: v.array(jobValidator),
    failed: v.array(v.string()),
    failing: v.array(failureValidator),
    reran: v.boolean(),
    // Every job of the run, skipped ones included, when the jobs API listed them all.
    listed_jobs: v.optional(v.array(v.string())),
    rerun_refused: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string> => {
    const row = await ctx.db.get(args.run);
    if (!row || row.attempt !== args.attempt) return "stale";
    const now = Date.now();
    if (args.verdict === "rerunning") {
      await ctx.db.patch(row._id, { state: "rerunning", jobs: args.jobs, failed: args.failed, failing: args.failing, updated_at: now });
      return "rerunning";
    }
    if (args.verdict === "lost") {
      await loseRun(ctx, row, now);
      return "lost";
    }
    let patch: Partial<Doc<"main_ci_runs">>;
    if (args.verdict === "green") {
      // Red on its first attempt and green on the rerun: a flake, recorded for the quarantine list (QUARANTINE.md).
      if (row.state === "rerunning") for (const f of row.failing.filter((f) => row.failed.includes(f.job))) await flakeEvent(ctx, row, f, "green on a rerun");
      patch = { state: "green", jobs: args.jobs, failed: [], failing: [], held_since: undefined, updated_at: now };
    } else if (args.verdict === "unproven") {
      patch = { state: "unproven", jobs: args.jobs, failed: args.failed, failing: args.failing, rerun_refused: args.rerun_refused, updated_at: now };
    } else {
      patch = { state: "red", jobs: args.jobs, failed: args.failed, failing: args.failing, reran: args.reran, held_since: now, updated_at: now };
      await ctx.scheduler.runAfter(HOLD_MS, internal.mainRed.release, { run: row._id });
    }
    await ctx.db.patch(row._id, patch);
    const next: Doc<"main_ci_runs"> = { ...row, ...patch };
    const recent: Doc<"main_ci_runs">[] = await scopeRuns(ctx, next).order("desc").take(RUNS_SCANNED);
    const self = recent.find((r) => r._id === row._id);
    if (self) Object.assign(self, next);
    else recent.push(next);
    await expireUnproven(ctx, recent, now);
    await decideUnproven(ctx, next, recent, now);
    await upkeepCulprits(ctx, next, args.listed_jobs, now);
    return (await reevaluate(ctx, next, now, undefined, recent)).get(String(row._id)) ?? (next.state === "red" ? "held" : next.state);
  },
});

/** No verdict will come: the run holds nothing and names nobody, and the reds held behind it are placed. */
async function loseRun(ctx: any, row: Doc<"main_ci_runs">, now: number): Promise<void> {
  await ctx.db.patch(row._id, { state: "lost", failing: [], held_since: undefined, updated_at: now });
  await reevaluate(ctx, row, now);
}

/** A hold's deadline: place it with what has settled, even when it has fallen out of the newest runs. */
export const release = internalMutation({
  args: { run: v.id("main_ci_runs") },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.run);
    if (row?.held_since != null) await reevaluate(ctx, row, Date.now(), row);
  },
});

// ── placing reds ─────────────────────────────────────────────────────────────

/**
 * Place the scope's held reds in the branch's order. One that must still wait stops the walk: a later red is
 * placed only once every earlier one is, so it sees the culprit an earlier commit named. `also` is a held row the
 * newest runs may not include (an old run rerun by hand), placed with them.
 */
async function reevaluate(ctx: any, s: Scope, now: number, also?: Doc<"main_ci_runs">, read?: Doc<"main_ci_runs">[]): Promise<Map<string, string>> {
  const recent: Doc<"main_ci_runs">[] = read ?? (await scopeRuns(ctx, s).order("desc").take(RUNS_SCANNED));
  if (also && !recent.some((r) => r._id === also._id)) recent.push(also);
  const out = new Map<string, string>();
  for (const h of recent.filter((r) => r.held_since != null).sort((a, b) => a.seq - b.seq)) {
    const decision = await place(ctx, h, recent, now);
    out.set(String(h._id), decision);
    if (decision === "held") break;
    // Placed: later reds compare with it as the settled red it now is.
    h.held_since = undefined;
  }
  return out;
}

/**
 * Whether a held red must still wait for the commits before it since its last green: one whose run here has no
 * verdict yet (or an unproven one), or one with no run here at all that is young enough for its run to still be
 * going. GitHub is asked about those (`probeCandidates`) once; if it cannot answer, every such young commit counts
 * as still going.
 */
async function waitsOnCandidates(ctx: any, h: Doc<"main_ci_runs">, recent: Doc<"main_ci_runs">[], baseSeq: number | null, commits: Doc<"commits">[], now: number): Promise<boolean> {
  if (recent.some((r) => (r.state === "judging" || r.state === "rerunning" || r.state === "unproven") && r.seq < h.seq && (baseSeq == null || r.seq > baseSeq))) return true;
  const young = commits
    .filter((c) => c.sha.toLowerCase() !== h.sha && c.main_at != null && c.main_at > now - HOLD_MS && !recent.some((r) => r.sha === c.sha.toLowerCase()))
    .map((c) => c.sha.toLowerCase());
  if (!young.length) return false;
  const probe = h.candidates_probe;
  if (!probe) {
    await ctx.db.patch(h._id, { candidates_probe: { at: now, answered: false, failed: false, pending: [] } });
    await ctx.scheduler.runAfter(0, internal.mainRed.probeCandidates, { run: h._id, shas: young });
    return true;
  }
  return !probe.answered || probe.failed || young.some((s) => probe.pending.includes(s));
}

/**
 * One held red: join the open culprits owning a job it failed. For the failed jobs none owns: a later run that
 * passed them makes it history, a commit before it whose run has no verdict yet holds it (until the deadline), a
 * job with no known last green makes it a baseline, and otherwise it names a culprit, or adds to the open culprit
 * already named for that commit (one commit, one event, whichever workflows it broke).
 */
async function place(ctx: any, h: Doc<"main_ci_runs">, recent: Doc<"main_ci_runs">[], now: number): Promise<string> {
  const judged = recent.filter((r) => r._id !== h._id && settledVerdict(r)).map(judgedOf);
  const open = await openCulprits(ctx, h);
  const { joins, fresh } = placeRed(h, open);
  let decision = joins.length ? "joined" : "red";
  if (fresh.length) {
    if (greenAfter(judged, h.workflow, h.seq, fresh)) decision = "history";
    else {
      const bases = fresh.map((job) => lastGreenFor(judged, h.workflow, h.seq, job));
      const base = bases.every((b) => b) ? bases.reduce((a, b) => (b!.seq < a!.seq ? b : a)) : null;
      const range = base ? await mainCommitsAfter(ctx, h.repository, base.sha, h.sha) : null;
      if (now < h.held_since! + HOLD_MS && (await waitsOnCandidates(ctx, h, recent, base?.seq ?? null, range?.known ? range.commits : [], now))) return "held";
      const c = range?.known ? culpritOf(range.commits.map((x) => x.sha.toLowerCase()), h.sha) : null;
      if (c) decision = await raiseOrMerge(ctx, h, fresh, c, open, now);
      else decision = "baseline";
    }
  }
  for (const i of joins) {
    const red = open[i];
    if (red.payload.red_shas.includes(h.sha)) continue;
    await ctx.db.patch(red._id, {
      payload: { ...red.payload, red_shas: [...red.payload.red_shas, h.sha].slice(-RED_SHAS_KEPT) },
      newest_red_seq: Math.max(red.newest_red_seq, h.seq),
      seen_at: now,
      updated_at: now,
    });
  }
  await ctx.db.patch(h._id, { held_since: undefined, failing: [], updated_at: now });
  return decision;
}

/**
 * A culprit for the red run's fresh jobs. When another workflow already named the same commit and it is still open,
 * the jobs and their failures join that culprit: one commit is one event and one brief.
 */
async function raiseOrMerge(ctx: any, h: Doc<"main_ci_runs">, fresh: string[], c: { culprit_sha: string; culprit_exact: boolean; candidates: string[] }, open: Doc<"main_reds">[], now: number): Promise<string> {
  const refs: JobRef[] = fresh.map((job) => ({ workflow: h.workflow, job }));
  const failing = h.failing.filter((f) => fresh.includes(f.job));
  const same = open.find((o) => o.payload.culprit_sha === c.culprit_sha);
  if (same) {
    await ctx.db.patch(same._id, {
      jobs: [...same.jobs, ...refs],
      payload: { ...same.payload, failing: [...same.payload.failing, ...failing] },
      newest_red_seq: Math.max(same.newest_red_seq, h.seq),
      seen_at: now,
      updated_at: now,
    });
    return "merged";
  }
  await raiseRed(ctx, h, refs, failing, c, now);
  return "main_red";
}

/** A new culprit: fire main_red with its payload, and brief. */
async function raiseRed(ctx: any, h: Doc<"main_ci_runs">, jobs: JobRef[], failing: CiFailure[], c: { culprit_sha: string; culprit_exact: boolean; candidates: string[] }, now: number): Promise<void> {
  const commit = await commitBySha(ctx, h.repository, c.culprit_sha);
  const session = commit ? await conversationFromSessionTrailer(ctx, commit.message, linkScope(h)) : undefined;
  const run = await runThatMerged(ctx, h.workspace, c.culprit_sha, commit?.main_at ?? commit?.timestamp ?? h.at);
  const taskId = run?.task_id ?? commit?.task_ids?.[0];
  const task = taskId ? await ctx.db.get(taskId) : null;
  const payload: MainRedPayload = {
    repo: h.repository,
    branch: h.branch,
    culprit_sha: c.culprit_sha,
    culprit_exact: c.culprit_exact,
    candidates: c.candidates.slice(-CANDIDATES_KEPT),
    culprit_subject: commit ? commit.message.split("\n")[0].slice(0, 200) : null,
    culprit_author: commit ? commit.author_login ?? commit.author_name : null,
    culprit_session: session ? String(session).slice(0, 7) : null,
    culprit_run: run ? String(run._id) : null,
    culprit_task: task?.short_id ?? null,
    red_shas: [h.sha],
    first_red_at: h.at,
    ci_run_url: h.url ?? null,
    reran: !!h.reran,
    failing,
  };
  const redId = await ctx.db.insert("main_reds", {
    workspace: h.workspace,
    ...(h.team_id ? { team_id: h.team_id } : {}),
    repository: h.repository,
    payload,
    jobs,
    newest_red_seq: h.seq,
    status: "red",
    seen_at: now,
    created_at: now,
    updated_at: now,
  });
  // No committer-written words in the title: it reaches a trigger's run as its prompt. The subject is in the payload.
  const title = `${h.repository} ${h.branch} red at ${c.culprit_sha.slice(0, 7)}${c.culprit_exact ? "" : ` (one of ${c.candidates.length})`}`;
  const note = h.rerun_refused ? `Not rerun: ${h.rerun_refused}. The next run failed the same job.` : undefined;
  await announce(ctx, h, MAIN_RED_EVENT, `main_red:${redId}`, title, h.url, h.sha, payload, now, note);
  await brief(ctx, h, payload, redId, note);
}

/** A fixed culprit on the first green run after it: it ends, and main_green carries it to the culprit's workspace. */
async function endRed(ctx: any, red: Doc<"main_reds">, green: Doc<"main_ci_runs">, now: number): Promise<void> {
  await ctx.db.patch(red._id, { status: "green", green_sha: green.sha, green_at: now, updated_at: now });
  const title = `${red.repository} ${red.payload.branch} green again at ${green.sha.slice(0, 7)} after ${red.payload.culprit_sha.slice(0, 7)}`;
  await announce(ctx, { workspace: red.workspace, team_id: red.team_id, repository: red.repository, branch: red.payload.branch }, MAIN_GREEN_EVENT, `main_green:${red._id}`, title, green.url, green.sha, red.payload, now);
}

// ── reads ────────────────────────────────────────────────────────────────────

/**
 * Is the branch's newest commit red by its own judged run of a workflow the culprit failed? A culprit stays open
 * until its jobs pass, which a branch whose newer commits skip those jobs may not see for a while, so an open
 * culprit alone does not say the branch is red now.
 */
async function headIsRed(ctx: any, red: Doc<"main_reds">): Promise<boolean> {
  const head: Doc<"commits"> | null = await ctx.db.query("commits").withIndex("by_repository_main", (q: any) => q.eq("repository", red.repository)).order("desc").first();
  if (head?.main_at == null) return false;
  for (const workflow of new Set(red.jobs.map((j) => j.workflow))) {
    const runs: Doc<"main_ci_runs">[] = await scopeRuns(ctx, { workspace: red.workspace, repository: red.repository, workflow }).order("desc").take(20);
    if (runs.some((r) => r.sha === head.sha.toLowerCase() && r.state === "red")) return true;
  }
  return false;
}

/**
 * The open main_red events on a repository the caller may read, oldest first, while the branch's head is red:
 * what the Deploy station's wait line names as the reason. Nothing while the head is green or still running.
 */
export const open = query({
  args: { api_token: v.optional(v.string()), repository: v.string() },
  handler: async (ctx, args): Promise<{ open: MainRedPayload[] }> => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const repository = normalizeRepository(args.repository)!;
    const rows = await ctx.db.query("main_reds").withIndex("by_repository_status", (q) => q.eq("repository", repository).eq("status", "red")).order("desc").take(CULPRITS_READ);
    const out: MainRedPayload[] = [];
    for (const r of rows.sort((a, b) => a.created_at - b.created_at)) {
      if ((await workspaceGrantsAccess(ctx, userId, r.workspace)) && (await headIsRed(ctx, r))) out.push(r.payload);
    }
    return { open: out };
  },
});
