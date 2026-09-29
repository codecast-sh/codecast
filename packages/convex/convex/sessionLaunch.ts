import type { Id } from "./_generated/dataModel";
import { isTeamMember } from "./privacy";
import { addSessionOwnerRow, isSessionOwner, syncPrimaryOwnerCache } from "./sessionOwners";

/**
 * The machines the viewer may start sessions on that are not their own: a
 * team agent box (a device whose daemon signs in as a bot on one of the
 * viewer's teams) and a teammate's machine they shared with one of those
 * teams (device_shares). Either way the session runs under the device's own
 * account and the creator stays an owner (retainSessionCreator).
 *
 * `canEdit` is whether the viewer may annotate the machine (its SSH host): a
 * team admin for an agent box, which has no person behind it; nobody for a
 * teammate's machine, which its owner manages on their own page.
 */
export async function listTeamMachines(ctx: { db: any }, userId: Id<"users">) {
  const memberships = await ctx.db.query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const machines: Array<{ device: any; runner: any; teamId: Id<"teams">; canEdit: boolean }> = [];
  const seen = new Set<string>();
  const add = (device: any, runner: any, teamId: Id<"teams">, canEdit: boolean) => {
    if (seen.has(device._id.toString())) return;
    seen.add(device._id.toString());
    machines.push({ device, runner, teamId, canEdit });
  };
  for (const membership of memberships) {
    const users = await ctx.db.query("users")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", membership.team_id)).collect();
    for (const bot of users) {
      if (!bot.is_bot || bot._id === userId) continue;
      const devices = await ctx.db.query("devices")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", bot._id)).collect();
      for (const device of devices) add(device, bot, membership.team_id, membership.role === "admin");
    }
    const shares = await ctx.db.query("device_shares")
      .withIndex("by_team", (q: any) => q.eq("team_id", membership.team_id)).collect();
    for (const share of shares) {
      if (share.user_id === userId || !(await isTeamMember(ctx, share.user_id, share.team_id))) continue;
      const device = await ctx.db.query("devices")
        .withIndex("by_user_device", (q: any) => q.eq("user_id", share.user_id).eq("device_id", share.device_id)).first();
      const owner = device && await ctx.db.get(share.user_id);
      if (owner) add(device, owner, membership.team_id, false);
    }
  }
  return machines;
}

/**
 * Is this device (not the viewer's own) one of their team machines? The same
 * rule as listTeamMachines, answered for one row without walking the roster,
 * so a subscribed query reads one device's facts and nothing else.
 */
export async function isTeamMachineFor(ctx: { db: any }, userId: Id<"users">, device: any): Promise<boolean> {
  const runner = await ctx.db.get(device.user_id);
  if (!runner) return false;
  if (runner.is_bot) return !!runner.team_id && await isTeamMember(ctx, userId, runner.team_id);
  const shares = await ctx.db.query("device_shares")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", device.user_id).eq("device_id", device.device_id)).collect();
  for (const share of shares) {
    if (await isTeamMember(ctx, userId, share.team_id) && await isTeamMember(ctx, device.user_id, share.team_id)) return true;
  }
  return false;
}

export async function resolveSessionLaunchDevice(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId: string,
) {
  const own = await ctx.db.query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId)).first();
  if (own) return own;
  const matches = (await listTeamMachines(ctx, userId)).filter(({ device }) => device.device_id === deviceId);
  if (matches.length > 1) throw new Error("Ambiguous team machine");
  return matches[0]?.device ?? null;
}

export async function sessionLaunchRunner(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId?: string | null,
): Promise<Id<"users">> {
  if (!deviceId) return userId;
  const device = await resolveSessionLaunchDevice(ctx, userId, deviceId);
  if (!device) throw new Error("Unknown device: choose one of your machines or one your team shares");
  return device.user_id;
}

export async function retainSessionCreator(
  ctx: { db: any },
  conversationId: Id<"conversations">,
  creatorUserId: Id<"users">,
  runnerUserId: Id<"users">,
) {
  if (creatorUserId === runnerUserId) return;
  await addSessionOwnerRow(ctx, conversationId, creatorUserId, creatorUserId);
  await syncPrimaryOwnerCache(ctx, conversationId);
}

export async function findAgentBoxSessionCreatedBy(
  ctx: { db: any },
  sessionId: string,
  creatorUserId: Id<"users">,
) {
  const rows = await ctx.db.query("conversations")
    .withIndex("by_session_id", (q: any) => q.eq("session_id", sessionId)).collect();
  for (const row of rows) {
    if (row.author_user_id === creatorUserId && await isSessionOwner(ctx, row._id, creatorUserId)) return row;
  }
  return null;
}
