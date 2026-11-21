// A repository's pipeline (docs/architecture/pipeline.md PL6;
// contracts/pipeline.ts): published from the checkout that publishes its
// deploy targets (deploys.md DP10), into the repository's team's workspace,
// and read back per team for the pipeline page. Access is the row's workspace
// key, as deploy_targets reads it.

import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { requireTeamMembership } from "./lib/access";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { normalizeRepository } from "./lib/gitRefs";
import { deployTeamFor } from "./changesDeploy";
import { teamKey } from "./deployTargetsCi";
import { parseOwnerRepo } from "@codecast/shared/contracts";

/** The most a published pipeline may weigh: well under a document's 1 MiB. */
export const PIPELINE_MAX_BYTES = 700_000;

const flowShape = (f: any, lane: string) => {
  if (!f || typeof f !== "object" || typeof f.slug !== "string" || !Array.isArray(f.stations) || !f.graph || !Array.isArray(f.graph.nodes) || !Array.isArray(f.graph.edges)) {
    throw new Error(`the pipeline's ${lane} flow is not a PipelineFlow`);
  }
};

/** A string's FNV-1a hash, enough to tell a republish of the same pipeline. */
function hashOf(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/** A checkout's pipeline: one row per repository in its team's workspace, replaced whole. */
export const publish = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    change: v.any(),
    release: v.any(),
    device_id: v.optional(v.union(v.string(), v.null())),
    head_sha: v.optional(v.union(v.string(), v.null())),
    head_at: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const parsed = parseOwnerRepo(args.repository);
    if (!parsed) throw new Error(`"${args.repository}" is not an owner/name repository.`);
    const repository = normalizeRepository(parsed);
    let teamId = args.team_id;
    if (teamId) await requireTeamMembership(ctx, userId, teamId);
    else teamId = await deployTeamFor(ctx, userId, repository);
    flowShape(args.change, "change");
    flowShape(args.release, "release");
    if (!Array.isArray(args.release.targets)) throw new Error("the pipeline's release flow names no targets list");
    const body = JSON.stringify({ change: args.change, release: args.release });
    const bytes = new TextEncoder().encode(body).length;
    if (bytes > PIPELINE_MAX_BYTES) throw new Error(`the pipeline is ${bytes} bytes, over ${PIPELINE_MAX_BYTES}`);
    const hash = hashOf(body);
    const workspace = teamKey(teamId);
    const now = Date.now();
    const row = await ctx.db
      .query("pipelines")
      .withIndex("by_workspace_repository", (q) => q.eq("workspace", workspace).eq("repository", repository))
      .first();
    const device_id = args.device_id ?? undefined;
    const head_sha = args.head_sha ?? undefined;
    // The newest commit's pipeline stands: a checkout behind it (an old clone, a stale worktree) does not write over it.
    if (row?.head_at !== undefined && (args.head_at === undefined || args.head_at < row.head_at) && head_sha !== row.head_sha) {
      return { team_id: teamId, repository, changed: false, refused: `the published pipeline is from a newer commit (${String(row.head_sha ?? "").slice(0, 10)})` };
    }
    if (row && row.hash === hash && row.device_id === device_id && row.head_sha === head_sha) return { team_id: teamId, repository, changed: false };
    const fields = { change: args.change, release: args.release, device_id, head_sha, head_at: args.head_at, hash, publisher_user_id: userId, published_at: now, updated_at: now };
    if (row) await ctx.db.patch(row._id, fields);
    else await ctx.db.insert("pipelines", { workspace, team_id: teamId, repository, ...fields });
    return { team_id: teamId, repository, changed: true };
  },
});

const rowOut = (r: Doc<"pipelines">) => ({
  _id: r._id,
  workspace: r.workspace,
  repository: r.repository,
  published_at: r.published_at,
  device_id: r.device_id ?? null,
  head_sha: r.head_sha ?? null,
  change: r.change,
  release: r.release,
});

/** A team's pipelines, one per repository, as contracts/pipeline Pipeline rows. */
export const forTeam = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), repository: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const workspace = teamKey(args.team_id);
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return [];
    const repository = args.repository ? parseOwnerRepo(args.repository) : null;
    const rows = await ctx.db
      .query("pipelines")
      .withIndex("by_workspace_repository", (q) => (repository ? q.eq("workspace", workspace).eq("repository", normalizeRepository(repository)) : q.eq("workspace", workspace)))
      .take(100);
    return rows.map(rowOut);
  },
});
