// Production paused (docs/architecture/deploys.md DP17): one record per repository saying who paused it, why, and
// what ends it. While one stands nothing is sent to the repository's targets. Pausing and lifting are a permission
// of their own, separate from any deploy grant: team admins, members an admin granted it, and a role holding the
// pause authority (the Release Captain).

import { v } from "convex/values";
import { mutation, query } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { workspaceGrantsAccess } from "./lib/accessKeys";
import { teamKey } from "./deployTargetsCi";
import { repositoryArg } from "./deployTargetsState";
import { deployTeamFor } from "./changesDeploy";
import { roleForSession } from "./orgRoles";
import { resolveAssigneeToUserId } from "./tasks";
import { PAUSE_AUTHORITY_ID, PAUSE_AUTHORITY_KIND, PAUSE_HOLDERS, type DeployPauseView } from "@codecast/shared/contracts/deployPause";

export type PauseHolder = Doc<"deploy_pauses">["by"];

/** A role's pause grant, when it holds one that has not expired. */
function holdsPauseAuthority(role: Doc<"org_roles"> | null | undefined, now: number): boolean {
  return !!role && role.status === "active" && (role.authority ?? []).some((a) => a.id === PAUSE_AUTHORITY_ID && a.kind === PAUSE_AUTHORITY_KIND && (a.expires_at === undefined || a.expires_at > now));
}

/**
 * Who is pausing, as the pause records them, or null when they hold no pause: the role the calling session speaks for
 * when it holds the pause authority, else a team admin or a member an admin granted it.
 */
export async function pauseHolderOf(ctx: any, userId: Id<"users">, teamId: Id<"teams">, fromSession?: string): Promise<PauseHolder | null> {
  const role = fromSession ? await roleForSession(ctx, userId, fromSession).catch(() => null) : null;
  if (role) {
    const row: Doc<"org_roles"> | null = await ctx.db.get(role.role_id);
    if (row && String(row.team_id) === String(teamId) && holdsPauseAuthority(row, Date.now())) return { kind: "role", name: row.name, user_id: userId, role_id: row._id };
  }
  const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first();
  if (!m || (m.role !== "admin" && !m.production_pause)) return null;
  const user = await ctx.db.get(userId);
  return { kind: "person", name: user?.name ?? user?.github_username ?? user?.email ?? "someone", user_id: userId };
}

export async function requirePauseHolder(ctx: any, userId: Id<"users">, teamId: Id<"teams">, fromSession?: string): Promise<PauseHolder> {
  const holder = await pauseHolderOf(ctx, userId, teamId, fromSession);
  if (!holder) throw new Error(`Pausing, lifting and rolling back production is held by ${PAUSE_HOLDERS}: a team admin grants it (cast line deploy grant <person>)`);
  return holder;
}

/** The pause standing on a repository, if any. */
export async function activePauseOf(ctx: any, workspace: string, repository: string): Promise<Doc<"deploy_pauses"> | null> {
  return await ctx.db
    .query("deploy_pauses")
    .withIndex("by_workspace_repository_lifted", (q: any) => q.eq("workspace", workspace).eq("repository", repository).eq("lifted_at", undefined))
    .first();
}

/** The pause as every reader shows it. */
export async function pauseViewOf(ctx: any, p: Doc<"deploy_pauses">): Promise<DeployPauseView> {
  const task = p.until ? await ctx.db.get(p.until.task_id) : null;
  const sooner = `${p.by.name} or the Release Captain`;
  return {
    repository: p.repository,
    by: p.by.name,
    reason: p.reason,
    at: p.created_at,
    lifts: p.until
      ? `It lifts itself once ${task?.short_id ?? "its task"}'s ${p.until.kind === "revert" ? "revert" : "fix forward"} is green on main; ${sooner} can lift it sooner.`
      : `${sooner} lifts it.`,
    rollback: p.rollback ?? null,
    until: p.until ? { task: task?.short_id ?? null, kind: p.until.kind, migrations: p.until.migrations, commits: p.until.shas.length } : null,
  };
}

/** Refuse a send while the repository is paused (a rollback is the one send a pause lets through). */
export async function refuseWhilePaused(ctx: any, workspace: string, repository: string): Promise<void> {
  const p = await activePauseOf(ctx, workspace, repository);
  if (p) throw new Error(`Production is paused by ${p.by.name}: ${p.reason}. Nothing is sent until it lifts (cast line deploy status)`);
}

