// A repository's deploy targets and what waits on each (docs/architecture/deploys.md
// DP10 to DP14).
//
//  - publish: the checkout's declared targets (contracts/deployTargets), from
//    the machine that holds it (`cast line deploy targets --publish`, and every
//    line profile publish).
//  - CI on main: every workflow run and check suite on the default branch, per
//    commit (recordCommitCi, from the webhook drain), and its backfill.
//  - main's order: commits.main_at, stamped from each push to the default
//    branch (stampMainOrder) and backfilled from GitHub.
//  - live: what runs on each target is its newest live deploy. A deploy is
//    recorded by its path (deploy.sh, a ship pass, a codecast run), by GitHub
//    for a target that deploys on push (a commit status on main), or by the
//    target's json reader, polled (pollLiveReaders).
//  - view: per target its live deploy, what is going out, its recent deploys
//    and the commits on main after its live sha that touch its paths, each with
//    the session that wrote it, its tasks and its CI, grouped by session.
//  - request: deploy a target from codecast (main's head, an earlier deploy's
//    sha, or the target's rollback), run on the publishing machine by the
//    line-deploy graph.

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { requireTeamMembership } from "./lib/access";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { normalizeRepository } from "./lib/gitRefs";
import { nextShortId } from "./counters";
import { enqueueConfigCommand } from "./users";
import { deployTeamFor, findDeployTeam } from "./changesDeploy";
import { resolveTeamForRepository } from "./githubWebhooks";
import { recordDeployMarker } from "./deploys";
import { lineDeployTargets } from "./deployCarries";
import { parseOwnerRepo } from "@codecast/shared/contracts";
import { DEPLOY_SHORT_ID_PREFIX } from "@codecast/shared/contracts/deploys";
import {
  DEPLOY_TARGET_NAME_RE,
  canRedeploySha,
  commitTouchesTarget,
  readJsonLive,
  type DeployLiveReader,
} from "@codecast/shared/contracts/deployTargets";
import { checkSuiteCi, ciOf, recordCommitCi, recordGithubDeployStatus, teamKey, workflowRunCi } from "./deployTargetsCi";
import { commitBySha, deployCommitsOf, mainAtOf, mainCommitsAfter, targetDeploys, targetState, upsertMainCommits } from "./deployTargetsState";

/** Commits kept on one deploy's record. */
const COMMITS_MAX = 200;

const liveReaderValidator = v.union(
  v.object({ kind: v.literal("marker") }),
  v.object({ kind: v.literal("github-status"), context: v.string() }),
  v.object({ kind: v.literal("json"), url: v.string(), sha_field: v.string(), version_field: v.optional(v.string()) }),
);

const targetValidator = v.object({
  name: v.string(),
  command: v.optional(v.string()),
  runs: v.union(v.literal("here"), v.literal("push")),
  live: liveReaderValidator,
  rollback: v.optional(v.string()),
  policy: v.union(v.literal("press"), v.literal("auto")),
  paths: v.array(v.string()),
  ship_stage: v.optional(v.union(v.literal("before_push"), v.literal("after_push"), v.literal("press"))),
});

/** The team a CLI call means: the one it names (a member), else the repository's (deployTeamFor). */
async function teamFor(ctx: any, userId: Id<"users">, repository: string, teamId?: Id<"teams">): Promise<Id<"teams">> {
  if (teamId) {
    await requireTeamMembership(ctx, userId, teamId);
    return teamId;
  }
  return await deployTeamFor(ctx, userId, repository);
}

function repositoryArg(raw: string): string {
  const repository = parseOwnerRepo(raw);
  if (!repository) throw new Error(`"${raw}" is not an owner/name repository.`);
  return normalizeRepository(repository);
}

async function targetRows(ctx: any, workspace: string, repository?: string): Promise<Doc<"deploy_targets">[]> {
  const rows: Doc<"deploy_targets">[] = await ctx.db
    .query("deploy_targets")
    .withIndex("by_workspace_repository", (q: any) => (repository ? q.eq("workspace", workspace).eq("repository", repository) : q.eq("workspace", workspace)))
    .take(200);
  return rows.filter((r) => !r.retired_at);
}

// ── publish ──────────────────────────────────────────────────────────────────

