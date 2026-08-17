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
import { teamFeatureOffMessage, teamHasFeature } from "./teamFeatures";
// Key shapes, builders and lease timings are the shared contract
// (@codecast/shared/contracts/callRoomKeys) so the web client can build keys
// and share staleness math without importing server code. This module adds
// what only the server can: authorization.
import {
  parseRoomKey,
  type ParsedRoomKey,
} from "@codecast/shared/contracts";

export {
  CALL_HEARTBEAT_MS,
  CALL_INVITE_TTL_MS,
  CALL_MEMBER_STALE_MS,
  channelRoomKey,
  dmRoomKey,
  parseRoomKey,
  sessionRoomKey,
  type ParsedRoomKey,
} from "@codecast/shared/contracts";

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
//
// Calls are a per-team opt-in: after the membership rules below pick the
// room's team, the team must have `features.calls` on. This one function is
// every call path's authorization (rooms, rings, tokens, occupancy,
// transcripts), so the feature gate lives here and nowhere else.
export async function authorizeRoom(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
): Promise<RoomAuthorization> {
  const auth = await authorizeRoomMembership(ctx, userId, roomKey);
  if (!auth.ok) return auth;
  if (!(await teamHasFeature(ctx, auth.teamId, "calls"))) {
    return { ok: false, reason: teamFeatureOffMessage("calls") };
  }
  return auth;
}

async function authorizeRoomMembership(
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
