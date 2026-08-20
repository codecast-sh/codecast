// Huddle room keys: parsing and authorization, in one place.
//
// A room is a string key, never a row (see call_members in schema.ts). Three
// shapes, each anchored to something the product already scopes:
//   dm:<id>:<id>[:<id>…] a set of people (two or more), user ids sorted
//                        ascending so every side derives the identical key
//                        without coordination; a chat DM or group thread
//                        huddles in the room of its member set
//   channel:<channelId>  a chat channel's standing room (private channels
//                        admit their members only)
//   session:<convId>     a huddle about one conversation/session
//
// Membership is not the only door. An accepted ring is a GRANT: whoever a
// member rang into a room may join it while THAT huddle still runs, whether
// or not they belong to its anchor. That is how "add people" works the same
// way in a 1:1, a private channel and a session huddle. A huddle "still
// runs" while the room has stayed occupied since the ring was answered —
// joinRoom expires a room's accepted invites whenever the room restarts from
// empty, so a guest cannot come back later to an empty private room or slip
// into the NEXT huddle held in the same room.
//
// Authorization answers "may THIS user join/ring THIS room" and is enforced by
// every calls.* mutation and the token mint — the media server trusts our JWT,
// so this module is the entire security boundary for who can listen in.
import type { Doc, Id } from "./_generated/dataModel";
import { createTeamFeedFilter, isTeamMember } from "./privacy";
import { canAccessChannel } from "./chatAccess";
import { teamFeatureOffMessage, teamHasFeature } from "./teamFeatures";
// Key shapes, builders and lease timings are the shared contract
// (@codecast/shared/contracts/callRoomKeys) so the web client can build keys
// and share staleness math without importing server code. This module adds
// what only the server can: authorization.
import {
  CALL_MEMBER_STALE_MS,
  parseRoomKey,
  type ParsedRoomKey,
} from "@codecast/shared/contracts";

export {
  CALL_HEARTBEAT_MS,
  CALL_INVITE_TTL_MS,
  CALL_MEMBER_STALE_MS,
  MAX_ROOM_MEMBERS,
  channelRoomKey,
  chatRoomKey,
  dmRoomKey,
  parseRoomKey,
  roomMemberIds,
  sessionRoomKey,
  type ParsedRoomKey,
} from "@codecast/shared/contracts";

/** The lease is the truth: a row older than the stale window is not in the
 *  room, whatever else it says. One filter for every reader (occupancy,
 *  getMyCalls, the grant, the presence strip). */
export function liveMembers<T extends { last_seen: number }>(rows: T[], now: number): T[] {
  return rows.filter((m) => now - m.last_seen < CALL_MEMBER_STALE_MS);
}

// A team every one of `users` belongs to, walking the first user's
// memberships. A people room bills its rows to that team; a set with no
// common team has no room.
async function sharedTeam(
  ctx: any,
  users: Id<"users">[],
): Promise<Id<"teams"> | null> {
  const [first, ...rest] = users;
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", first))
    .collect();
  for (const m of memberships) {
    let all = true;
    for (const other of rest) {
      if (!(await isTeamMember(ctx, other, m.team_id))) { all = false; break; }
    }
    if (all) return m.team_id;
  }
  return null;
}

// The invite grant: a ring into this room that the user accepted, for a
// huddle that is still running. "Still running" is anchored to the room's
// OWN people: some live occupant other than the guest must themselves pass
// the membership rules — guests cannot keep each other's grants alive, so a
// room the members have all left winds down instead of persisting as a
// members-free huddle inside someone's private room. joinRoom additionally
// expires a room's accepted invites when the room restarts from empty. The
// guest must also still be on the team the invite billed to — removal from
// the team closes this door like every other. Returns that team so the
// guest's own membership row lands in the same team as everyone else's.
async function acceptedInviteGrant(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
): Promise<Id<"teams"> | null> {
  const invites = await ctx.db
    .query("call_invites")
    .withIndex("by_to_room", (q: any) =>
      q.eq("to_user", userId).eq("room_key", roomKey),
    )
    .collect();
  const accepted = invites
    .filter((i: Doc<"call_invites">) => i.status === "accepted")
    .sort((a: Doc<"call_invites">, b: Doc<"call_invites">) =>
      (b.responded_at ?? 0) - (a.responded_at ?? 0),
    )[0];
  if (!accepted) return null;
  if (!(await isTeamMember(ctx, userId, accepted.team_id))) return null;
  const rows: Doc<"call_members">[] = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  const others = liveMembers(rows, Date.now()).filter(
    (m) => String(m.user_id) !== String(userId),
  );
  for (const m of others) {
    if ((await authorizeRoomMembership(ctx, m.user_id, roomKey)).ok) {
      return accepted.team_id;
    }
  }
  return null;
}

/** joinRoom calls this when it finds the room EMPTY (no live rows): the next
 *  seat starts a NEW huddle, so every grant issued for the previous one dies
 *  here. Guests still inside a running huddle never hit this — the room is
 *  not empty while they (or anyone) hold a fresh lease. */
export async function expireRoomGrants(ctx: any, roomKey: string): Promise<void> {
  const invites = await ctx.db
    .query("call_invites")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  for (const inv of invites) {
    // "cancelled", not "expired": expired is the caller-visible "no answer"
    // settle (getMyCalls shows it for 30s); a grant quietly used up by its
    // huddle ending is nobody's news.
    if (inv.status === "accepted") {
      await ctx.db.patch(inv._id, { status: "cancelled" });
    }
  }
}

export type RoomAuthorization =
  | { ok: true; teamId: Id<"teams">; parsed: ParsedRoomKey }
  | { ok: false; reason: string };

/** Room access WITHOUT the invite grant: membership rules + the feature
 *  gate. Call history reads use this — a grant admits its guest to the
 *  running huddle, never to everything the room ever recorded. */
export async function authorizeRoomNoGrant(
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
  let auth = await authorizeRoomMembership(ctx, userId, roomKey);
  if (!auth.ok) {
    const parsed = parseRoomKey(roomKey);
    if (!parsed) return auth;
    const granted = await acceptedInviteGrant(ctx, userId, roomKey);
    if (!granted) return auth;
    auth = { ok: true, teamId: granted, parsed };
  }
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
      // Third parties cannot join a people room even inside the same team.
      return { ok: false, reason: "not a member of this dm" };
    }
    const teamId = await sharedTeam(ctx, parsed.users as Id<"users">[]);
    if (!teamId) return { ok: false, reason: "no shared team" };
    return { ok: true, teamId, parsed };
  }

  if (parsed.kind === "channel") {
    const channel = await ctx.db.get(parsed.channelId as Id<"chat_channels">);
    if (!channel || channel.archived_at) {
      return { ok: false, reason: "channel not found" };
    }
    // The chat room's own gate: team member, chat on for the team, and a
    // membership row for private channels and group threads.
    if (!(await canAccessChannel(ctx, userId, channel))) {
      return { ok: false, reason: "not a member of this channel" };
    }
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
