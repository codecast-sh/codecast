// Codecast's own deploy queue (docs/architecture/deploys.md DP18): a target whose deploys run as a GitHub Actions
// workflow (`workflow = "deploy.yml"`) is sent by dispatching that workflow through codecast's GitHub app with an
// exact sha, so no publishing machine is needed. A deploy waits in the queue until nothing of its target is running
// or waiting on GitHub: a workflow's concurrency group keeps only its newest pending run, so a second dispatch would
// drop the one waiting (a rollback).

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { targetDeploys, targetRows } from "./deployTargetsState";
import { activePauseOf } from "./deployPause";
import { reachedRollout } from "@codecast/shared/contracts/deployPause";

const GITHUB_API = "https://api.github.com";
const MINUTE = 60_000;
/** A send that never came back (the action died) frees the queue after this. */
const SENDING_STALE_MS = 5 * MINUTE;
/** A dispatch GitHub took but never started a run for fails after this. */
const SENT_STALE_MS = 15 * MINUTE;
/** GitHub's run states that hold the workflow's concurrency group. */
const GOING = ["queued", "in_progress", "waiting", "requested", "pending"] as const;

/** Whether a target's deploys go through codecast's GitHub app: it names its workflow. */
export function sendsThroughGithub(t: Pick<Doc<"deploy_targets">, "workflow">): boolean {
  return !!t.workflow;
}

/** Run the queue of one target soon (after a request, a run finishing, a pause lifting). */
export async function kickDispatch(ctx: any, workspace: string, target: string): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.deployDispatch.next, { workspace, target });
}

/**
 * The next deploy of a target to send, claimed as sending, or why none goes now: one is going out (a run, or a send
 * GitHub has not named a run for yet), the queue is empty, or production is paused (only the rollback that paused it
 * goes through a pause).
 */
export async function nextCore(ctx: any, workspace: string, target: string, now = Date.now()): Promise<{ sending?: string; waiting?: string }> {
  const deploys: Doc<"deploys">[] = await targetDeploys(ctx, workspace, target, 60);
  for (const d of deploys) {
    if (d.status !== "requested" || !d.dispatch || d.dispatch.state === "queued") continue;
    if (d.dispatch.state === "sending" && now - d.dispatch.at > SENDING_STALE_MS) {
      await ctx.db.patch(d._id, { dispatch: { ...d.dispatch, state: "queued", at: now }, updated_at: now });
      d.dispatch = { ...d.dispatch, state: "queued" };
    } else if (d.dispatch.state === "sent" && !d.workflow_run && now - d.dispatch.at > SENT_STALE_MS) {
      await ctx.db.patch(d._id, { status: "failed", note: `GitHub took the dispatch but started no run in ${SENT_STALE_MS / MINUTE} minutes`, finished_at: now, updated_at: now });
      d.status = "failed";
    }
  }
  const going = deploys.find((d) => d.status === "running" || (d.status === "requested" && d.dispatch && d.dispatch.state !== "queued"));
  if (going) return { waiting: `${going.short_id} is going out` };
  const queued = deploys.filter((d) => d.status === "requested" && d.dispatch?.state === "queued").sort((a, b) => a.created_at - b.created_at);
  if (!queued.length) return {};
  const pause = queued[0].repository ? await activePauseOf(ctx, workspace, queued[0].repository) : null;
  const next = pause ? queued.find((d) => d.action === "rollback" && pause.rollback === d.short_id) : queued[0];
  if (!next) return { waiting: "production is paused" };
  await ctx.db.patch(next._id, { dispatch: { ...next.dispatch!, state: "sending", at: now }, updated_at: now });
  await ctx.scheduler.runAfter(0, internal.deployDispatch.send, { deploy: next._id });
  return { sending: next.short_id };
}

export const next = internalMutation({
  args: { workspace: v.string(), target: v.string() },
  handler: async (ctx, args) => nextCore(ctx, args.workspace, args.target),
});

