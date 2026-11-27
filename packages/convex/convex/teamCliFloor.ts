// A team's CLI floor and its fleet (ct-102483). A team forces its own members'
// machines onto a release without platform staff: the floor is set by a team
// admin, or by the team's Release Captain (the role holding the team's deploy
// grant) from its session. The global min_cli_version stays staff-only
// (systemConfig.setMinCliVersion). Every device is held to the highest floor
// that applies to its owner (systemConfig.effectiveMinCliVersion).

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./functions";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireUserOrToken } from "./lib/auth";
import { deployGrantOf } from "./lib/deployAllowance";
import { roleForSession } from "./orgRoles";
import { DEVICE_ONLINE_MS } from "./deviceRouting";
import { isBelowMinimum, isValidVersion, INVALID_VERSION_MESSAGE } from "@platform/flags";
import { getSystemConfig, highestFloor } from "./systemConfig";
import { deployByRef } from "./lib/deployRows";
import { workspaceGrantsAccess } from "./lib/access";
import { liveRoleByHandle } from "./lib/orgAccess";
import { tellRole } from "./pendingMessages";
import { isStaff } from "./lib/staff";
import { parseWorkspaceKey } from "./lib/accessKeys";
import { installationCoversRepo } from "./githubApp";
import { CLI_RELEASE_REPOSITORY } from "@codecast/shared/contracts/deploys";

const FLEET_WINDOW_MS = 24 * 3600_000;

export const TEAM_FLOOR_HOLDERS = "the team's admins and its Release Captain (the role holding the team's deploy grant, from its standing session)";

/** Whether the caller may move the team's floor and read its fleet: a team admin, or the session's role when it is the team's and holds a live deploy grant. */
export async function mayForceTeamFleet(ctx: any, userId: Id<"users">, teamId: Id<"teams">, fromSession?: string, now = Date.now()): Promise<boolean> {
  const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first();
  if (!m) return false;
  if (m.role === "admin") return true;
  const role = fromSession ? await roleForSession(ctx, userId, fromSession).catch(() => null) : null;
  // Only the role's standing session speaks for it: any member can file their
  // own session under a role, which must not hand them the role's grant.
  if (!role?.is_standing) return false;
  const row: Doc<"org_roles"> | null = await ctx.db.get(role.role_id);
  return !!row && String(row.team_id) === String(teamId) && row.status === "active" && !!deployGrantOf(row, now);
}

async function requireTeamFleet(ctx: any, args: { api_token?: string; team_id: Id<"teams">; from_session?: string }): Promise<Doc<"teams">> {
  const userId = await requireUserOrToken(ctx, args.api_token);
  const team: Doc<"teams"> | null = await ctx.db.get(args.team_id);
  if (!team || !(await mayForceTeamFleet(ctx, userId, args.team_id, args.from_session))) {
    throw new Error(`Forcing a team's machines onto a release is held by ${TEAM_FLOOR_HOLDERS}`);
  }
  return team;
}

/** Raise the team's floor. Never lowers it: a finish that lands after a newer release's keeps the newer floor. */
export const set = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), version: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (!isValidVersion(args.version)) throw new Error(INVALID_VERSION_MESSAGE);
    const team = await requireTeamFleet(ctx, args);
    const standing = team.min_cli_version;
    if (standing && !isBelowMinimum(standing, args.version)) return { team: team.name, version: standing, changed: false };
    // Its time: the release sweep reports a machine still below it half an hour on.
    await ctx.db.patch(team._id, { min_cli_version: args.version, min_cli_version_at: Date.now() });
    return { team: team.name, version: args.version, changed: true };
  },
});

/**
 * Lower the team's floor to `version`, or clear it when none is given: a team
 * admin's alone (the Release Captain only raises). The way back from a floor
 * set past every published release, which no machine can reach.
 */
export const lower = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), version: v.optional(v.string()) },
  handler: async (ctx, args) => {
    if (args.version !== undefined && !isValidVersion(args.version)) throw new Error(INVALID_VERSION_MESSAGE);
    const userId = await requireUserOrToken(ctx, args.api_token);
    const team: Doc<"teams"> | null = await ctx.db.get(args.team_id);
    const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", args.team_id)).first();
    if (!team || m?.role !== "admin") throw new Error("Lowering or clearing a team's CLI floor is held by the team's admins");
    const standing = team.min_cli_version ?? null;
    if (!standing || (args.version && !isBelowMinimum(args.version, standing))) return { team: team.name, version: standing, changed: false };
    await ctx.db.patch(team._id, args.version ? { min_cli_version: args.version, min_cli_version_at: Date.now() } : { min_cli_version: undefined, min_cli_version_at: undefined });
    return { team: team.name, version: args.version ?? null, changed: true };
  },
});

