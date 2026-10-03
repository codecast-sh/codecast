// Guests: people from outside the team in a huddle, from a link.
//
// Two sides, and they never share a door.
//
// THE ROOM'S SIDE is signed in. Anyone who may widen a room (callRooms.
// authorizeRoomInviter: its own people, or whoever sits in a people or session
// huddle) makes a link and sends it. The people INSIDE answer the door: admit,
// deny, and later remove. Being inside is the authority, exactly as it is for
// a teammate's knock, because the person at the door is asking to be let in by
// whoever is in the meeting, not by whoever made the link a day ago.
//
// THE GUEST'S SIDE is not signed in and never will be. A guest is a
// call_guests row and proves it with the secret their browser was handed when
// they first knocked (only its hash is stored). Every public function here
// takes the link token or the guest's id and secret, answers about that one
// row and that one room, and nothing else: no team, no other guest, no member
// list, no transcript. A guest learns who is in the call the way anybody in a
// call does, from the media server, after somebody let them in.
//
// The lifecycle (CallGuestStatus):
//   requestJoin           -> waiting   (a knock the room sees while the lease holds)
//   admitGuest            -> admitted  (mintGuestToken now answers)
//   denyGuest             -> denied    (may ask again after a quiet minute)
//   removeGuest           -> removed   (put out of LiveKit too; this row is done)
//   leaveCall             -> left      (left_reason "self")
//   the huddle ends       -> left      (left_reason "huddle_ended", settled
//                                       where the huddle ends: calls.leaveRoom,
//                                       the record's end, the next joinRoom,
//                                       the guest's own beat, the minute sweep)
//   the page goes quiet   -> left      (left_reason "lapsed", by the sweep,
//                                       once the media server no longer
//                                       lists them, or sooner by the roster
//                                       check for a guest it listed before
//                                       (noteGuestsInMedia); "not_joined"
//                                       for a place nobody ever came into)
//   requestJoin, soon     -> admitted  (a place let go that way, within
//                                       GUEST_RESUME_MS of the same huddle,
//                                       comes back without a knock)
//
// THE MEDIA SERVER IS MADE TO AGREE, never trusted to. Every one of those
// endings goes through lib/callGuestAdmission, which writes the row and runs
// a roster check against LiveKit (enforceGuestRoster) now and on a tail that
// outlasts a token, so a guest put out stays out whatever their client does.
//
// AN ADMISSION IS FOR ONE HUDDLE, the way an accepted ring is: it lasts while
// that huddle runs (somebody seated, or the room inside its grace) and dies
// with it, so a guest from Tuesday's meeting cannot walk into Wednesday's with
// the secret still in their browser. It does NOT hang on the link: a link that
// expires or is revoked mid-meeting stops new knocks and closes the door on
// people still waiting at it, and leaves the people already inside alone.
// A link also lives on its creator's standing (linkUsable): a teammate who
// leaves the team, or loses the room, takes their links with them, and a link
// made from a seat in somebody else's huddle lives only as long as that
// huddle (the seat was the whole of the creator's standing).
// Removing someone is its own act (removeGuest), because revoking a link to
// stop it spreading should not hang up on the client you are talking to.
//
// Presence is a lease (isGuestPresent): the guest's page beats while it is
// open, and an admitted guest the media server still lists counts as seen too
// (noteGuestsInMedia), since a phone stops a background page's timers long
// before it drops the call. A knock from a closed page drops off the door
// within a seat's window and is settled "lapsed" by the minute sweep; an
// admitted guest whose page blinked stays admitted and listed, since the
// admission's window is longer than a background tab's beat. A page quiet for
// longer than that (GUEST_ADMISSION_LAPSE_MS) ends the admission: an unseen
// guest is not left holding the media open.
//
// A link anybody can hold is bounded everywhere it could cost the room: new
// guests per minute, places at the door (per room and per link, checked by
// one rule, doorHasRoom, on every way back to it), pushes to its creator (per
// link), and the reads behind the door (by lease, never by history).
import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  authorizeRoomInviter,
  authorizeRoomNoGrant,
  liveMembers,
  liveSeat,
  parseRoomKey,
  readRoomState,
} from "./callRooms";
import { liveTranscriptFor, postEvent } from "./callChat";
import { isRestricted } from "./chatAccess";
import { huddleAlive } from "./transcripts";
import { isTeamMember } from "./privacy";
import { teamHasFeature } from "./teamFeatures";
import { bucketTs } from "./presenceState";
import { enqueuePush, readPresence } from "./pushRouter";
import { signLivekitJwt } from "./lib/livekitJwt";
import { listParticipants, livekitConfigFromEnv, putOutOfRoom } from "./lib/livekitServer";
import { sha256Hex } from "./lib/hash";
import { requireUser } from "./lib/requireUser";
import { newSlug } from "./lib/slug";
import { roomRecordingState } from "./lib/callRecordingRuns";
import { personImage, publicPersonLabel, teammateLabel } from "./lib/personLabel";
import {
  GUEST_ROSTER_TAIL_MS,
  GUEST_SETTLED_WATCH_MS,
  checkGuestRoster,
  endGuestAdmissions,
  noteGuestAttendance,
  roomGuestRows,
  settleGuest,
  settleGuests,
} from "./lib/callGuestAdmission";
import {
  CALL_GUEST_WAITING_PUSH_TYPE,
  CALL_MEMBER_STALE_MS,
  GUEST_ADMISSION_LAPSE_MS,
  GUEST_CREATOR_NOTICE_ANY_LINK_MS,
  GUEST_CREATOR_NOTICE_MS,
  GUEST_DENY_COOLDOWN_MS,
  GUEST_JOIN_REFUSAL_TEXT,
  GUEST_KNOCKS_PER_LINK_PER_MINUTE,
  GUEST_LINK_REFUSAL_TEXT,
  GUEST_LINK_MAX_TTL_MS,
  GUEST_LINK_MIN_TTL_MS,
  GUEST_LINK_TTL_MS,
  GUEST_REKNOCK_MIN_MS,
  GUEST_RESUME_MS,
  GUEST_TOKEN_TTL_S,
  MAX_ROOM_GUESTS,
  MAX_WAITING_GUESTS,
  MAX_WAITING_PER_LINK,
  guestDisplayName,
  guestIdentity,
  guestJoinPath,
  isGuestIdentity,
  isGuestPresent,
  normalizeGuestName,
  type CallGuestView,
  type GuestJoinRefusal,
  type GuestLinkRefusal,
} from "@codecast/shared/contracts";

// The link token is the whole secret of a link, and the guest secret the
// whole proof of a guest; both are far past guessing (~143 and ~190 bits).
const LINK_TOKEN_LENGTH = 24;
const GUEST_SECRET_LENGTH = 32;

// ── Pure rules (exported for tests) ───────────────────────────────────────

/** Why a link refuses, by its own fields alone, or null. */
export function linkRefusal(
  link: Pick<Doc<"call_guest_links">, "revoked_at" | "expires_at"> | null,
  now: number,
): "not_found" | "revoked" | "expired" | null {
  if (!link) return "not_found";
  if (link.revoked_at) return "revoked";
  if (now >= link.expires_at) return "expired";
  return null;
}

/** Has this link neither expired nor been turned off? */
export function linkOpen(link: Pick<Doc<"call_guest_links">, "revoked_at" | "expires_at">, now: number): boolean {
  return linkRefusal(link, now) === null;
}

/** The ttl a creator asked for, held inside the allowed range. */
export function clampLinkTtl(ttlMs: number | undefined): number {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return GUEST_LINK_TTL_MS;
  return Math.min(GUEST_LINK_MAX_TTL_MS, Math.max(GUEST_LINK_MIN_TTL_MS, Math.round(ttlMs)));
}

/** What the guest's own page shows (CallGuestView). `huddleRunning` is the
 *  room's answer and only matters to an admitted guest; `linkClosed` (expired,
 *  turned off, or its creator gone) only to one still waiting. */
export function guestView(
  row: Pick<Doc<"call_guests">, "status" | "left_reason">,
  opts: { huddleRunning: boolean; linkClosed: boolean },
): CallGuestView {
  switch (row.status) {
    case "waiting":
      return opts.linkClosed ? "closed" : "waiting";
    case "admitted":
      return opts.huddleRunning ? "admitted" : "ended";
    case "left":
      return row.left_reason === "huddle_ended" ? "ended" : "left";
    default:
      return row.status;
  }
}