/** Pause a repository's production. A standing pause is kept, and says so. */
export async function pauseCore(ctx: any, by: PauseHolder, args: { workspace: string; team_id: Id<"teams">; repository: string; reason: string }): Promise<Doc<"deploy_pauses">> {
  const reason = args.reason.trim();
  if (!reason) throw new Error("Say why production is paused (--reason)");
  const standing = await activePauseOf(ctx, args.workspace, args.repository);
  if (standing) throw new Error(`Production is already paused by ${standing.by.name}: ${standing.reason}`);
  const id = await ctx.db.insert("deploy_pauses", { workspace: args.workspace, team_id: args.team_id, repository: args.repository, by, reason: reason.slice(0, 500), created_at: Date.now() });
  return (await ctx.db.get(id))!;
}

/** Whether `by` may lift `p`: whoever paused it, or the Release Captain (a role holding the pause authority). */
function mayLift(p: Doc<"deploy_pauses">, by: PauseHolder): boolean {
  if (by.kind === "role") return true;
  return p.by.kind === "person" && String(p.by.user_id) === String(by.user_id);
}

export async function liftCore(ctx: any, p: Doc<"deploy_pauses">, liftedBy: string, on?: string): Promise<void> {
  await ctx.db.patch(p._id, { lifted_at: Date.now(), lifted_by: liftedBy, ...(on ? { lifted_on: on } : {}) });
}

/** The team and repository a call means: the team it names, else the repository's. */
async function scopeOf(ctx: any, userId: Id<"users">, args: { team_id?: Id<"teams">; repository: string }): Promise<{ team_id: Id<"teams">; workspace: string; repository: string }> {
  const repository = repositoryArg(args.repository);
  const team_id = args.team_id ?? (await deployTeamFor(ctx, userId, repository));
  const workspace = teamKey(team_id);
  if (!(await workspaceGrantsAccess(ctx, userId, workspace))) throw new Error("Not a member of that team");
  return { team_id, workspace, repository };
}

export const status = query({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), repository: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const s = await scopeOf(ctx, userId, args);
    const p = await activePauseOf(ctx, s.workspace, s.repository);
    return { repository: s.repository, paused: p ? await pauseViewOf(ctx, p) : null, can_pause: !!(await pauseHolderOf(ctx, userId, s.team_id, args.from_session)) };
  },
});

export const pause = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), repository: v.string(), reason: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const s = await scopeOf(ctx, userId, args);
    const by = await requirePauseHolder(ctx, userId, s.team_id, args.from_session);
    return await pauseViewOf(ctx, await pauseCore(ctx, by, { ...s, reason: args.reason }));
  },
});

export const lift = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), repository: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const s = await scopeOf(ctx, userId, args);
    const by = await requirePauseHolder(ctx, userId, s.team_id, args.from_session);
    const p = await activePauseOf(ctx, s.workspace, s.repository);
    if (!p) return { lifted: false, repository: s.repository };
    if (!mayLift(p, by)) throw new Error(`${p.by.name} paused production; they or the Release Captain lift it`);
    await liftCore(ctx, p, by.name);
    return { lifted: true, repository: s.repository };
  },
});

/** A team admin grants (or takes back) a member's pause: founders hold it as admins, engineers by this grant. */
export const grant = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.optional(v.id("teams")), repository: v.string(), person: v.string(), revoke: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const s = await scopeOf(ctx, userId, args);
    const mine = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", s.team_id)).first();
    if (mine?.role !== "admin") throw new Error("Only a team admin grants the production pause");
    const person = await resolveAssigneeToUserId(ctx, args.person.replace(/^@/, ""), s.team_id);
    const m = person ? await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", person).eq("team_id", s.team_id)).first() : null;
    if (!m) throw new Error(`${args.person} is not a member of this team`);
    await ctx.db.patch(m._id, { production_pause: args.revoke ? undefined : true });
    const user = await ctx.db.get(m.user_id);
    return { person: user?.name ?? user?.email ?? args.person, holds: !args.revoke || m.role === "admin" };
  },
});
