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

const FLEET_WINDOW_MS = 24 * 3600_000;

export const TEAM_FLOOR_HOLDERS = "the team's admins and its Release Captain (the role holding the team's deploy grant, from its session)";

/** Whether the caller may move the team's floor and read its fleet: a team admin, or the session's role when it is the team's and holds a live deploy grant. */
export async function mayForceTeamFleet(ctx: any, userId: Id<"users">, teamId: Id<"teams">, fromSession?: string, now = Date.now()): Promise<boolean> {
  const m = await ctx.db.query("team_memberships").withIndex("by_user_team", (q: any) => q.eq("user_id", userId).eq("team_id", teamId)).first();
  if (!m) return false;
  if (m.role === "admin") return true;
  const role = fromSession ? await roleForSession(ctx, userId, fromSession).catch(() => null) : null;
  if (!role) return false;
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
    await ctx.db.patch(team._id, { min_cli_version: args.version });
    return { team: team.name, version: args.version, changed: true };
  },
});

type FleetDevice = { device_id: string; label: string; owner: string; cli_version: string | null; online: boolean; error: string | null };

/**
 * Which of the team's machines run `version`: every member's device seen in
 * the last day, split into those that took it, those online and still below
 * it (laggards), those below it and offline (they update when they wake), and
 * those that cannot update themselves (a source checkout, a managed install).
 */
export const fleet = query({
  args: { api_token: v.optional(v.string()), team_id: v.id("teams"), version: v.string(), from_session: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const team = await requireTeamFleet(ctx, args);
    const now = Date.now();
    const members = await ctx.db.query("team_memberships").withIndex("by_team_id", (q: any) => q.eq("team_id", team._id)).collect();
    const out = { team: team.name, version: args.version, floor: team.min_cli_version ?? null, took: [] as FleetDevice[], lagging: [] as FleetDevice[], offline: [] as FleetDevice[], cannot_update: [] as FleetDevice[] };
    for (const m of members) {
      const user = await ctx.db.get(m.user_id);
      const owner = user?.name ?? user?.github_username ?? user?.email ?? "someone";
      const devices = await ctx.db.query("devices").withIndex("by_user_id", (q: any) => q.eq("user_id", m.user_id)).collect();
      for (const d of devices) {
        if (!d.cli_version || now - d.last_seen > FLEET_WINDOW_MS) continue;
        const row: FleetDevice = { device_id: d.device_id, label: d.display_name ?? d.label, owner, cli_version: d.cli_version, online: now - d.last_seen < DEVICE_ONLINE_MS, error: d.update_error ?? null };
        if (!isBelowMinimum(d.cli_version, args.version)) out.took.push(row);
        else if (d.can_self_update === false || d.distribution === "source") out.cannot_update.push(row);
        else if (row.online) out.lagging.push(row);
        else out.offline.push(row);
      }
    }
    return out;
  },
});
