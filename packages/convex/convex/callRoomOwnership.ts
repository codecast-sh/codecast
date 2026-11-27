// Who a call room belongs to: the teams that can hold a person's calls, and
// whether a room is one person's alone (a people room of one, or a session the
// team cannot read). The owner-only rules the room door, the call record and a
// session room's own route all read.
import type { Doc, Id } from "./_generated/dataModel";
import { parseRoomKey, sessionRoomConversationId } from "@codecast/shared/contracts";
import { getOwnerMembership, isConversationTeamVisibleSync } from "./privacy";
import { effectiveMembershipVisibility } from "./teamVisibility";
import { teamHasFeature } from "./teamFeatures";
import { featureVendorRefusal } from "./lib/vendorGuard";

/** The caller's teams that can hold calls (calls on, no vendor refusal), in
 *  membership order, and why the vendor guard refuses each other team that
 *  has calls on. calls.getCallConfig hands both to the client; a room that
 *  belongs to one person borrows its billing team from the first list. */
export async function callTeamsOf(
  ctx: any,
  userId: Id<"users">,
): Promise<{ teams: Id<"teams">[]; off: Record<string, string> }> {
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .collect();
  const teams: Id<"teams">[] = [];
  const off: Record<string, string> = {};
  for (const m of memberships) {
    if (!(await teamHasFeature(ctx, m.team_id, "calls"))) continue;
    // A regulated team's calls stay off while LiveKit has no BAA.
    const vendorOff = await featureVendorRefusal(ctx, m.team_id, "calls");
    if (vendorOff) off[String(m.team_id)] = vendorOff;
    else teams.push(m.team_id);
  }
  return { teams, off };
}

/** Is this room one person's alone, rather than one the team may walk into?
 *  A people room of one is its person's. A session room is its owner's while
 *  the team cannot read the conversation: no team, an owner no longer on that
 *  team, or a row the team feed hides (the rule authorizeRoomMembership admits
 *  teammates by). A session room whose conversation is gone fails closed.
 *  Read wherever a private huddle's flag is read: the open door, the
 *  inviter's seat, the record's `private` stamp, the call board's workspace. */
export async function isOwnerOnlyRoom(ctx: any, roomKey: string): Promise<boolean> {
  const parsed = parseRoomKey(roomKey);
  if (parsed?.kind === "dm") return parsed.users.length === 1;
  if (parsed?.kind !== "session") return false;
  const conversation = await ctx.db.get(parsed.conversationId as Id<"conversations">);
  return !conversation || (await sessionIsOwnerOnly(ctx, conversation));
}

/** The team feed's visibility rule (createTeamFeedFilter.isVisible) for one
 *  conversation, from its owner's one membership row instead of the team's
 *  whole roster: this runs per room on team-wide subscriptions. */
export async function sessionIsOwnerOnly(ctx: any, conversation: Doc<"conversations">): Promise<boolean> {
  if (!conversation.team_id) return true;
  const membership = await getOwnerMembership(ctx, conversation.user_id, conversation.team_id);
  if (!membership) return true;
  return !isConversationTeamVisibleSync(conversation, effectiveMembershipVisibility(membership, conversation.started_at));
}

/** Who a session room's own route speaks as (deliverRoutes sends a route's
 *  words as its added_by). In a room that is the session owner's alone, the
 *  owner: a guest rung in who begins the record cannot write to the owner's
 *  private session, which would refuse every live chunk. Elsewhere, whoever
 *  turned the words on, as before. */
export async function ownRouteAdder(ctx: any, roomKey: string, fallback: Id<"users">): Promise<Id<"users">> {
  const own = sessionRoomConversationId(roomKey);
  if (!own || !(await isOwnerOnlyRoom(ctx, roomKey))) return fallback;
  const conversation = await ctx.db.get(own as Id<"conversations">);
  return conversation?.user_id ?? fallback;
}

/** In a room that is a session owner's alone, that session's own route is
 *  the owner's to take off: it is their door to the record (canReadCall), so
 *  a guest who scribes after a handover cannot shut them out of it. A dead
 *  session's route still leaves through dropDeadRoute. */
export async function assertMayDropOwnRoute(ctx: any, t: Doc<"transcripts">, userId: Id<"users">, kind: string, target: string): Promise<void> {
  const own = sessionRoomConversationId(t.room_key);
  if (kind !== "session" || target !== own || !(await isOwnerOnlyRoom(ctx, t.room_key))) return;
  const conversation = await ctx.db.get(own as Id<"conversations">);
  if (String(conversation?.user_id) !== String(userId)) throw new Error("Only the session's owner can take its own route off");
}