/** A guest whose place in a running huddle was let go without anybody
 *  deciding it (their page went quiet, or they never came in from the lobby)
 *  and who may walk back in without knocking (GUEST_RESUME_MS). Only a place
 *  somebody granted (decided_by: a knock abandoned at the door never was),
 *  and only into the huddle it was granted for: somebody seated now was
 *  already seated when the place went. A huddle that ended and started again
 *  has only newer seats, so a guest from that meeting knocks on this one
 *  like anyone (and so does one whose whole room changed seats meanwhile,
 *  which is the safe way to be wrong). */
async function guestResumable(ctx: any, guest: Doc<"call_guests">, now: number): Promise<boolean> {
  if (guest.status !== "left" || (guest.left_reason !== "lapsed" && guest.left_reason !== "not_joined")) return false;
  const since = guest.settled_at;
  if (!guest.decided_by || !since || now - since >= GUEST_RESUME_MS) return false;
  const seats: Doc<"call_members">[] = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", guest.room_key))
    .collect();
  return liveMembers(seats, now).some((m) => m.joined_at <= since);
}

/** Why an admitted guest's place is let go when nobody decided it: a page
 *  that was in the media and went quiet "lapsed"; one that never came in
 *  (held at the lobby, a permission prompt left open) "not_joined". */
function quietReason(guest: Pick<Doc<"call_guests">, "media_seen_at">): "lapsed" | "not_joined" {
  return guest.media_seen_at ? "lapsed" : "not_joined";
}

/** May one more guest from this link take a place at the door? The room's
 *  places and this link's share of them, so a link that got out cannot keep
 *  out the guests arriving on another. One rule for every way onto the door:
 *  a first knock, a knock from a row that was elsewhere, and a page coming
 *  back after a lapse (guestHeartbeat). `guestId` is the row asking, which
 *  never counts against itself. */
export function doorHasRoom(
  waiting: ReadonlyArray<{ guest: Pick<Doc<"call_guests">, "_id">; link: Pick<Doc<"call_guest_links">, "_id"> }>,
  linkId: Id<"call_guest_links">,
  guestId?: Id<"call_guests">,
): boolean {
  const others = waiting.filter((w) => String(w.guest._id) !== String(guestId));
  if (others.length >= MAX_WAITING_GUESTS) return false;
  return others.filter((w) => String(w.link._id) === String(linkId)).length < MAX_WAITING_PER_LINK;
}

const DOOR_FULL_TEXT = "Too many people are waiting to join. Try again in a minute.";

/** Whether `secret` is the one this row was minted with. Shape checked first
 *  so a junk argument never reaches the hash. */
export async function secretMatches(row: Pick<Doc<"call_guests">, "secret_hash">, secret: unknown): Promise<boolean> {
  if (typeof secret !== "string" || secret.length < 16 || secret.length > 128) return false;
  return (await sha256Hex(secret)) === row.secret_hash;
}

// ── Reads shared with calls.ts and the recording paths ─────────────────────

/** A guest row by an id from outside (an argument, an identity), or null for
 *  an id of another table or a row that does not exist. */
async function guestRow(ctx: any, guestId: string): Promise<Doc<"call_guests"> | null> {
  const id = ctx.db.normalizeId("call_guests", guestId);
  return id ? await ctx.db.get(id) : null;
}

/** The guest this id and secret prove, or null for anything else: an id of
 *  another table, a row that does not exist, a wrong secret. The one door for
 *  every public guest function, and for anything a guest may do in a call
 *  (stopping a recording), so no caller compares hashes on its own. */
export async function guestBySecret(
  ctx: any,
  guestId: string,
  secret: string,
): Promise<Doc<"call_guests"> | null> {
  const row = await guestRow(ctx, guestId);
  return row && (await secretMatches(row, secret)) ? row : null;
}

/** Does the person who made this link still stand where they stood when they
 *  made it? A link is their vouching for strangers, so it is only as good as
 *  they are: one of the room's own people must still be one (a channel they
 *  left, a session gone private). A teammate who made it from a SEAT in
 *  somebody's people or session huddle stood there only while that huddle
 *  ran, the way an accepted ring is a grant for one huddle
 *  (callRooms.expireRoomGrants, which also turns such links off when the
 *  room's next huddle starts): the link works while the huddle runs and they
 *  are still on the team, and answers "inviter_gone" from then on, so a room
 *  they were let into once does not keep a door for strangers. */
async function creatorStillVouches(ctx: any, link: Doc<"call_guest_links">, now: number): Promise<boolean> {
  if (link.created_via === "seat") {
    return (await isTeamMember(ctx, link.created_by, link.team_id)) && (await huddleAlive(ctx, link.room_key, now));
  }
  return (await authorizeRoomNoGrant(ctx, link.created_by, link.room_key)).ok;
}

/** Why a link turns a guest away right now, or null when it lets them knock.
 *  Every knock, every beat at the door, and every admit asks this, so a link
 *  that expires, is turned off or loses its creator closes on the people
 *  already waiting at it as well as the next one. */
export async function linkUsable(
  ctx: any,
  link: Doc<"call_guest_links"> | null,
  now: number,
): Promise<GuestLinkRefusal | null> {
  const own = linkRefusal(link, now);
  if (own || !link) return own ?? "not_found";
  if (!(await teamHasFeature(ctx, link.team_id, "calls"))) return "unavailable";
  if (!(await creatorStillVouches(ctx, link, now))) return "inviter_gone";
  return null;
}

/** The guests inside the room right now, present by the admission's window
 *  (isGuestPresent): what the room lists, and what the cap on guests counts.
 *  A guest past that window is one the sweep is putting out. */
export async function admittedGuests(ctx: any, roomKey: string, now: number): Promise<Doc<"call_guests">[]> {
  return (await roomGuestRows(ctx, roomKey, "admitted", now)).filter((g) => isGuestPresent(g, now));
}

/** The guests at the door right now: present by their lease, on a link that
 *  still lets them knock. Each with its link, read once per link. */
async function waitingGuests(
  ctx: any,
  roomKey: string,
  now: number,
): Promise<Array<{ guest: Doc<"call_guests">; link: Doc<"call_guest_links"> }>> {
  const links = new Map<string, Doc<"call_guest_links"> | null>();
  const out: Array<{ guest: Doc<"call_guests">; link: Doc<"call_guest_links"> }> = [];
  for (const guest of await roomGuestRows(ctx, roomKey, "waiting", now)) {
    if (!isGuestPresent(guest, now)) continue;
    const key = String(guest.link_id);
    if (!links.has(key)) {
      const link: Doc<"call_guest_links"> | null = await ctx.db.get(guest.link_id);
      links.set(key, link && !(await linkUsable(ctx, link, now)) ? link : null);
    }
    const link = links.get(key);
    if (link) out.push({ guest, link });
  }
  return out;
}

/** The door's entries for the guests waiting at it, in the same list as a
 *  teammate's knock (calls.getRoomKnocks). Marked by `kind` and keyed by
 *  their LiveKit identity (`from_user` is `guest:<id>`, never a users id):
 *  admitting one is admitGuest, not a ring, since a guest has no phone to
 *  ring and no team to be rung into. `created_at` is their latest knock for
 *  the same reason a teammate's is (RoomDoor's re-knock signature), and moves
 *  when they change the name they are asking under. `link_turned_away`
 *  counts the times the room already denied or removed somebody from the
 *  same link (the link's own counter): past one, the door offers to turn the
 *  link off rather than keep answering it. `link_by` names whose link
 *  brought them (`link_mine` when it is the viewer's own): whoever answers is
 *  deciding whether a stranger hears the meeting, and with several links
 *  open, "via Sam's link" is how an expected guest is told from a leaked
 *  link. A teammate's name as teammates see it; it moves only with the link. */
