// Rolling production back (docs/architecture/deploys.md DP19): pause first, so nothing sends the change again, then
// redeploy the earlier commit through codecast's queue (DP18), and name the commit that will end it, filed to the
// Release Captain as a task: a revert of each commit the rollback took off, or a fix forward when one of them carries a
// migration. The pause lifts itself once that commit is green on main, not when it merges: a deploy of main's head
// while its CI runs would ship the change again.

import { v } from "convex/values";
import { internalMutation, mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { teamKey, ciOf } from "./deployTargetsCi";
import { mainCommitsAfter, repositoryArg, targetRows } from "./deployTargetsState";
import { deployTeamFor } from "./changesDeploy";
import { requestTargetDeployCore } from "./deployTargetRequest";
import { activePauseOf, liftCore, pauseViewOf, requirePauseHolder } from "./deployPause";
import { cancelForPause, kickDispatch, sendsThroughGithub } from "./deployDispatch";
import { createTaskAs } from "./tasks";
import { tellRole } from "./pendingMessages";
import { emitNotification } from "./notificationRouter";
import { teamTimezone } from "./lib/teamDay";
import { PAUSE_AUTHORITY_ID, PAUSE_REMIND_MS, inWorkingHours, rollbackEnding } from "@codecast/shared/contracts/deployPause";

/** The team's Release Captain: an active role holding the pause authority, `@release` first. */
async function releaseCaptainOf(ctx: any, teamId: Id<"teams">): Promise<Doc<"org_roles"> | null> {
  const now = Date.now();
  const roles: Doc<"org_roles">[] = (await ctx.db.query("org_roles").withIndex("by_team", (q: any) => q.eq("team_id", teamId)).take(200))
    .filter((r: Doc<"org_roles">) => r.status === "active" && (r.authority ?? []).some((a) => a.id === PAUSE_AUTHORITY_ID && (a.expires_at === undefined || a.expires_at > now)));
  return roles.find((r) => r.handle === "release") ?? roles[0] ?? null;
}

export type RollbackResult = {
  deploy: string;
  target: string;
  sha: string;
  task: string;
  ending: "revert" | "fix_forward";
  commits: number;
  migrations: string[];
  cancelled: string[];
};

/**
 * Roll a repository's production back to an earlier live deploy (`of`, else the one before the current), as `by`:
 * pause, queue the rollback behind whatever is going out, cancel what the pause catches, and file what ends it.
 */
export async function rollbackCore(ctx: any, userId: Id<"users">, args: { team_id: Id<"teams">; repository: string; target?: string; of?: string; reason: string; from_session?: string; client_key?: string }): Promise<RollbackResult> {
  const workspace = teamKey(args.team_id);
  const by = await requirePauseHolder(ctx, userId, args.team_id, args.from_session);
  const reason = args.reason.trim();
  if (!reason) throw new Error("Say why production is rolled back (--reason)");
  const targets = (await targetRows(ctx, workspace, args.repository)).filter((t) => sendsThroughGithub(t) && (!args.target || t.name === args.target.toLowerCase()));
  if (targets.length !== 1) throw new Error(targets.length ? `More than one target of ${args.repository} runs a workflow; name the target` : `No target of ${args.repository} names the workflow its deploys run as, so codecast cannot send a rollback`);
  const t = targets[0];

  const asked = await requestTargetDeployCore(ctx, userId, { team_id: args.team_id, target: t.name, repository: t.repository, action: "rollback", ...(args.of ? { of: args.of } : {}), ...(args.client_key ? { client_key: args.client_key } : {}), actor: by.name.split(/\s+/)[0], paused: true });
  const row: Doc<"deploys"> = await ctx.db.get(asked._id as Id<"deploys">);
  // What it takes off production: the commits on main after the commit it puts back, up to what was live.
  const range = row.previous_sha ? await mainCommitsAfter(ctx, t.repository, asked.sha!, row.previous_sha) : { commits: [], known: false };
  const ending = range.known ? rollbackEnding(range.commits.map((c) => ({ files: (c.files ?? []).map((f: any) => f.filename) }))) : { kind: "fix_forward" as const, migrations: [] };
  const lines = range.commits.map((c) => `- ${c.sha.slice(0, 10)} ${c.message.split("\n")[0].slice(0, 120)}`);
  const captain = await releaseCaptainOf(ctx, args.team_id);
  const task = await createTaskAs(ctx, userId, {
    title: ending.kind === "revert" ? `Revert what rollback ${asked.short_id} took off production` : `Fix forward what rollback ${asked.short_id} took off production`,
    description: [
      `${by.name} rolled ${t.repository}'s ${t.name} back to ${asked.sha!.slice(0, 10)} (${asked.short_id}): ${reason}`,
      "",
      ending.kind === "revert"
        ? "End it with a revert of each commit below, merged to main naming this task."
        : range.known
          ? `End it with a fix forward merged to main naming this task: a revert cannot take back the migrations in its range (${ending.migrations.join(", ")}).`
          : "End it with a fix forward merged to main naming this task: codecast could not read the range it took off, so a revert is not known to be safe.",
      "Production stays paused until that commit is green on main, then the pause lifts itself and production deploys again.",
      ...(lines.length ? ["", "Taken off production:", ...lines] : []),
    ].join("\n"),
    team_id: args.team_id,
    workspace: "team",
    priority: "high",
    ...(captain ? { assignee: `@${captain.handle}` } : {}),
  });
  const taskId = ctx.db.normalizeId("tasks", String(task.id)) as Id<"tasks">;

  // A pause already standing is replaced by the rollback's, which says what ends it.
  const standing = await activePauseOf(ctx, workspace, t.repository);
  if (standing) await liftCore(ctx, standing, `rollback ${asked.short_id}`);
  const head = (await mainCommitsAfter(ctx, t.repository, row.previous_sha ?? null)).commits.at(-1)?.sha ?? row.previous_sha ?? asked.sha!;
  await ctx.db.insert("deploy_pauses", {
    workspace,
    team_id: args.team_id,
    repository: t.repository,
    by,
    reason: `Rollback ${asked.short_id}: ${reason}`.slice(0, 500),
    rollback: asked.short_id,
    until: { task_id: taskId, kind: ending.kind, from_sha: head, shas: range.commits.map((c) => c.sha), migrations: ending.migrations },
    created_at: Date.now(),
  });
  const cancelled = await cancelForPause(ctx, workspace, t.repository, by.name, `rolled back: ${reason}`, asked.short_id);
  return { deploy: asked.short_id, target: t.name, sha: asked.sha!, task: task.short_id, ending: ending.kind, commits: range.commits.length, migrations: ending.migrations, cancelled };
}

export const rollback = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), repository: v.string(), target: v.optional(v.string()), of: v.optional(v.string()), reason: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => rollbackFor(ctx, await requireUserOrToken(ctx, args.api_token), args),
});

