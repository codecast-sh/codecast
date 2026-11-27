// The release sweep (pl-1146 piece 7): the exceptions a workspace's Release
// Captain acts on, in one read, so its hourly check is gated on there being
// a new one (`cast release sweep --new` as the routine's `state` precheck)
// and spends nothing on a quiet hour or on exceptions it already saw. Five kinds, each read the way the surface that owns
// it reads it:
//   - open run-stop incidents (flowStops.openFlowStopIncidents);
//   - deploy targets holding a commit merged longer ago than the target's
//     deadline (deployDeadlineMs) that it does not run yet;
//   - runs that failed in the last two hours outside any incident, not
//     cancelled, not since re-run, on a task still open, and the pipeline's to
//     answer for: a failure that is no stop (a crash, a timeout, a station
//     error no stop exit caught), or a stop at a shared exit still held. A stop
//     about the change itself (rejected, findings) is its own run's to act on;
//   - team machines online and still below a floor raised half an hour ago or
//     more (teamCliFloor.teamFleet);
//   - sessions whose change is live everywhere and that nothing keeps, yet are
//     still in the inbox (retireOnLive.liveRetireRefusal answers null).
// Reads only. A public action runs each kind in queries of its own, so no kind
// spends another's read budget, and the heavy reads are cut finer still: a
// `commits` row carries its files' patches (tens of KB each on a busy repo),
// so the late commits are read a page per query, and each session judged for
// retirement is judged in a query of its own.

import { ConvexError, v } from "convex/values";
import { action, internalQuery, type ActionCtx } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { verifyApiToken } from "./apiTokens";
import { createWorkContext } from "./data";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { canAccessConversation } from "./lib/access";
import { isFlowStop, openFlowStopIncidents, stopStationOf, type FlowStopIncident } from "./flowStops";
import { commitBySha, targetDeploys, targetRows } from "./deployTargetsState";
import { teamFleet } from "./teamCliFloor";
import { liveRetireRefusal } from "./retireOnLive";
import { isTerminalTaskStatus } from "@codecast/shared/tasks";
import { commitTouchesTarget, deployDeadlineMs } from "@codecast/shared/contracts/deployTargets";
import { liveDeployOf } from "@codecast/shared/contracts/deploys";
import { isBelowMinimum } from "@platform/flags";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Failed runs this recent are the sweep's; older ones were the last sweeps'. */
export const FAILED_RUN_WINDOW_MS = 2 * 60 * MINUTE;
/** A machine still below a floor this long after it was raised did not take it. */
export const LAGGARD_AFTER_MS = 30 * MINUTE;
/** Commits landed this recently are read for their sessions. */
export const RETIRE_WINDOW_MS = DAY;
const FAILED_RUNS_READ = 100;
/** Late commits counted per target, read LATE_PAGE to a query: a commit row is at most 1 MiB, so a page stays under 16. */
export const LATE_COMMITS_READ = 200;
export const LATE_PAGE = 10;
/** Newest landed commits read per repository for their sessions, LATE_PAGE to a query. */
export const RETIRE_COMMITS_READ = 40;
/** Sessions judged for retirement in one sweep: each judgment reads its commits, edits and liveness. */
const RETIRE_SESSIONS_MAX = 12;
/** A target with no deploy open and none in a week is dormant (deployReach): it ships rarely and holds nothing up. */
const DORMANT_MS = 7 * DAY;

