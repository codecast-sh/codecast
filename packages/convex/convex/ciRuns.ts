// A CI check issue's runs, read back from GitHub. The workflow_run webhook
// says only that a workflow failed at a commit (ingest.recordCiRun); the
// issue page needs what GitHub's checks page shows: which job and step
// failed, the annotations, and the end of the log. `fetch` reads one run
// through the App's installation for the repository and keeps it in
// ci_run_details; `get` serves it to anyone who may read a group whose kept
// samples name that run.
import { v } from "convex/values";
import { action, internalMutation, internalQuery, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { scopeArgs } from "./lib/ingestScopeArgs";
import { groupByRef } from "./ingest";
import { CI_ANNOTATIONS_MAX, isFailedConclusion, logTail, readAnnotations, readJobs, readRun, type CiAnnotation } from "./lib/ciRunRead";

const GITHUB_API = "https://api.github.com";
/** A finished run does not change; a read that came back short is tried again after this. */
const RETRY_SHORT_MS = 10 * 60_000;
/** Failed jobs whose annotations are read. */
const ANNOTATED_JOBS = 3;
/** A job log past this many bytes is not read for its tail. */
const LOG_MAX_BYTES = 30 * 1024 * 1024;

/** The repository a group's kept sample names for this run, or null when none of its samples is that run. */
async function runRepository(ctx: any, group: Doc<"event_groups">, runId: string): Promise<string | null> {
  if (group.kind !== "check") return null;
  const samples = await ctx.db.query("event_samples").withIndex("by_group_at", (q: any) => q.eq("group_id", group._id)).order("desc").take(50);
  for (const s of samples) {
    try {
      const c = s.context_json ? JSON.parse(s.context_json) : null;
      if (c && String(c.run_id ?? "") === runId && typeof c.repository === "string") return c.repository;
    } catch {
      // A sample whose context is not JSON names no run.
    }
  }
  return null;
}

/** One run's detail as the issue page shows it, or null before it was read. */
export const get = query({
  args: { ...scopeArgs, group: v.string(), run_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const group = await groupByRef(ctx, userId, args.group);
    const repository = await runRepository(ctx, group, args.run_id);
    if (!repository) return null;
    return await ctx.db.query("ci_run_details").withIndex("by_repo_run", (q) => q.eq("repository", repository).eq("run_id", args.run_id)).first();
  },
});

export const fetchTarget = internalQuery({
  args: { api_token: v.optional(v.string()), group: v.string(), run_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const group = await groupByRef(ctx, userId, args.group);
    const repository = await runRepository(ctx, group, args.run_id);
    if (!repository) return null;
    const ws = parseWorkspaceKey(group.workspace);
    const existing = await ctx.db.query("ci_run_details").withIndex("by_repo_run", (q) => q.eq("repository", repository).eq("run_id", args.run_id)).first();
    return {
      repository,
      user_id: userId as Id<"users">,
      team_id: ws?.type === "team" ? ws.teamId : undefined,
      fetched_at: existing?.fetched_at ?? null,
      short: existing ? !!existing.error || (!existing.log_tail && !existing.log_error && existing.jobs.some((j) => isFailedConclusion(j.conclusion))) : null,
    };
  },
});

const jobValidator = v.object({
  id: v.string(),
  name: v.string(),
  conclusion: v.optional(v.string()),
  duration_ms: v.optional(v.number()),
  url: v.optional(v.string()),
  steps: v.array(v.object({ number: v.number(), name: v.string(), conclusion: v.optional(v.string()) })),
});

export const store = internalMutation({
  args: {
    repository: v.string(),
    run_id: v.string(),
    title: v.optional(v.string()),
    event: v.optional(v.string()),
    actor: v.optional(v.string()),
    attempt: v.optional(v.number()),
    started_at: v.optional(v.number()),
    duration_ms: v.optional(v.number()),
    jobs: v.array(jobValidator),
    annotations: v.array(v.object({ job: v.string(), level: v.string(), message: v.string(), title: v.optional(v.string()), path: v.optional(v.string()), line: v.optional(v.number()) })),
    log_job: v.optional(v.string()),
    log_tail: v.optional(v.string()),
    log_error: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const row = { ...args, fetched_at: Date.now() };
    const existing = await ctx.db.query("ci_run_details").withIndex("by_repo_run", (q) => q.eq("repository", args.repository).eq("run_id", args.run_id)).first();
    // A short read never replaces a whole one: GitHub can drop a log or a token can lapse after a good read.
    if (existing && args.error && !existing.error) return existing._id;
    if (existing) {
      await ctx.db.replace(existing._id, row);
      return existing._id;
    }
    return await ctx.db.insert("ci_run_details", row);
  },
});

/** What one read keeps beside the run's key. */
type KeptRun = Partial<Omit<Doc<"ci_run_details">, "_id" | "_creationTime" | "repository" | "run_id" | "fetched_at">>;

async function gh(token: string, path: string): Promise<{ ok: true; body: any } | { ok: false; status: number; message: string }> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) {
    let message = `${res.status}`;
    try {
      message = String((await res.json())?.message ?? message);
    } catch {
      // The status alone names it.
    }
    return { ok: false, status: res.status, message };
  }
  return { ok: true, body: await res.json() };
}