/** Roll back as the caller (the CLI, the Deploys page): the team it names, else the repository's. */
export async function rollbackFor(ctx: any, userId: Id<"users">, args: { team_id?: Id<"teams">; repository: string; target?: string; of?: string; reason: string; from_session?: string; client_key?: string }): Promise<RollbackResult> {
  const repository = repositoryArg(args.repository);
  const team_id = args.team_id ?? (await deployTeamFor(ctx, userId, repository));
  if (!(await workspaceGrantsAccess(ctx, userId, teamKey(team_id)))) throw new Error("Not a member of that team");
  return await rollbackCore(ctx, userId, { ...args, team_id, repository });
}

// ── what ends a rollback ─────────────────────────────────────────────────────

/** Whether a commit's CI passed on main: the target's CI workflow when it names one (ci.yml), else all of it. */
async function greenOnMain(ctx: any, repository: string, sha: string, ciWorkflow?: string): Promise<boolean> {
  if (!ciWorkflow) return (await ciOf(ctx, repository, sha)).state === "passed";
  const rows: Doc<"commit_ci">[] = await ctx.db.query("commit_ci").withIndex("by_repository_sha", (q: any) => q.eq("repository", repository).eq("sha", sha.toLowerCase())).take(50);
  const newest = rows.filter((r) => r.kind === "workflow" && r.path?.split("/").pop() === ciWorkflow).sort((a, b) => b.started_at - a.started_at)[0];
  return newest?.status === "completed" && newest.conclusion === "success";
}