/** Every GitHub-sent target's queue, run on a schedule: the backstop for a webhook that never came. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows: Doc<"deploy_targets">[] = (await ctx.db.query("deploy_targets").take(500)).filter((t: Doc<"deploy_targets">) => !t.retired_at && sendsThroughGithub(t));
    for (const t of rows) await nextCore(ctx, t.workspace, t.name);
    return rows.length;
  },
});

/** What sending one deploy needs, while it is still claimed as sending. */
export const sendJob = internalQuery({
  args: { deploy: v.id("deploys") },
  handler: async (ctx, args): Promise<{ repository: string; team_id: Id<"teams">; workflow: string; inputs: Record<string, string> } | null> => {
    const d = await ctx.db.get(args.deploy);
    if (!d || d.status !== "requested" || d.dispatch?.state !== "sending" || !d.repository || !d.team_id) return null;
    const t = (await targetRows(ctx, d.workspace, d.repository)).find((r: Doc<"deploy_targets">) => r.name === d.target);
    if (!t?.workflow) return null;
    return { repository: d.repository, team_id: d.team_id, workflow: t.workflow, inputs: d.dispatch.inputs ?? {} };
  },
});

/** How a send ended: GitHub took it, a run of the workflow is already going (back in the queue), or it failed. */
export const settle = internalMutation({
  args: { deploy: v.id("deploys"), outcome: v.union(v.literal("sent"), v.literal("busy"), v.literal("failed")), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deploy);
    if (!d || d.status !== "requested" || d.dispatch?.state !== "sending") return;
    const now = Date.now();
    if (args.outcome === "failed") {
      await ctx.db.patch(d._id, { status: "failed", note: (args.note ?? "The dispatch failed").slice(0, 1500), finished_at: now, updated_at: now });
      return;
    }
    await ctx.db.patch(d._id, { dispatch: { ...d.dispatch, state: args.outcome === "sent" ? "sent" : "queued", at: now }, updated_at: now });
  },
});

async function gh(token: string, path: string, init?: RequestInit): Promise<Response> {
  return await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", ...(init?.body ? { "Content-Type": "application/json" } : {}) },
  });
}

async function installationToken(ctx: any, repository: string, teamId: Id<"teams">): Promise<{ token: string; permissions?: Record<string, string> } | null> {
  const installation: any = await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, { repository, team_id: teamId });
  if (!installation?.installation_id) return null;
  return await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: installation.installation_id });
}

/**
 * Dispatch one claimed deploy: only when GitHub has no run of the workflow going or waiting, on the default branch,
 * with the deploy's inputs (its exact sha). The run's webhook then names the deploy (deployTargetsCi.recordWorkflowRunDeploy).
 */
export const send = internalAction({
  args: { deploy: v.id("deploys") },
  handler: async (ctx, args): Promise<string> => {
    const job: { repository: string; team_id: Id<"teams">; workflow: string; inputs: Record<string, string> } | null = await ctx.runQuery(internal.deployDispatch.sendJob, { deploy: args.deploy });
    if (!job) return "nothing to send";
    const settle = (outcome: "sent" | "busy" | "failed", note?: string) => ctx.runMutation(internal.deployDispatch.settle, { deploy: args.deploy, outcome, ...(note ? { note } : {}) });
    try {
      const auth = await installationToken(ctx, job.repository, job.team_id);
      if (!auth) { await settle("failed", `No installation of codecast's GitHub app covers ${job.repository}`); return "no installation"; }
      if (auth.permissions && auth.permissions.actions !== "write") { await settle("failed", `Codecast's GitHub app cannot dispatch workflows on ${job.repository}: its installation needs actions: write`); return "no actions: write"; }
      const wf = encodeURIComponent(job.workflow);
      for (const status of GOING) {
        const res = await gh(auth.token, `/repos/${job.repository}/actions/workflows/${wf}/runs?status=${status}&per_page=1`);
        if (!res.ok) throw new Error(`GitHub answered ${res.status} listing ${job.workflow}'s runs`);
        if (((await res.json()) as any)?.total_count > 0) { await settle("busy"); return `a run is ${status}`; }
      }
      const repo = await gh(auth.token, `/repos/${job.repository}`);
      const branch = repo.ok ? ((await repo.json()) as any)?.default_branch ?? "main" : "main";
      const res = await gh(auth.token, `/repos/${job.repository}/actions/workflows/${wf}/dispatches`, { method: "POST", body: JSON.stringify({ ref: branch, inputs: job.inputs }) });
      if (res.status !== 204) { await settle("failed", `GitHub refused the dispatch of ${job.workflow} (${res.status}): ${(await res.text()).slice(0, 500)}`); return "refused"; }
      await settle("sent");
      return "sent";
    } catch (err) {
      // A blip is retried by the next sweep: the claim goes back to the queue.
      console.error(`deploy dispatch of ${args.deploy} failed:`, err instanceof Error ? err.message : err);
      await settle("busy");
      return "retry";
    }
  },
});