// What the sweep answers is an agent's input (`--new` puts it in the message that wakes @release), so it carries only
// what the server made or checked: ids, counts, shas, versions, times, enum states, and names that pass `safeName`.
// Never free text other people write (titles, stop reasons, device labels, people's names, update errors): the ids
// lead to them (cast task show, cast line deploy show, cast devices).
export type SweepIncident = { task_id: Id<"tasks">; short_id: string; status: string; runs: Array<{ run_id: Id<"workflow_runs">; task_short_id: string | null; station: string | null; stopped_at: number }> };
export type LateTarget = { target: string; repository: string; commits: number; oldest_sha: string; waiting_since: number; deadline_ms: number; open: { short_id: string; status: string } | null };
export type FailedRun = { run_id: Id<"workflow_runs">; task_short_id: string; flow: string; station: string | null; failed_at: number };
export type Laggard = { device: Id<"devices">; device_id: string | null; own: boolean; owner_id: Id<"users">; cli_version: string | null; floor: string; floor_set_at: number | null };
export type Unretired = { conversation_id: Id<"conversations">; short_id: string };
export const SWEEP_KINDS = ["incidents", "late_targets", "failed_runs", "laggards", "unretired"] as const;
export type SweepKind = (typeof SWEEP_KINDS)[number];
/** `failed_kinds`: the kinds whose read failed this time, each listed empty, so one kind's failure never fails the rest.
 *  `unretired_skipped`: the sessions whose retirement judgment failed this time, left out of `unretired`. */
export type ReleaseSweep = { workspace: string; checked_at: number; incidents: SweepIncident[]; late_targets: LateTarget[]; failed_runs: FailedRun[]; laggards: Laggard[]; unretired: Unretired[]; unretired_skipped: number; failed_kinds: SweepKind[] };

/** A name a sweep may carry (a target, repository, flow, station, device id): identifier characters only, else null. */
const safeName = (s: string | null | undefined): string | null => (s && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(s) ? s : null);
const WITHHELD = "(name withheld)";
const VERSION = /^\d+\.\d+\.\d+$/;
const version = (s: string | null | undefined): string | null => (s && VERSION.test(s) ? s : null);
const SHA = /^[0-9a-f]{7,40}$/;

/** Whether a failed run was stopped by a person or the system's own cancel, not by its pipeline. */
const isCancelled = (failReason: string | undefined) => /^cancell?ed\b/i.test(failReason ?? "");

/** A target that may be late: where its wait is measured from, and until when a commit merged is overdue. */
type LateStart = { target: string; repository: string; paths: string[]; after: number; until: number; deadline_ms: number; open: LateTarget["open"] };
type LatePage = { late: Array<{ sha: string; main_at: number }>; read: number; cursor: string; done: boolean };

/** Each live, not dormant target, with its live deploy's place in main's order. Reads no commit past the live one. */
export const lateStarts = internalQuery({
  args: { workspace: v.string(), now: v.number() },
  handler: async (ctx, { workspace, now }): Promise<LateStart[]> => {
    const out: LateStart[] = [];
    for (const t of await targetRows(ctx, workspace)) {
      const deploys: Doc<"deploys">[] = (await targetDeploys(ctx, workspace, t.name)).filter((d) => !d.repository || d.repository === t.repository);
      const open = deploys.find((d) => d.status === "requested" || d.status === "running") ?? null;
      if (!open && !deploys.some((d) => now - d.created_at < DORMANT_MS)) continue;
      const live = liveDeployOf(deploys);
      const from = live?.sha ? await commitBySha(ctx, t.repository, live.sha) : null;
      // No live deploy on main as codecast knows it: nothing to measure the wait from.
      if (from?.main_at == null) continue;
      // The target's own `deadline` stays on the CLI (CLI_ONLY_TARGET_KEYS); the server holds it to the default for its kind.
      const deadline = deployDeadlineMs(t, t.runs === "here" && t.policy === "press");
      out.push({ target: t.name, repository: t.repository, paths: t.paths, after: from.main_at, until: now - deadline, deadline_ms: deadline, open: open ? { short_id: open.short_id, status: open.status } : null });
    }
    return out;
  },
});

/** One page of the commits merged after a target's live one and before its deadline, oldest first: those touching its paths. */
export const lateCommitsPage = internalQuery({
  args: { repository: v.string(), paths: v.array(v.string()), after: v.number(), until: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, a): Promise<LatePage> => {
    const page = await ctx.db
      .query("commits")
      .withIndex("by_repository_main", (q) => q.eq("repository", a.repository).gt("main_at", a.after).lte("main_at", a.until))
      .paginate({ cursor: a.cursor, numItems: LATE_PAGE });
    const late = page.page.filter((c) => commitTouchesTarget(a.paths, (c.files ?? []).map((f) => f.filename))).map((c) => ({ sha: c.sha, main_at: c.main_at! }));
    return { late, read: page.page.length, cursor: page.continueCursor, done: page.isDone };
  },
});

