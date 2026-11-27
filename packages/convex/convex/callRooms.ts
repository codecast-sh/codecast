// Huddle room keys: parsing and authorization, in one place.
//
// A room is a string key, never a row (see call_members in schema.ts). Three
// shapes, each anchored to something the product already scopes:
//   dm:<id>[:<id>…]      a set of people (one or more), user ids sorted
//                        ascending so every side derives the identical key
//                        without coordination; a chat DM or group thread
//                        huddles in the room of its member set, and a set
//                        of one is a huddle with yourself
//   channel:<channelId>  a chat channel's standing room (private channels
//                        admit their members only)
//   session:<convId>     a huddle about one conversation/session
//   rec:<uuid>           NOT a room: one person's microphone, recorded. See
//                        the recordings section below — every door here is
//                        shut on it and the transcript's creator is the only
//                        person it admits.
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
// There are two LAYERS of access here and reading one as the other is the
// mistake this comment exists to prevent.
//
// MEMBERSHIP (authorizeRoomMembership) is what a room's KEY grants. It governs
// everything that is not the huddle running right now: the call record and its
// transcript, and the authority to ring more people in. A people room admits
// the users its key names, whether that is two or nine. A channel room admits
// whoever may access the channel (canAccessChannel — a private channel and a
// group thread admit their members only). A session room admits the
// conversation's owner, and a teammate when the row is team-visible.
//
// The OPEN DOOR (openRoomDoor) is what an OCCUPIED room grants, and it governs
// LIVE ENTRY only. A huddle running right now admits any member of the team it
// bills to, the way an occupied meeting room in an office admits whoever walks
// up to it: walking in is not an interruption. This holds for a people room of
// ANY SIZE — there is no principled line at two, so a group thread's huddle is
// as open as a 1:1 — and for a session room whose conversation the viewer
// cannot even see (they hear voices; getLiveRooms redacts the title, never the
// room). The single exception is a CHANNEL room, which is that channel's own
// standing space rather than a huddle held in public: its door stays the
// channel's own, so a private channel or group thread admits its members only,
// live or not.
//
// The LOCK (call_room_state) is how a huddle opts out. It shuts the open door
// and leaves membership and the grant working, so a group that wants privacy
// locks the room exactly like a pair does. A PRIVATE huddle (chosen at start)
// is locked and also unlisted: nobody outside sees it or can knock, a session
// room's team visibility admits nobody but its owner, and its call record
// stays with the people who were in it (transcripts.canReadCall). The team is the outer wall and
// nothing on either layer moves it: no door ever admits a non-teammate.
//
// An OWNER-ONLY room (isOwnerOnlyRoom) behaves as a private huddle for everyone
// but its owner, and nothing stores it: a people room of one is its person's,
// and a session room is its owner's whenever the team cannot read the
// session. Derived from the key and the conversation on every read, so no
// unlock, no new huddle in an empty room and no client flag can open it.
//
// Who may WIDEN a room is a third question and it turns on neither layer: the
// answer is being INSIDE it. Any live occupant may ring a teammate in
// (authorizeRoomInviter), which is the same gesture as admitting a knocker —
// whoever is in a meeting room can open its door, and a walk-in who may lock
// the door must be able to open it too. Two things keep that from chaining
// into a leak: a CHANNEL room still takes membership authority, so nobody
// walks into a channel's room and fills it with people the channel excludes;
// and every recipient must be a teammate, which is the outer wall again. A
// grant you have not used is not a seat — you must actually be in the room.
//
// Authorization answers "may THIS user join/ring THIS room" and is enforced by
// every calls.* mutation and the token mint — the media server trusts our JWT,
// so this module is the entire security boundary for who can listen in.
import type { Doc, Id } from "./_generated/dataModel";
import { getOwnerMembership, isConversationTeamVisibleSync, isTeamMember } from "./privacy";
import { effectiveMembershipVisibility } from "./teamVisibility";
import { canAccessChannel, isCommunity, isRestricted } from "./chatAccess";
import { teamFeatureOffMessage, teamHasFeature } from "./teamFeatures";
import { checkGuestRoster, endGuestAdmissions, roomHasGuestLinks } from "./lib/callGuestAdmission";
// Key shapes, builders and lease timings are the shared contract
// (@codecast/shared/contracts/callRoomKeys) so the web client can build keys
// and share staleness math without importing server code. This module adds
// what only the server can: authorization.
import {
  CALL_MEMBER_STALE_MS,
  isRecRoomKey,
  isRoomlessKey,
  parseRoomKey,
  type ParsedRoomKey,
} from "@codecast/shared/contracts";