async function standingPauses(ctx: any, repository?: string): Promise<Doc<"deploy_pauses">[]> {
  const rows: Doc<"deploy_pauses">[] = await ctx.db.query("deploy_pauses").withIndex("by_lifted", (q: any) => q.eq("lifted_at", undefined)).take(200);
  return repository ? rows.filter((p) => p.repository === repository) : rows;
}

/**
 * Lift each rollback's pause whose ending commit is green on main: the first commit on main after the rollback that
 * names its task, once it or a commit after it passed CI (a newer push can cancel the ending commit's own run).
 */
export async function liftEndedPauses(ctx: any, repository?: string): Promise<string[]> {
  const lifted: string[] = [];
  for (const p of await standingPauses(ctx, repository)) {
    if (!p.until) continue;
    const after = await mainCommitsAfter(ctx, p.repository, p.until.from_sha);
    if (!after.known) continue;
    const at = after.commits.findIndex((c) => (c.task_ids ?? []).some((id) => String(id) === String(p.until!.task_id)));
    if (at < 0) continue;
    const targets = await targetRows(ctx, p.workspace, p.repository);
    const ciWorkflow = targets.find((t) => t.ci_workflow)?.ci_workflow;
    for (const c of after.commits.slice(at).reverse()) {
      if (!(await greenOnMain(ctx, p.repository, c.sha, ciWorkflow))) continue;
      await liftCore(ctx, p, "green on main", c.sha);
      for (const t of targets.filter(sendsThroughGithub)) await kickDispatch(ctx, p.workspace, t.name);
      lifted.push(p.repository);
      break;
    }
  }
  return lifted;
}

// ── reminders ────────────────────────────────────────────────────────────────

/**
 * Remind whoever lifts each standing pause, inside the team's working hours and at most every PAUSE_REMIND_MS: a
 * rollback's pause reminds the Release Captain of its task, any other the one who paused.
 */
export async function remindCore(ctx: any, now = Date.now()): Promise<number> {
  let told = 0;
  for (const p of await standingPauses(ctx)) {
    if (now - (p.reminded_at ?? p.created_at) < PAUSE_REMIND_MS) continue;
    if (!inWorkingHours(now, p.team_id ? await teamTimezone(ctx, p.team_id) : "UTC")) continue;
    const view = await pauseViewOf(ctx, p);
    const message = `Production is still paused (${p.repository}): ${p.reason}. ${view.lifts}`;
    const captain = p.until && p.team_id ? await releaseCaptainOf(ctx, p.team_id) : null;
    const roleId = captain?._id ?? (p.by.kind === "role" ? p.by.role_id : undefined);
    if (roleId) await tellRole(ctx, roleId, { content: message, client_id: `production-paused:${p._id}:${now}` });
    else await emitNotification(ctx, { event_type: "production_paused", entity_type: "deploy", entity_id: p.rollback ?? String(p._id), link: "/deploys", message, recipient_ids: [p.by.user_id] });
    await ctx.db.patch(p._id, { reminded_at: now });
    told++;
  }
  return told;
}

/** The pauses' sweep: lift what ended (the backstop for a CI webhook that never came), then remind. */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => ({ lifted: await liftEndedPauses(ctx), reminded: await remindCore(ctx) }),
});