export async function guestKnocks(ctx: any, roomKey: string, now: number, viewer: { canAnswer: boolean; userId: Id<"users"> }) {
  const creators = new Map<string, string>();
  const out = [];
  for (const { guest, link } of await waitingGuests(ctx, roomKey, now)) {
    const by = String(link.created_by);
    if (!creators.has(by)) creators.set(by, teammateLabel(await ctx.db.get(link.created_by)));
    out.push({
      from_user: guestIdentity(String(guest._id)),
      from_name: guest.name,
      from_image: undefined as string | undefined,
      created_at: guest.knocked_at,
      kind: "guest" as const,
      guest_id: String(guest._id),
      link_id: String(link._id),
      link_turned_away: link.turned_away ?? 0,
      link_by: creators.get(by)!,
      link_mine: by === String(viewer.userId),
      can_answer: viewer.canAnswer,
    });
  }
  return out;
}

/** A guest as the people in the room see them. No secret, no link, no lease
 *  stamp (it moves every beat and paints nothing). */
export function projectGuest(g: Doc<"call_guests">) {
  return {
    guest_id: String(g._id),
    identity: guestIdentity(String(g._id)),
    name: g.name,
    joined_at: bucketTs(g.decided_at ?? g.knocked_at),
  };
}

/** What a guest is told before joining and while inside: is this call being
 *  transcribed, is it being recorded, and will that video be on the call's
 *  public link. Every huddle transcribes unless the room switched it off
 *  (calls.setRoomTranscribeOff); recording is a composite run in progress
 *  (call_recordings), which is what puts their face on file; and a run whose
 *  call shares its video by link (roomRecordingState.video_shared) puts it
 *  in front of anyone with that link. */
async function roomNotice(ctx: any, roomKey: string): Promise<{ transcribed: boolean; recording: boolean; video_public: boolean }> {
  const run = await roomRecordingState(ctx, roomKey);
  const recording = !!run && run.status !== "stopping";
  return {
    transcribed: !(await readRoomState(ctx, roomKey))?.transcribe_off,
    recording,
    video_public: recording && !!run?.video_shared,
  };
}

/** The name the guest's page gives the meeting, which also travels in every
 *  unfurl of the link (bot-meta caches it). A channel the whole team can see
 *  reads as its name, which the team chose to show as a place to meet. A
 *  private channel's name is a fact about who is in it ("#layoffs-q4"), and
 *  a session's title is the agent work's own label ("fix the auth race in
 *  prod"), both written for the team and never for a stranger, so those
 *  rooms are named the way a people room is: after whoever invited them
 *  (the page's meetingTitle). */
/*  linkTitle hides a room's NAME from strangers, not its ids. An admitted
 *  guest's LiveKit client holds the room name, which is the room_key itself
 *  ("session:<conversationId>", "channel:<channelId>", "dm:<a>:<b>"), and
 *  every participant identity: a member's Convex user id, an agent face's
 *  "agent:<conversationId>". None of them grants anything (every read checks
 *  standing, and a guest has none), but they are visible to anyone the room
 *  admits, so nothing may treat a room key or a member's id as private. */
export async function linkTitle(ctx: any, link: Pick<Doc<"call_guest_links">, "room_key">): Promise<string | null> {
  const parsed = parseRoomKey(link.room_key);
  if (parsed?.kind === "channel") {
    const channel: Doc<"chat_channels"> | null = await ctx.db.get(parsed.channelId as Id<"chat_channels">);
    return channel?.name && !isRestricted(channel) ? `#${channel.name}` : null;
  }
  return null;
}

/** Who sent the link, as somebody outside the team may see them: a name,
 *  never an address (the link travels; personLabel says why). */
async function inviterOf(ctx: any, link: Pick<Doc<"call_guest_links">, "created_by">) {
  const u = await ctx.db.get(link.created_by);
  return { name: publicPersonLabel(u), image: personImage(u) };
}

async function linkByToken(ctx: any, token: string): Promise<Doc<"call_guest_links"> | null> {
  if (typeof token !== "string" || token.length < 8 || token.length > 64) return null;
  return await ctx.db
    .query("call_guest_links")
    .withIndex("by_token", (q: any) => q.eq("token", token))
    .unique();
}

/** The same refusals as the room hears them, when somebody tries to let in a
 *  guest whose link stopped working while they waited. */
const LINK_REFUSAL_FOR_ROOM: Record<GuestLinkRefusal, string> = {
  not_found: "That guest's link no longer exists",
  revoked: "That guest's link was turned off",
  expired: "That guest's link expired",
  unavailable: "Calls are switched off for this team",
  inviter_gone: "Whoever made that guest's link can no longer invite guests",
};

// ── The room's side (signed in) ────────────────────────────────────────────

const NOT_A_DOORKEEPER = "Only someone in the huddle can do that";

/** The guest this caller may answer for: the caller is inside the guest's
 *  room right now, with the authority to widen it. Seated is what answering a
 *  door takes (the person knocking asks the meeting, not the room's owner);
 *  the inviter rule on top keeps a channel room's own wall, as it does for
 *  ringing a teammate in. The door learns the same answer up front
 *  (getRoomKnocks' `can_answer`). A guest id that names nothing answers the
 *  same as a guest in a room the caller is not in, so the room's mutations
 *  are no way to learn which guest ids exist. */
async function guestForDoorkeeper(
  ctx: any,
  userId: Id<"users">,
  guestId: string,
  now: number,
): Promise<Doc<"call_guests">> {
  const guest = await guestRow(ctx, guestId);
  if (!guest || !(await liveSeat(ctx, userId, guest.room_key, now))) throw new Error(NOT_A_DOORKEEPER);
  const auth = await authorizeRoomInviter(ctx, userId, guest.room_key);
  if (!auth.ok) throw new Error(`Cannot answer the door: ${auth.reason}`);
  return guest;
}

/** Turn a link off, once. */
async function revokeLink(ctx: any, link: Doc<"call_guest_links">, userId: Id<"users">, now: number): Promise<void> {
  if (!link.revoked_at) await ctx.db.patch(link._id, { revoked_at: now, revoked_by: userId });
}

/** A link for this room, made by the caller. Reuses the caller's own open
 *  link for the room unless they asked for a different lifetime or a fresh
 *  one (a "new link" after the old one leaked revokes it and starts over), so
 *  copying the link twice hands out one door, not two. */
export const createGuestLink = mutation({
  args: {
    room_key: v.string(),
    ttl_ms: v.optional(v.number()),
    fresh: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const auth = await authorizeRoomInviter(ctx, userId, args.room_key);
    if (!auth.ok) throw new Error(`Cannot invite guests: ${auth.reason}`);
    const now = Date.now();
    const mine = (
      await ctx.db
        .query("call_guest_links")
        .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
        .collect()
    ).filter((l) => String(l.created_by) === String(userId) && linkOpen(l, now));
    if (!args.fresh && args.ttl_ms === undefined && mine.length > 0) {
      const link = mine.sort((a, b) => b.created_at - a.created_at)[0];
      return { link_id: link._id, token: link.token, path: guestJoinPath(link.token), expires_at: link.expires_at, reused: true };
    }
    if (args.fresh) {
      for (const l of mine) await revokeLink(ctx, l, userId, now);
    }
    const token = newSlug(LINK_TOKEN_LENGTH);
    const expires_at = now + clampLinkTtl(args.ttl_ms);
    const link_id = await ctx.db.insert("call_guest_links", {
      room_key: args.room_key,
      team_id: auth.teamId,
      token,
      created_by: userId,
      // The standing every later knock re-checks (creatorStillVouches).
      created_via: (await authorizeRoomNoGrant(ctx, userId, args.room_key)).ok ? "member" : "seat",
      created_at: now,
      expires_at,
    });
    return { link_id, token, path: guestJoinPath(token), expires_at, reused: false };
  },
});

/** The open links into a room, for the people who could make one. Null for
 *  anyone else rather than an error, like every room read a chip subscribes
 *  to, and null rather than empty because the answer is also the permission:
 *  a stage offers invite (and remove, which takes the same standing) only to
 *  a viewer this answers with a list. Counts are of guests present now. */