export {
  CALL_HEARTBEAT_MS,
  CALL_INVITE_TTL_MS,
  CALL_KNOCK_TTL_MS,
  CALL_MEMBER_STALE_MS,
  MAX_ROOM_MEMBERS,
  channelRoomKey,
  chatRoomKey,
  dmRoomKey,
  isRecRoomKey,
  parseRoomKey,
  recRoomKey,
  roomMemberIds,
  sessionRoomKey,
  type ParsedRoomKey,
} from "@codecast/shared/contracts";
import { featureVendorRefusal } from "./lib/vendorGuard";
import { canAccessConversation } from "./lib/access";

/** The lease is the truth: a row older than the stale window is not in the
 *  room, whatever else it says. One filter for every reader (occupancy,
 *  getMyCalls, the grant, the presence strip).
 *
 *  A PREWARM ROW IS NOT A MEMBER either, and it is dropped here for the same
 *  reason the lease is: this is the one question every reader of the table
 *  already asks. A prewarm row holds a media connection open ahead of a burst
 *  — nothing published, nobody listening — so counting it would put a person
 *  in a room they never entered: "X hears you" over silence, an occupancy chip
 *  on an empty room, an invite grant carried by nobody, and a room whose lease
 *  never lapses. Fifteen readers, one rule, no reader that has to remember it.
 */
export function liveMembers<T extends { last_seen: number; prewarm?: boolean }>(
  rows: T[],
  now: number,
): T[] {
  return rows.filter((m) => isSeat(m) && now - m.last_seen < CALL_MEMBER_STALE_MS);
}

/** Is this row a person's seat at all, at any freshness?
 *
 *  `liveMembers` asks two questions at once — is it a seat, and is its lease
 *  current — and almost every reader wants both. This is the first half alone,
 *  for the one reader that wants a STALE seat on purpose: the orphan-transcript
 *  sweep dates a dead huddle's end from the last lease anybody refreshed, and a
 *  prewarm row that arrived afterwards would push that end up to ninety seconds
 *  into the future and inflate the recording's duration by the same amount.
 *
 *  Exported so the prewarm rule lives in this file only. A reader that spells
 *  out `!row.prewarm` for itself is the sixteenth place to forget it. */
export function isSeat(row: { prewarm?: boolean }): boolean {
  return !row.prewarm;
}

// ── Recordings ────────────────────────────────────────────────────────────
//
// `rec:<uuid>` is the one room kind with no room in it. A recording is one
// person's microphone: no media server, no seat, no second participant. It
// borrows a room key only because everything downstream of capture — the ASR
// mint, segments, flush beats, the summary, the calls page, `cast calls` — is
// keyed by one, and reusing that pipeline whole is the entire design.
//
// So the key grants nothing by itself: it names a uuid and no owner. The
// TRANSCRIPT is the truth. Whoever started it owns the recording, and nobody
// else may reach it — not a teammate, not an admin, not somebody who learned
// the uuid. A key with no transcript is a fresh id the caller just minted, so
// any authenticated user may start on it; that first `start` is what makes it
// theirs.
//
// Every live-call door stays shut on rec keys, and the default is what shuts
// them: `authorizeRoom` and `authorizeRoomNoGrant` REFUSE a rec key unless the
// caller passes `{ rec: true }`, so joinRoom, invite, knock, the media token
// mint, occupancy and the inviter rule all refuse without being edited — as
// will anything written next. Only the transcription paths a recording truly
// needs opt in. `openRoomDoor` returns null before it reads anything, which
// means no call_members row can be created for a rec key, which in turn is why
// getLiveRooms and getRoomOccupancy cannot list one: they enumerate that table.
//
// `meet:<uuid>` is the same shape for a meeting on another platform that a
// Recall bot attends (meetingBots.ts). Every door is shut on it too
// (isRoomlessKey); its owner is whoever sent the bot, and its transcript is
// begun by the server when the bot is sent, so an unclaimed meet key is
// refused rather than handed to whoever asks first.

/** The transcript a rec key belongs to, or null while the id is unclaimed. The
 *  LIVE one wins over an older ended row, so a recording in progress can never
 *  have its ownership answered by some earlier transcript that happened to use
 *  the same id. */