async function lateTargets(ctx: ActionCtx, workspace: string, now: number): Promise<LateTarget[]> {
  const starts: LateStart[] = await ctx.runQuery(internal.releaseSweep.lateStarts, { workspace, now });
  return (await Promise.all(starts.map(async (s): Promise<LateTarget | null> => {
    const late: LatePage["late"] = [];
    let cursor: string | null = null;
    for (let read = 0; read < LATE_COMMITS_READ;) {
      const page: LatePage = await ctx.runQuery(internal.releaseSweep.lateCommitsPage, { repository: s.repository, paths: s.paths, after: s.after, until: s.until, cursor });
      late.push(...page.late);
      read += page.read;
      if (page.done) break;
      cursor = page.cursor;
    }
    if (!late.length) return null;
    const oldest = late[0].sha.toLowerCase();
    return { target: safeName(s.target) ?? WITHHELD, repository: safeName(s.repository) ?? WITHHELD, commits: late.length, oldest_sha: SHA.test(oldest) ? oldest : "", waiting_since: late[0].main_at, deadline_ms: s.deadline_ms, open: s.open };
  }))).filter((t): t is LateTarget => t !== null);
}

async function failedRuns(ctx: any, workspace: string, now: number): Promise<FailedRun[]> {
  const rows: Doc<"workflow_runs">[] = await ctx.db
    .query("workflow_runs")
    .withIndex("by_workspace_status_updated", (q: any) => q.eq("workspace", workspace).eq("status", "failed").gt("updated_at", now - FAILED_RUN_WINDOW_MS))
    .order("desc")
    .take(FAILED_RUNS_READ);
  const out: FailedRun[] = [];
  for (const run of rows) {
    // An incident's runs are listed under it; a queued resume is already acted on; a run with no task cannot be resumed.
    if (run.incident_task_id || run.resume_queued || !run.task_id || isCancelled(run.fail_reason)) continue;
    // A stop is @release's only at a shared exit (its fingerprint), held while no second change shares it.
    if (isFlowStop(run.fail_reason) && !run.stop_fingerprint) continue;
    const task: Doc<"tasks"> | null = await ctx.db.get(run.task_id);
    if (!task || isTerminalTaskStatus(task.status)) continue;
    // A later run of the same task is the re-run: this one is history.
    const newer = await ctx.db.query("workflow_runs").withIndex("by_task", (q: any) => q.eq("task_id", run.task_id)).order("desc").first();
    if (newer && String(newer._id) !== String(run._id)) continue;
    const wf: Doc<"workflows"> | null = run.workflow_id ? await ctx.db.get(run.workflow_id) : null;
    out.push({
      run_id: run._id,
      task_short_id: task.short_id,
      flow: safeName(wf?.name ?? run.workflow_name) ?? "flow",
      // The stop's words are free text (CI and model output): the run's page holds them.
      station: safeName(run.stop_station ?? stopStationOf(run.node_statuses, run.current_node_id ?? "", wf?.nodes ?? [])),
      failed_at: run.updated_at,
    });
  }
  return out;
}

async function laggards(ctx: any, workspace: string, viewer: Id<"users">, now: number): Promise<Laggard[]> {
  const ws = parseWorkspaceKey(workspace);
  if (ws?.type !== "team") return [];
  const team: Doc<"teams"> | null = await ctx.db.get(ws.teamId);
  if (!team) return [];
  const global = await ctx.db.query("system_config").withIndex("by_key", (q: any) => q.eq("key", "min_cli_version")).unique();
  // A floor with no time (set before it was kept) counts as raised long ago.
  const floors = [
    ...(global?.value ? [{ version: global.value as string, at: (global.updated_at as number | undefined) ?? null }] : []),
    ...(team.min_cli_version ? [{ version: team.min_cli_version, at: team.min_cli_version_at ?? null }] : []),
  ].filter((f) => version(f.version) && (f.at == null || now - f.at >= LAGGARD_AFTER_MS));
  const byDevice = new Map<string, Laggard>();
  for (const f of floors) {
    for (const d of (await teamFleet(ctx, team, f.version, now)).lagging) {
      const seen = byDevice.get(String(d.id));
      if (seen && !isBelowMinimum(seen.floor, f.version)) continue;
      // Named by its row and the id its daemon reports (when it is an id), never by its label or its owner's name.
      byDevice.set(String(d.id), { device: d.id, device_id: safeName(d.device_id), own: String(d.user_id) === String(viewer), owner_id: d.user_id, cli_version: version(d.cli_version), floor: f.version, floor_set_at: f.at });
    }
  }
  return [...byDevice.values()];
}

