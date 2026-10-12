// The roles and sessions inside a chat room (docs/architecture/agent-channels.md
// C5). Anyone who can post in a room may add an agent to it or take one out:
// putting a role in a room is no more than naming it on every line, which any
// teammate may already do, and a session goes in only for someone who may
// already send it messages. What membership does lives in chat.ts
// (deliverToChannelAgents): a person's line reaches every member.

import { mutation } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { chatFail, loadChannel, patchChat, requireCaller } from "./chat";
import { MAX_CHANNEL_AGENTS, channelAgentRows } from "./chatAccess";
import { canSendProductMessage } from "./pendingMessages";
import { isTeamMember } from "./privacy";
import { liveRoleByHandle } from "./lib/orgAccess";
import { findConversationByAnyRefWhere } from "./conversationSessionLookup";

type Agent =
  | { kind: "role"; id: Id<"org_roles">; short_id: string; label: string }
  | { kind: "session"; id: Id<"conversations">; short_id: string; label: string };

function roleAgent(role: Doc<"org_roles">): Agent {
  return { kind: "role", id: role._id, short_id: role.short_id, label: `@${role.handle}` };
}

// A role as or-N, @handle or its id; a session as its short id or id. A role
// answers when it lives in the room's team or is the caller's own; a session
// when the caller may send it messages.
async function resolveAgent(
  ctx: MutationCtx,
  userId: Id<"users">,
  channel: Doc<"chat_channels">,
  ref: string,
): Promise<Agent> {
  const trimmed = ref.trim().replace(/^@/, "");
  if (!trimmed) chatFail("INVALID", "Name a role (@handle or or-N) or a session (its short id)");
  const roleFits = (role: Doc<"org_roles"> | null): role is Doc<"org_roles"> =>
    !!role && role.status !== "retired"
    && ((!!role.team_id && role.team_id.toString() === channel.team_id.toString())
      || (!!role.scope_user_id && role.scope_user_id.toString() === userId.toString()));

  const roleId = ctx.db.normalizeId("org_roles", trimmed);
  if (roleId || /^or-\d+$/i.test(trimmed)) {
    const role = roleId
      ? await ctx.db.get(roleId)
      : await ctx.db.query("org_roles").withIndex("by_short_id", (q: any) => q.eq("short_id", trimmed.toLowerCase())).first();
    if (!roleFits(role)) chatFail("NOT_FOUND", `No role ${trimmed} in this channel's team`);
    return roleAgent(role);
  }

  const conversation = await findConversationByAnyRefWhere(ctx as any, trimmed, (c) => canSendProductMessage(ctx, userId, c));
  if (conversation) {
    const owner = (conversation as any).user_id as Id<"users">;
    // Its replies go out as the person who runs it, who must be able to post here.
    if (!(await isTeamMember(ctx as any, owner, channel.team_id))) {
      chatFail("INVALID", "That session runs for someone outside this channel's team");
    }
    const shortId = (conversation as any).short_id ?? String(conversation._id).slice(0, 7);
    return { kind: "session", id: conversation._id as Id<"conversations">, short_id: shortId, label: shortId };
  }

  const handle = trimmed.toLowerCase();
  const teamRole = await liveRoleByHandle(ctx, { team_id: channel.team_id }, handle);
  if (roleFits(teamRole)) return roleAgent(teamRole);
  const ownRole = await liveRoleByHandle(ctx, { scope_user_id: userId }, handle);
  if (roleFits(ownRole)) return roleAgent(ownRole);
  return chatFail("NOT_FOUND", `No role or session answers to ${ref.trim()}`);
}

function rowFor(rows: Doc<"chat_channel_agents">[], agent: Agent) {
  return rows.find((r) => String(r.role_id ?? r.conversation_id) === String(agent.id));
}

async function openRoom(ctx: MutationCtx, userId: Id<"users">, channelId: Id<"chat_channels">) {
  const channel = await loadChannel(ctx, userId, channelId);
  if (channel.kind === "dm") chatFail("INVALID", "A direct message's members are fixed: make a channel for a group with agents");
  if (channel.kind === "community") chatFail("INVALID", "Agents can't be members of a community channel");
  if (channel.archived_at) chatFail("FORBIDDEN", "This channel is archived");
  return channel;
}

export const addChannelAgents = mutation({
  args: {
    api_token: v.optional(v.string()),
    channel_id: v.id("chat_channels"),
    // or-N, @handle, a role id, a session short id or a conversation id.
    refs: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const channel = await openRoom(ctx, userId, args.channel_id);
    const rows = await channelAgentRows(ctx, channel._id);
    const added: Agent[] = [];
    const already: Agent[] = [];
    const now = Date.now();
    for (const ref of args.refs) {
      const agent = await resolveAgent(ctx, userId, channel, ref);
      if (rowFor(rows, agent) || added.some((a) => a.id === agent.id)) {
        already.push(agent);
        continue;
      }
      if (rows.length + added.length >= MAX_CHANNEL_AGENTS) {
        chatFail("INVALID", `At most ${MAX_CHANNEL_AGENTS} roles and sessions per channel`);
      }
      await ctx.db.insert("chat_channel_agents", {
        channel_id: channel._id,
        ...(agent.kind === "role" ? { role_id: agent.id } : { conversation_id: agent.id }),
        short_id: agent.short_id,
        added_by: userId,
        added_at: now,
      });
      added.push(agent);
    }
    // The rail carries the roster as a derived field: bump the channel so
    // every reader's listChannels re-runs.
    if (added.length > 0) await patchChat(ctx, channel._id, {});
    const view = (a: Agent) => ({ kind: a.kind, id: a.id, short_id: a.short_id, label: a.label });
    return { channel_id: channel._id, channel_name: channel.name, added: added.map(view), already: already.map(view) };
  },
});

export const removeChannelAgent = mutation({
  args: {
    api_token: v.optional(v.string()),
    channel_id: v.id("chat_channels"),
    ref: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await requireCaller(ctx, args.api_token);
    const channel = await loadChannel(ctx, userId, args.channel_id);
    const rows = await channelAgentRows(ctx, channel._id);
    const ref = args.ref.trim().replace(/^@/, "");
    // By id or the copied short id first, so a member whose role retired or
    // whose session the caller can no longer reach still comes out.
    let row = rows.find((r) => String(r.role_id ?? r.conversation_id) === ref || r.short_id === ref.toLowerCase() || r.short_id === ref);
    if (!row) row = rowFor(rows, await resolveAgent(ctx, userId, channel, args.ref));
    if (!row) return { channel_id: channel._id, channel_name: channel.name, removed: false };
    await ctx.db.delete(row._id);
    await patchChat(ctx, channel._id, {});
    return { channel_id: channel._id, channel_name: channel.name, removed: true, short_id: row.short_id };
  },
});