/** A checkout's declared targets: each upserted by name, and a target it no longer declares retired. */
export const publish = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    targets: v.array(targetValidator),
    device_id: v.optional(v.string()),
    root: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const repository = repositoryArg(args.repository);
    const teamId = await teamFor(ctx, userId, repository, args.team_id);
    const workspace = teamKey(teamId);
    const now = Date.now();
    const existing: Doc<"deploy_targets">[] = await ctx.db
      .query("deploy_targets")
      .withIndex("by_workspace_repository", (q) => q.eq("workspace", workspace).eq("repository", repository))
      .take(200);
    const declared = new Set<string>();
    const out: Array<{ name: string; changed: boolean }> = [];
    for (const t of args.targets) {
      const name = t.name.trim().toLowerCase();
      if (!DEPLOY_TARGET_NAME_RE.test(name)) throw new Error(`"${t.name}" is not a target name`);
      if (declared.has(name)) throw new Error(`target ${name} is declared twice`);
      declared.add(name);
      const fields = {
        command: t.command,
        runs: t.runs,
        live: t.live,
        rollback: t.rollback,
        policy: t.policy,
        paths: t.paths,
        ship_stage: t.ship_stage,
        device_id: args.device_id,
        root: args.root,
      };
      const row = existing.find((r) => r.name === name);
      if (row) {
        const changed = JSON.stringify(Object.entries(fields).map(([k, val]) => [k, (row as any)[k]])) !== JSON.stringify(Object.entries(fields).map(([k, val]) => [k, val])) || !!row.retired_at;
        // A changed reader reads afresh.
        const readerChanged = JSON.stringify(row.live) !== JSON.stringify(t.live);
        await ctx.db.patch(row._id, { ...fields, publisher_user_id: userId, retired_at: undefined, published_at: now, updated_at: now, ...(readerChanged ? { last_read: undefined } : {}) });
        out.push({ name, changed });
      } else {
        await ctx.db.insert("deploy_targets", { workspace, team_id: teamId, repository, name, ...fields, publisher_user_id: userId, published_at: now, updated_at: now });
        out.push({ name, changed: true });
      }
    }
    for (const row of existing) if (!declared.has(row.name) && !row.retired_at) await ctx.db.patch(row._id, { retired_at: now, updated_at: now });
    if (args.targets.some((t) => t.live.kind === "json")) await ctx.scheduler.runAfter(0, internal.deployTargets.pollLiveReaders, { workspace });
    return { team_id: teamId, repository, targets: out };
  },
});

/** A repository's CI per commit, for shas a reader names (newest first as given). */
export const ciForCommits = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), repository: v.string(), shas: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    if (!(await workspaceGrantsAccess(ctx, userId, teamKey(args.team_id)))) return [];
    const repository = repositoryArg(args.repository);
    const out = [];
    for (const sha of args.shas.slice(0, 100)) {
      const ci = await ciOf(ctx, repository, sha);
      out.push({ sha, state: ci.state, url: ci.url, runs: ci.runs });
    }
    return out;
  },
});

/** Every deploy target of a team: live, going out, history and the waiting queue grouped by session (DP12). */
export const view = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), repository: v.optional(v.string()), target: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    if (!args.team_id && !args.repository) throw new Error("Name a team or a repository");
    // A repository none of the caller's teams works on has no targets they can see; a
    // flow's deploy wait polls this, so an empty answer lets it pass instead of retrying a throw.
    const teamId = args.team_id ?? (await findDeployTeam(ctx, userId, repositoryArg(args.repository!)));
    if (!teamId) return { targets: [] };
    const workspace = teamKey(teamId);
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return { targets: [] };
    const rows = (await targetRows(ctx, workspace, args.repository ? repositoryArg(args.repository) : undefined)).filter((r) => !args.target || r.name === args.target);
    const targets = [];
    for (const t of rows) targets.push(await targetState(ctx, t));
    return { team_id: teamId, targets };
  },
});

/** A team's recent `cast ship checkout` passes, newest first. */
export const shipPasses = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const workspace = teamKey(args.team_id);
    if (!(await workspaceGrantsAccess(ctx, userId, workspace))) return [];
    return await ctx.db.query("ship_passes").withIndex("by_workspace_finished", (q) => q.eq("workspace", workspace)).order("desc").take(Math.min(args.limit ?? 20, 100));
  },
});

// ── what a deploy carried, from main's order ─────────────────────────────────

/**
 * A live deploy's range on main: its sha's place in main's order (cut_at, what
 * a merge is held against), its previous sha (the deploy before it on the
 * target, when it did not say) and the commits between, touching the target's
 * paths. Called once a deploy goes live.
 */
