// Which chat channels an org role follows (docs/architecture/agent-channels.md
// C1): the rooms whose new lines ride the role's wake frame. Editing the list
// is a role setting, so it takes the ADMIN grant (the host, the personal owner,
// or a team admin), the same bar as renaming or reparenting the role.

import { mutation } from "./functions";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { loadChannel, requireCaller } from "./chat";
import { userCanAdminRole } from "./lib/orgAccess";

// "or-N" or a handle. A handle is looked up in every team the caller belongs
// to, then among the caller's personal roles; an ambiguous handle is an error
// naming the short ids, never a guess.
async function resolveRole(
  ctx: MutationCtx,
  userId: Id<"users">,
  ref: string,
): Promise<Doc<"org_roles">> {
  const trimmed = ref.trim().replace(/^@/, "");
  if (!trimmed) throw new Error("Name a role: its short id (or-N) or its handle");
  if (/^or-\d+$/i.test(trimmed)) {
    const role = await ctx.db
      .query("org_roles")
      .withIndex("by_short_id", (q: any) => q.eq("short_id", trimmed.toLowerCase()))
      .first();
    if (!role || !(await userCanAdminRole(ctx, userId, role))) throw new Error(`Role ${trimmed} not found`);
    return role;
  }
  const handle = trimmed.toLowerCase();
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const found: Doc<"org_roles">[] = [];
  for (const m of memberships) {
    const role = await ctx.db
      .query("org_roles")
      .withIndex("by_team_handle", (q: any) => q.eq("team_id", m.team_id).eq("handle", handle))
      .first();
    if (role && role.status !== "retired" && (await userCanAdminRole(ctx, userId, role))) found.push(role);
  }
  const personal = await ctx.db
    .query("org_roles")
    .withIndex("by_scope_user_handle", (q: any) => q.eq("scope_user_id", userId).eq("handle", handle))
    .first();
  if (personal && personal.status !== "retired") found.push(personal);
  if (found.length === 0) throw new Error(`No role you administer answers to @${handle}`);
  if (found.length > 1) {
    throw new Error(`@${handle} names ${found.length} roles: ${found.map((r) => r.short_id).join(", ")}. Use the short id`);
  }
  return found[0];
}

// A channel id, or "#name" resolved inside the role's team (a personal role
// has no team: pass the id).
async function resolveChannel(
  ctx: MutationCtx,
  userId: Id<"users">,
  role: Doc<"org_roles">,
  ref: string,
): Promise<Doc<"chat_channels">> {
  const trimmed = ref.trim();
  if (trimmed.startsWith("#")) {
    if (!role.team_id) throw new Error("A personal role follows channels by id: cast chat channels prints them");
    const name = trimmed.slice(1).toLowerCase();
    const channel = await ctx.db
      .query("chat_channels")
      .withIndex("by_team_name", (q: any) => q.eq("team_id", role.team_id).eq("name", name))
      .first();
    if (!channel) throw new Error(`No channel #${name} in this team`);
    return await loadChannel(ctx, userId, channel._id);
  }
  const channel = await loadChannel(ctx, userId, trimmed as Id<"chat_channels">);
  if (role.team_id && channel.team_id.toString() !== role.team_id.toString()) {
    throw new Error("That channel belongs to another team");
  }
  return channel;
}

/** Add a channel to a role's follow list (idempotent). Exported so a role
 *  created for a project with a bound channel can follow it at creation. */
export async function followChannelForRole(
  ctx: MutationCtx,
  role: Doc<"org_roles">,
  channelId: Id<"chat_channels">,
): Promise<Id<"chat_channels">[]> {
  const current = role.follow_channel_ids ?? [];
  if (current.some((id) => id.toString() === channelId.toString())) return current;
  const next = [...current, channelId];
  await ctx.db.patch(role._id, { follow_channel_ids: next, updated_at: Date.now() });
  return next;
}

function summary(role: Doc<"org_roles">, channel: Doc<"chat_channels">, follows: Id<"chat_channels">[]) {
  return {
    role_id: role._id,
    short_id: role.short_id,
    handle: role.handle,
    channel_id: channel._id,
    channel_name: channel.name,
    follow_channel_ids: follows,
  };
}

const args = {
  api_token: v.optional(v.string()),
  role: v.string(),
  channel: v.string(),
};

export const follow = mutation({
  args,
  handler: async (ctx, a) => {
    const userId = await requireCaller(ctx, a.api_token);
    const role = await resolveRole(ctx, userId, a.role);
    const channel = await resolveChannel(ctx, userId, role, a.channel);
    if (channel.kind === "dm") throw new Error("A role cannot follow a direct message");
    // A role's bot is never a member of a private room (chatAccess: a private
    // channel never has a bot member), so a follow there could only ever be
    // read through the host's access, which is a leak into the role's frame.
    if (channel.kind === "private") throw new Error("A role cannot follow a private channel");
    return summary(role, channel, await followChannelForRole(ctx, role, channel._id));
  },
});

export const unfollow = mutation({
  args,
  handler: async (ctx, a) => {
    const userId = await requireCaller(ctx, a.api_token);
    const role = await resolveRole(ctx, userId, a.role);
    const channel = await resolveChannel(ctx, userId, role, a.channel);
    const next = (role.follow_channel_ids ?? []).filter((id) => id.toString() !== channel._id.toString());
    if (next.length !== (role.follow_channel_ids ?? []).length) {
      await ctx.db.patch(role._id, { follow_channel_ids: next, updated_at: Date.now() });
    }
    return summary(role, channel, next);
  },
});