async function roomlessTranscript(ctx: any, roomKey: string): Promise<Doc<"transcripts"> | null> {
  const rows: Doc<"transcripts">[] = await ctx.db
    .query("transcripts")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  return (
    rows.find((t) => t.status === "live") ??
    rows.sort((a, b) => b.started_at - a.started_at)[0] ??
    null
  );
}

/** Which team a new recording ROUTES to (transcripts.team_id) so the owner's
 *  own history list finds it. Routing, never access — the recording stays
 *  visible to its creator alone whatever team it bills to. A team the person
 *  has actually joined, because a stale active-team pointer would file the row
 *  where their own list never looks. */
export async function recRoutingTeam(
  ctx: any,
  userId: Id<"users">,
): Promise<Id<"teams"> | null> {
  const user = await ctx.db.get(userId);
  for (const candidate of [user?.active_team_id, user?.team_id]) {
    if (candidate && (await isTeamMember(ctx, userId, candidate))) return candidate;
  }
  const firstMembership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", userId))
    .first();
  return firstMembership?.team_id ?? null;
}

/** May this user read a call with no room behind it (a `rec:` recording or a
 *  `meet:` meeting a bot attended)? The call's own record is the whole answer,
 *  since there is no room to ask: its creator always; a teammate the bot
 *  heard speak in a meeting (filed under their codecast id when Recall
 *  matched their email, meetingBots.speakerOf) or whose calendar the bot
 *  attended for (recorded_people); and teammates once the
 *  creator shared it into the team. Team membership and the calls feature
 *  hold for everyone but the creator. transcripts.canReadCall and the call's
 *  chat (callChat.list) both answer through here. */
export async function canReadRoomlessCall(
  ctx: any,
  userId: Id<"users">,
  t: Pick<Doc<"transcripts">, "room_key" | "started_by" | "team_id" | "participants" | "rec_shared" | "recorded_people" | "screen_recording">,
): Promise<boolean> {
  if (String(t.started_by) === String(userId)) return true;
  // A screen recording is part of the session it was sent to, like an image
  // in a message there: the session's readers read it, and the team's call
  // sharing never reaches it.
  if (t.screen_recording) {
    const conv = t.screen_recording.conversation_id ? await ctx.db.get(t.screen_recording.conversation_id) : null;
    return !!conv && (await canAccessConversation(ctx, userId, conv));
  }
  const heard =
    parseRoomKey(t.room_key)?.kind === "meet" &&
    ((t.participants ?? []).some((p) => String(p.id) === String(userId)) ||
      (t.recorded_people ?? []).some((id) => String(id) === String(userId)));
  if (!heard && !t.rec_shared) return false;
  return (await isTeamMember(ctx, userId, t.team_id)) && (await teamHasFeature(ctx, t.team_id, "calls"));
}

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

/** The team a room that is one person's alone bills to: a people room of one,
 *  or a session with no team (or a team its owner has left). One of their
 *  teams that can hold calls: the team the room's live seats already bill to,
 *  so switching workspace mid-huddle never splits its seats, rings and record
 *  across teams; else `prefer` (the session's team); else the active team;
 *  else the first. With none, the team a recording would file under, so
 *  authorizeRoom's feature gate says why calls are off. */