export async function fillDeployRange(ctx: any, deployId: Id<"deploys">): Promise<void> {
  const d: Doc<"deploys"> | null = await ctx.db.get(deployId);
  if (!d || d.status !== "live" || !d.sha) return;
  const patch: Partial<Doc<"deploys">> = {};
  if (!d.repository) {
    // A source's marker names its environment, not a repository (Union's errors source posts `production`): the
    // repository is the one whose published target has that name in the workspace, when exactly one does.
    const repos = [...new Set((await targetRows(ctx, d.workspace)).filter((r) => r.name === d.target).map((r) => r.repository))];
    if (repos.length !== 1) return;
    d.repository = patch.repository = repos[0];
  }
  if (d.cut_at == null) {
    const cut = await mainAtOf(ctx, d.repository, d.sha);
    if (cut != null) patch.cut_at = cut;
  }
  let previous = d.previous_sha ?? null;
  if (!previous) {
    // The live deploys created just before this one, however far back it is.
    const earlier: Doc<"deploys">[] = await ctx.db
      .query("deploys")
      .withIndex("by_workspace_target_created", (q: any) => q.eq("workspace", d.workspace).eq("target", d.target).lte("created_at", d.created_at))
      .order("desc")
      .take(30);
    const before = earlier.find((x) => x._id !== d._id && x.status === "live" && x.sha && (x.live_at ?? x.created_at) <= (d.live_at ?? d.created_at));
    if (before?.sha && before.sha !== d.sha) previous = patch.previous_sha = before.sha;
  }
  if (!d.commits?.length && previous) {
    const t = (await targetRows(ctx, d.workspace, d.repository)).find((r) => r.name === d.target);
    const range = await mainCommitsAfter(ctx, d.repository!, previous, d.sha);
    if (range.known) {
      const commits = await deployCommitsOf(ctx, range.commits
        .filter((c) => commitTouchesTarget(t?.paths ?? [], (c.files ?? []).map((f) => f.filename)))
        .reverse()
        .slice(0, COMMITS_MAX));
      if (commits.length) patch.commits = commits;
    }
  }
  if (Object.keys(patch).length) await ctx.db.patch(deployId, { ...patch, updated_at: Date.now() });
}

// ── deploying a target from codecast (DP13) ──────────────────────────────────

/**
 * Ask for a deploy of one target: main's head (`deploy`), an earlier deploy's
 * sha again (`redeploy`, only for a command that takes `$sha`), or the
 * target's rollback command (`rollback`, back to the live deploy before the
 * current one, or the one named). The machine that published the target runs
 * it (`cast line deploy run dp-N`, the line-deploy graph), and the deploy ends
 * live or failed.
 */