/**
 * The release a deploy's team machines were last forced onto: the floor they
 * are held to (the team's floor raised by the global one, else the global
 * one) and the sha of the live deploy of the same target that went out as
 * that version. The finish compares the daemon against that sha, not the
 * release just before, so a release that skipped its force is made up by the
 * next one that changes the daemon (releaseFinish.ts). `sha` null when no
 * such deploy is recorded.
 */
export const forcedRelease = query({
  args: { api_token: v.optional(v.string()), deploy: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await deployByRef(ctx, args.deploy);
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) return null;
    const team: Doc<"teams"> | null = d.team_id ? await ctx.db.get(d.team_id) : null;
    const global = await getSystemConfig(ctx, "min_cli_version");
    const floor = highestFloor([global, team?.min_cli_version]);
    const rows: Doc<"deploys">[] = await ctx.db.query("deploys").withIndex("by_workspace_target_created", (q: any) => q.eq("workspace", d.workspace).eq("target", d.target)).order("desc").take(FORCED_RELEASE_READ);
    for (const version of [...new Set([floor, global])]) {
      const hit = version ? rows.find((r) => r.status === "live" && r.version === version && r.sha) : undefined;
      if (hit) return { floor: version, sha: hit.sha!, deploy: hit.short_id };
    }
    return { floor, sha: null, deploy: null };
  },
});
const FORCED_RELEASE_READ = 200;

/**
 * Tell the team's Release Captain (@release) what a release's finish left
 * undone: the force it could not make (`not_forced` set), or else the team's
 * machines still online and below the release after the finish's wait. Any
 * member may: the finish runs as whoever shipped. The message lands in the
 * captain's session labelled as codecast, so it carries only what the server
 * read itself: the deploy must be a live `cli` deploy in this team's workspace
 * that the caller can read, its version and id come from that row, a refused
 * force says only that the floor was not raised (`not_forced`'s text, the
 * CLI's refusal, is not repeated), and laggards are counted and named by
 * their device rows' ids, never by the labels, owners' names, versions or
 * errors members' machines wrote. Sent as the caller (from_user_id says who),
 * once per deploy and kind. `told` is the role's handle, or null when
 * no @release can be reached or there is nothing to say.
 */
export const tellRelease = mutation({
  // `version` and the text of `not_forced` are read from the deploy and ignored; running CLIs still send them.
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), deploy: v.string(), version: v.optional(v.string()), not_forced: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await deployByRef(ctx, args.deploy);
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) throw new Error(`No deploy ${args.deploy} you can read`);
    const ws = parseWorkspaceKey(d.workspace);
    if (ws?.type !== "team" || String(ws.teamId) !== String(args.team_id)) throw new Error(`${d.short_id} is not a deploy of this team`);
    if (d.target !== "cli" || d.status !== "live" || !d.version || !RELEASE_VERSION.test(d.version)) throw new Error(`${d.short_id} is not a live CLI release`);
    if (args.version !== undefined && args.version !== d.version) throw new Error(`${d.short_id} is release ${d.version}, not ${args.version}`);
    const team: Doc<"teams"> | null = await ctx.db.get(ws.teamId);
    if (!team) throw new Error(`${d.short_id}'s team is gone`);
    const role = await liveRoleByHandle(ctx, { team_id: team._id }, RELEASE_HANDLE);
    if (!role) return { told: null };
    const version = d.version;
    let content: string;
    // The caller is named by from_user_id, never by a name in the text.
    if (args.not_forced !== undefined) {
      content = `${d.short_id}: release ${version} changed the daemon, but your team's machines were not forced onto it: the finish its sender ran could not raise the floor. Raise it with cast force-update ${version} --team ${team._id}.`;
    } else {
      const lagging = (await teamFleet(ctx, team, version, Date.now())).lagging;
      if (!lagging.length) return { told: null };
      // Device rows' ids and checked versions only: labels, owners' names and update errors are what members' machines wrote.
      const ids = lagging.slice(0, 20).map((m) => `${m.id} (${shownVersion(m.cli_version)})`).join(", ");
      content = `${d.short_id}: ${lagging.length} of your team's machines are online and still below ${version} after the release's wait: ${ids}${lagging.length > 20 ? ", ..." : ""}. The deploy's note names them: cast line deploy show ${d.short_id}`;
    }
    const sent = await tellRole(ctx, role._id, { content, from_user_id: userId, client_id: `team-cli-floor:${d.short_id}:${args.not_forced !== undefined ? "not-forced" : "lagging"}` });
    return { told: sent ? role.handle : null };
  },
});
const RELEASE_HANDLE = "release";