type RetirePage = { sessions: Id<"conversations">[]; read: number; cursor: string; done: boolean };

/**
 * One page of a repository's newest landed commits, newest first: the sessions behind them that the viewer may read
 * and that are still in the inbox. Paged like lateCommitsPage, since a commit row carries its patches.
 */
export const retireCandidates = internalQuery({
  args: { repository: v.string(), viewer: v.id("users"), now: v.number(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { repository, viewer, now, cursor }): Promise<RetirePage> => {
    const page = await ctx.db
      .query("commits")
      .withIndex("by_repository_main", (q) => q.eq("repository", repository).gt("main_at", now - RETIRE_WINDOW_MS))
      .order("desc")
      .paginate({ cursor, numItems: LATE_PAGE });
    const sessions: Id<"conversations">[] = [];
    for (const id of new Set(page.page.flatMap((c) => (c.conversation_id ? [c.conversation_id] : [])))) {
      const conv: Doc<"conversations"> | null = await ctx.db.get(id);
      // Retired already: the common case, judged for nothing.
      if (!conv || conv.inbox_killed_at) continue;
      if (await canAccessConversation(ctx, viewer, conv as any)) sessions.push(id);
    }
    return { sessions, read: page.page.length, cursor: page.continueCursor, done: page.isDone };
  },
});

/** The sessions behind one repository's RETIRE_COMMITS_READ newest landed commits, a page per query. */
async function retireCandidatesOf(ctx: ActionCtx, repository: string, viewer: Id<"users">, now: number): Promise<Id<"conversations">[]> {
  const out: Id<"conversations">[] = [];
  let cursor: string | null = null;
  for (let read = 0; read < RETIRE_COMMITS_READ;) {
    const page: RetirePage = await ctx.runQuery(internal.releaseSweep.retireCandidates, { repository, viewer, now, cursor });
    out.push(...page.sessions);
    read += page.read;
    if (page.done) break;
    cursor = page.cursor;
  }
  return out;
}

/** One session judged for retirement: listed when its change is live everywhere and nothing keeps it. */
export const retireJudge = internalQuery({
  args: { workspace: v.string(), conversation_id: v.id("conversations"), now: v.number() },
  handler: async (ctx, { workspace, conversation_id, now }): Promise<Unretired | null> => {
    const conv: Doc<"conversations"> | null = await ctx.db.get(conversation_id);
    if (!conv || (await liveRetireRefusal(ctx, conv, now, { workspace })) !== null) return null;
    return { conversation_id: conv._id, short_id: safeName(conv.short_id) ?? String(conv._id) };
  },
});

/** The unretired sessions, and how many could not be judged: one session's failed judgment (a read past a limit) drops
 *  that session alone, never the kind. */
async function unretired(ctx: ActionCtx, scope: SweepScope, now: number): Promise<{ rows: Unretired[]; skipped: number }> {
  const byRepo: Id<"conversations">[][] = await Promise.all(scope.repositories.map((repository) => retireCandidatesOf(ctx, repository, scope.viewer, now)));
  const sessions = [...new Set(byRepo.flat())].slice(0, RETIRE_SESSIONS_MAX);
  const judged = await Promise.allSettled(sessions.map((conversation_id): Promise<Unretired | null> => ctx.runQuery(internal.releaseSweep.retireJudge, { workspace: scope.workspace, conversation_id, now })));
  const rows: Unretired[] = [];
  let skipped = 0;
  judged.forEach((j, i) => {
    if (j.status === "fulfilled") {
      if (j.value) rows.push(j.value);
      return;
    }
    skipped++;
    console.error(`[releaseSweep.sweep] ${sessions[i]} not judged: ${j.reason instanceof Error ? j.reason.message : String(j.reason)}`);
  });
  return { rows, skipped };
}

/** Who sweeps which workspace, and the repositories its targets name. */
type SweepScope = { workspace: string; viewer: Id<"users">; repositories: string[] };
const scopeArgs = { api_token: v.string(), workspace: v.optional(v.union(v.literal("personal"), v.literal("team"))), team_id: v.optional(v.id("teams")) };

export const scope = internalQuery({
  args: scopeArgs,
  handler: async (ctx, args): Promise<SweepScope> => {
    const auth = await verifyApiToken(ctx, args.api_token, false);
    if (!auth) throw new ConvexError("Unauthorized");
    const { db } = await createWorkContext(ctx, { userId: auth.userId, workspace: args.workspace, team_id: args.team_id });
    return { workspace: db.workspaceKey, viewer: auth.userId, repositories: [...new Set((await targetRows(ctx, db.workspaceKey)).map((t) => t.repository))] };
  },
});

/** Open incidents without their titles (stop text: CI and model output a change's author can steer). */
export const incidents = internalQuery({
  args: { workspace: v.string() },
  handler: async (ctx, { workspace }): Promise<SweepIncident[]> =>
    (await openFlowStopIncidents(ctx, workspace)).map((i: FlowStopIncident) => ({
      task_id: i.task_id, short_id: i.short_id, status: i.status,
      runs: i.runs.map((r) => ({ run_id: r.run_id, task_short_id: r.task_short_id, station: safeName(r.station), stopped_at: r.stopped_at })),
    })),
});

export const failedRunsOf = internalQuery({
  args: { workspace: v.string(), now: v.number() },
  handler: async (ctx, { workspace, now }): Promise<FailedRun[]> => await failedRuns(ctx, workspace, now),
});

export const laggardsOf = internalQuery({
  args: { workspace: v.string(), viewer: v.id("users"), now: v.number() },
  handler: async (ctx, { workspace, viewer, now }): Promise<Laggard[]> => await laggards(ctx, workspace, viewer, now),
});

export const sweep = action({
  args: scopeArgs,
  handler: async (ctx, args): Promise<ReleaseSweep> => {
    const now = Date.now();
    const s: SweepScope = await ctx.runQuery(internal.releaseSweep.scope, args);
    const failed = new Set<SweepKind>();
    let unretiredSkipped = 0;
    // Each kind on its own: one that fails (a read past a limit) is listed empty and named, the others still answer.
    const kind = async <T>(name: SweepKind, read: () => Promise<T[]>): Promise<T[]> => {
      try {
        return await read();
      } catch (e) {
        console.error(`[releaseSweep.sweep] ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
        failed.add(name);
        return [];
      }
    };
    const [incidents, late_targets, failed_runs, laggards, unretiredRows] = await Promise.all([
      kind("incidents", (): Promise<SweepIncident[]> => ctx.runQuery(internal.releaseSweep.incidents, { workspace: s.workspace })),
      kind("late_targets", () => lateTargets(ctx, s.workspace, now)),
      kind("failed_runs", (): Promise<FailedRun[]> => ctx.runQuery(internal.releaseSweep.failedRunsOf, { workspace: s.workspace, now })),
      kind("laggards", (): Promise<Laggard[]> => ctx.runQuery(internal.releaseSweep.laggardsOf, { workspace: s.workspace, viewer: s.viewer, now })),
      kind("unretired", async () => {
        const { rows, skipped } = await unretired(ctx, s, now);
        unretiredSkipped = skipped;
        return rows;
      }),
    ]);
    return { workspace: s.workspace, checked_at: now, incidents, late_targets, failed_runs, laggards, unretired: unretiredRows, unretired_skipped: unretiredSkipped, failed_kinds: SWEEP_KINDS.filter((k) => failed.has(k)) };
  },
});