export async function requestTargetDeployCore(
  ctx: any,
  userId: Id<"users">,
  args: { team_id: Id<"teams">; target: string; repository?: string; action?: "deploy" | "redeploy" | "rollback"; of?: string; here?: boolean; cli?: boolean; client_key?: string; request_id?: string },
): Promise<{ _id: string; short_id: string; target: string; action: string; sha: string | null; commits: number }> {
  const workspace = teamKey(args.team_id);
  if (!(await workspaceGrantsAccess(ctx, userId, workspace))) throw new Error("Not a member of that team");
  const name = args.target.trim().toLowerCase();
  const candidates = (await targetRows(ctx, workspace, args.repository ? repositoryArg(args.repository) : undefined)).filter((r) => r.name === name);
  if (!candidates.length) throw new Error(`No deploy target ${name}: declare it as a [[target]] in .codecast/deploy.toml and publish (cast line deploy targets --publish)`);
  if (candidates.length > 1) throw new Error(`More than one repository has a target ${name}; name the repository`);
  const t = candidates[0];
  const action = args.action ?? "deploy";
  if (t.runs === "push") throw new Error(`${name} deploys itself when main moves; there is nothing to send from here`);
  if (!t.command) throw new Error(`${name} names no command`);
  if (!args.here && (!t.device_id || !t.root)) throw new Error(`No machine publishes ${name}, so nothing can run it`);
  const deploys = await targetDeploys(ctx, workspace, name);
  const open = deploys.find((d) => (d.status === "requested" || d.status === "running") && (!d.repository || d.repository === t.repository));
  if (open) throw new Error(`${open.short_id} is already going out to ${name} (${open.status}); wait for it to finish`);
  const live = deploys.find((d) => d.status === "live");
  let sha: string | undefined;
  let rollbackOf: string | undefined;
  if (action !== "deploy") {
    const of = args.of
      ? deploys.find((d) => d.short_id === args.of!.toLowerCase())
      : deploys.find((d) => d.status === "live" && d._id !== live?._id && d.sha && d.sha !== live?.sha);
    if (!of?.sha) throw new Error(args.of ? `No deploy ${args.of} of ${name} with a sha` : `No earlier live deploy of ${name} to go back to`);
    if (action === "redeploy" && !canRedeploySha(t)) throw new Error(`${name}'s command sends the tree it runs in, not a sha: it cannot redeploy ${of.short_id}${t.rollback ? "; use its rollback" : ""}`);
    if (action === "rollback" && !t.rollback) throw new Error(`${name} names no rollback command`);
    sha = of.sha;
    rollbackOf = of.short_id;
  }
  // What it will send: the commits on main after the live sha that touch the target (a deploy of main's head).
  let commits: Doc<"deploys">["commits"] & {} = [];
  if (action === "deploy") {
    const after = await mainCommitsAfter(ctx, t.repository, live?.sha ?? null);
    commits = await deployCommitsOf(ctx, after.commits
      .filter((c) => commitTouchesTarget(t.paths, (c.files ?? []).map((f) => f.filename)))
      .reverse()
      .slice(0, COMMITS_MAX));
  }
  const now = Date.now();
  const user = await ctx.db.get(userId);
  const shortId = await nextShortId(ctx.db, DEPLOY_SHORT_ID_PREFIX);
  const id = await ctx.db.insert("deploys", {
    short_id: shortId,
    ...(args.client_key ? { client_key: args.client_key } : {}),
    workspace,
    team_id: args.team_id,
    target: name,
    status: "requested",
    trigger: "person",
    started_by: { kind: args.cli ? "cli" : "person", name: user?.name ?? user?.github_username ?? user?.email ?? "someone", user_id: userId },
    source: "codecast",
    event_ids: [],
    repository: t.repository,
    ...(sha ? { sha } : {}),
    ...(live?.sha ? { previous_sha: live.sha } : {}),
    ...(commits.length ? { commits } : {}),
    carries: [],
    action,
    ...(rollbackOf ? { rollback_of: rollbackOf } : {}),
    created_at: now,
    updated_at: now,
  });
  if (!args.here) {
    try {
      await enqueueConfigCommand(ctx, userId, "line_deploy", JSON.stringify({ deploy: shortId, root: t.root }), t.device_id, args.request_id);
    } catch (err) {
      throw new Error(`${name} runs on the machine that published it, which is not yours: ask its owner, or run \`cast line deploy --target ${name} --go\` there (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  return { _id: String(id), short_id: shortId, target: name, action, sha: sha ?? null, commits: commits.length };
}

export const request = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    target: v.string(),
    repository: v.optional(v.string()),
    action: v.optional(v.union(v.literal("deploy"), v.literal("redeploy"), v.literal("rollback"))),
    of: v.optional(v.string()),
    here: v.optional(v.boolean()),
    client_key: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    if (!args.team_id && !args.repository) throw new Error("Name a team or a repository");
    const team_id = args.team_id ?? (await teamFor(ctx, userId, repositoryArg(args.repository!)));
    return await requestTargetDeployCore(ctx, userId, { ...args, team_id, cli: !!args.api_token });
  },
});

/** One published target as the CLI that runs a deploy of it reads it (the file stays the authority for the command). */
export const forDeploy = query({
  args: { api_token: v.optional(v.string()), deploy: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await ctx.db.query("deploys").withIndex("by_short_id", (q) => q.eq("short_id", args.deploy.toLowerCase())).first();
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) return null;
    const t = (await targetRows(ctx, d.workspace, d.repository)).find((r) => r.name === d.target);
    return t ? { name: t.name, repository: t.repository, live: t.live, runs: t.runs } : null;
  },
});

/**
 * Targets that go out by themselves (policy auto): a deploy of main's head is
 * asked for, as the target's publisher, when commits wait, nothing is going
 * out, CI on the newest waiting commit is green, and the last deploy did not
 * fail on that same head.
 */
export async function autoDeployTargetsCore(ctx: any): Promise<Array<{ target: string; deploy?: string; why?: string }>> {
  const out: Array<{ target: string; deploy?: string; why?: string }> = [];
  const rows: Doc<"deploy_targets">[] = (await ctx.db.query("deploy_targets").take(500)).filter((r: Doc<"deploy_targets">) => r.policy === "auto" && r.runs === "here" && !r.retired_at && r.command && r.device_id && r.root);
  for (const t of rows) {
    const s = await targetState(ctx, t);
    if (s.open || !s.queue.known || !s.queue.commits) continue;
    const newest = s.queue.groups.flatMap((g) => g.commits).sort((a, b) => b.at - a.at)[0];
    if (newest?.ci !== "passed") { out.push({ target: t.name, why: `CI on ${newest?.sha.slice(0, 7)} is ${newest?.ci}` }); continue; }
    const last = s.history[0];
    if (last?.status === "failed" && (last.created_at >= newest.at)) { out.push({ target: t.name, why: `${last.short_id} failed on this head` }); continue; }
    try {
      const asked = await requestTargetDeployCore(ctx, t.publisher_user_id, { team_id: t.team_id!, target: t.name, repository: t.repository });
      out.push({ target: t.name, deploy: asked.short_id });
    } catch (err) {
      out.push({ target: t.name, why: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export const autoDeployTargets = internalMutation({ args: {}, handler: async (ctx) => autoDeployTargetsCore(ctx) });

// ── a ship pass (DP11) ───────────────────────────────────────────────────────

/**
 * Record one `cast ship checkout` pass: its commits, the groups it held back,
 * each deploy step's result. A step that names a target records its deploy,
 * after the push, with the sha that went out (what it pushed, else the tip it
 * built when nothing was pushed); a failed one records a failed deploy.
 */
export const recordShipPass = mutation({
  args: {
    api_token: v.optional(v.string()),
    team_id: v.optional(v.id("teams")),
    repository: v.string(),
    device_id: v.optional(v.string()),
    ok: v.boolean(),
    stage: v.string(),
    reason: v.optional(v.string()),
    base: v.optional(v.string()),
    tip: v.optional(v.string()),
    pushed: v.optional(v.string()),
    pr_url: v.optional(v.string()),
    commits: v.array(v.object({ sha: v.optional(v.string()), message: v.string(), files: v.number(), session_id: v.optional(v.string()), conversation_id: v.optional(v.string()) })),
    held: v.array(v.object({ group: v.string(), paths: v.number(), note: v.optional(v.string()) })),
    deploys: v.array(v.object({ name: v.string(), stage: v.string(), ok: v.boolean(), target: v.optional(v.string()), output: v.optional(v.string()), dirty: v.optional(v.number()) })),
    started_at: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const repository = repositoryArg(args.repository);
    const teamId = await teamFor(ctx, userId, repository, args.team_id);
    const workspace = teamKey(teamId);
    const now = Date.now();
    const passId = await ctx.db.insert("ship_passes", {
      workspace,
      team_id: teamId,
      repository,
      user_id: userId,
      ...(args.device_id ? { device_id: args.device_id } : {}),
      ok: args.ok,
      stage: args.stage,
      ...(args.reason ? { reason: args.reason.slice(-2000) } : {}),
      ...(args.base ? { base: args.base } : {}),
      ...(args.pushed ? { pushed: args.pushed } : {}),
      ...(args.pr_url ? { pr_url: args.pr_url } : {}),
      commits: args.commits.slice(0, 200).map((c) => {
        const conv = c.conversation_id ? ctx.db.normalizeId("conversations", c.conversation_id) : null;
        return { ...(c.sha ? { sha: c.sha } : {}), message: c.message.slice(0, 300), files: c.files, ...(c.session_id ? { session_id: c.session_id } : {}), ...(conv ? { conversation_id: conv } : {}) };
      }),
      held: args.held.slice(0, 100),
      deploys: [],
      started_at: args.started_at,
      finished_at: now,
    });
    const user = await ctx.db.get(userId);
    const startedBy = { kind: "person" as const, name: user?.name ?? user?.github_username ?? "someone", user_id: userId };
    const sha = (args.pushed ?? args.tip)?.toLowerCase();
    const deploys = [];
    for (const step of args.deploys) {
      let deploy: string | null = null;
      if (step.target && sha) {
        deploy = await recordDeployMarker(ctx, {
          workspace,
          team_id: teamId,
          target: step.target,
          sha,
          repository,
          source: "cast ship checkout",
          started_by: startedBy,
          status: step.ok ? "live" : "failed",
          ...(step.ok ? {} : { note: (step.output ?? "").slice(-1500) || `${step.name} failed` }),
          ...(!args.pushed && step.ok ? { note: `deployed from ${sha.slice(0, 10)}, which the ship did not push` } : {}),
          ...(step.dirty ? { dirty: step.dirty } : {}),
          ship_pass_id: passId,
          at: now,
        });
      }
      deploys.push({ name: step.name, stage: step.stage, ok: step.ok, ...(step.target ? { target: step.target } : {}), ...(deploy ? { deploy } : {}), ...(step.output ? { output: step.output.slice(-3000) } : {}) });
    }
    await ctx.db.patch(passId, { deploys });
    return { pass: String(passId), deploys: deploys.map((d) => ({ name: d.name, deploy: d.deploy ?? null })) };
  },
});

// ── live readers ─────────────────────────────────────────────────────────────

export const jsonReaderTargets = internalQuery({
  args: { workspace: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const rows: Doc<"deploy_targets">[] = args.workspace
      ? await ctx.db.query("deploy_targets").withIndex("by_workspace_repository", (q) => q.eq("workspace", args.workspace!)).take(200)
      : await ctx.db.query("deploy_targets").take(500);
    return rows.filter((r) => !r.retired_at && r.live.kind === "json").map((r) => ({ _id: r._id, live: r.live as Extract<DeployLiveReader, { kind: "json" }>, last: r.last_read ?? null }));
  },
});

/** What a json reader read: a changed sha records the deploy that put it there. */
export const recordLiveRead = internalMutation({
  args: { target_id: v.id("deploy_targets"), sha: v.optional(v.string()), version: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const t = await ctx.db.get(args.target_id);
    if (!t) return null;
    const now = Date.now();
    if (args.error || !args.sha) {
      await ctx.db.patch(t._id, { last_read: { ...(t.last_read ?? {}), at: now, error: args.error ?? "the document names no commit" } });
      return null;
    }
    const changed = t.last_read?.sha !== args.sha || (args.version && t.last_read?.version !== args.version);
    await ctx.db.patch(t._id, { last_read: { sha: args.sha, ...(args.version ? { version: args.version } : {}), at: now } });
    if (!changed) return null;
    return await recordDeployMarker(ctx, {
      workspace: t.workspace,
      ...(t.team_id ? { team_id: t.team_id } : {}),
      target: t.name,
      sha: args.sha,
      ...(args.version ? { version: args.version } : {}),
      repository: t.repository,
      source: "live reader",
      ...(t.live.kind === "json" ? { url: t.live.url } : {}),
      at: now,
    });
  },
});

/** Read every json live reader (a release's latest.json) and record what changed. */
export const pollLiveReaders = internalAction({
  args: { workspace: v.optional(v.string()) },
  handler: async (ctx, args): Promise<number> => {
    const targets = await ctx.runQuery(internal.deployTargets.jsonReaderTargets, { workspace: args.workspace });
    let recorded = 0;
    for (const t of targets) {
      try {
        const res = await fetch(t.live.url, { headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`${t.live.url} answered ${res.status}`);
        const { sha, version } = readJsonLive(t.live, await res.json());
        const r = await ctx.runMutation(internal.deployTargets.recordLiveRead, { target_id: t._id, ...(sha ? { sha } : {}), ...(version ? { version } : {}) });
        if (r) recorded++;
      } catch (err) {
        await ctx.runMutation(internal.deployTargets.recordLiveRead, { target_id: t._id, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
      }
    }
    return recorded;
  },
});


// ── backfill: main's order, CI and GitHub deploy statuses (DP14) ─────────────

async function gh(token: string, path: string): Promise<any | null> {
  const res = await fetch(`https://api.github.com${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  return res.ok ? await res.json() : null;
}

export const backfillTarget = internalQuery({
  args: { repository: v.string() },
  handler: async (ctx, args): Promise<{ team_id: Id<"teams">; contexts: string[] } | null> => {
    const repository = normalizeRepository(args.repository);
    const team = await resolveTeamForRepository(ctx, repository);
    if (!team) return null;
    const targets = (await ctx.db.query("deploy_targets").withIndex("by_repository_name", (q) => q.eq("repository", repository)).take(50)).filter((r) => !r.retired_at);
    return { team_id: team, contexts: [...new Set(targets.flatMap((t) => (t.live.kind === "github-status" ? [t.live.context] : [])))] };
  },
});

/** Commits of main read back from GitHub, oldest first: each upserted with its files and stamped in main's order. */
export const backfillMainCommits = internalMutation({
  args: {
    repository: v.string(),
    team_id: v.id("teams"),
    branch: v.string(),
    commits: v.array(v.object({ sha: v.string(), message: v.string(), author_name: v.string(), author_email: v.string(), author_login: v.optional(v.string()), at: v.number(), files: v.optional(v.array(v.string())) })),
  },
  handler: async (ctx, args) => upsertMainCommits(ctx, args),
});

const mainCommitValidator = v.object({ sha: v.string(), message: v.string(), author_name: v.string(), author_email: v.string(), author_login: v.optional(v.string()), at: v.number(), files: v.optional(v.array(v.string())) });

/**
 * Main's commits as a checkout reports them, for a repository no GitHub installation routes (a local bare remote,
 * another host): webhooks never see it, so this is how its targets get a waiting queue. A repository the App
 * covers is left to its webhooks and backfill.
 */
export const reportMainCommits = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), repository: v.string(), branch: v.string(), commits: v.array(mainCommitValidator) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    await requireTeamMembership(ctx, userId, args.team_id);
    const repository = repositoryArg(args.repository);
    if (await resolveTeamForRepository(ctx, repository)) return { skipped: "GitHub reports this repository's commits" };
    return await upsertMainCommits(ctx, { repository, team_id: args.team_id, branch: args.branch, commits: args.commits.slice(0, 300) });
  },
});
export const backfillCi = internalMutation({
  args: { team_id: v.id("teams"), rows: v.array(v.object({ repository: v.string(), sha: v.string(), name: v.string(), kind: v.union(v.literal("workflow"), v.literal("suite")), run_id: v.optional(v.string()), status: v.string(), conclusion: v.optional(v.string()), url: v.optional(v.string()), started_at: v.number() })) },
  handler: async (ctx, args) => {
    let n = 0;
    for (const r of args.rows) if (await recordCommitCi(ctx, r, args.team_id)) n++;
    return n;
  },
});