async function borrowedCallTeam(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
  prefer?: Id<"teams"> | null,
): Promise<Id<"teams"> | null> {
  const { teams } = await callTeamsOf(ctx, userId);
  const seats: Doc<"call_members">[] = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  const occupied = liveMembers(seats, Date.now())[0]?.team_id;
  const user = await ctx.db.get(userId);
  for (const candidate of [occupied, prefer, user?.active_team_id]) {
    if (candidate && teams.some((t) => String(t) === String(candidate))) return candidate;
  }
  return teams[0] ?? (await recRoutingTeam(ctx, userId));
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

// A team every one of `users` belongs to, walking the first user's
// memberships. A people room bills its rows to that team: the first common
// one that can hold calls (callTeamsOf), else the first common one, so
// authorizeRoom's feature gate says why calls are off. A set with no common
// team has no room.
async function sharedTeam(
  ctx: any,
  users: Id<"users">[],
): Promise<Id<"teams"> | null> {
  const [first, ...rest] = users;
  const sharedByAll = async (teamId: Id<"teams">) => {
    for (const other of rest) {
      if (!(await isTeamMember(ctx, other, teamId))) return false;
    }
    return true;
  };
  for (const teamId of (await callTeamsOf(ctx, first)).teams) {
    if (await sharedByAll(teamId)) return teamId;
  }
  const memberships = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_id", (q: any) => q.eq("user_id", first))
    .collect();
  for (const m of memberships) {
    if (await sharedByAll(m.team_id)) return m.team_id;
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
  // A guest's admission is the same kind of grant (callGuests.ts): it was for
  // the huddle that just ended. Whoever is still holding the media open from
  // it is put out, so the next huddle starts with only the people its own
  // door lets in. Guests still WAITING stay (endGuestAdmissions says why).
  // With nobody admitted the media room is checked all the same whenever a
  // guest link ever opened this room: a guest put out of an earlier huddle
  // whose client reconnected on a token LiveKit kept refreshing after the
  // roster tail ended would otherwise sit in this one, listening.
  if ((await endGuestAdmissions(ctx, roomKey)) === 0 && (await roomHasGuestLinks(ctx, roomKey))) {
    await checkGuestRoster(ctx, roomKey);
  }
  // A guest link made from a SEAT was the seat-holder's standing in that
  // huddle and nothing more (callGuests.creatorStillVouches): it dies with
  // it, turned off here so the new huddle's door is only the links its own
  // people made.
  const seatLinks = await ctx.db
    .query("call_guest_links")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  const now = Date.now();
  for (const l of seatLinks) {
    if (l.created_via === "seat" && !l.revoked_at) await ctx.db.patch(l._id, { revoked_at: now });
  }
}

/** The room's one state row (lock, transcription opt-out), or null for the
 *  ordinary case, so the common path costs one empty index read. */
export async function readRoomState(ctx: any, roomKey: string): Promise<any | null> {
  return await ctx.db
    .query("call_room_state")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .first();
}

/** Is this room's door shut? */
export async function isRoomLocked(ctx: any, roomKey: string): Promise<boolean> {
  return !!(await readRoomState(ctx, roomKey))?.locked;
}

/** Has this huddle turned transcription off? */
export async function isRoomTranscribeOff(ctx: any, roomKey: string): Promise<boolean> {
  return !!(await readRoomState(ctx, roomKey))?.transcribe_off;
}

/** Write to the room's one state row, creating it on first use. `seat` is
 *  the caller's live seat: only someone inside writes room state, and the
 *  row bills to the seat's team. */
export async function upsertRoomState(
  ctx: any,
  roomKey: string,
  seat: { team_id: Id<"teams">; user_id: Id<"users"> },
  patch: { locked?: boolean; private?: boolean; transcribe_off?: boolean; transcribe_off_at?: number; emptied_at?: number; words_public?: boolean },
  now: number,
): Promise<void> {
  const existing = await readRoomState(ctx, roomKey);
  if (existing) {
    await ctx.db.patch(existing._id, {
      ...patch,
      ...(patch.locked !== undefined ? { locked_by: seat.user_id } : {}),
      updated_at: now,
    });
    return;
  }
  await ctx.db.insert("call_room_state", {
    room_key: roomKey,
    team_id: seat.team_id,
    locked: patch.locked ?? false,
    locked_by: seat.user_id,
    private: patch.private,
    transcribe_off: patch.transcribe_off,
    transcribe_off_at: patch.transcribe_off_at,
    emptied_at: patch.emptied_at,
    words_public: patch.words_public,
    updated_at: now,
  });
}

/** Stamp on the room whether its live call record's words are on a public
 *  link (call_room_state.words_public), from the record as it now stands:
 *  its link turned on or off (publicShare.claimShareToken), a record begun
 *  (transcripts.beginCallRecord: a new one has no link) or ended. Only the
 *  record the room is keeping now speaks for it, so a link turned on for an
 *  earlier call of the same room changes nothing here. Written only when the
 *  answer moves; the row is created for it with the record's team and
 *  scribe, the seat a state row bills to. */
export async function stampRoomWordsPublic(
  ctx: any,
  call: Pick<Doc<"transcripts">, "room_key" | "team_id" | "started_by" | "status" | "share_token">,
  opts: { ending?: boolean } = {},
): Promise<void> {
  if (isRoomlessKey(call.room_key)) return;
  if (call.status !== "live" && !opts.ending) return;
  const wordsPublic = call.status === "live" && !opts.ending && !!call.share_token;
  if (!!(await readRoomState(ctx, call.room_key))?.words_public === wordsPublic) return;
  await upsertRoomState(ctx, call.room_key, { team_id: call.team_id, user_id: call.started_by }, { words_public: wordsPublic }, Date.now());
}

// The open door: a live huddle admits any member of the team it bills to.
// "Live" is the room's own lease (liveMembers) — an empty room is not a
// huddle, so this never opens a room that merely used to hold one. The billing
// team comes from the live rows themselves rather than from the key, which is
// what lets a session room admit a teammate who cannot see its conversation
// (the title redacts in getLiveRooms; the room does not).
//
// A people room is DELIBERATELY not checked against its key's users, at any
// size: a live `dm:` huddle of three admits a fourth teammate exactly as a
// 1:1 admits a third. That is the decided product — there is no principled
// line at two people, and a group wanting privacy locks the room. Do not
// "fix" this by requiring parsed.users.includes(userId); that rule lives one
// layer down, in authorizeRoomMembership, where it still governs history and
// the authority to ring people in.
//
// `ignoreLock` answers a different question than authorization does: "would
// this room admit me if I knocked?" — getLiveRooms lists locked rooms so the
// caller can knock at them, and knock itself checks the same wall.
export async function openRoomDoor(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
  opts: { ignoreLock?: boolean } = {},
): Promise<Id<"teams"> | null> {
  const parsed = parseRoomKey(roomKey);
  if (!parsed) return null;
  // A recording has no door to be open: nobody can be inside one. Refusing
  // here rather than relying on the empty table is what makes that structural
  // — a stray call_members row could never turn a recording into a huddle
  // anyone may walk into.
  if (parsed.kind === "rec" || parsed.kind === "meet") return null;
  if (parsed.kind === "channel") {
    // The one room the open door does not touch: a channel's standing room is
    // that channel's own space, so a private channel or group thread keeps its
    // membership wall even while occupied. (A public channel's room was
    // already open to the team, so this branch only ever subtracts.)
    const channel = await ctx.db.get(parsed.channelId as Id<"chat_channels">);
    if (!channel || channel.archived_at || isRestricted(channel)) return null;
  }
  const rows: Doc<"call_members">[] = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  const live = liveMembers(rows, Date.now());
  if (live.length === 0) return null;
  const teamId = live[0].team_id;
  if (!(await isTeamMember(ctx, userId, teamId))) return null;
  // A private huddle has no door to knock at: it is not shown to the people
  // outside it, so `ignoreLock` (would I be let in if I knocked?) is no.
  const state = await readRoomState(ctx, roomKey);
  if (state?.private || (!opts.ignoreLock && state?.locked)) return null;
  // Nor does a room that is one person's: its owner enters by membership,
  // and anyone else only by being rung in.
  if (await isOwnerOnlyRoom(ctx, roomKey)) return null;
  return teamId;
}

/** Everything a huddle left on its room: the lock it set and the knocks at
 *  its door. Called from the same joinRoom branch as expireRoomGrants — a
 *  room restarting from empty is a NEW huddle, which starts unlocked with
 *  nobody waiting outside. */
export async function clearRoomState(ctx: any, roomKey: string): Promise<void> {
  for (const table of ["call_room_state", "call_knocks", "call_stage_pins"] as const) {
    const rows = await ctx.db
      .query(table)
      .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  }
}

/** The caller's own live row in a room, or null. One definition of "I am in
 *  this room right now" for every rule that turns on it: locking the door,
 *  ringing someone in, and reading who is knocking. */
export async function liveSeat(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
  now: number = Date.now(),
): Promise<Doc<"call_members"> | null> {
  const row = await ctx.db
    .query("call_members")
    .withIndex("by_user_room", (q: any) =>
      q.eq("user_id", userId).eq("room_key", roomKey),
    )
    .unique();
  return row && liveMembers([row], now).length > 0 ? row : null;
}

/** Why a team cannot hold calls, or null when it can: the calls feature is
 *  off, or the team holds regulated data and LiveKit, which carries every
 *  call's audio and video, has no BAA with Codecast yet (lib/vendorGuard). */
export async function callsOffReason(ctx: { db: any }, teamId: Id<"teams">): Promise<string | null> {
  if (!(await teamHasFeature(ctx, teamId, "calls"))) return teamFeatureOffMessage("calls");
  return featureVendorRefusal(ctx, teamId, "calls");
}

export type RoomAuthorization =
  | { ok: true; teamId: Id<"teams">; parsed: ParsedRoomKey }
  | { ok: false; reason: string };

/** Room access by MEMBERSHIP alone: neither the invite grant nor the open
 *  door, plus the feature gate. Call history reads use this — walking into a
 *  running huddle, whether rung in or through the open door, is entry to that
 *  huddle and never to everything the room ever recorded. Ringing more people
 *  in gates on this too: only the room's own people may widen it. */
export async function authorizeRoomNoGrant(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
): Promise<RoomAuthorization> {
  // Rec keys never pass here. Both questions this answers are a huddle's —
  // who may ring more people in, and who may read a ROOM's call history — and
  // a recording answers each elsewhere: nobody can be rung into one, and its
  // record belongs to its creator alone (transcripts.canReadCall, which
  // settles a rec transcript before it ever calls this).
  if (isRoomlessKey(roomKey)) {
    return { ok: false, reason: "a recording is not a room" };
  }
  const auth = await authorizeRoomMembership(ctx, userId, roomKey);
  if (!auth.ok) return auth;
  const off = await callsOffReason(ctx, auth.teamId);
  return off ? { ok: false, reason: off } : auth;
}

/** May this user ring MORE people into the room? Membership answers yes as it
 *  always did, and so now does a live seat in a people or session room: the
 *  walk-in sitting in the huddle is exactly the person a knocker is asking to
 *  be let in by, and they can already lock the door. A CHANNEL room is
 *  excluded on purpose — its authority stays canAccessChannel's, so a guest
 *  rung into a private channel's room cannot chain-invite the team into it.
 *  The recipient's own wall (a teammate of this team) is checked by `invite`. */
export async function authorizeRoomInviter(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
): Promise<RoomAuthorization> {
  const auth = await authorizeRoomNoGrant(ctx, userId, roomKey);
  if (auth.ok) return auth;
  const parsed = parseRoomKey(roomKey);
  if (!parsed || parsed.kind === "channel") return auth;
  const seat = await liveSeat(ctx, userId, roomKey);
  if (!seat) return auth;
  // A room that became one person's while a walk-in sat in it (the session
  // went private, its owner left the team) is widened only by someone who
  // was rung in; the owner rings by membership above.
  if ((await isOwnerOnlyRoom(ctx, roomKey)) && !(await acceptedInviteGrant(ctx, userId, roomKey))) return auth;
  const off = await callsOffReason(ctx, seat.team_id);
  return off ? { ok: false, reason: off } : { ok: true, teamId: seat.team_id, parsed };
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
  opts: { rec?: boolean } = {},
): Promise<RoomAuthorization> {
  // DEFAULT DENY FOR RECORDINGS. Every caller here is a live-call door —
  // joining, ringing, knocking, minting a media token, reading occupancy — and
  // none of them has any business with one person's microphone. Refusing
  // unless a caller says `{ rec: true }` means the transcription paths opt in
  // one at a time and everything else, including whatever is written next, is
  // shut without having to remember.
  if (!opts.rec && isRoomlessKey(roomKey)) {
    return { ok: false, reason: isRecRoomKey(roomKey) ? "a recording is not a room" : "a meeting on another platform is not a room" };
  }
  let auth = await authorizeRoomMembership(ctx, userId, roomKey);
  if (!auth.ok) {
    const parsed = parseRoomKey(roomKey);
    if (!parsed) return auth;
    // No grant and no open door for a recording: refusal by the transcript's
    // owner is the whole answer, and there is no second layer under it.
    if (parsed.kind === "rec" || parsed.kind === "meet") return auth;
    // The open door first: it is the common case now and the cheaper read.
    // The grant is tried regardless because it survives a lock — whoever was
    // rung in was let in deliberately.
    const granted =
      (await openRoomDoor(ctx, userId, roomKey)) ??
      (await acceptedInviteGrant(ctx, userId, roomKey));
    if (!granted) return auth;
    auth = { ok: true, teamId: granted, parsed };
  }
  // A recording is exempt from the calls feature. That flag buys a team the
  // huddle: a media server, rooms, rings, someone else's voice. Recording your
  // own microphone needs none of it, so gating it there would charge a team
  // for something it is not using. The dependency a recording really has is
  // the server's OPENAI_API_KEY, and mintAsrToken says so in plain words when
  // it is missing.
  if (auth.parsed.kind === "rec") return auth;
  const off = await callsOffReason(ctx, auth.teamId);
  return off ? { ok: false, reason: off } : auth;
}

/** The membership rules alone, without the feature gate. Exported for
 *  getLiveRooms, whose label redaction asks exactly this question: may this
 *  user SEE what the room is about, as opposed to walk into it?
 *
 *  This is also where a rec key gets its only answer — the transcript's
 *  creator, nobody else — so callers that need a recording (transcripts.start
 *  and friends, via `authorizeRoom(..., { rec: true })`) and callers that must
 *  refuse one share a single rule. */
export async function authorizeRoomMembership(
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
    // A room of one is a huddle with yourself: there is nobody to share a
    // team with, so it bills to one of yours that can hold calls.
    const teamId =
      parsed.users.length === 1
        ? await borrowedCallTeam(ctx, userId, roomKey)
        : await sharedTeam(ctx, parsed.users as Id<"users">[]);
    if (!teamId) return { ok: false, reason: "no shared team" };
    return { ok: true, teamId, parsed };
  }

  if (parsed.kind === "rec") {
    // Owner only, and the transcript says who that is. An unclaimed id is not
    // a room standing open — it is a uuid this caller just generated, and the
    // `start` it is about to make is what claims it.
    const t = await roomlessTranscript(ctx, roomKey);
    if (t) {
      if (String(t.started_by) !== String(userId)) {
        return { ok: false, reason: "not your recording" };
      }
      return { ok: true, teamId: t.team_id, parsed };
    }
    const teamId = await recRoutingTeam(ctx, userId);
    if (!teamId) return { ok: false, reason: "no team to file this recording under" };
    return { ok: true, teamId, parsed };
  }

  if (parsed.kind === "meet") {
    // Whoever sent the bot. The server begins the transcript when it sends
    // one, so a key with no transcript is nobody's.
    const t = await roomlessTranscript(ctx, roomKey);
    if (!t) return { ok: false, reason: "meeting not found" };
    if (String(t.started_by) !== String(userId)) return { ok: false, reason: "not your meeting" };
    return { ok: true, teamId: t.team_id, parsed };
  }

  if (parsed.kind === "channel") {
    const channel = await ctx.db.get(parsed.channelId as Id<"chat_channels">);
    if (!channel || channel.archived_at) {
      return { ok: false, reason: "channel not found" };
    }
    // The chat room's own gate: team member, chat on for the team, and a
    // membership row for private channels and group threads. A community
    // room is open to every signed-in user for READING and POSTING, but a
    // huddle is the team's own voice room: its members only.
    if (!(await canAccessChannel(ctx, userId, channel))) {
      return { ok: false, reason: "not a member of this channel" };
    }
    if (isCommunity(channel) && !(await isTeamMember(ctx, userId, channel.team_id))) {
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
    // team_id is routing: the session's team bills its room while the owner
    // is on it. A session with no team, or a team the owner has left, borrows
    // one of theirs; such a room is the owner's alone (isOwnerOnlyRoom), so the
    // borrowed team's members get no door into it.
    if (conversation.team_id && (await isTeamMember(ctx, userId, conversation.team_id))) {
      return { ok: true, teamId: conversation.team_id, parsed };
    }
    const teamId = await borrowedCallTeam(ctx, userId, roomKey, conversation.team_id);
    if (!teamId) return { ok: false, reason: "no team to hold this huddle" };
    return { ok: true, teamId, parsed };
  }
  if (!conversation.team_id) {
    return { ok: false, reason: "conversation has no team" };
  }
  // A private huddle is not the session's to share: seeing the conversation
  // lets a teammate in only to its ordinary huddles. The one who made it
  // private keeps their way back in (a dropped connection, a second window).
  const state = await readRoomState(ctx, roomKey);
  if (state?.private && String(state.locked_by) !== String(userId)) {
    return { ok: false, reason: "private huddle" };
  }
  const membership = await ctx.db
    .query("team_memberships")
    .withIndex("by_user_team", (q: any) =>
      q.eq("user_id", userId).eq("team_id", conversation.team_id),
    )
    .unique();
  if (!membership) return { ok: false, reason: "not a team member" };
  if (await sessionIsOwnerOnly(ctx, conversation)) {
    return { ok: false, reason: "conversation not team-visible" };
  }
  return { ok: true, teamId: conversation.team_id, parsed };
}