export const listGuestLinks = query({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    if (!(await authorizeRoomInviter(ctx, userId, args.room_key)).ok) return null;
    const now = Date.now();
    const links = (
      await ctx.db
        .query("call_guest_links")
        .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
        .collect()
    ).filter((l) => linkOpen(l, now));
    // Counts of the guests present now, from the room's own lease-bounded
    // reads (never every row a link ever made), tallied per link.
    const tally = new Map<string, { waiting: number; admitted: number }>();
    const count = (linkId: Id<"call_guest_links">, k: "waiting" | "admitted") => {
      const t = tally.get(String(linkId)) ?? { waiting: 0, admitted: 0 };
      t[k]++;
      tally.set(String(linkId), t);
    };
    for (const g of await roomGuestRows(ctx, args.room_key, "waiting", now)) if (isGuestPresent(g, now)) count(g.link_id, "waiting");
    for (const g of await admittedGuests(ctx, args.room_key, now)) count(g.link_id, "admitted");
    const out = [];
    for (const l of links.sort((a, b) => b.created_at - a.created_at)) {
      const creator = await ctx.db.get(l.created_by);
      out.push({
        link_id: l._id,
        token: l.token,
        path: guestJoinPath(l.token),
        created_by: String(l.created_by),
        created_by_name: teammateLabel(creator),
        mine: String(l.created_by) === String(userId),
        created_at: l.created_at,
        expires_at: l.expires_at,
        waiting: tally.get(String(l._id))?.waiting ?? 0,
        admitted: tally.get(String(l._id))?.admitted ?? 0,
      });
    }
    return out;
  },
});

/** How a guest will see this call on a link the viewer makes: the meeting's
 *  name and who invited them, from the same two functions the guest's page
 *  and the link's unfurl use (linkTitle, inviterOf), so the invite panel
 *  never says one thing while the link carries another (a private channel's
 *  name stays inside, and a viewer with no name is "A teammate"). Answered
 *  before any link exists, which is when it matters: the person is about to
 *  decide what to send. Null for anyone who could not make a link here. */
export const guestLinkPreview = query({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    if (!(await authorizeRoomInviter(ctx, userId, args.room_key)).ok) return null;
    return {
      title: await linkTitle(ctx, { room_key: args.room_key }),
      inviter: (await inviterOf(ctx, { created_by: userId })).name,
    };
  },
});

/** Turn a link off. Its creator may always (revoking only ever narrows), and
 *  so may anyone who could have made it. Waiting guests on it lose their
 *  place at the door (their page reads "closed"); admitted guests stay. */
export const revokeGuestLink = mutation({
  args: { link_id: v.id("call_guest_links") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const link = await ctx.db.get(args.link_id);
    if (!link) throw new Error("Link not found");
    if (String(link.created_by) !== String(userId) && !(await authorizeRoomInviter(ctx, userId, link.room_key)).ok) {
      throw new Error("Link not found");
    }
    await revokeLink(ctx, link, userId, Date.now());
    return { revoked: true };
  },
});

/** Let a waiting guest in. Pressing twice, or two people pressing at once,
 *  admits them once. `name` is the name the door showed whoever pressed: a
 *  guest who changed it since is asking under a different name, and the
 *  room is asked again rather than admitting somebody it did not see. */
export const admitGuest = mutation({
  args: { guest_id: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const guest = await guestForDoorkeeper(ctx, userId, args.guest_id, now);
    if (guest.status === "admitted") return { status: "admitted" as const };
    if (guest.status !== "waiting" || !isGuestPresent(guest, now)) {
      throw new Error(`${guest.name} is no longer at the door`);
    }
    if (args.name !== undefined && args.name !== guest.name) {
      throw new Error(`They are now asking to join as "${guest.name}". Check who it is before letting them in.`);
    }
    const refusal = await linkUsable(ctx, await ctx.db.get(guest.link_id), now);
    if (refusal) throw new Error(LINK_REFUSAL_FOR_ROOM[refusal]);
    // Admissions, not presence: a guest whose page went quiet still holds a
    // place until the sweep puts them out, so the cap cannot be slipped by
    // letting pages lapse. The cap itself is what bounds this read.
    if ((await roomGuestRows(ctx, guest.room_key, "admitted", now, { all: true })).length >= MAX_ROOM_GUESTS) {
      throw new Error(`A huddle holds at most ${MAX_ROOM_GUESTS} guests at once`);
    }
    await ctx.db.patch(guest._id, { status: "admitted", decided_by: userId, decided_at: now, media_seen_at: undefined });
    const live = await liveTranscriptFor(ctx, guest.room_key);
    if (live) await noteGuestAttendance(ctx, guest, live._id, now);
    await tellRoom(ctx, guest, userId, "guest_admitted");
    return { status: "admitted" as const };
  },
});

/** Turn a waiting guest away. They may ask again after a quiet minute.
 *  `revoke_link` also turns their link off, for the stranger who keeps
 *  coming back on a link that got out. */
export const denyGuest = mutation({
  args: { guest_id: v.string(), revoke_link: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const guest = await guestForDoorkeeper(ctx, userId, args.guest_id, now);
    if (args.revoke_link) await revokeLinkOf(ctx, guest, userId, now);
    if (guest.status !== "waiting") return { status: guest.status };
    await settleGuest(ctx, guest, { status: "denied", decided_by: userId, decided_at: now });
    await countTurnedAway(ctx, guest);
    return { status: "denied" as const };
  },
});

/** Put a guest out: at the door or inside. The row is done for good (a new
 *  knock needs a new row, which the room sees as somebody new), and the media
 *  server is made to agree whatever the row said before (a guest marked left
 *  can still be holding the media open). `revoke_link` shuts the door they
 *  came through in the same press. */
export const removeGuest = mutation({
  args: { guest_id: v.string(), revoke_link: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const guest = await guestForDoorkeeper(ctx, userId, args.guest_id, now);
    if (args.revoke_link) await revokeLinkOf(ctx, guest, userId, now);
    // Already removed: that removal's roster check is still running its tail.
    if (guest.status === "removed") return { status: "removed" as const };
    await settleGuest(ctx, guest, { status: "removed", decided_by: userId, decided_at: now });
    await countTurnedAway(ctx, guest);
    await tellRoom(ctx, guest, userId, "guest_removed");
    return { status: "removed" as const };
  },
});

/** A line in the room's thread for letting a stranger in or putting one out.
 *  The door is a moment only the people looking at it see; the thread is
 *  what everyone else reads later, and who opened the room to an outsider is
 *  a fact the room should keep. Turning a knock away is not written: nobody
 *  came in, and a denied stranger is no news to the meeting. */
async function tellRoom(
  ctx: any,
  guest: Doc<"call_guests">,
  userId: Id<"users">,
  event: "guest_admitted" | "guest_removed",
): Promise<void> {
  await postEvent(ctx, { room_key: guest.room_key, team_id: guest.team_id, user_id: userId, event, guest_name: guest.name });
}

async function revokeLinkOf(ctx: any, guest: Doc<"call_guests">, userId: Id<"users">, now: number): Promise<void> {
  const link: Doc<"call_guest_links"> | null = await ctx.db.get(guest.link_id);
  if (link) await revokeLink(ctx, link, userId, now);
}

/** One more person the room turned away or put out from this guest's link
 *  (guestKnocks' `link_turned_away`). */
async function countTurnedAway(ctx: any, guest: Doc<"call_guests">): Promise<void> {
  const link: Doc<"call_guest_links"> | null = await ctx.db.get(guest.link_id);
  if (link) await ctx.db.patch(link._id, { turned_away: (link.turned_away ?? 0) + 1 });
}

// ── The guest's side (no account) ──────────────────────────────────────────

/** What a link's page shows before the guest types anything: which meeting,
 *  who invited them, whether anybody is there yet, and the notice. Never the
 *  team, the members, or anything the creator could not see themselves. */
export const describeGuestLink = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const link = await linkByToken(ctx, args.token);
    const refusal = await linkUsable(ctx, link, now);
    if (refusal || !link) return { ok: false as const, reason: refusal ?? ("not_found" as const) };
    return {
      ok: true as const,
      title: await linkTitle(ctx, link),
      inviter: await inviterOf(ctx, link),
      expires_at: link.expires_at,
      live: await huddleAlive(ctx, link.room_key, now),
      ...(await roomNotice(ctx, link.room_key)),
    };
  },
});

/** How a guest is named on somebody's lock screen. Marked as a guest, like
 *  everywhere the room reads names, and never a link or an address: the
 *  name is whatever a stranger typed, and a push is no place to carry one. */