export const backfillStatuses = internalMutation({
  args: { rows: v.array(v.object({ repository: v.string(), sha: v.string(), context: v.string(), state: v.string(), url: v.optional(v.string()), description: v.optional(v.string()), at: v.number() })) },
  handler: async (ctx, args) => {
    const out: string[] = [];
    for (const r of args.rows) out.push(...(await recordGithubDeployStatus(ctx, { ...r, on_default_branch: true })));
    return out;
  },
});

/**
 * Read a repository's default branch back from GitHub: its last `commits`
 * commits in order with their files, the CI on each (workflow runs and other
 * apps' check suites), and the deploy statuses its github-status targets name.
 *   packages/convex/run.sh deployTargets:backfill '{"repository":"codecast-sh/codecast","commits":150}'
 */
export const backfill = internalAction({
  // offset: commits back from main's head to start at, so a long history is read in passes of up to 500, newest first.
  args: { repository: v.string(), commits: v.optional(v.number()), files: v.optional(v.boolean()), offset: v.optional(v.number()), ci: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const repository = normalizeRepository(args.repository);
    const target: { team_id: Id<"teams">; contexts: string[] } | null = await ctx.runQuery(internal.deployTargets.backfillTarget, { repository });
    const installation: any = target ? await ctx.runQuery(internal.githubApp.getInstallationForRepoInTeam, { repository, team_id: target.team_id }) : null;
    if (!target || !installation?.installation_id) return { error: "no team installation routes this repository" };
    const { token } = await ctx.runAction(internal.githubApp.getInstallationToken, { installation_id: installation.installation_id });
    const repo = await gh(token, `/repos/${repository}`);
    const branch: string = repo?.default_branch ?? "main";
    const want = Math.min(args.commits ?? 150, 500);
    const offset = Math.max(0, Math.floor((args.offset ?? 0) / 100) * 100);
    const listed: any[] = [];
    for (let page = offset / 100 + 1; listed.length < want && page <= offset / 100 + 5; page++) {
      const batch = await gh(token, `/repos/${repository}/commits?sha=${encodeURIComponent(branch)}&per_page=100&page=${page}`);
      if (!Array.isArray(batch) || !batch.length) break;
      listed.push(...batch);
      if (batch.length < 100) break;
    }
    // GitHub lists newest first along the branch; main's order is the reverse.
    const ordered = listed.slice(0, want).reverse();
    const commits = [];
    for (const c of ordered) {
      let files: string[] | undefined;
      if (args.files !== false) {
        const full = await gh(token, `/repos/${repository}/commits/${c.sha}`);
        files = Array.isArray(full?.files) ? full.files.map((f: any) => String(f.filename)).slice(0, 300) : undefined;
      }
      const at = Date.parse(c.commit?.committer?.date ?? c.commit?.author?.date ?? "");
      commits.push({
        sha: c.sha,
        message: String(c.commit?.message ?? ""),
        author_name: String(c.commit?.author?.name ?? "Unknown"),
        author_email: String(c.commit?.author?.email ?? ""),
        ...(c.author?.login ? { author_login: c.author.login } : {}),
        at: Number.isFinite(at) ? at : Date.now(),
        ...(files ? { files } : {}),
      });
    }
    let inserted = 0;
    let stamped = 0;
    for (let i = 0; i < commits.length; i += 25) {
      const r = await ctx.runMutation(internal.deployTargets.backfillMainCommits, { repository, team_id: target.team_id, branch, commits: commits.slice(i, i + 25) });
      inserted += r.inserted;
      stamped += r.ordered;
    }
    // CI: the default branch's workflow runs, newest pages, and each recent commit's other apps' suites.
    const ciRows: any[] = [];
    for (let page = 1; args.ci !== false && page <= 4; page++) {
      const body = await gh(token, `/repos/${repository}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100&page=${page}`);
      const runs: any[] = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
      for (const run of runs) {
        const row = workflowRunCi({ workflow_run: run, repository: { full_name: repository, default_branch: branch }, workflow: { name: run.name } });
        if (row) ciRows.push(row);
      }
      if (runs.length < 100) break;
    }
    const statusRows: any[] = [];
    for (const c of args.ci === false ? [] : ordered.slice(-60)) {
      const suites = await gh(token, `/repos/${repository}/commits/${c.sha}/check-suites?per_page=50`);
      for (const s of suites?.check_suites ?? []) {
        const row = checkSuiteCi({ check_suite: { ...s, head_branch: branch }, repository: { full_name: repository, default_branch: branch } });
        if (row) ciRows.push(row);
      }
      if (target.contexts.length) {
        const st = await gh(token, `/repos/${repository}/commits/${c.sha}/status`);
        for (const s of st?.statuses ?? []) {
          if (!target.contexts.includes(s.context)) continue;
          const at = Date.parse(s.updated_at ?? s.created_at ?? "");
          statusRows.push({ repository, sha: c.sha, context: s.context, state: s.state, ...(s.target_url ? { url: s.target_url } : {}), ...(s.description ? { description: String(s.description).slice(0, 500) } : {}), at: Number.isFinite(at) ? at : Date.now() });
        }
      }
    }
    let ci = 0;
    for (let i = 0; i < ciRows.length; i += 50) ci += await ctx.runMutation(internal.deployTargets.backfillCi, { team_id: target.team_id, rows: ciRows.slice(i, i + 50) });
    statusRows.sort((a, b) => a.at - b.at);
    const deploys = statusRows.length ? await ctx.runMutation(internal.deployTargets.backfillStatuses, { rows: statusRows }) : [];
    return { branch, commits: commits.length, inserted, stamped, ci, statuses: statusRows.length, deploys };
  },
});