/** A version a message to a role may carry: x.y.z, else "unknown" (a heartbeat's cli_version is the machine's own string). */
const shownVersion = (v: string | null | undefined) => (v && RELEASE_VERSION.test(v) ? v : "unknown");

/**
 * A release that changes the daemon, finished without raising the global
 * floor, forces only the deploy's own team. Forcing another team's machines
 * is that team's Release Captain's call, so each other team whose members'
 * machines (seen in the last day) run older, and whose floor is below the
 * release, has its @release told once per deploy with the command to do it.
 * It writes into every other team's inbox, so only codecast's own CLI
 * release may ask: a `cli` deploy of CLI_RELEASE_REPOSITORY in a team
 * workspace whose team holds a GitHub App installation on that repository
 * (an install GitHub confirmed, where a deploy target's repository is only
 * what its publisher claimed), or any deploy when platform staff ask. The
 * message carries only the checked version, the deploy's id and the told
 * team's own id and numbers (a team's name is admin-written free text). Each team's fleet is read in a mutation of its
 * own (tellOtherTeam), so no one transaction reads every team's machines; the
 * caller learns only how many teams are being checked (`asked`).
 */
export const tellOtherTeams = mutation({
  args: { api_token: v.optional(v.string()), deploy: v.string(), version: v.string() },
  handler: async (ctx, args) => {
    if (!RELEASE_VERSION.test(args.version)) throw new Error(`${args.version} is not a release version (x.y.z)`);
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await deployByRef(ctx, args.deploy);
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) throw new Error(`No deploy ${args.deploy} you can read`);
    if (d.target !== "cli" || d.status !== "live" || d.version !== args.version) throw new Error(`${args.deploy} is not the live CLI release ${args.version}`);
    if (!isStaff(await ctx.db.get(userId)) && !(await isCodecastCliRelease(ctx, d))) {
      throw new Error(`${d.short_id} is not a release of codecast's CLI (${CLI_RELEASE_REPOSITORY}, from a team whose GitHub App installation covers it)`);
    }
    const global = await getSystemConfig(ctx, "min_cli_version");
    if (global && !isBelowMinimum(global, args.version)) return { asked: 0 };
    let asked = 0;
    // Only teams with a @release can be told: read those roles, never every team.
    const roles: Doc<"org_roles">[] = await ctx.db.query("org_roles").withIndex("by_handle", (q: any) => q.eq("handle", RELEASE_HANDLE)).take(OTHER_TEAMS_MAX + 1);
    if (roles.length > OTHER_TEAMS_MAX) console.warn(`[teamCliFloor.tellOtherTeams] ${d.short_id}: more than ${OTHER_TEAMS_MAX} @release roles; only the first ${OTHER_TEAMS_MAX} are read`);
    const seen = new Set<string>();
    for (const role of roles.slice(0, OTHER_TEAMS_MAX)) {
      if (!role.team_id || role.status === "retired" || seen.has(String(role.team_id))) continue;
      seen.add(String(role.team_id));
      if (d.team_id && String(role.team_id) === String(d.team_id)) continue;
      const team: Doc<"teams"> | null = await ctx.db.get(role.team_id);
      if (!team) continue;
      const floor = highestFloor([global, team.min_cli_version]);
      if (floor && !isBelowMinimum(floor, args.version)) continue;
      await ctx.scheduler.runAfter(0, internal.teamCliFloor.tellOtherTeam, { role_id: role._id, deploy: d.short_id, version: args.version });
      asked++;
    }
    return { asked };
  },
});

