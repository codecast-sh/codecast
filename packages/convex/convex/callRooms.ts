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
// locks the room exactly like a pair does. The team is the outer wall and
// nothing on either layer moves it: no door ever admits a non-teammate.
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
import { createTeamFeedFilter, isTeamMember } from "./privacy";
import { canAccessChannel, isRestricted } from "./chatAccess";
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

/** The transcript a rec key belongs to, or null while the id is unclaimed. The
 *  LIVE one wins over an older ended row, so a recording in progress can never
 *  have its ownership answered by some earlier transcript that happened to use
 *  the same id. */
async function recTranscript(ctx: any, roomKey: string): Promise<Doc<"transcripts"> | null> {
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
async function recRoutingTeam(
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
  patch: { locked?: boolean; transcribe_off?: boolean },
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
    transcribe_off: patch.transcribe_off,
    updated_at: now,
  });
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
  if (parsed.kind === "rec") return null;
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
  if (!opts.ignoreLock && (await isRoomLocked(ctx, roomKey))) return null;
  return teamId;
}

/** Everything a huddle left on its room: the lock it set and the knocks at
 *  its door. Called from the same joinRoom branch as expireRoomGrants — a
 *  room restarting from empty is a NEW huddle, which starts unlocked with
 *  nobody waiting outside. */
export async function clearRoomState(ctx: any, roomKey: string): Promise<void> {
  for (const table of ["call_room_state", "call_knocks"] as const) {
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
  if (parseRoomKey(roomKey)?.kind === "rec") {
    return { ok: false, reason: "a recording is not a room" };
  }
  const auth = await authorizeRoomMembership(ctx, userId, roomKey);
  if (!auth.ok) return auth;
  if (!(await teamHasFeature(ctx, auth.teamId, "calls"))) {
    return { ok: false, reason: teamFeatureOffMessage("calls") };
  }
  return auth;
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
  if (!(await teamHasFeature(ctx, seat.team_id, "calls"))) {
    return { ok: false, reason: teamFeatureOffMessage("calls") };
  }
  return { ok: true, teamId: seat.team_id, parsed };
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
  if (!opts.rec && parseRoomKey(roomKey)?.kind === "rec") {
    return { ok: false, reason: "a recording is not a room" };
  }
  let auth = await authorizeRoomMembership(ctx, userId, roomKey);
  if (!auth.ok) {
    const parsed = parseRoomKey(roomKey);
    if (!parsed) return auth;
    // No grant and no open door for a recording: refusal by the transcript's
    // owner is the whole answer, and there is no second layer under it.
    if (parsed.kind === "rec") return auth;
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
  if (!(await teamHasFeature(ctx, auth.teamId, "calls"))) {
    return { ok: false, reason: teamFeatureOffMessage("calls") };
  }
  return auth;
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
    const teamId = await sharedTeam(ctx, parsed.users as Id<"users">[]);
    if (!teamId) return { ok: false, reason: "no shared team" };
    return { ok: true, teamId, parsed };
  }

  if (parsed.kind === "rec") {
    // Owner only, and the transcript says who that is. An unclaimed id is not
    // a room standing open — it is a uuid this caller just generated, and the
    // `start` it is about to make is what claims it.
    const t = await recTranscript(ctx, roomKey);
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
