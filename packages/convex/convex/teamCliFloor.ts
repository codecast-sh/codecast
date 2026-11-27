// A team's CLI floor and its fleet (ct-102483). A team forces its own members'
// machines onto a release without platform staff: the floor is set by a team
// admin, or by the team's Release Captain (the role holding the team's deploy
// grant) from its session. The global min_cli_version stays staff-only
// (systemConfig.setMinCliVersion). Every device is held to the highest floor
// that applies to its owner (systemConfig.effectiveMinCliVersion).

import { v } from "convex/values";
import { mutation, query } from "./functions";
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
 * undone: the force it could not make (`not_forced`, the refusal), or else the
 * team's machines still online and below `version` after the finish's wait.
 * Any member may: the finish runs as whoever shipped. Once per deploy and
 * kind. `told` is the role's handle, or null when no @release can be reached
 * or there is nothing to say.
 */
export const tellRelease = mutation({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), deploy: v.string(), version: v.string(), not_forced: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const team: Doc<"teams"> | null = await ctx.db.get(args.team_id);
    const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", args.team_id)).first();
    if (!team || !m) throw new Error("Only a member of the team can tell its Release Captain");
    const role = await liveRoleByHandle(ctx, { team_id: team._id }, RELEASE_HANDLE);
    if (!role) return { told: null };
    let content: string;
    if (args.not_forced) {
      content = `${args.deploy}: release ${args.version} changed the daemon, but ${team.name}'s machines were not forced onto it: ${args.not_forced.slice(0, 300)}. Raise the floor with cast force-update ${args.version} --team ${team.name}.`;
    } else {
      const lagging = (await teamFleet(ctx, team, args.version, Date.now())).lagging;
      if (!lagging.length) return { told: null };
      const named = lagging.slice(0, 20).map((d) => `${d.label} (${d.owner}, ${d.cli_version ?? "?"}${d.error ? `: ${d.error.slice(0, 120)}` : ""})`).join(", ");
      content = `${args.deploy}: ${lagging.length} of ${team.name}'s machines are online and still below ${args.version} after the release's wait: ${named}.`;
    }
    const sent = await tellRole(ctx, role._id, { content, client_id: `team-cli-floor:${args.deploy}:${args.not_forced ? "not-forced" : "lagging"}` });
    return { told: sent ? role.handle : null };
  },
});
const RELEASE_HANDLE = "release";

/**
 * A release that changes the daemon, finished without raising the global
 * floor, forces only the deploy's own team. Forcing another team's machines
 * is that team's Release Captain's call, so each other team whose members'
 * machines (seen in the last day) run older, and whose floor is below the
 * release, has its @release told once per deploy with the command to do it.
 * Whoever may read the deploy may ask: they learn only how many teams were
 * told, never which or what their machines run.
 */
export const tellOtherTeams = mutation({
  args: { api_token: v.optional(v.string()), deploy: v.string(), version: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUserOrToken(ctx, args.api_token);
    const d = await deployByRef(ctx, args.deploy);
    if (!d || !(await workspaceGrantsAccess(ctx, userId, d.workspace))) throw new Error(`No deploy ${args.deploy} you can read`);
    if (d.target !== "cli" || d.version !== args.version) throw new Error(`${args.deploy} is not the CLI release ${args.version}`);
    const global = await getSystemConfig(ctx, "min_cli_version");
    if (global && !isBelowMinimum(global, args.version)) return { told: 0 };
    const now = Date.now();
    let told = 0;
    for (const team of (await ctx.db.query("teams").collect()) as Doc<"teams">[]) {
      if (d.team_id && String(team._id) === String(d.team_id)) continue;
      const floor = highestFloor([global, team.min_cli_version]);
      if (floor && !isBelowMinimum(floor, args.version)) continue;
      const role = await liveRoleByHandle(ctx, { team_id: team._id }, RELEASE_HANDLE);
      if (!role) continue;
      const f = await teamFleet(ctx, team, args.version, now);
      const older = f.lagging.length + f.offline.length;
      if (!older) continue;
      const name = /^[\w.-]+$/.test(team.name) ? team.name : JSON.stringify(team.name);
      const content = `CLI release ${args.version} (${args.deploy}) changes the running daemon. ${team.name}'s floor is ${floor ?? "unset"}, and ${older} of its machines seen in the last day run older. Forcing them restarts each daemon and is your call: cast force-update ${args.version} --team ${name}`;
      if (await tellRole(ctx, role._id, { content, client_id: `team-cli-floor:${d.short_id}:${team._id}` })) told++;
    }
    return { told };
  },
});

export type FleetDevice = { device_id: string; label: string; owner: string; user_id: Id<"users">; cli_version: string | null; online: boolean; error: string | null };

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
  const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team._id)).collect();
  const out = { team: team.name, version, floor: team.min_cli_version ?? null, took: [] as FleetDevice[], lagging: [] as FleetDevice[], offline: [] as FleetDevice[], cannot_update: [] as FleetDevice[] };
  for (const m of members) {
    const user = await ctx.db.get(m.user_id);
    const owner = user?.name ?? user?.github_username ?? user?.email ?? "someone";
    const devices = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", m.user_id)).collect();
    for (const d of devices) {
      if (!d.cli_version || now - d.last_seen > FLEET_WINDOW_MS) continue;
      const row: FleetDevice = { device_id: d.device_id, label: d.display_name ?? d.label, owner, user_id: m.user_id, cli_version: d.cli_version, online: now - d.last_seen < DEVICE_ONLINE_MS, error: d.update_error ?? null };
      if (!isBelowMinimum(d.cli_version, version)) out.took.push(row);
      // Automatic update off: it waits for someone to press Update, so it is not lagging.
      else if (d.can_self_update === false || d.distribution === "source" || d.settings?.auto_update === false) out.cannot_update.push(row);
      else if (row.online) out.lagging.push(row);
      else out.offline.push(row);
    }
  }
  return out;
}
