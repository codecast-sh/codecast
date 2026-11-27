// One holder at a time for a repository's before-merge deploys through the
// push that lands them (docs/architecture/flows.md, the Merge station). A
// whole-tree deploy (convex) from one machine between another's deploy and
// its merge takes the other's backend back out of production; a local lock
// orders one checkout only. The Merge station holds this lease from before its
// rebase to the landed sha, so merges land one at a time in the order they
// asked, each rebased on the one before; `cast ship checkout` holds it from its
// first before-push deploy to its push, and `cast repo lease` around a command.
//
// DP13's "one deploy of a target going out at a time" is a deploys row with
// commits, queued on the machine that publishes the target, so it cannot
// stand for a merge in progress; this table is the lease.

import { v } from "convex/values";
import { mutation } from "./functions";
import type { Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { parseWorkspaceKey, workspaceGrantsAccess } from "./lib/accessKeys";
import { teamFor } from "./deployTargets";
import { findDeployTeam } from "./changesDeploy";
import { resolveTeamForRepository } from "./githubWebhooks";
import { repositoryArg } from "./deployTargetsState";
import { teamKey } from "./deployTargetsCi";

/** How long a lease holds without a renewal: a holder renews every minute, so a dead one frees it within this. */
export const LEASE_MS = 10 * 60_000;
/** How long a waiter keeps its place without asking again. A waiter asks every 5s, so one that stopped (killed, asleep)
 *  drops out within this and never holds up the line behind it, as a dead holder would for a whole lease. */
export const WAITER_STALE_MS = 60_000;

type Waiter = { token: string; holder: string; since: number; seen_at: number };

export type LeaseAnswer =
  | { held: true; expires_at: number }
  // `position`: the taker's place in line, the holder being 1st; `holder` is whoever is in front.
  | { held: false; holder: string; since: number; expires_at: number; position?: number }
  | { released: boolean };

/**
 * The lease is granted in the order takers asked: a take while it is held (or while others wait) joins the line on
 * the row, and is granted only once it is first in line and the lease is free. A released lease with a line keeps
 * its row, free (no token), until the first in line asks again.
 */
export async function leaseCore(
  ctx: any,
  userId: Id<"users">,
  args: { repository: string; op: "take" | "renew" | "release"; token: string; holder?: string; team_id?: Id<"teams">; run_id?: string },
  now = Date.now(),
): Promise<LeaseAnswer> {
  const repository = repositoryArg(args.repository);
  const { workspace, teamId } = await leaseWorkspace(ctx, userId, repository, args);
  // One lease per repository, whoever takes it: every workspace connected to it deploys the same production.
  const row = await ctx.db.query("repo_leases").withIndex("by_repository", (q: any) => q.eq("repository", repository)).first();
  const mine = !!row && !!row.token && row.token === args.token;
  const line: Waiter[] = (row?.waiters ?? []).filter((w: Waiter) => now - w.seen_at <= WAITER_STALE_MS);
  if (args.op === "release") {
    if (mine) await (line.length ? ctx.db.patch(row._id, { token: "", expires_at: now, waiters: line }) : ctx.db.delete(row._id));
    // A waiter that gives up leaves the line.
    else if (line.some((w) => w.token === args.token)) {
      const left = line.filter((w) => w.token !== args.token);
      await ctx.db.patch(row._id, { waiters: left.length ? left : undefined });
    }
    return { released: mine };
  }
  const live = !!row && row.expires_at > now;
  // A renewal extends only this holder's own row, lapsed or not. With no row (another holder took it, merged and
  // released it while this one slept) or another's token, the lease is gone: renewing must never take it back.
  if (args.op === "renew" && !mine) return { held: false, holder: row?.holder ?? "nobody", since: row?.acquired_at ?? now, expires_at: row?.expires_at ?? now };
  const expires_at = now + LEASE_MS;
  if (mine) {
    await ctx.db.patch(row._id, { expires_at });
    return { held: true, expires_at };
  }
  const holder = (args.holder ?? "someone").slice(0, 200);
  const queued = line.some((w) => w.token === args.token)
    ? line.map((w) => (w.token === args.token ? { ...w, seen_at: now } : w))
    : [...line, { token: args.token, holder, since: now, seen_at: now }];
  const ahead = queued.findIndex((w) => w.token === args.token);
  if (live || ahead > 0) {
    await ctx.db.patch(row._id, { waiters: queued });
    const front = live ? { holder: row.holder, since: row.acquired_at } : { holder: `${queued[0].holder} (next in line)`, since: queued[0].since };
    return { held: false, ...front, expires_at: row.expires_at, position: ahead + (live ? 2 : 1) };
  }
  const rest = queued.slice(1);
  const lease = { workspace, repository, token: args.token, holder, holder_user_id: userId, acquired_at: now, expires_at };
  // A patch's undefined clears the field: the last holder's team and a line that is now empty.
  if (row) await ctx.db.patch(row._id, { ...lease, team_id: teamId, waiters: rest.length ? rest : undefined });
  else await ctx.db.insert("repo_leases", { ...lease, ...(teamId ? { team_id: teamId } : {}) });
  return { held: true, expires_at };
}

/**
 * Who may take the repository's lease, recorded on the row (and deleted with that workspace). A station names its run
 * and needs access to the run's workspace, so the answer never depends on how many teams connected the repository;
 * `cast ship checkout` has no run and needs the repository's team. Either way the caller must work on the repository:
 * a run of one's own names no repository it can lease for, and a refusal (which names the holder) goes only to those
 * who may wait for it. The lease itself is keyed on the repository alone.
 */
async function leaseWorkspace(ctx: any, userId: Id<"users">, repository: string, args: { team_id?: Id<"teams">; run_id?: string }): Promise<{ workspace: string; teamId?: Id<"teams"> }> {
  if (args.run_id) {
    const id = ctx.db.normalizeId("workflow_runs", args.run_id);
    const run = id ? await ctx.db.get(id) : null;
    if (!run || !(await workspaceGrantsAccess(ctx, userId, run.workspace))) throw new Error(`No run ${args.run_id} you can lease a repository for.`);
    if (!(await worksOn(ctx, userId, repository, run))) throw new Error(`Run ${args.run_id} cannot lease ${repository}: neither its workspace nor any of your teams works on it.`);
    return { workspace: run.workspace, ...(run.team_id ? { teamId: run.team_id } : {}) };
  }
  const teamId = await teamFor(ctx, userId, repository, args.team_id);
  // A named team is checked as a run's workspace is: membership alone would let anyone hold any repository's lease
  // (stalling every merge in it) and read its holders. A resolved team already works on it.
  if (args.team_id && !(await workspaceWorksOn(ctx, repository, teamKey(teamId)))) throw new Error(`Team ${args.team_id} cannot lease ${repository}: it does not work on it.`);
  return { workspace: teamKey(teamId), teamId };
}

/**
 * Whether a run's lease on the repository is the caller's to take: one of the caller's teams works on it (the GitHub
 * App or a published checkout, as `cast ship checkout` asks), the team of the run's workspace connected it, or the
 * run's workspace published deploy targets for it.
 */
async function worksOn(ctx: any, userId: Id<"users">, repository: string, run: { workspace: string }): Promise<boolean> {
  // findDeployTeam throws only when more than one of the caller's teams works on it: that is access too.
  if (await findDeployTeam(ctx, userId, repository).then(Boolean, () => true)) return true;
  // The run's team is its workspace (access), never its team_id (routing).
  return await workspaceWorksOn(ctx, repository, run.workspace);
}

/** Whether a workspace works on the repository: its team connected it (the GitHub App or a published checkout), or it published deploy targets for it. */
async function workspaceWorksOn(ctx: any, repository: string, workspace: string): Promise<boolean> {
  const ws = parseWorkspaceKey(workspace);
  if (ws?.type === "team") {
    if ((await resolveTeamForRepository(ctx, repository)) === ws.teamId) return true;
    const sources = await ctx.db.query("repo_sources").withIndex("by_repository", (q: any) => q.eq("repository", repository)).take(100);
    if (sources.some((r: any) => r.team_id === ws.teamId)) return true;
  }
  const declared = await ctx.db.query("deploy_targets").withIndex("by_workspace_repository", (q: any) => q.eq("workspace", workspace).eq("repository", repository)).first();
  return !!declared;
}

export const lease = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    op: v.union(v.literal("take"), v.literal("renew"), v.literal("release")),
    token: v.string(),
    holder: v.optional(v.string()),
    run_id: v.optional(v.string()),
  },
  handler: async (ctx, { api_token, ...args }) => leaseCore(ctx, await requireUserOrToken(ctx, api_token), args),
});
