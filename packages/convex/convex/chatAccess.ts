// The ONE access rule for chat rooms, shared by chat.ts (reading, writing,
// notifying) and callRooms.ts (huddling in a channel's room): a public channel
// is readable and writable by the members of its team; a private channel or
// DM additionally requires a membership row — the team check stays underneath
// so leaving the team closes every door at once, even if a membership row
// lingers. `team_id` stays ROUTING on every kind — access never reads it
// alone. Returns false rather than throwing so queries can degrade to an
// empty result.
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isTeamMember } from "./privacy";
import { teamHasFeature } from "./teamFeatures";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Private channels and DMs gate on their member rows; public gates on the team. */
export function isRestricted(channel: Doc<"chat_channels">): boolean {
  return channel.kind === "private" || channel.kind === "dm";
}

export async function isChannelMember(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
  userId: Id<"users">,
): Promise<boolean> {
  const row = await ctx.db
    .query("chat_channel_members")
    .withIndex("by_channel_user", (q: any) =>
      q.eq("channel_id", channelId).eq("user_id", userId))
    .first();
  return !!row;
}

export async function channelMemberIds(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
): Promise<Id<"users">[]> {
  const rows = await ctx.db
    .query("chat_channel_members")
    .withIndex("by_channel", (q: any) => q.eq("channel_id", channelId))
    .collect();
  return rows.map((r) => r.user_id);
}

export async function canAccessChannel(
  ctx: ReadCtx,
  userId: Id<"users">,
  channel: Doc<"chat_channels"> | null,
): Promise<boolean> {
  if (!channel) return false;
  if (!(await isTeamMember(ctx as any, userId, channel.team_id))) return false;
  // Chat is a per-team opt-in: a team that turned it off (or never turned it
  // on) has no readable channels, member or not.
  if (!(await teamHasFeature(ctx as any, channel.team_id, "chat"))) return false;
  if (isRestricted(channel)) {
    if (await isChannelMember(ctx, channel._id, userId)) return true;
    // The anchor's host stands in for the anchor. An anchor is a MEMBER of the
    // DM rooms it opens or is messaged in, but the session that reads and
    // answers there authenticates as the human who hosts it — so that human
    // may enter those rooms too. Their machine runs the anchor and holds the
    // transcript, so this widens nothing they could not already see. Only DM
    // rooms: a private channel never has a bot member.
    if (channel.kind === "dm") return await hostsAnchorIn(ctx, channel._id, userId);
    return false;
  }
  return true;
}

// Is `userId` the host (or personal owner) of an anchor whose bot identity is a
// member of this room?
async function hostsAnchorIn(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
  userId: Id<"users">,
): Promise<boolean> {
  for (const memberId of await channelMemberIds(ctx, channelId)) {
    const member = await ctx.db.get(memberId);
    if (!member?.is_bot) continue;
    const anchor = await ctx.db
      .query("anchors")
      .withIndex("by_bot_user", (q: any) => q.eq("bot_user_id", memberId))
      .first();
    if (!anchor) continue;
    if (anchor.host_user_id.toString() === userId.toString()) return true;
    if (anchor.scope_user_id && anchor.scope_user_id.toString() === userId.toString()) return true;
  }
  return false;
}
