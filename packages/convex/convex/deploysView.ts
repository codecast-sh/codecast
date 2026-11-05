// Deploys shaped for readers (docs/architecture/deploys.md): a deploy's view with
// its carries and steps, and what happened after each live deploy.

import type { Doc, Id } from "./_generated/dataModel";
import { LINE_DEPLOY_STEP_LABELS } from "@codecast/shared/contracts/lineDeploy";
import { summarizeAfter, type DeployAfter, type DeployAfterError, type DeployAfterProblem, type DeployView } from "@codecast/shared/contracts/deploys";

const DAY = 24 * 60 * 60 * 1000;
/** The after window of a deploy with no later one on its target is capped here. */
const AFTER_MAX_MS = 14 * DAY;
/** A carried fix's findings count against its deploy for this long after it went live (the line's default watch). */
const FIX_WATCH_MS = 7 * DAY;
/** Error groups read for one list's after windows. */
const GROUPS_SCAN = 600;

const isLiveDeploy = (d: Doc<"deploys">) => d.status === "live";


export async function shapeView(ctx: any, d: Doc<"deploys">): Promise<DeployView> {
  const carries = [];
  for (const c of d.carries) {
    const task = await ctx.db.get(c.task_id);
    const decision = c.decision_id ? await ctx.db.get(c.decision_id) : null;
    carries.push({
      task_id: String(c.task_id),
      ...(c.run_id ? { run_id: String(c.run_id) } : {}),
      ...(c.decision_id ? { decision_id: String(c.decision_id) } : {}),
      ...(c.merge_sha ? { merge_sha: c.merge_sha } : {}),
      ...(c.merged_at ? { merged_at: c.merged_at } : {}),
      ...(c.pr_url ? { pr_url: c.pr_url } : {}),
      how: c.how,
      task_short_id: task?.short_id ?? null,
      task_title: task?.title ?? null,
      decision_short_id: decision?.short_id ?? null,
    });
  }
  return {
    _id: String(d._id),
    short_id: d.short_id,
    ...(d.client_key ? { client_key: d.client_key } : {}),
    project_id: d.project_id ? String(d.project_id) : null,
    target: d.target,
    status: d.status,
    trigger: d.trigger,
    started_by: d.started_by
      ? { kind: d.started_by.kind, name: d.started_by.name, ...(d.started_by.user_id ? { user_id: String(d.started_by.user_id) } : {}), ...(d.started_by.role_id ? { role_id: String(d.started_by.role_id) } : {}) }
      : null,
    source: d.source,
    repository: d.repository ?? null,
    sha: d.sha ?? null,
    previous_sha: d.previous_sha ?? null,
    version: d.version ?? null,
    url: d.url ?? null,
    commits: d.commits ?? [],
    carries,
    note: d.note ?? null,
    action: d.action ?? null,
    rollback_of: d.rollback_of ?? null,
    dirty: d.dirty ?? null,
    created_at: d.created_at,
    live_at: d.live_at ?? null,
    finished_at: d.finished_at ?? null,
    ...(d.run_id ? { run_id: String(d.run_id), steps: await deployStepsOf(ctx, d.run_id) } : {}),
  };
}

const STEP_STATIONS = new Set([...Object.keys(LINE_DEPLOY_STEP_LABELS), "returned"]);

/** A deploy's steps as its run's stations stand (DP8), read from the run, in run order. */
export async function deployStepsOf(ctx: any, runId: Id<"workflow_runs">): Promise<NonNullable<DeployView["steps"]>> {
  const run = await ctx.db.get(runId);
  return (run?.node_statuses ?? [])
    .filter((n: any) => STEP_STATIONS.has(n.node_id))
    .map((n: any) => ({ id: n.node_id, status: n.status, ...(n.started_at ? { started_at: n.started_at } : {}), ...(n.completed_at ? { completed_at: n.completed_at } : {}) }));
}

/**
 * What happened after each live deploy: per carried problem its findings in
 * the window and whether one reopened it, and the error groups that started
 * or came back in the window. `deploys` newest first, all on one workspace.
 */
export async function afterFor(ctx: any, workspace: string, deploys: Doc<"deploys">[], now: number): Promise<Map<string, DeployAfter>> {
  const out = new Map<string, DeployAfter>();
  const live = deploys.filter(isLiveDeploy).sort((a, b) => (a.live_at ?? a.created_at) - (b.live_at ?? b.created_at));
  if (!live.length) return out;
  const earliest = live[0].live_at ?? live[0].created_at;
  const groups = await ctx.db
    .query("event_groups")
    .withIndex("by_workspace_last_seen", (q: any) => q.eq("workspace", workspace).gte("last_seen", earliest))
    .order("desc")
    .take(GROUPS_SCAN);
  for (let i = 0; i < live.length; i++) {
    const d = live[i];
    const from = d.live_at ?? d.created_at;
    const next = live.slice(i + 1).find((n) => n.target === d.target);
    const to = next ? next.live_at ?? next.created_at : Math.min(now, from + AFTER_MAX_MS);
    const problems: DeployAfterProblem[] = [];
    for (const c of d.carries) {
      const signals = await ctx.db
        .query("signals")
        .withIndex("by_task", (q: any) => q.eq("task_id", c.task_id).gte("created_at", from))
        .take(200);
      // A fix is judged over the week after it went live (the line's watch), whatever deploys came next.
      const fixTo = Math.min(now, from + FIX_WATCH_MS);
      const inWindow = signals.filter((s: any) => !s.retired && (s.observed_at ?? s.created_at) >= from && (s.observed_at ?? s.created_at) < fixTo);
      const times = inWindow.map((s: any) => s.observed_at ?? s.created_at).sort((a: number, b: number) => a - b);
      problems.push({ task_id: String(c.task_id), findings: inWindow.length, reopened: inWindow.some((s: any) => s.reopened), first_at: times[0] ?? null });
    }
    const errors: DeployAfterError[] = [];
    for (const g of groups) {
      if (d.source_id && String(g.source_id) !== String(d.source_id)) continue;
      if (g.kind !== "error") continue;
      const isNew = g.first_seen >= from && g.first_seen < to;
      const regressed = !isNew && g.regressed_at != null && g.regressed_at >= from && g.regressed_at < to;
      if (!isNew && !regressed) continue;
      errors.push({ group_id: String(g._id), short_id: g.short_id, title: g.title, kind: isNew ? "new" : "regressed", at: isNew ? g.first_seen : g.regressed_at, count: g.count });
    }
    errors.sort((a, b) => a.at - b.at);
    out.set(String(d._id), summarizeAfter(from, to, !next && to >= now, problems, errors.slice(0, 20)));
  }
  return out;
}

