// The ONE access rule for chat rooms, shared by chat.ts (reading, writing,
// notifying) and callRooms.ts (huddling in a channel's room): a public channel
// is readable and writable by the members of its team; a private channel or
// DM additionally requires a membership row — the team check stays underneath
// so leaving the team closes every door at once, even if a membership row
// lingers. A community channel (the public site's rooms) is open to every
// signed-in user, and canReadChannelAnonymously opens it to visitors too.
// `team_id` stays ROUTING on every kind — access never reads it alone.
// Returns false rather than throwing so queries can degrade to an empty
// result.
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { isConversationOwner, isTeamMember } from "./privacy";
import { teamHasFeature } from "./teamFeatures";

type ReadCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

/** Private channels and DMs gate on their member rows; public gates on the team. */
export function isRestricted(channel: Doc<"chat_channels">): boolean {
  return channel.kind === "private" || channel.kind === "dm";
}

/** The product's public rooms: every visitor reads, every signed-in user
 *  writes. The routing team is where they are managed, not who may enter. */
export function isCommunity(channel: Doc<"chat_channels"> | null | undefined): boolean {
  return channel?.kind === "community";
}

/**
 * May someone with NO identity read this room? Only a community channel, and
 * only while it is open — an archived room leaves the public site with the
 * rail. The one place chat answers a question for an anonymous caller;
 * every write still needs a signed-in user.
 */
export function canReadChannelAnonymously(channel: Doc<"chat_channels"> | null): boolean {
  return !!channel && isCommunity(channel) && !channel.archived_at;
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

/** The most roles and sessions one room holds (agent-channels.md C5). */
export const MAX_CHANNEL_AGENTS = 50;

/** The roles and sessions inside a room: chat_channel_agents rows. */
export async function channelAgentRows(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
): Promise<Doc<"chat_channel_agents">[]> {
  return await ctx.db
    .query("chat_channel_agents")
    .withIndex("by_channel", (q: any) => q.eq("channel_id", channelId))
    .take(MAX_CHANNEL_AGENTS);
}

export async function canAccessChannel(
  ctx: ReadCtx,
  userId: Id<"users">,
  channel: Doc<"chat_channels"> | null,
): Promise<boolean> {
  if (!channel) return false;
  // A community room is open to every signed-in user: no team membership, no
  // per-team feature flag. Who may MANAGE it is a separate question the
  // mutations ask of the routing team's admins.
  if (isCommunity(channel)) return true;
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
    // A role or session a member put in a private room reads and answers
    // there as the person who runs it, the same stand-in an anchor's host is
    // for its DM rooms: the lines reach that person's machine anyway.
    return await runsAgentIn(ctx, channel._id, userId);
  }
  return true;
}

// Does `userId` run one of the room's member agents: own the session, or host
// (or personally own) the role's standing agent?
async function runsAgentIn(
  ctx: ReadCtx,
  channelId: Id<"chat_channels">,
  userId: Id<"users">,
): Promise<boolean> {
  for (const row of await channelAgentRows(ctx, channelId)) {
    if (row.conversation_id) {
      const conversation = await ctx.db.get(row.conversation_id);
      if (conversation && (await isConversationOwner(ctx as any, userId, conversation as any))) return true;
    } else if (row.role_id) {
      const role = await ctx.db.get(row.role_id);
      if (role && isRunner(role, userId)) return true;
    }
  }
  return false;
}

// The host or personal owner of an anchor, or of a role (whose standing
// session runs on its host's machine): both rows carry the same two fields.
function isRunner(row: Pick<Doc<"anchors">, "host_user_id" | "scope_user_id">, userId: Id<"users">): boolean {
  return row.host_user_id.toString() === userId.toString()
    || (!!row.scope_user_id && row.scope_user_id.toString() === userId.toString());
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
    if (anchor && isRunner(anchor, userId)) return true;
  }
  return false;
}
