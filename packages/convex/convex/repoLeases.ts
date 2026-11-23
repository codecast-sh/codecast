// One holder at a time for a repository's before-merge deploys through the
// push that lands them (docs/architecture/flows.md, the Merge station). A
// whole-tree deploy (convex) from one machine between another's deploy and
// its merge takes the other's backend back out of production; a local lock
// orders one checkout only. The Merge station holds this lease from its first
// before-merge step to the landed sha, and `cast ship checkout` from its
// first before-push deploy to its push.
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

export type LeaseAnswer =
  | { held: true; expires_at: number }
  | { held: false; holder: string; since: number; expires_at: number }
  | { released: boolean };

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
  const mine = !!row && row.token === args.token;
  if (args.op === "release") {
    if (mine) await ctx.db.delete(row._id);
    return { released: mine };
  }
  const live = !!row && row.expires_at > now;
  if (live && !mine) return { held: false, holder: row.holder, since: row.acquired_at, expires_at: row.expires_at };
  // A renewal extends only this holder's own row, lapsed or not. With no row (another holder took it, merged and
  // released it while this one slept) or another's token, the lease is gone: renewing must never take it back.
  if (args.op === "renew" && !mine) return { held: false, holder: row?.holder ?? "nobody", since: row?.acquired_at ?? now, expires_at: row?.expires_at ?? now };
  const expires_at = now + LEASE_MS;
  if (mine) await ctx.db.patch(row._id, { expires_at });
  else {
    if (row) await ctx.db.delete(row._id);
    await ctx.db.insert("repo_leases", { workspace, ...(teamId ? { team_id: teamId } : {}), repository, token: args.token, holder: (args.holder ?? "someone").slice(0, 200), holder_user_id: userId, acquired_at: now, expires_at });
  }
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
  const ws = parseWorkspaceKey(run.workspace);
  if (ws?.type === "team") {
    if ((await resolveTeamForRepository(ctx, repository)) === ws.teamId) return true;
    const sources = await ctx.db.query("repo_sources").withIndex("by_repository", (q: any) => q.eq("repository", repository)).take(100);
    if (sources.some((r: any) => r.team_id === ws.teamId)) return true;
  }
  const declared = await ctx.db.query("deploy_targets").withIndex("by_workspace_repository", (q: any) => q.eq("workspace", run.workspace).eq("repository", repository)).first();
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
