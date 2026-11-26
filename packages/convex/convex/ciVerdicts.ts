// Our own CI runner's verdict per commit (ct-102083): `cast ci record` writes one `kind: "runner"` commit_ci row
// per (repository, sha, name) with its jobs, failing tests and gzipped log tails; `cast ci show` and `cast ci log`
// read it back. In shadow nothing that decides a deploy reads these rows (`ciRowDecides`).

import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { deployTeamFor } from "./changesDeploy";
import { repositoryArg } from "./deployTargetsState";
import { recordCommitCi, teamKey } from "./deployTargetsCi";
import { resolveTeamForRepository } from "./githubWebhooks";
import { runnerJob } from "./deploySchema";

/** The team whose rows the caller reads and writes for a repository: the one recordCommitCi routes it to. */
async function teamFor(ctx: any, args: { api_token?: string; team_id?: Id<"teams">; repository: string }) {
  const userId = await requireUserOrToken(ctx, args.api_token);
  const repository = repositoryArg(args.repository);
  const team = args.team_id ?? (await deployTeamFor(ctx, userId, repository));
  if (!(await workspaceGrantsAccess(ctx, userId, teamKey(team)))) throw new Error("Not a member of that team");
  return { team, repository };
}

/**
 * The team a runner verdict is written for: the one GitHub routes the repository to, as for GitHub's own CI rows,
 * and only by its members. Anyone else is refused, so no team can write over another's verdict.
 */
async function routedTeamFor(ctx: any, userId: Id<"users">, rawRepository: string, asked?: Id<"teams">) {
  const repository = repositoryArg(rawRepository);
  const team = await resolveTeamForRepository(ctx, repository);
  if (!team) throw new Error(`No codecast team has the GitHub App on ${repository}, so it takes no CI verdicts.`);
  if ((asked && asked !== team) || !(await workspaceGrantsAccess(ctx, userId, teamKey(team)))) {
    throw new Error(`${repository} belongs to a team you are not a member of; its CI verdicts are that team's to record.`);
  }
  return { team, repository };
}

/**
 * Claim each job's log: an upload this caller made through /cli/artifacts/upload that nothing has claimed, or one the
 * stored row already holds (a retried record). Claiming removes the upload record, so the day's sweep spares the blob
 * and no other row can take it. Returns the ids newly claimed.
 */
async function claimLogs(ctx: any, userId: Id<"users">, held: Set<string>, ids: Id<"_storage">[]): Promise<Id<"_storage">[]> {
  const claimed: Id<"_storage">[] = [];
  for (const id of ids) {
    if (held.has(id)) continue;
    const upload = await ctx.db.query("artifact_uploads").withIndex("by_storage_id", (q: any) => q.eq("storage_id", id)).first();
    if (!upload || upload.user_id !== userId) throw new Error(`Log ${id} is not an unclaimed upload of yours; upload job logs through /cli/artifacts/upload.`);
    await ctx.db.delete(upload._id);
    claimed.push(id);
  }
  return claimed;
}

export const record = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    sha: v.string(),
    name: v.string(),
    run_kind: v.union(v.literal("main"), v.literal("landing")),
    host: v.string(),
    run_id: v.string(),
    started_at: v.number(),
    status: v.union(v.literal("in_progress"), v.literal("completed")),
    conclusion: v.optional(v.union(v.literal("success"), v.literal("failure"), v.literal("infra"))),
    jobs: v.array(runnerJob),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const { team, repository } = await routedTeamFor(ctx, userId, args.repository, args.team_id);
    if (!/^[0-9a-f]{40}$/i.test(args.sha)) throw new Error(`"${args.sha}" is not a full 40-character commit sha.`);
    const [before] = await rowsAt(ctx, team, repository, args.sha, args.name, "runner");
    const held = new Set((before?.jobs ?? []).map((j) => j.log_storage_id).filter((x): x is Id<"_storage"> => !!x));
    const claimed = await claimLogs(ctx, userId, held, args.jobs.flatMap((j) => (j.log_storage_id ? [j.log_storage_id] : [])));
    const { api_token: _t, team_id: _team, ...row } = args;
    const outcome = await recordCommitCi(ctx, { ...row, repository, kind: "runner" }, team);
    // A verdict the stored run stands over leaves its fresh logs unreferenced: drop them.
    if (outcome !== "written") for (const id of claimed) await ctx.storage.delete(id);
    const [stored] = await rowsAt(ctx, team, repository, args.sha, args.name, "runner");
    return { sha: args.sha.toLowerCase(), run_id: stored?.run_id ?? null, status: stored?.status ?? null, conclusion: stored?.conclusion ?? null, written: outcome === "written" };
  },
});

