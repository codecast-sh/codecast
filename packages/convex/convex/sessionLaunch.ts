import type { Id } from "./_generated/dataModel";
import { addSessionOwnerRow, isSessionOwner, syncPrimaryOwnerCache } from "./sessionOwners";

export async function listAgentBoxDevices(ctx: { db: any }, userId: Id<"users">) {
  const memberships = await ctx.db.query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId)).collect();
  const boxes: Array<{ device: any; bot: any; teamId: Id<"teams">; canEdit: boolean }> = [];
  for (const membership of memberships) {
    const users = await ctx.db.query("users")
      .withIndex("by_team_id", (q: any) => q.eq("team_id", membership.team_id)).collect();
    for (const bot of users) {
      if (!bot.is_bot || bot._id === userId) continue;
      const devices = await ctx.db.query("devices")
        .withIndex("by_user_id", (q: any) => q.eq("user_id", bot._id)).collect();
      for (const device of devices) {
        boxes.push({ device, bot, teamId: membership.team_id, canEdit: membership.role === "admin" });
      }
    }
  }
  return boxes;
}

export async function resolveSessionLaunchDevice(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId: string,
) {
  const own = await ctx.db.query("devices")
    .withIndex("by_user_device", (q: any) => q.eq("user_id", userId).eq("device_id", deviceId)).first();
  if (own) return own;
  const matches = (await listAgentBoxDevices(ctx, userId)).filter(({ device }) => device.device_id === deviceId);
  if (matches.length > 1) throw new Error("Ambiguous agent box device");
  return matches[0]?.device ?? null;
}

export async function sessionLaunchRunner(
  ctx: { db: any },
  userId: Id<"users">,
  deviceId?: string | null,
): Promise<Id<"users">> {
  if (!deviceId) return userId;
  const device = await resolveSessionLaunchDevice(ctx, userId, deviceId);
  if (!device) throw new Error("Unknown device: choose one of your machines or a team agent box");
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