export function guestPushName(name: string): string {
  // normalizeGuestName already took the colon out of "https://", so the
  // scheme is matched as a word.
  return /(\bhttps?\b|www\.|@|\b[\w-]+\.[a-z]{2,}\b)/i.test(name) ? "A guest" : guestDisplayName(name);
}

/** Tell the link's creator that somebody is at the door of a room nobody is
 *  in. A guest is usually sent the link ahead of the meeting, so the common
 *  case is a guest arriving first, at a door nobody can see; inside a running
 *  huddle the door itself shows them. At most one push per link per
 *  GUEST_CREATOR_NOTICE_MS, however many people arrive on it (a link anybody
 *  can hold must not become a way to page its creator), naming everybody
 *  waiting on it when there is more than one, and at most one per
 *  GUEST_CREATOR_NOTICE_ANY_LINK_MS across every link that person made, so
 *  several links getting out do not multiply it. Returns the stamp to store on
 *  the guest's row, the push that covers them (sent now or within the
 *  window), or undefined when nobody was told.
 *
 *  The stamp is what the guest's page reads as "we let them know", so it is
 *  only made for word that is on its way. A creator who is at their desk has
 *  their push HELD (pushRouter holds a phone push for minutes while the
 *  desktop is in use), so that push is no claim: the app itself tells them
 *  (listGuestsWaiting), and stamps the row when it has (noteGuestsWaitingShown). */
async function tellCreatorIfAlone(
  ctx: any,
  link: Doc<"call_guest_links">,
  guest: { _id?: Id<"call_guests">; name: string },
  now: number,
): Promise<number | undefined> {
  const seats: Doc<"call_members">[] = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", link.room_key))
    .collect();
  if (liveMembers(seats, now).length > 0) return undefined;
  const creator = await ctx.db.get(link.created_by);
  // Only a phone hears this (enqueuePush skips anyone without one), and the
  // stamp is what the guest's page reads as "we let them know": no phone, no
  // stamp, and the page says only that someone can let them in.
  if (!creator?.push_token || !creator.notifications_enabled) return undefined;
  const atDesk = (await readPresence(ctx, creator, now)).active;
  if (link.creator_told_at && now - link.creator_told_at < GUEST_CREATOR_NOTICE_MS) return atDesk ? undefined : link.creator_told_at;
  // A push about another room's door does not cover this guest, so nobody is
  // claimed to have been told: their page says only that someone can let
  // them in, and the next arrival past the window sends word.
  const since = now - GUEST_CREATOR_NOTICE_ANY_LINK_MS;
  const toldLately: Doc<"call_guest_links">[] = await ctx.db
    .query("call_guest_links")
    .withIndex("by_creator_told", (q: any) => q.eq("created_by", link.created_by).gt("creator_told_at", since))
    .collect();
  if (toldLately.some((l) => (l.creator_told_at ?? 0) > since)) return undefined;
  const others = (await waitingGuests(ctx, link.room_key, now)).filter(
    (w) => String(w.link._id) === String(link._id) && String(w.guest._id) !== String(guest._id),
  );
  const title = await linkTitle(ctx, link);
  await enqueuePush(ctx, {
    user: creator,
    type: CALL_GUEST_WAITING_PUSH_TYPE,
    title: others.length > 0 ? `${others.length + 1} guests are waiting to join` : `${guestPushName(guest.name)} is waiting to join`,
    body: `They opened your guest link${title ? ` to ${title}` : ""}. Join the huddle to let them in.`,
    data: { type: CALL_GUEST_WAITING_PUSH_TYPE, room_key: link.room_key },
  });
  await ctx.db.patch(link._id, { creator_told_at: now });
  return atDesk ? undefined : now;
}

/** The guests waiting on the viewer's own links at a room NOBODY is in: the
 *  feed behind the app's "Ada (guest) is waiting to join" toast, its system
 *  notification and the Live now row. An outside invitee usually arrives
 *  before the meeting, at a door no teammate can see (the door itself is
 *  read only from inside the room, calls.getRoomKnocks), and until this feed
 *  the only word of them was a phone push, held for minutes while the person
 *  who sent the link sat at their desk. Only the viewer's own links: a link
 *  is its maker's vouching, and its maker is who the guest is waiting for.
 *  A room with somebody seated is left out, because there the door shows the
 *  guest to people who can answer it.
 *
 *  `present_until` is the end of the guest's lease as of their last beat.
 *  Nothing re-runs this query when a waiting page simply closes (no row
 *  changes until the sweep settles it), so the reader drops a row past it
 *  rather than announce somebody who gave up minutes ago. */
export const listGuestsWaiting = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    // Only links the clock still holds open: the range leaves expired ones
    // out of the read set (so their writes re-run nothing in any window),
    // and a guest can only be waiting on a live link anyway. linkOpen then
    // drops the revoked. The cap is a safety bound, never a window: nobody
    // keeps hundreds of live links, and were it ever reached, latest expiry
    // first keeps the links made most recently.
    const links = (
      await ctx.db
        .query("call_guest_links")
        .withIndex("by_creator_expires", (q) => q.eq("created_by", userId).gt("expires_at", now))
        .order("desc")
        .take(200)
    ).filter((l) => linkOpen(l, now));
    const out = [];
    for (const roomKey of new Set(links.map((l) => l.room_key))) {
      const waiting = (await waitingGuests(ctx, roomKey, now)).filter((w) => String(w.link.created_by) === String(userId));
      if (waiting.length === 0) continue;
      const seats: Doc<"call_members">[] = await ctx.db
        .query("call_members")
        .withIndex("by_room", (q) => q.eq("room_key", roomKey))
        .collect();
      if (liveMembers(seats, now).length > 0) continue;
      const title = await linkTitle(ctx, { room_key: roomKey });
      for (const { guest } of waiting) {
        out.push({
          guest_id: String(guest._id),
          name: guest.name,
          room_key: roomKey,
          title,
          knocked_at: guest.knocked_at,
          present_until: guest.last_seen + CALL_MEMBER_STALE_MS,
        });
      }
    }
    return out.sort((a, b) => a.knocked_at - b.knocked_at);
  },
});

/** The app showed the viewer that these guests are waiting (the toast went
 *  up in a window they are using). That is word delivered, which is the only
 *  thing the guest's page may call "we let them know": the stamp is made
 *  here, by the surface that did the telling, and only on the viewer's own
 *  links and a knock still standing. */
export const noteGuestsWaitingShown = mutation({
  args: { guest_ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    for (const id of args.guest_ids.slice(0, MAX_WAITING_GUESTS)) {
      const guest = await guestRow(ctx, id);
      if (!guest || guest.status !== "waiting") continue;
      if ((guest.creator_told_at ?? 0) >= guest.knocked_at) continue;
      const link = await ctx.db.get(guest.link_id);
      if (!link || String(link.created_by) !== String(userId)) continue;
      await ctx.db.patch(guest._id, { creator_told_at: now });
    }
    return null;
  },
});

/** Knock. The first knock from a browser makes the guest's row and returns
 *  its secret, ONCE: the page keeps it (localStorage) and passes it back on
 *  every later call. A knock from a row the browser already holds refreshes
 *  it: a guest who left or was turned away (after the cooldown) is back at
 *  the door, and a guest already admitted is simply told so. Taking the
 *  notice is part of knocking: nobody reaches the room without having been
 *  told it is transcribed and may be recorded. */