// ── a codecast cancel (DP18) ─────────────────────────────────────────────────

/**
 * Stop what a pause catches going out: a deploy still in the queue is cancelled at once, and a run that has not
 * reached rollout is cancelled on GitHub. Each carries codecast's cancel, the only cancel that counts as a pause.
 * `keep` is the rollback that paused.
 */
export async function cancelForPause(ctx: any, workspace: string, repository: string, by: string, why: string, keep?: string): Promise<string[]> {
  const now = Date.now();
  const out: string[] = [];
  for (const t of (await targetRows(ctx, workspace, repository)).filter(sendsThroughGithub)) {
    for (const d of await targetDeploys(ctx, workspace, t.name, 30)) {
      if (d.short_id === keep) continue;
      const cancel = { by, at: now, why };
      if (d.status === "requested" && d.dispatch?.state === "queued") {
        await ctx.db.patch(d._id, { status: "cancelled", cancel, finished_at: now, updated_at: now });
        out.push(d.short_id);
      } else if (d.status === "running" && d.workflow_run && !d.cancel) {
        await ctx.scheduler.runAfter(0, internal.deployDispatch.cancelRun, { deploy: d._id, by, why });
        out.push(d.short_id);
      }
    }
  }
  return out;
}

export const cancelJob = internalQuery({
  args: { deploy: v.id("deploys") },
  handler: async (ctx, args): Promise<{ repository: string; team_id: Id<"teams">; run: string } | null> => {
    const d = await ctx.db.get(args.deploy);
    if (!d || d.status !== "running" || !d.workflow_run || !d.repository || !d.team_id) return null;
    return { repository: d.repository, team_id: d.team_id, run: d.workflow_run.split("/")[0] };
  },
});

export const markCancelled = internalMutation({
  args: { deploy: v.id("deploys"), by: v.string(), why: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db.get(args.deploy);
    if (d && !d.cancel) await ctx.db.patch(d._id, { cancel: { by: args.by, at: Date.now(), why: args.why }, updated_at: Date.now() });
  },
});

/** Cancel a deploy's run on GitHub unless it has reached rollout, which a cancel no longer stops cleanly. */
export const cancelRun = internalAction({
  args: { deploy: v.id("deploys"), by: v.string(), why: v.string() },
  handler: async (ctx, args): Promise<string> => {
    const job: { repository: string; team_id: Id<"teams">; run: string } | null = await ctx.runQuery(internal.deployDispatch.cancelJob, { deploy: args.deploy });
    if (!job) return "nothing to cancel";
    const auth = await installationToken(ctx, job.repository, job.team_id);
    if (!auth) return "no installation";
    const jobs = await gh(auth.token, `/repos/${job.repository}/actions/runs/${job.run}/jobs?per_page=100`);
    if (!jobs.ok) return `GitHub answered ${jobs.status} listing the run's jobs`;
    if (reachedRollout(((await jobs.json()) as any)?.jobs ?? [])) return "reached rollout";
    const res = await gh(auth.token, `/repos/${job.repository}/actions/runs/${job.run}/cancel`, { method: "POST" });
    if (res.status !== 202) return `GitHub refused the cancel (${res.status})`;
    await ctx.runMutation(internal.deployDispatch.markCancelled, { deploy: args.deploy, by: args.by, why: args.why });
    return "cancelled";
  },
});