/** Why GitHub refused, in the words the page shows. */
function refusal(status: number, what: string): string {
  if (status === 403) return `the GitHub App may not read ${what}`;
  if (status === 404) return `GitHub has no ${what} for this run`;
  if (status === 410) return `GitHub expired this run's ${what}`;
  return `GitHub answered ${status} for ${what}`;
}

/**
 * Read one run of a CI check issue from GitHub and keep it: the run, its
 * jobs and steps, the failed jobs' annotations, and the tail of the first
 * failed job's log. A run read whole is never read again; a short read is
 * retried after RETRY_SHORT_MS. Answers what was kept.
 */
export const read = action({
  args: { ...scopeArgs, group: v.string(), run_id: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const target = await ctx.runQuery(internal.ciRuns.fetchTarget, { api_token: args.api_token, group: args.group, run_id: args.run_id });
    if (!target) return { ok: false, error: "no kept run with that id" };
    if (target.fetched_at !== null && (!target.short || Date.now() - target.fetched_at < RETRY_SHORT_MS)) return { ok: true };
    const keep = (row: KeptRun) =>
      ctx.runMutation(internal.ciRuns.store, { repository: target.repository, run_id: args.run_id, jobs: [], annotations: [], ...row });
    const installation = await ctx.runQuery(internal.githubApp.getInstallationForRepo, { repository: target.repository, user_id: target.user_id, team_id: target.team_id });
    if (!installation) {
      await keep({ error: `the GitHub App is not installed on ${target.repository}` });
      return { ok: false, error: "no installation" };
    }
    const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: installation.installation_id });
    const base = `/repos/${target.repository}/actions/runs/${encodeURIComponent(args.run_id)}`;
    const run = await gh(token, base);
    if (!run.ok) {
      await keep({ error: refusal(run.status, "Actions runs") });
      return { ok: false, error: run.message };
    }
    const jobsAnswer = await gh(token, `${base}/jobs?filter=latest&per_page=100`);
    const jobs = jobsAnswer.ok ? readJobs(jobsAnswer.body) : [];
    const failed = jobs.filter((j) => isFailedConclusion(j.conclusion));
    const annotations: CiAnnotation[] = [];
    for (const job of failed.slice(0, ANNOTATED_JOBS)) {
      const a = await gh(token, `/repos/${target.repository}/check-runs/${job.id}/annotations?per_page=${CI_ANNOTATIONS_MAX}`);
      if (a.ok) annotations.push(...readAnnotations(job.name, a.body));
    }
    let log: { log_job?: string; log_tail?: string; log_error?: string } = {};
    const lead = failed[0];
    if (lead) {
      const res = await fetch(`${GITHUB_API}/repos/${target.repository}/actions/jobs/${lead.id}/logs`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      });
      const size = Number(res.headers.get("content-length") ?? 0);
      if (!res.ok) log = { log_job: lead.name, log_error: refusal(res.status, "logs") };
      else if (size > LOG_MAX_BYTES) log = { log_job: lead.name, log_error: "the log is too large to read" };
      else log = { log_job: lead.name, log_tail: logTail(await res.text()) };
    }
    await keep({
      ...readRun(run.body),
      jobs,
      annotations: annotations.slice(0, CI_ANNOTATIONS_MAX),
      ...log,
      ...(jobsAnswer.ok ? {} : { error: refusal(jobsAnswer.status, "jobs") }),
    });
    return { ok: true };
  },
});