export const requestJoin = mutation({
  args: {
    token: v.string(),
    name: v.string(),
    accept_notice: v.literal(true),
    guest_id: v.optional(v.string()),
    secret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const link = await linkByToken(ctx, args.token);
    const refusal = await linkUsable(ctx, link, now);
    if (refusal || !link) throw new Error(GUEST_LINK_REFUSAL_TEXT[refusal ?? "not_found"]);
    const name = normalizeGuestName(args.name);
    if (!name) throw new Error("Type the name the room should see");

    const prior =
      args.guest_id && args.secret ? await guestBySecret(ctx, args.guest_id, args.secret) : null;
    // A row from another link is somebody else's door: the browser held on to
    // an old guest id, and this knock starts fresh on the link it came in by.
    const mine = prior && String(prior.link_id) === String(link._id) ? prior : null;
    const waiting = await waitingGuests(ctx, link.room_key, now);

    if (mine) {
      if (mine.status === "removed") throw new Error("You were removed from this call");
      if (mine.status === "admitted" && (await huddleAlive(ctx, link.room_key, now))) {
        await ctx.db.patch(mine._id, { last_seen: now });
        return { guest_id: String(mine._id), secret: null, status: "admitted" as const };
      }
      // Back from a blink the room never decided on (a phone that slept, a
      // lobby left open too long): the same place again, no knock, while the
      // huddle they were let into runs and it holds a place for them.
      if (await guestResumable(ctx, mine, now)) {
        if ((await roomGuestRows(ctx, mine.room_key, "admitted", now, { all: true })).length >= MAX_ROOM_GUESTS) {
          throw new Error(`The call is full: ${MAX_ROOM_GUESTS} guests are already in it. Try again in a minute.`);
        }
        await ctx.db.patch(mine._id, { status: "admitted", last_seen: now, left_reason: undefined, media_seen_at: undefined });
        return { guest_id: String(mine._id), secret: null, status: "admitted" as const };
      }
      if (mine.status === "denied" && now - (mine.decided_at ?? 0) < GUEST_DENY_COOLDOWN_MS) {
        throw new Error("The room said not now. You can ask again in a minute.");
      }
      const atDoor = waiting.some((w) => String(w.guest._id) === String(mine._id));
      if (!atDoor && !doorHasRoom(waiting, link._id, mine._id)) throw new Error(DOOR_FULL_TEXT);
      // A knock the room is already showing is refreshed at most every few
      // seconds: the door's signature is this stamp, and a page that knocks
      // on a loop must not make it flicker. A new name is a new knock, so
      // the door shows the room who is asking now.
      const freshKnock = !atDoor || mine.name !== name || now - mine.knocked_at >= GUEST_REKNOCK_MIN_MS;
      const told = atDoor ? undefined : await tellCreatorIfAlone(ctx, link, { ...mine, name }, now);
      await ctx.db.patch(mine._id, {
        status: "waiting",
        name,
        knocked_at: freshKnock ? now : mine.knocked_at,
        last_seen: now,
        notice_accepted_at: now,
        decided_by: undefined,
        decided_at: undefined,
        left_reason: undefined,
        ...(told ? { creator_told_at: told } : {}),
      });
      // An admission whose huddle ended under a page still connected: the
      // row is back at the door, and the media room has to agree.
      if (mine.status === "admitted") await checkGuestRoster(ctx, mine.room_key);
      return { guest_id: String(mine._id), secret: null, status: "waiting" as const };
    }

    // A new person at the door: the link's rate and the waiting places both
    // bound how many a leaked link can produce. A denial or removal is of
    // the ROW, by design: somebody turned away who starts over without their
    // secret (a private window) comes back as a new row, under the rate and
    // the caps like anybody new, and the door shows the room how many it has
    // already turned away from this link, next to the one control that does
    // stop a link that got out (deny or remove with revoke_link).
    const recent = await ctx.db
      .query("call_guests")
      .withIndex("by_link", (q) => q.eq("link_id", link._id))
      .order("desc")
      .take(GUEST_KNOCKS_PER_LINK_PER_MINUTE);
    if (
      recent.length >= GUEST_KNOCKS_PER_LINK_PER_MINUTE &&
      recent.every((g) => now - g.created_at < 60_000)
    ) {
      throw new Error("Too many people are joining from this link right now. Try again in a minute.");
    }
    if (!doorHasRoom(waiting, link._id)) throw new Error(DOOR_FULL_TEXT);
    const secret = newSlug(GUEST_SECRET_LENGTH);
    const told = await tellCreatorIfAlone(ctx, link, { name }, now);
    const guestId = await ctx.db.insert("call_guests", {
      link_id: link._id,
      room_key: link.room_key,
      team_id: link.team_id,
      name,
      secret_hash: await sha256Hex(secret),
      status: "waiting",
      created_at: now,
      knocked_at: now,
      last_seen: now,
      notice_accepted_at: now,
      ...(told ? { creator_told_at: told } : {}),
    });
    return { guest_id: String(guestId), secret, status: "waiting" as const };
  },
});

/** The guest page's beat, every CALL_HEARTBEAT_MS while it is open, at the
 *  door and inside. Keeps the lease, puts a returning page back at the door
 *  (a knock whose lease lapsed is refreshed as a new knock) when the door has
 *  a place for it, puts the guest on the attendance of the huddle's record
 *  once there is one, and settles an admission whose huddle has ended.
 *  Returns what the page should show; `door_full` says a page that came back
 *  found every waiting place taken and is not at the door until one frees.
 *
 *  It also keeps getGuestState honest. That query answers from the clock as
 *  well as the rows (a link's expiry, the end of a huddle's grace), and
 *  Convex re-runs a query only when a row it read changes, so each beat
 *  stamps what it computed (beat_view) whenever it moved: the subscription
 *  then follows within a beat even when nothing else was written. */
export const guestHeartbeat = mutation({
  // `in_media`: this page is connected to the call's media right now, which
  // tells a place let go with nobody in it ("not_joined") from a dropped one.
  args: { guest_id: v.string(), secret: v.string(), in_media: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return null;
    const now = Date.now();
    if (guest.status === "admitted") {
      if (!(await huddleAlive(ctx, guest.room_key, now))) {
        // Everybody from the team is gone past the grace: the admission was
        // for that huddle. A page still connected is put out of the media
        // room too, so a guest alone cannot become the next huddle.
        await settleGuest(ctx, guest, { status: "left", left_reason: "huddle_ended" });
        return { view: "ended" as const };
      }
      await ctx.db.patch(guest._id, { last_seen: now, ...(args.in_media ? { media_seen_at: now } : {}), ...beatView(guest, "admitted") });
      const live = await liveTranscriptFor(ctx, guest.room_key);
      if (live) await noteGuestAttendance(ctx, guest, live._id, now);
      return { view: "admitted" as const };
    }
    if (guest.status === "waiting") {
      const link = await ctx.db.get(guest.link_id);
      const closed = !!(await linkUsable(ctx, link, now));
      const view = guestView(guest, { huddleRunning: false, linkClosed: closed });
      const stamp = beatView(guest, `${view}:${(await huddleAlive(ctx, guest.room_key, now)) ? "live" : "quiet"}`);
      if (closed || !link) {
        if (stamp.beat_view) await ctx.db.patch(guest._id, stamp);
        return { view };
      }
      // A page that is not at the door right now (its lease lapsed) takes a
      // place there again only if the door has one, by the same rule as a
      // knock: otherwise a script could let rows lapse and beat them all
      // back at once, past every cap.
      if (!isGuestPresent(guest, now) && !doorHasRoom(await waitingGuests(ctx, guest.room_key, now), link._id, guest._id)) {
        if (stamp.beat_view) await ctx.db.patch(guest._id, stamp);
        return { view, door_full: true as const };
      }
      // Back after a real absence is a new knock (the door sounds again).
      // A beat that merely ran late (a background tab's timers are slowed
      // to about one a minute) keeps the knock it had: the door's signature
      // is knocked_at, and moving it would ring the room every minute for
      // the same person standing in the same place.
      const back = now - guest.last_seen >= GUEST_ADMISSION_LAPSE_MS;
      const told = back ? await tellCreatorIfAlone(ctx, link, guest, now) : undefined;
      await ctx.db.patch(guest._id, {
        last_seen: now,
        ...stamp,
        ...(back ? { knocked_at: now } : {}),
        ...(told ? { creator_told_at: told } : {}),
      });
      return { view };
    }
    return { view: guestView(guest, { huddleRunning: false, linkClosed: false }) };
  },
});

/** The patch that records what a beat computed, or nothing when it is what
 *  the row already says (a beat writes it only when it moves). */
function beatView(guest: Pick<Doc<"call_guests">, "beat_view">, sig: string): { beat_view?: string } {
  return guest.beat_view === sig ? {} : { beat_view: sig };
}