/** One other team's @release told of a release its machines run older than (tellOtherTeams checked the ask). */
export const tellOtherTeam = internalMutation({
  args: { role_id: v.id("org_roles"), deploy: v.string(), version: v.string() },
  handler: async (ctx, args) => {
    const role: Doc<"org_roles"> | null = await ctx.db.get(args.role_id);
    const team: Doc<"teams"> | null = role?.team_id ? await ctx.db.get(role.team_id) : null;
    if (!role || !team) return;
    // Read again: the floors may have moved since the ask.
    const floor = highestFloor([await getSystemConfig(ctx, "min_cli_version"), team.min_cli_version]);
    if (floor && !isBelowMinimum(floor, args.version)) return;
    const f = await teamFleet(ctx, team, args.version, Date.now());
    const older = f.lagging.length + f.offline.length;
    if (!older) return;
    const content = `CLI release ${args.version} (${args.deploy}) changes the running daemon. Your team's floor is ${floor ? shownVersion(floor) : "unset"}, and ${older} of its machines seen in the last day run older. Forcing them restarts each daemon and is your call: cast force-update ${args.version} --team ${team._id}`;
    await tellRole(ctx, role._id, { content, client_id: `team-cli-floor:${args.deploy}:${team._id}` });
  },
});
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
const OTHER_TEAMS_MAX = 200;

/** A deploy of codecast's own CLI release: of CLI_RELEASE_REPOSITORY, in a team workspace whose team's GitHub App installation covers that repository. */
async function isCodecastCliRelease(ctx: any, d: Doc<"deploys">): Promise<boolean> {
  if (d.repository?.toLowerCase() !== CLI_RELEASE_REPOSITORY) return false;
  const ws = parseWorkspaceKey(d.workspace);
  if (ws?.type !== "team") return false;
  const installs: Doc<"github_app_installations">[] = await ctx.db.query("github_app_installations").withIndex("by_team_id", (q: any) => q.eq("team_id", ws.teamId)).collect();
  return installs.some((i) => installationCoversRepo(i, CLI_RELEASE_REPOSITORY));
}

export type FleetDevice = { id: Id<"devices">; device_id: string; label: string; owner: string; user_id: Id<"users">; cli_version: string | null; online: boolean; error: string | null };

/**
 * Which of the team's machines run `version`: every member's device seen in
 * the last day, split into those that took it, those online and still below
 * it (laggards), those below it and offline (they update when they wake), and
 * those that cannot update themselves (a source checkout, a managed install).
 */
export const fleet = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), version: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => teamFleet(ctx, await requireTeamFleet(ctx, args), args.version, Date.now()),
});

/** The fleet read itself, unguarded: `fleet` checks the caller, the release sweep (releaseSweep.ts) reads its own team's. */
export async function teamFleet(ctx: any, team: Doc<"teams">, version: string, now: number) {
  // Bounded, so one team's read stays far inside a transaction's read limit (about 6.6k documents at most).
  const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team._id)).take(FLEET_MEMBERS_MAX);
  if (members.length === FLEET_MEMBERS_MAX) console.warn(`[teamCliFloor.teamFleet] ${team.name}: only the first ${FLEET_MEMBERS_MAX} members' machines are read`);
  const out = { team: team.name, version, floor: team.min_cli_version ?? null, took: [] as FleetDevice[], lagging: [] as FleetDevice[], offline: [] as FleetDevice[], cannot_update: [] as FleetDevice[] };
  for (const m of members) {
    const user = await ctx.db.get(m.user_id);
    const owner = user?.name ?? user?.github_username ?? user?.email ?? "someone";
    // Newest registrations first: a machine still in use is rarely a member's oldest.
    const devices = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", m.user_id)).order("desc").take(FLEET_DEVICES_PER_MEMBER);
    for (const d of devices) {
      if (!d.cli_version || now - d.last_seen > FLEET_WINDOW_MS) continue;
      const row: FleetDevice = { id: d._id, device_id: d.device_id, label: d.display_name ?? d.label, owner, user_id: m.user_id, cli_version: d.cli_version, online: now - d.last_seen < DEVICE_ONLINE_MS, error: d.update_error ?? null };
      if (!isBelowMinimum(d.cli_version, version)) out.took.push(row);
      // Automatic update off: it waits for someone to press Update, so it is not lagging.
      else if (d.can_self_update === false || d.distribution === "source" || d.settings?.auto_update === false) out.cannot_update.push(row);
      else if (row.online) out.lagging.push(row);
      else out.offline.push(row);
    }
  }
  return out;
}
const FLEET_MEMBERS_MAX = 300;
const FLEET_DEVICES_PER_MEMBER = 20;
