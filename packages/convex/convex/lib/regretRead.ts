// The read side of regret (docs/architecture/regret.md R3 to R7): the
// changes a workspace landed, joined to their runs, deploys and reopens, and
// the merge step's allowance with the role's measured rate. A leaf, so the
// role reader, the merge step and Ship share it without an import cycle.

import type { Doc, Id } from "../_generated/dataModel";
import { passedChecks, regretSummary, roleLineRate, REGRET_RANGE_DAYS, type RegretChange, type RegretSummary } from "@codecast/shared/contracts/regretRates";
import { mergeAllowance, type MeasuredRate, type MergeAllowance } from "./lineMerge";

const DAY = 86_400_000;

/** The changes of a workspace that landed in the range, joined to their runs, deploys and reopens. */
export async function regretChanges(ctx: any, workspace: string, now: number, rangeDays = REGRET_RANGE_DAYS): Promise<RegretChange[]> {
  const from = now - rangeDays * DAY;
  const rows: Doc<"landed_changes">[] = await ctx.db.query("landed_changes").withIndex("by_workspace_landed", (q: any) => q.eq("workspace", workspace).gte("landed_at", from)).collect();
  // A run's merge commit names its run even when no session resolved.
  const merged: Doc<"workflow_runs">[] = await ctx.db.query("workflow_runs").withIndex("by_workspace_merged", (q: any) => q.eq("workspace", workspace).gte("merge.at", from - DAY)).collect();
  const runBySha = new Map(merged.map((r) => [String(r.merge!.sha).toLowerCase(), r]));
  const runs = new Map<string, Doc<"workflow_runs"> | null>(merged.map((r) => [String(r._id), r]));
  const runOf = async (id: Id<"workflow_runs"> | undefined) => {
    if (!id) return null;
    if (!runs.has(String(id))) runs.set(String(id), await ctx.db.get(id));
    return runs.get(String(id)) ?? null;
  };
  const roles = new Map<string, Doc<"org_roles"> | null>();
  const roleOf = async (id: Id<"org_roles"> | undefined | null) => {
    if (!id) return null;
    if (!roles.has(String(id))) roles.set(String(id), await ctx.db.get(id));
    return roles.get(String(id)) ?? null;
  };
  const lives = await liveDeploys(ctx, workspace, from);
  const reopens = new Map<string, number[]>();
  const reopenedAt = async (taskId: Id<"tasks"> | undefined) => {
    if (!taskId) return [];
    const k = String(taskId);
    if (!reopens.has(k)) {
      const sg: any[] = await ctx.db.query("signals").withIndex("by_task", (q: any) => q.eq("task_id", taskId).gte("created_at", from)).collect();
      reopens.set(k, sg.filter((s) => s.reopened).map((s) => s.created_at));
    }
    return reopens.get(k)!;
  };
  const out: RegretChange[] = [];
  for (const r of rows) {
    // Only a check flow counts as one: a graph run (a role's line, or a session flow from the pool). A Claude Code
    // workflow run checks nothing, so its sessions' commits landed outside any flow.
    const anyRun = runBySha.get(r.sha) ?? (await runOf(r.run_id));
    const run = anyRun && (anyRun as any).run_kind !== "workflow" ? anyRun : null;
    const lineRole = run?.org_role_id ? await roleOf(run.org_role_id) : null;
    const role = lineRole ?? (await roleOf(r.role_id));
    const flow = run ? run.workflow_name ?? "" : "";
    out.push({
      sha: r.sha,
      landed_at: r.landed_at,
      live_at: liveAtFor(r.landed_at, lives),
      fixes: r.fixed_by.map((f) => ({ at: f.at, top: f.top === undefined || f.lines >= f.top })),
      reopened_at: run?.task_id ? await reopenedAt(run.task_id) : [],
      role_id: role ? String(role._id) : null,
      role_handle: role?.handle ?? null,
      flow,
      through: lineRole ? "line" : run ? "session_flow" : "outside",
      checks: run ? passedChecks(flow, (run as any).node_statuses ?? []) : [],
    });
  }
  return out;
}

type LiveDeploy = { cut_at: number | null; live_at: number };

async function liveDeploys(ctx: any, workspace: string, from: number): Promise<LiveDeploy[]> {
  const rows: Doc<"deploys">[] = await ctx.db.query("deploys").withIndex("by_workspace_created", (q: any) => q.eq("workspace", workspace).gte("created_at", from)).collect();
  return rows.filter((d) => d.status === "live" && d.live_at).map((d) => ({ cut_at: d.cut_at ?? null, live_at: d.live_at! }));
}

/** The first live deploy holding a change on main: placed deploys by their cut, unplaced ones by time (deploys.md DP3). */
export function liveAtFor(landedAt: number, lives: ReadonlyArray<LiveDeploy>): number | null {
  let best: number | null = null;
  for (const d of lives) {
    const holds = d.cut_at != null ? d.cut_at >= landedAt : d.live_at >= landedAt;
    if (holds && (best === null || d.live_at < best)) best = d.live_at;
  }
  return best;
}

export async function regretSummaryFor(ctx: any, workspace: string, now: number, windowDays?: number): Promise<RegretSummary & { traced_through: number | null }> {
  const changes = await regretChanges(ctx, workspace, now);
  const newest = await ctx.db.query("landed_changes").withIndex("by_workspace_landed", (q: any) => q.eq("workspace", workspace)).order("desc").first();
  return { ...regretSummary(changes, { now, windowDays }), traced_through: newest?.recorded_at ?? null };
}

/**
 * The merge step's allowance with the role's measured rate read in (regret.md
 * R7): every reader of the merge step goes through here. The rate is read when
 * the role merges on it, or when `show` asks for it (the role's settings).
 */
export async function roleMergeAllowance(ctx: any, role: any, now: number, show = false): Promise<MergeAllowance> {
  const workspace = role.team_id ? `team:${role.team_id}` : null;
  let measured: MeasuredRate | null = null;
  if (workspace && (show || role.line_merge_rate)) {
    try {
      measured = roleLineRate(regretSummary(await regretChanges(ctx, workspace, now), { now }), String(role._id));
    } catch { measured = null; }
  }
  return mergeAllowance(role, now, measured);
}