/** Everything the guest's page renders after knocking, reactive: where they
 *  stand, the meeting's name, whether anybody is there, and the notice, which
 *  stays true while they are inside (a recording started mid-call shows up
 *  here as it starts). Null for a wrong id or secret: the page starts over.
 *
 *  What the room is doing is for somebody who may be part of it: at the door,
 *  inside, or out of it on a link that would let them knock again. A guest
 *  who was removed, turned away, or whose link stopped working learns where
 *  they stand and nothing more, so a secret kept after being put out is not
 *  a window onto the room. */
export const getGuestState = query({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return null;
    const now = Date.now();
    const link = await ctx.db.get(guest.link_id);
    const linkClosed = !!(await linkUsable(ctx, link, now));
    const live = guest.status === "admitted" ? await huddleAlive(ctx, guest.room_key, now) : false;
    const view = guestView(guest, { huddleRunning: live, linkClosed });
    const base = {
      view,
      name: guest.name,
      // Why a guest who is out is out ("self", "huddle_ended", "lapsed").
      left_reason: guest.status === "left" ? (guest.left_reason ?? null) : null,
      // When a turned-away guest may knock again; null otherwise.
      retry_at: guest.status === "denied" ? (guest.decided_at ?? 0) + GUEST_DENY_COOLDOWN_MS : null,
      // When this knock began, for the door's "waiting N min" (a reload must
      // not restart the clock), and whether the link's creator was sent word
      // of it (tellCreatorIfAlone), so the page only says "we let them know"
      // when somebody was actually told.
      knocked_at: guest.status === "waiting" ? guest.knocked_at : null,
      creator_told: guest.status === "waiting" && !!guest.creator_told_at && guest.creator_told_at >= guest.knocked_at - GUEST_CREATOR_NOTICE_MS,
      // A guest who left, was turned away or whose huddle ended may knock
      // again on a link that still works; their page offers it only then.
      link_open: !linkClosed,
      // Let go without anybody deciding it, and may walk straight back in
      // (guestResumable): the page rejoins rather than knocking.
      resumable: await guestResumable(ctx, guest, now),
    };
    const inTheRoom = view === "waiting" || view === "admitted" || base.resumable || ((view === "left" || view === "ended") && !linkClosed);
    if (!inTheRoom || !link) return { ...base, room: null };
    return {
      ...base,
      room: {
        title: await linkTitle(ctx, link),
        inviter: await inviterOf(ctx, link),
        live: view === "admitted" ? live : await huddleAlive(ctx, guest.room_key, now),
        ...(await roomNotice(ctx, guest.room_key)),
      },
    };
  },
});

/** The guest walks out, from the door or from inside. From inside, the media
 *  room is made to agree: a page that says "leave" and keeps the connection
 *  is out all the same. */
export const leaveCall = mutation({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return null;
    if (guest.status === "admitted" || guest.status === "waiting") {
      await settleGuest(ctx, guest, { status: "left", left_reason: "self" });
    }
    return { view: "left" as const };
  },
});

// ── Media ──────────────────────────────────────────────────────────────────

/** Who the media token is for, or why not (a GuestJoinRefusal the page acts
 *  on). A query so the hash, the status and the huddle are read at one
 *  instant. */
export const authForGuestToken = internalQuery({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const refuse = (reason: GuestJoinRefusal) => ({ ok: false as const, reason });
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return refuse("not_a_guest");
    if (guest.status !== "admitted") return refuse(guest.status === "removed" ? "removed" : "not_admitted");
    if (!(await huddleAlive(ctx, guest.room_key, Date.now()))) return refuse("ended");
    if (!(await teamHasFeature(ctx, guest.team_id, "calls"))) return refuse("unavailable");
    return { ok: true as const, room_key: guest.room_key, identity: guestIdentity(String(guest._id)), name: guest.name };
  },
});

/** A LiveKit token for an admitted guest, minted on connect and on every
 *  reconnect. Shorter lived than a member's (GUEST_TOKEN_TTL_S): LiveKit
 *  refreshes a connected participant's token by itself, so no lifetime ends a
 *  session, and removal is enforced server side (enforceGuestRoster); the
 *  short life only bounds how long a token copied out of a removed guest's
 *  client could get them back in before the roster check finds them.
 *
 *  What a guest may do: talk, show their camera, share a screen, and send on
 *  the data channel (the shared-screen cursors ride it). A guest shares a
 *  screen because showing something is half of why you bring someone outside
 *  into a meeting. What a guest may NOT do is rename themselves:
 *  canUpdateOwnMetadata is off, so the name the room admitted is the name
 *  every face, transcript line and recording carries. The identity prefix
 *  (guest:) is set here and nowhere else, which is what lets every surface
 *  tell a guest from a teammate or an agent (callParticipantKind). The
 *  media server's NAME is marked too (guestDisplayName: "Ada (guest)"),
 *  because some readers see only the name: the recording's tile labels, the
 *  file a screen share is saved under, any LiveKit tooling. A guest typing a
 *  teammate's name cannot pass for them in the artifact that outlives the
 *  call. Surfaces with a badge of their own show the first name beside it
 *  (firstName drops the mark), and normalizeGuestName strips it, so it never
 *  doubles. The page gets the plain name back for its own "you". */
export const mintGuestToken = action({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args): Promise<{ url: string; token: string; identity: string; name: string }> => {
    const cfg = livekitConfigFromEnv();
    if (!cfg) throw new Error("Calling is not configured");
    const auth = await ctx.runQuery(internal.callGuests.authForGuestToken, args);
    if (!auth.ok) throw new ConvexError({ code: auth.reason, message: GUEST_JOIN_REFUSAL_TEXT[auth.reason] });
    const token = await signLivekitJwt({
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      identity: auth.identity,
      name: guestDisplayName(auth.name),
      room: auth.room_key,
      metadata: JSON.stringify({ guest: true }),
      ttlSeconds: GUEST_TOKEN_TTL_S,
      grant: {
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true,
        canUpdateOwnMetadata: false,
      },
    });
    return { url: cfg.url, token, identity: auth.identity, name: auth.name };
  },
});

/** The guest identities the room allows in its media right now: admitted, in
 *  a huddle that is still running, of a team that still has calls on (a team
 *  switching calls off puts its guests out, not only stops new tokens).
 *  Everyone else with a guest identity is somebody the rows have already put
 *  out. */
export const allowedGuestIdentities = internalQuery({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    const now = Date.now();
    if (!(await huddleAlive(ctx, args.room_key, now))) return [];
    const teams = new Map<string, boolean>();
    const out: string[] = [];
    for (const g of await roomGuestRows(ctx, args.room_key, "admitted", now, { all: true })) {
      const key = String(g.team_id);
      if (!teams.has(key)) teams.set(key, await teamHasFeature(ctx, g.team_id, "calls"));
      if (teams.get(key)) out.push(guestIdentity(String(g._id)));
    }
    return out;
  },
});

/** Make the media room agree with the rows: list who LiveKit has in it, then
 *  ask the rows who is allowed, and put out every guest identity they do not
 *  allow (rights first, then the connection: livekitServer.putOutOfRoom).
 *  Listing FIRST: a guest admitted and connected between the two reads is in
 *  the listing and, read second, in the allowed set too, so the check never
 *  ejects somebody the room just let in. Then look again down the tail
 *  (lib/callGuestAdmission says why one eject is not enough). A LiveKit that
 *  does not answer is tried again on the next step; the minute sweep covers
 *  a tail that ran out while it was down. */
export const enforceGuestRoster = internalAction({
  args: { room_key: v.string(), tail: v.number() },
  handler: async (ctx, args) => {
    const cfg = livekitConfigFromEnv();
    if (!cfg) return { removed: 0 };
    let removed = 0;
    try {
      const guests = (await listParticipants(cfg, args.room_key)).filter((p) => isGuestIdentity(p.identity));
      const inMedia: string[] = [];
      if (guests.length > 0) {
        const allowed = new Set(await ctx.runQuery(internal.callGuests.allowedGuestIdentities, { room_key: args.room_key }));
        for (const p of guests) {
          if (allowed.has(p.identity)) {
            inMedia.push(p.identity);
            continue;
          }
          await putOutOfRoom(cfg, args.room_key, p.identity);
          removed++;
        }
      }
      // Told even when the listing holds no guest at all: that is exactly the
      // listing that says a guest who closed their tab has left the media.
      await ctx.runMutation(internal.callGuests.noteGuestsInMedia, { room_key: args.room_key, identities: inMedia });
    } catch (err) {
      console.warn(`[callGuests] roster check failed for ${args.room_key}:`, err);
    }
    const next = GUEST_ROSTER_TAIL_MS[args.tail];
    if (next !== undefined) {
      await ctx.scheduler.runAfter(next, internal.callGuests.enforceGuestRoster, { room_key: args.room_key, tail: args.tail + 1 });
    }
    return { removed };
  },
});