/** Read a team's json live readers now (the CLI's `targets` view asks for it after a publish). */
export const pollNow = action({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams") },
  handler: async (ctx, args): Promise<number> => {
    await ctx.runQuery(internal.deployTargets.assertMember, { api_token: args.api_token, team_id: args.team_id });
    return await ctx.runAction(internal.deployTargets.pollLiveReaders, { workspace: teamKey(args.team_id) });
  },
});

export const assertMember = internalQuery({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams") },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    if (!(await workspaceGrantsAccess(ctx, userId, teamKey(args.team_id)))) throw new Error("Not a member of that team");
    return true;
  },
});

/**
 * Record a deploy that went live at a known time from outside any path codecast saw (a release before its target
 * was declared, a replayed payload), as its marker would have.
 *   packages/convex/run.sh deployTargets:recordPastDeploy '{"repository":"o/r","target":"desktop","sha":"…","version":"1.1.128","at":1793000000000,"source":"release history"}'
 */
export const recordPastDeploy = internalMutation({
  args: { repository: v.string(), target: v.string(), sha: v.string(), version: v.optional(v.string()), at: v.number(), source: v.string(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const repository = normalizeRepository(args.repository);
    const t = (await ctx.db.query("deploy_targets").withIndex("by_repository_name", (q) => q.eq("repository", repository).eq("name", args.target)).take(5)).find((r) => !r.retired_at);
    if (!t) throw new Error(`No target ${args.target} published for ${repository}`);
    return await recordDeployMarker(ctx, {
      workspace: t.workspace, ...(t.team_id ? { team_id: t.team_id } : {}), target: t.name, sha: args.sha.toLowerCase(),
      ...(args.version ? { version: args.version } : {}), repository, source: args.source, ...(args.note ? { note: args.note } : {}), at: args.at,
    });
  },
});

/** Correct the sha a recorded outside deploy names (a hand-seeded past deploy written with the wrong commit). */
export const correctDeploySha = internalMutation({
  args: { deploy: v.string(), sha: v.string() },
  handler: async (ctx, args) => {
    const d = await ctx.db.query("deploys").withIndex("by_short_id", (q) => q.eq("short_id", args.deploy.toLowerCase())).first();
    if (!d) throw new Error(`No deploy ${args.deploy}`);
    if (d.trigger !== "outside") throw new Error(`${d.short_id} was sent by codecast; its sha is what its path reported`);
    await ctx.db.patch(d._id, { sha: args.sha.toLowerCase(), commits: undefined, previous_sha: undefined, updated_at: Date.now() });
    await fillDeployRange(ctx, d._id);
    return { short_id: d.short_id, sha: args.sha.toLowerCase() };
  },
});

/**
 * Fill what a target's past deploys carried, for deploys recorded before their range and links were kept: a live
 * deploy with no commits gets its range on main, and carried commits get the tasks they link and their session.
 */
export const backfillDeployRanges = internalMutation({
  args: { team_id: v.id("teams"), target: v.string(), take: v.optional(v.number()) },
  handler: async (ctx, args) => {
    let ranged = 0, linked = 0, uncarried = 0;
    // A target no line deploys to carries no line fixes (deployCarries.carriesForMarker); earlier markers gave it them all.
    const lineTarget = (await lineDeployTargets(ctx, teamKey(args.team_id))).has(args.target);
    // Oldest first, so each deploy's previous live deploy is already settled when its range is read.
    for (const d of (await targetDeploys(ctx, teamKey(args.team_id), args.target, args.take ?? 60)).reverse()) {
      if (!lineTarget && d.carries.length) {
        await ctx.db.patch(d._id, { carries: [], updated_at: Date.now() });
        uncarried++;
      }
      if (d.status !== "live") continue;
      if (!d.commits?.length) {
        await fillDeployRange(ctx, d._id);
        if ((await ctx.db.get(d._id))?.commits?.length) ranged++;
        continue;
      }
      if (!d.repository) continue;
      // Re-read each carried commit, so it keeps the tasks it links and the session behind it (commitSession).
      const rows = [];
      for (const c of d.commits) rows.push(await commitBySha(ctx, d.repository, c.sha));
      if (rows.some((r) => !r)) continue;
      const commits = await deployCommitsOf(ctx, rows as Doc<"commits">[]);
      if (JSON.stringify(commits) !== JSON.stringify(d.commits)) {
        await ctx.db.patch(d._id, { commits, updated_at: Date.now() });
        linked++;
      }
    }
    return { ranged, linked, uncarried };
  },
});