/** The commit_ci rows of one commit (a full sha, or a prefix of at least 7) in the caller's team, all kinds. */
async function rowsAt(ctx: any, team: Id<"teams">, repository: string, sha: string, name?: string, kind?: Doc<"commit_ci">["kind"]): Promise<Doc<"commit_ci">[]> {
  const s = sha.toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) throw new Error(`"${sha}" is not a commit sha.`);
  const rows: Doc<"commit_ci">[] = await ctx.db.query("commit_ci")
    .withIndex("by_repository_sha", (q: any) => (s.length === 40 ? q.eq("repository", repository).eq("sha", s) : q.eq("repository", repository).gte("sha", s).lt("sha", `${s}~`)))
    .take(200);
  const mine = rows.filter((r) => r.workspace === teamKey(team) && (!name || r.name === name) && (!kind || r.kind === kind));
  const shas = new Set(mine.map((r) => r.sha));
  if (shas.size > 1) throw new Error(`${sha} names more than one commit (${[...shas].map((x) => x.slice(0, 12)).join(", ")}); give more of it.`);
  return mine;
}

const readArgs = { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), repository: v.string(), sha: v.string() };

/** A commit's CI: the runner's verdicts with their jobs, and every other run beside them. */
export const show = query({
  args: { ...readArgs, name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { team, repository } = await teamFor(ctx, args);
    const rows = await rowsAt(ctx, team, repository, args.sha, args.name);
    return {
      repository,
      sha: rows[0]?.sha ?? null,
      runs: rows.sort((a, b) => a.started_at - b.started_at).map((r) => ({
        name: r.name, kind: r.kind, status: r.status, conclusion: r.conclusion ?? null, url: r.url ?? null, run_id: r.run_id ?? null,
        host: r.host ?? null, run_kind: r.run_kind ?? null, started_at: r.started_at, updated_at: r.updated_at,
        jobs: (r.jobs ?? []).map(({ log_storage_id, ...j }) => ({ ...j, has_log: !!log_storage_id })),
      })),
    };
  },
});

/** Where to fetch one runner job's gzipped log tail: a storage URL anyone holding it can read, so only the team's members get it. */
export const log = query({
  args: { ...readArgs, job: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { team, repository } = await teamFor(ctx, args);
    const runs = (await rowsAt(ctx, team, repository, args.sha, args.name)).filter((r) => r.kind === "runner").sort((a, b) => b.started_at - a.started_at);
    const run = runs.find((r) => r.jobs?.some((j) => j.name === args.job));
    if (!run) throw new Error(runs.length ? `No job "${args.job}" in the runner's verdict on ${args.sha} (jobs: ${runs.flatMap((r) => (r.jobs ?? []).map((j) => j.name)).join(", ")}).` : `No runner verdict on ${args.sha}.`);
    const job = run.jobs!.find((j) => j.name === args.job)!;
    const url = job.log_storage_id ? await ctx.storage.getUrl(job.log_storage_id) : null;
    return { sha: run.sha, name: run.name, job: job.name, url, encoding: "gzip" as const };
  },
});