/** What a roster listing says about the room's admitted guests, both ways.
 *
 *  Listed: seen, page beat or not. A phone suspends a background tab's
 *  timers within seconds, so a guest who glanced at a message for two
 *  minutes would otherwise be let go by the sweep while their connection
 *  never dropped. The roster check that lists them runs every minute for a
 *  room with guests in it, inside the lapse window, so a guest LiveKit holds
 *  never lapses.
 *
 *  Not listed, after having been (media_seen_at), with a page quiet past a
 *  seat's lease: gone. That is a closed tab, not a pocketed phone (LiveKit
 *  keeps a sleeping client listed) and not a reconnect (LiveKit keeps a
 *  reconnecting participant listed, and the page beats through it). Waiting
 *  out the whole lapse window for them left a guest nobody could see on
 *  every member's face row and room count for minutes after LiveKit let
 *  them go. Let go as "lapsed", which stays resumable (GUEST_RESUME_MS), so
 *  a page that does come back walks in without knocking. A guest admitted
 *  but not yet in the media has no media_seen_at (admitting clears it), so
 *  somebody still connecting is never mistaken for somebody who left. */
export const noteGuestsInMedia = internalMutation({
  args: { room_key: v.string(), identities: v.array(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const listed = new Set(args.identities);
    let touched = 0;
    const gone: Doc<"call_guests">[] = [];
    for (const g of await roomGuestRows(ctx, args.room_key, "admitted", now, { all: true })) {
      if (!listed.has(guestIdentity(String(g._id)))) {
        if (g.media_seen_at && now - g.last_seen >= CALL_MEMBER_STALE_MS) gone.push(g);
        continue;
      }
      await ctx.db.patch(g._id, { last_seen: Math.max(g.last_seen, now), media_seen_at: now });
      touched++;
    }
    await settleGuests(ctx, args.room_key, gone, { status: "left", left_reason: "lapsed" });
    return { touched, lapsed: gone.length };
  },
});

/** Admitted guests whose pages went quiet past the lapse window, checked
 *  against the media server before their places are let go: one LiveKit
 *  still lists is alive (a phone in a pocket keeps its call while its page
 *  sleeps) and is kept, as the roster check would. A media server that does
 *  not answer cannot vouch for anyone, so the quiet are let go as before. */
export const lapseQuietGuests = internalAction({
  args: { room_key: v.string(), guest_ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<{ kept: number; lapsed: number }> => {
    const cfg = livekitConfigFromEnv();
    let inMedia: string[] = [];
    if (cfg) {
      try {
        inMedia = (await listParticipants(cfg, args.room_key)).map((p) => p.identity).filter(isGuestIdentity);
      } catch (err) {
        console.warn(`[callGuests] could not list ${args.room_key} before letting quiet guests go:`, err);
      }
    }
    return await ctx.runMutation(internal.callGuests.settleQuietGuests, { ...args, in_media: inMedia });
  },
});

/** The second half of lapseQuietGuests: each guest read again (a beat may
 *  have landed meanwhile), kept when the media server listed them, let go
 *  ("lapsed", or "not_joined" for a place nobody ever came into) when not. */
export const settleQuietGuests = internalMutation({
  args: { room_key: v.string(), guest_ids: v.array(v.string()), in_media: v.array(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const listed = new Set(args.in_media);
    const out: Record<"lapsed" | "not_joined", Doc<"call_guests">[]> = { lapsed: [], not_joined: [] };
    let kept = 0;
    for (const id of args.guest_ids) {
      const g = await guestRow(ctx, id);
      if (!g || g.room_key !== args.room_key || g.status !== "admitted" || now - g.last_seen < GUEST_ADMISSION_LAPSE_MS) continue;
      if (listed.has(guestIdentity(String(g._id)))) {
        await ctx.db.patch(g._id, { last_seen: now, media_seen_at: now });
        kept++;
        continue;
      }
      out[quietReason(g)].push(g);
    }
    for (const reason of ["lapsed", "not_joined"] as const) {
      await settleGuests(ctx, args.room_key, out[reason], { status: "left", left_reason: reason });
    }
    return { kept, lapsed: out.lapsed.length + out.not_joined.length };
  },
});

/** A knock whose page has been gone this long is abandoned, not waiting: the
 *  sweep settles it ("lapsed"), and the guest's page, if it ever comes back,
 *  knocks again. Long past the door's own lease (which already hides it) so
 *  a page that was only in the background comes back to the door by its
 *  beat; short enough that rows from closed pages do not pile up. */
export const GUEST_WAITING_ABANDONED_MS = 15 * 60_000;

/** Every minute, needing nobody's cooperation, guest's or teammate's:
 *   - every room with a guest admitted: end the admissions of a huddle that
 *     is over (nobody may be left to notice: the last teammate's tab died, a
 *     script stopped beating), put out a guest whose page has been quiet
 *     past GUEST_ADMISSION_LAPSE_MS, and check the media room;
 *   - every running huddle whose room put a guest out within
 *     GUEST_SETTLED_WATCH_MS: check the media room, for the client that
 *     reconnected on a token LiveKit refreshed after the roster tail ended;
 *   - every knock abandoned past GUEST_WAITING_ABANDONED_MS: settled, so a
 *     leaked link's lapsed rows do not pile up. */
export const sweepGuestRooms = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const admitted = await ctx.db
      .query("call_guests")
      .withIndex("by_status_seen", (q) => q.eq("status", "admitted"))
      .collect();
    const rooms = new Map<string, Doc<"call_guests">[]>();
    for (const g of admitted) rooms.set(g.room_key, [...(rooms.get(g.room_key) ?? []), g]);
    let ended = 0;
    let lapsed = 0;
    for (const [roomKey, guests] of rooms) {
      if (!(await huddleAlive(ctx, roomKey, now))) {
        ended += await endGuestAdmissions(ctx, roomKey);
        continue;
      }
      // A quiet page is not yet a guest gone: a phone suspends a background
      // tab's timers long before it drops the call. The media server is asked
      // first (lapseQuietGuests), and only a guest it does not hold is let go.
      const quiet = guests.filter((g) => now - g.last_seen >= GUEST_ADMISSION_LAPSE_MS);
      if (quiet.length > 0) {
        await ctx.scheduler.runAfter(0, internal.callGuests.lapseQuietGuests, {
          room_key: roomKey,
          guest_ids: quiet.map((g) => String(g._id)),
        });
      } else {
        await checkGuestRoster(ctx, roomKey, { once: true });
      }
      lapsed += quiet.length;
    }

    const settled = await ctx.db
      .query("call_guests")
      .withIndex("by_settled", (q) => q.gt("settled_at", now - GUEST_SETTLED_WATCH_MS))
      .take(1000);
    const watched = new Set<string>();
    for (const g of settled) {
      if (rooms.has(g.room_key) || watched.has(g.room_key)) continue;
      watched.add(g.room_key);
      if (await huddleAlive(ctx, g.room_key, now)) await checkGuestRoster(ctx, g.room_key, { once: true });
    }

    const abandoned = await ctx.db
      .query("call_guests")
      .withIndex("by_status_seen", (q) => q.eq("status", "waiting").lt("last_seen", now - GUEST_WAITING_ABANDONED_MS))
      .take(500);
    const byRoom = new Map<string, Doc<"call_guests">[]>();
    for (const g of abandoned) byRoom.set(g.room_key, [...(byRoom.get(g.room_key) ?? []), g]);
    for (const [roomKey, rows] of byRoom) await settleGuests(ctx, roomKey, rows, { status: "left", left_reason: "lapsed" });

    return { rooms: rooms.size, ended, lapsed, watched: watched.size, abandoned: abandoned.length };
  },
});
