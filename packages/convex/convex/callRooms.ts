// Huddle room keys: parsing and authorization, in one place.
//
// A room is a string key, never a row (see call_members in schema.ts). Three
// shapes, each anchored to something the product already scopes:
//   dm:<userA>:<userB>   two people, user ids sorted ascending so both sides
//                        derive the identical key without coordination
//   channel:<channelId>  a chat channel's standing room
//   session:<convId>     a huddle about one conversation/session
//
// Authorization answers "may THIS user join/ring THIS room" and is enforced by
// every calls.* mutation and the token mint — the media server trusts our JWT,
// so this module is the entire security boundary for who can listen in.
import type { Id } from "./_generated/dataModel";
import { createTeamFeedFilter } from "./privacy";

export type ParsedRoomKey =
  | { kind: "dm"; users: [string, string] }
  | { kind: "channel"; channelId: string }
  | { kind: "session"; conversationId: string };

// Convex ids are opaque strings; the parser only enforces shape, never
// existence — the authorizer does the lookups.
export function parseRoomKey(roomKey: string): ParsedRoomKey | null {
  if (typeof roomKey !== "string" || roomKey.length > 200) return null;
  const parts = roomKey.split(":");
  if (parts[0] === "dm" && parts.length === 3) {
    const [, a, b] = parts;
    if (!a || !b || a === b) return null;
    // Canonical order is part of the key's identity: reject the swapped form
    // rather than normalizing it, or the same pair could occupy two rooms.
    if (a > b) return null;
    return { kind: "dm", users: [a, b] };
  }
  if (parts[0] === "channel" && parts.length === 2 && parts[1]) {
    return { kind: "channel", channelId: parts[1] };
  }
  if (parts[0] === "session" && parts.length === 2 && parts[1]) {
    return { kind: "session", conversationId: parts[1] };
  }
  return null;
}

export function dmRoomKey(a: string, b: string): string {
  return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

export function channelRoomKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function sessionRoomKey(conversationId: string): string {
  return `session:${conversationId}`;
}

async function sharedTeam(
  ctx: any,
  a: Id<"users">,
  b: Id<"users">,
): Promise<Id<"teams"> | null> {
  const aMemberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", a))
    .collect();
  for (const m of aMemberships) {
    const other = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) =>
        q.eq("user_id", b).eq("team_id", m.team_id),
      )
      .unique();
    if (other) return m.team_id;
  }
  return null;
}

export type RoomAuthorization =
  | { ok: true; teamId: Id<"teams">; parsed: ParsedRoomKey }
  | { ok: false; reason: string };

// May `userId` participate in `roomKey`? Returns the team the room bills its
// membership rows to (call_members.team_id) so callers never re-derive it.
export async function authorizeRoom(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
): Promise<RoomAuthorization> {
  const parsed = parseRoomKey(roomKey);
  if (!parsed) return { ok: false, reason: "malformed room key" };

  if (parsed.kind === "dm") {
    if (!parsed.users.includes(String(userId))) {
      // Third parties cannot join a DM room even inside the same team.
      return { ok: false, reason: "not a member of this dm" };
    }
    const other = parsed.users[0] === String(userId) ? parsed.users[1] : parsed.users[0];
    const teamId = await sharedTeam(ctx, userId, other as Id<"users">);
    if (!teamId) return { ok: false, reason: "no shared team" };
    return { ok: true, teamId, parsed };
  }

  if (parsed.kind === "channel") {
    const channel = await ctx.db.get(parsed.channelId as Id<"chat_channels">);
    if (!channel || channel.archived_at) {
      return { ok: false, reason: "channel not found" };
    }
    const membership = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_team", (q: any) =>
        q.eq("user_id", userId).eq("team_id", channel.team_id),
      )
      .unique();
    if (!membership) return { ok: false, reason: "not a team member" };
    return { ok: true, teamId: channel.team_id, parsed };
  }

  // session room: the conversation must be visible to this user under the
  // SAME rule the feed uses — owner always; a teammate only when the row is
  // team-visible (team_id is routing, not visibility; privacy.ts owns this).
  const conversation = await ctx.db.get(
    parsed.conversationId as Id<"conversations">,
  );
  if (!conversation) return { ok: false, reason: "conversation not found" };
  if (String(conversation.user_id) === String(userId)) {
    if (!conversation.team_id) {
      return { ok: false, reason: "conversation has no team" };
    }
    return { ok: true, teamId: conversation.team_id, parsed };
  }
  if (!conversation.team_id) {
    return { ok: false, reason: "conversation has no team" };
  }
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) =>
      q.eq("user_id", userId).eq("team_id", conversation.team_id),
    )
    .unique();
  if (!membership) return { ok: false, reason: "not a team member" };
  const feedFilter = await createTeamFeedFilter(ctx, conversation.team_id);
  if (!feedFilter.isVisible(conversation)) {
    return { ok: false, reason: "conversation not team-visible" };
  }
  return { ok: true, teamId: conversation.team_id, parsed };
}
