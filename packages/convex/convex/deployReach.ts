// How far a merged pull request or a commit on main has gone toward production
// (docs/architecture/deploys.md DP16): per deploy target the change touches,
// live, going out, failed, rolled back or waiting, read from the deploys the
// target recorded. The rule is contracts/deployReach; this reads its inputs.

import { v } from "convex/values";
import { query } from "./functions";
import type { Doc } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { canAccessPullRequest, workspaceGrantsAccess } from "./lib/access";
import { normalizeRepository } from "./lib/gitRefs";
import { commitBySha, targetDeploys } from "./deployTargetsState";
import { accessibleCommits } from "./commits";
import { commitTouchesTarget } from "@codecast/shared/contracts/deployTargets";
import { deployReach, type DeployReach, type ReachChange, type ReachDeploy } from "@codecast/shared/contracts/deployReach";

const REACH_DEPLOYS = 20;
const PR_REF = /^([^/\s#@]+\/[^/\s#@]+)#(\d+)$/;
const COMMIT_REF = /^([^/\s#@]+\/[^/\s#@]+)@([0-9a-f]{7,40})$/i;
/** A full sha alone: a run knows the commit it merged but not the repository's name, which the commit's own row carries. */
const BARE_SHA = /^[0-9a-f]{40}$/i;

/** The deploys of each target the change touches, with a place on main for every one that went out after the live one. */
async function reachOf(ctx: any, userId: any, repository: string, change: ReachChange, files: string[] | null): Promise<DeployReach | null> {
  const rows: Doc<"deploy_targets">[] = (await ctx.db.query("deploy_targets").withIndex("by_repository_name", (q: any) => q.eq("repository", repository)).take(50))
    .filter((t: Doc<"deploy_targets">) => !t.retired_at);
  const access = new Map<string, boolean>();
  const places = new Map<string, number | null>();
  const placeOf = async (sha: string): Promise<number | null> => {
    if (!places.has(sha)) places.set(sha, (await commitBySha(ctx, repository, sha))?.main_at ?? null);
    return places.get(sha)!;
  };
  // A target that names no paths ships "every path" only in a repository whose targets name none: beside targets that
  // say what they ship (Union's production beside its line-profile apps), it says nothing about what a change touches.
  const someNamePaths = rows.some((t) => t.paths.length > 0);
  const targets: Array<{ target: string; deploys: ReachDeploy[] }> = [];
  for (const t of rows) {
    if (someNamePaths && t.paths.length === 0) continue;
    if (!access.has(t.workspace)) access.set(t.workspace, await workspaceGrantsAccess(ctx, userId, t.workspace));
    if (!access.get(t.workspace) || !commitTouchesTarget(t.paths, files)) continue;
    // Reach reads back to the first live deploy that held the change; an older one only names which deploy took it out.
    const deploys = (await targetDeploys(ctx, t.workspace, t.name, REACH_DEPLOYS)).filter((d) => !d.repository || d.repository === repository);
    const live = deploys.find((d) => d.status === "live");
    const out: ReachDeploy[] = [];
    for (const d of deploys) {
      // A deploy is stamped with its place on main once live; the live one stamped before main ordered its sha, and
      // any newer one still going out or failed, is placed here, so a rollback is never read by time.
      const unplaced = d.cut_at == null && d.sha && (!live || d.created_at >= live.created_at) && d.status !== "cancelled";
      out.push({
        short_id: d.short_id,
        status: d.status,
        sha: d.sha ?? null,
        cut_at: d.cut_at ?? (unplaced ? await placeOf(d.sha!) : null),
        created_at: d.created_at,
        live_at: d.live_at ?? null,
        finished_at: d.finished_at ?? null,
        url: d.url ?? null,
        note: d.note ?? null,
      });
    }
    targets.push({ target: t.name, deploys: out });
  }
  return deployReach(change, targets, Date.now());
}

/**
 * A merged pull request's (`owner/repo#N`) or a main commit's (`owner/repo@sha`) reach: null when it is not on main,
 * the repository declares no deploy targets the viewer can read, or the change touches none of them.
 */
export const get = query({
  args: { ref: v.string() },
  handler: async (ctx, args): Promise<(DeployReach & { _id: string; ref: string }) | null> => {
    const userId = await requireUserOrToken(ctx, undefined);
    const ref = args.ref.trim();
    const pr = PR_REF.exec(ref);
    if (pr) {
      const repository = normalizeRepository(pr[1]!);
      const row: Doc<"pull_requests"> | null = await ctx.db
        .query("pull_requests")
        .withIndex("by_repository_number", (q: any) => q.eq("repository", repository).eq("number", Number(pr[2])))
        .first();
      if (!row || row.state !== "merged" || !(await canAccessPullRequest(ctx, userId, row))) return null;
      const sha = row.merge_commit_sha ?? null;
      const commit = sha ? await commitBySha(ctx, repository, sha) : null;
      const files = row.files?.length ? row.files.map((f) => f.filename) : commit?.files?.map((f) => f.filename) ?? null;
      const reach = await reachOf(ctx, userId, repository, { sha, main_at: commit?.main_at ?? null, merged_at: row.merged_at ?? null }, files);
      return reach ? { ...reach, _id: ref, ref } : null;
    }
    const c = COMMIT_REF.exec(ref);
    if (c) return commitReach(ctx, userId, ref, c[2]!, normalizeRepository(c[1]!));
    if (BARE_SHA.test(ref)) return commitReach(ctx, userId, ref, ref, null);
    return null;
  },
});

/** The reach of each of a few full shas (a team's landed runs, for their sessions' inbox cards): one subscription for all. */
export const many = query({
  args: { refs: v.array(v.string()) },
  handler: async (ctx, args): Promise<Array<DeployReach & { _id: string; ref: string }>> => {
    const userId = await requireUserOrToken(ctx, undefined);
    // The client asks for at most this many (LANDED_REACH_MAX); a longer ask is cut, and the rest read as unknown.
    const refs = [...new Set(args.refs.map((r) => r.trim()).filter((r) => BARE_SHA.test(r)))].slice(0, 25);
    const out = await Promise.all(refs.map((ref) => commitReach(ctx, userId, ref, ref, null)));
    return out.filter((r): r is DeployReach & { _id: string; ref: string } => !!r);
  },
});

/** A main commit's reach, by a sha prefix in a named repository, or by a full sha in whichever repository main ordered it. */
async function commitReach(ctx: any, userId: any, ref: string, sha: string, repository: string | null): Promise<(DeployReach & { _id: string; ref: string }) | null> {
  const prefix = sha.toLowerCase();
  // Every row of the commit (a session's and the webhook's): readable through any, ordered on main by the one that is.
  const rows: Doc<"commits">[] = (await ctx.db.query("commits").withIndex("by_sha", (q: any) => q.gte("sha", prefix).lt("sha", `${prefix}~`)).take(20))
    .filter((r: Doc<"commits">) => r.sha.startsWith(prefix) && (!repository || !r.repository || normalizeRepository(r.repository) === repository));
  // A commit main never ordered is on a branch: nothing deploys it. A full sha alone may sit on main in more than one
  // repository (a fork beside its upstream): each is tried in turn, through the rows of that repository only.
  const repos = repository ? [repository] : [...new Set(rows.filter((r) => r.main_at != null && r.repository).map((r) => normalizeRepository(r.repository!)))];
  for (const repo of repos) {
    const mine = repository ? rows : rows.filter((r) => r.repository && normalizeRepository(r.repository) === repo);
    const commit = mine.find((r) => r.main_at != null);
    if (!commit || !(await accessibleCommits(ctx, userId, mine)).length) continue;
    const reach = await reachOf(ctx, userId, repo, { sha: commit.sha, main_at: commit.main_at!, merged_at: commit.main_at! }, commit.files?.map((f) => f.filename) ?? null);
    if (reach) return { ...reach, _id: ref, ref };
  }
  return null;
}
