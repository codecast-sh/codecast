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
//   the page goes quiet   -> left      (left_reason "lapsed", by the sweep)
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
// leaves the team, or loses the room, takes their links with them.
// Removing someone is its own act (removeGuest), because revoking a link to
// stop it spreading should not hang up on the client you are talking to.
//
// Presence is the seat lease (isGuestPresent, CALL_MEMBER_STALE_MS): the
// guest's page beats while it is open. A knock from a closed page drops off
// the door within one window; an admitted guest whose page blinked stays
// admitted and simply reconnects, since presence decides what the room shows
// and the admission decides what the server allows. A page quiet for longer
// than a blink (GUEST_ADMISSION_LAPSE_MS) ends the admission: an unseen
// guest is not left holding the media open.
import { v } from "convex/values";
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
  authorizeRoomMembership,
  authorizeRoomNoGrant,
  liveMembers,
  liveSeat,
  parseRoomKey,
  readRoomState,
} from "./callRooms";
import { liveTranscriptFor } from "./callChat";
import { huddleAlive } from "./transcripts";
import { isTeamMember } from "./privacy";
import { teamHasFeature } from "./teamFeatures";
import { bucketTs } from "./presenceState";
import { enqueuePush } from "./pushRouter";
import { signLivekitJwt } from "./lib/livekitJwt";
import { listParticipants, livekitConfigFromEnv, removeParticipant } from "./lib/livekitServer";
import { sha256Hex } from "./lib/hash";
import { newSlug } from "./lib/slug";
import { isRoomRecording } from "./lib/callRecordingRuns";
import { personImage, publicPersonLabel, teammateLabel } from "./lib/personLabel";
import {
  GUEST_ROSTER_TAIL_MS,
  checkGuestRoster,
  endGuestAdmissions,
  noteGuestAttendance,
  settleGuest,
} from "./lib/callGuestAdmission";
import {
  CALL_GUEST_WAITING_PUSH_TYPE,
  GUEST_ADMISSION_LAPSE_MS,
  GUEST_CREATOR_NOTICE_MS,
  GUEST_DENY_COOLDOWN_MS,
  GUEST_KNOCKS_PER_LINK_PER_MINUTE,
  GUEST_LINK_MAX_TTL_MS,
  GUEST_LINK_MIN_TTL_MS,
  GUEST_LINK_TTL_MS,
  GUEST_REKNOCK_MIN_MS,
  GUEST_TOKEN_TTL_S,
  MAX_ROOM_GUESTS,
  MAX_WAITING_GUESTS,
  MAX_WAITING_PER_LINK,
  guestIdentity,
  guestJoinPath,
  isGuestIdentity,
  isGuestPresent,
  normalizeGuestName,
  type CallGuestView,
} from "@codecast/shared/contracts";

// The link token is the whole secret of a link, and the guest secret the
// whole proof of a guest; both are far past guessing (~143 and ~190 bits).
const LINK_TOKEN_LENGTH = 24;
const GUEST_SECRET_LENGTH = 32;

// ── Pure rules (exported for tests) ───────────────────────────────────────

/** Has this link neither expired nor been turned off? */
export function linkOpen(link: Pick<Doc<"call_guest_links">, "revoked_at" | "expires_at">, now: number): boolean {
  return !link.revoked_at && now < link.expires_at;
}

/** Every reason a link turns a guest away. The first three are the link's
 *  own; `unavailable` is the team (calls switched off), `inviter_gone` is the
 *  person whose standing the link lived on (linkUsable). */
export type LinkRefusal = "not_found" | "revoked" | "expired" | "unavailable" | "inviter_gone";

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
 *  left, a session gone private), and a teammate who made it from a seat in
 *  somebody's huddle must still be on the team. The same walls every grant
 *  in callRooms dies at. */
async function creatorStillVouches(ctx: any, link: Doc<"call_guest_links">): Promise<boolean> {
  if (link.created_via === "seat") return await isTeamMember(ctx, link.created_by, link.team_id);
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
): Promise<LinkRefusal | null> {
  const own = linkRefusal(link, now);
  if (own || !link) return own ?? "not_found";
  if (!(await teamHasFeature(ctx, link.team_id, "calls"))) return "unavailable";
  if (!(await creatorStillVouches(ctx, link))) return "inviter_gone";
  return null;
}

/** A room's guests in one status, sorted by id so a subscription that
 *  carries them stays byte-stable between beats. */
async function guestRows(ctx: any, roomKey: string, status: "waiting" | "admitted"): Promise<Doc<"call_guests">[]> {
  const rows: Doc<"call_guests">[] = await ctx.db
    .query("call_guests")
    .withIndex("by_room_status", (q: any) => q.eq("room_key", roomKey).eq("status", status))
    .collect();
  return rows.sort((a, b) => String(a._id).localeCompare(String(b._id)));
}

/** The guests inside the room right now, each present by its lease. What the
 *  room lists; the cap on guests counts admissions instead (guestRows), so a
 *  guest whose page went quiet still holds their place until they are out. */
export async function admittedGuests(ctx: any, roomKey: string, now: number): Promise<Doc<"call_guests">[]> {
  return (await guestRows(ctx, roomKey, "admitted")).filter((g) => isGuestPresent(g, now));
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
  for (const guest of await guestRows(ctx, roomKey, "waiting")) {
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
 *  counts the people already denied or removed from the same link: past one,
 *  the door offers to turn the link off rather than keep answering it. */
export async function guestKnocks(ctx: any, roomKey: string, now: number, canAnswer: boolean) {
  const turnedAway = new Map<string, number>();
  const out = [];
  for (const { guest, link } of await waitingGuests(ctx, roomKey, now)) {
    const key = String(link._id);
    if (!turnedAway.has(key)) {
      const onLink: Doc<"call_guests">[] = await ctx.db
        .query("call_guests")
        .withIndex("by_link", (q: any) => q.eq("link_id", link._id))
        .collect();
      turnedAway.set(key, onLink.filter((g) => g.status === "denied" || g.status === "removed").length);
    }
    out.push({
      from_user: guestIdentity(String(guest._id)),
      from_name: guest.name,
      from_image: undefined as string | undefined,
      created_at: guest.knocked_at,
      kind: "guest" as const,
      guest_id: String(guest._id),
      link_id: key,
      link_turned_away: turnedAway.get(key)!,
      can_answer: canAnswer,
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
 *  transcribed, and is it being recorded. Every huddle transcribes unless the
 *  room switched it off (calls.setRoomTranscribeOff); recording is a composite
 *  run in progress (call_recordings), which is what puts their face on file. */
async function roomNotice(ctx: any, roomKey: string): Promise<{ transcribed: boolean; recording: boolean }> {
  return {
    transcribed: !(await readRoomState(ctx, roomKey))?.transcribe_off,
    recording: await isRoomRecording(ctx, roomKey),
  };
}

/** The name the guest's page gives the meeting: the anchor the creator could
 *  see, and nothing they could not. A channel reads as its name; a session
 *  reads as its title only when the CREATOR may see that conversation (a
 *  teammate who walked into a session huddle through the open door was never
 *  shown its title, so their link cannot show it to a stranger: the same
 *  redaction getLiveRooms applies); a people room has no title, and the page
 *  names it after whoever invited them. */
async function linkTitle(ctx: any, link: Doc<"call_guest_links">): Promise<string | null> {
  const parsed = parseRoomKey(link.room_key);
  if (parsed?.kind === "channel") {
    const channel = await ctx.db.get(parsed.channelId as Id<"chat_channels">);
    return channel?.name ? `#${channel.name}` : null;
  }
  if (parsed?.kind === "session") {
    if (!(await authorizeRoomMembership(ctx, link.created_by, link.room_key)).ok) return null;
    const conv = await ctx.db.get(parsed.conversationId as Id<"conversations">);
    return conv?.title?.trim() || null;
  }
  return null;
}

/** Who sent the link, as somebody outside the team may see them: a name,
 *  never an address (the link travels; personLabel says why). */
async function inviterOf(ctx: any, link: Doc<"call_guest_links">) {
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

/** What the guest's page says for each refusal, in words for somebody who has
 *  never heard of codecast and only wants to get into a meeting. */
const LINK_REFUSAL_TEXT: Record<LinkRefusal, string> = {
  not_found: "This link isn't valid. Ask whoever sent it for a new one.",
  revoked: "This link was turned off. Ask whoever sent it for a new one.",
  expired: "This link has expired. Ask whoever sent it for a new one.",
  unavailable: "This meeting isn't taking guests right now.",
  inviter_gone: "Whoever sent this link can no longer invite guests to this meeting. Ask someone else in it for a new one.",
};

/** The same refusals as the room hears them, when somebody tries to let in a
 *  guest whose link stopped working while they waited. */
const LINK_REFUSAL_FOR_ROOM: Record<LinkRefusal, string> = {
  not_found: "That guest's link no longer exists",
  revoked: "That guest's link was turned off",
  expired: "That guest's link expired",
  unavailable: "Calls are switched off for this team",
  inviter_gone: "Whoever made that guest's link can no longer invite guests",
};

// ── The room's side (signed in) ────────────────────────────────────────────

async function requireUser(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

/** The caller is inside the guest's room right now, with the authority to
 *  widen it. Seated is what answering a door takes (the person knocking asks
 *  the meeting, not the room's owner); the inviter rule on top keeps a
 *  channel room's own wall, as it does for ringing a teammate in. The door
 *  learns the same answer up front (getRoomKnocks' `can_answer`). */
async function requireDoorkeeper(ctx: any, userId: Id<"users">, roomKey: string, now: number) {
  const seat = await liveSeat(ctx, userId, roomKey, now);
  if (!seat) throw new Error("Only someone in the huddle can do that");
  const auth = await authorizeRoomInviter(ctx, userId, roomKey);
  if (!auth.ok) throw new Error(`Cannot answer the door: ${auth.reason}`);
  return seat;
}

async function guestForRoom(ctx: any, guestId: string): Promise<Doc<"call_guests">> {
  const row = await guestRow(ctx, guestId);
  if (!row) throw new Error("Guest not found");
  return row;
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

/** The open links into a room, for the people who could make one. Empty for
 *  anyone else rather than an error, like every room read a chip subscribes
 *  to. Counts are of guests present right now. */
export const listGuestLinks = query({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    if (!(await authorizeRoomInviter(ctx, userId, args.room_key)).ok) return [];
    const now = Date.now();
    const links = (
      await ctx.db
        .query("call_guest_links")
        .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
        .collect()
    ).filter((l) => linkOpen(l, now));
    const out = [];
    for (const l of links.sort((a, b) => b.created_at - a.created_at)) {
      const guests = (
        await ctx.db
          .query("call_guests")
          .withIndex("by_link", (q) => q.eq("link_id", l._id))
          .collect()
      ).filter((g) => isGuestPresent(g, now));
      out.push({
        link_id: l._id,
        token: l.token,
        path: guestJoinPath(l.token),
        created_by: String(l.created_by),
        created_by_name: teammateLabel(await ctx.db.get(l.created_by)),
        mine: String(l.created_by) === String(userId),
        created_at: l.created_at,
        expires_at: l.expires_at,
        waiting: guests.filter((g) => g.status === "waiting").length,
        admitted: guests.filter((g) => g.status === "admitted").length,
      });
    }
    return out;
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
    const guest = await guestForRoom(ctx, args.guest_id);
    await requireDoorkeeper(ctx, userId, guest.room_key, now);
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
    // letting pages lapse.
    if ((await guestRows(ctx, guest.room_key, "admitted")).length >= MAX_ROOM_GUESTS) {
      throw new Error(`A huddle holds at most ${MAX_ROOM_GUESTS} guests at once`);
    }
    await ctx.db.patch(guest._id, { status: "admitted", decided_by: userId, decided_at: now });
    const live = await liveTranscriptFor(ctx, guest.room_key);
    if (live) await noteGuestAttendance(ctx, guest, live._id, now);
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
    const guest = await guestForRoom(ctx, args.guest_id);
    await requireDoorkeeper(ctx, userId, guest.room_key, now);
    if (args.revoke_link) await revokeLinkOf(ctx, guest, userId, now);
    if (guest.status !== "waiting") return { status: guest.status };
    await ctx.db.patch(guest._id, { status: "denied", decided_by: userId, decided_at: now });
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
    const guest = await guestForRoom(ctx, args.guest_id);
    await requireDoorkeeper(ctx, userId, guest.room_key, now);
    if (args.revoke_link) await revokeLinkOf(ctx, guest, userId, now);
    // Already removed: that removal's roster check is still running its tail.
    if (guest.status === "removed") return { status: "removed" as const };
    await settleGuest(ctx, guest, { status: "removed", decided_by: userId, decided_at: now });
    return { status: "removed" as const };
  },
});

async function revokeLinkOf(ctx: any, guest: Doc<"call_guests">, userId: Id<"users">, now: number): Promise<void> {
  const link: Doc<"call_guest_links"> | null = await ctx.db.get(guest.link_id);
  if (link) await revokeLink(ctx, link, userId, now);
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

/** Tell the link's creator that somebody is at the door of a room nobody is
 *  in. A guest is usually sent the link ahead of the meeting, so the common
 *  case is a guest arriving first, at a door nobody can see; inside a running
 *  huddle the door itself shows them. Once per arrival, and not again for
 *  GUEST_CREATOR_NOTICE_MS. Returns the stamp to store, or undefined. */
async function tellCreatorIfAlone(
  ctx: any,
  link: Doc<"call_guest_links">,
  guest: { name: string; creator_told_at?: number },
  now: number,
): Promise<number | undefined> {
  if (guest.creator_told_at && now - guest.creator_told_at < GUEST_CREATOR_NOTICE_MS) return undefined;
  const seats: Doc<"call_members">[] = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", link.room_key))
    .collect();
  if (liveMembers(seats, now).length > 0) return undefined;
  const creator = await ctx.db.get(link.created_by);
  if (!creator) return undefined;
  const title = await linkTitle(ctx, link);
  await enqueuePush(ctx, {
    user: creator,
    type: CALL_GUEST_WAITING_PUSH_TYPE,
    title: `${guest.name} is waiting to join`,
    body: `They opened your guest link${title ? ` to ${title}` : ""}. Join the huddle to let them in.`,
    data: { type: CALL_GUEST_WAITING_PUSH_TYPE, room_key: link.room_key },
  });
  return now;
}

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
    if (refusal || !link) throw new Error(LINK_REFUSAL_TEXT[refusal ?? "not_found"]);
    const name = normalizeGuestName(args.name);
    if (!name) throw new Error("Type the name the room should see");

    const prior =
      args.guest_id && args.secret ? await guestBySecret(ctx, args.guest_id, args.secret) : null;
    // A row from another link is somebody else's door: the browser held on to
    // an old guest id, and this knock starts fresh on the link it came in by.
    const mine = prior && String(prior.link_id) === String(link._id) ? prior : null;
    const waiting = await waitingGuests(ctx, link.room_key, now);
    // The waiting places: the room's, and this link's share of them, so a
    // link that got out cannot keep out the guests arriving on another.
    const roomFull = waiting.length >= MAX_WAITING_GUESTS;
    const linkFull = waiting.filter((w) => String(w.link._id) === String(link._id)).length >= MAX_WAITING_PER_LINK;

    if (mine) {
      if (mine.status === "removed") throw new Error("You were removed from this call");
      if (mine.status === "admitted" && (await huddleAlive(ctx, link.room_key, now))) {
        await ctx.db.patch(mine._id, { last_seen: now });
        return { guest_id: String(mine._id), secret: null, status: "admitted" as const };
      }
      if (mine.status === "denied" && now - (mine.decided_at ?? 0) < GUEST_DENY_COOLDOWN_MS) {
        throw new Error("The room said not now. You can ask again in a minute.");
      }
      const atDoor = waiting.some((w) => String(w.guest._id) === String(mine._id));
      if (!atDoor && (roomFull || linkFull)) {
        throw new Error("Too many people are waiting to join. Try again in a minute.");
      }
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
    // bound how many a leaked link can produce.
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
    if (roomFull || linkFull) {
      throw new Error("Too many people are waiting to join. Try again in a minute.");
    }
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
 *  (a knock whose lease lapsed is refreshed as a new knock), puts the guest
 *  on the attendance of the huddle's record once there is one, and settles
 *  an admission whose huddle has ended. Returns what the page should show. */
export const guestHeartbeat = mutation({
  args: { guest_id: v.string(), secret: v.string() },
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
      await ctx.db.patch(guest._id, { last_seen: now });
      const live = await liveTranscriptFor(ctx, guest.room_key);
      if (live) await noteGuestAttendance(ctx, guest, live._id, now);
      return { view: "admitted" as const };
    }
    if (guest.status === "waiting") {
      const link = await ctx.db.get(guest.link_id);
      const closed = !!(await linkUsable(ctx, link, now));
      if (!closed && link) {
        const back = !isGuestPresent(guest, now);
        const told = back ? await tellCreatorIfAlone(ctx, link, guest, now) : undefined;
        await ctx.db.patch(guest._id, {
          last_seen: now,
          ...(back ? { knocked_at: now } : {}),
          ...(told ? { creator_told_at: told } : {}),
        });
      }
      return { view: guestView(guest, { huddleRunning: false, linkClosed: closed }) };
    }
    return { view: guestView(guest, { huddleRunning: false, linkClosed: false }) };
  },
});

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
      // A guest who left, was turned away or whose huddle ended may knock
      // again on a link that still works; their page offers it only then.
      link_open: !linkClosed,
    };
    const inTheRoom = view === "waiting" || view === "admitted" || ((view === "left" || view === "ended") && !linkClosed);
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
    if (guest.status === "admitted") {
      await settleGuest(ctx, guest, { status: "left", left_reason: "self" });
    } else if (guest.status === "waiting") {
      await ctx.db.patch(guest._id, { status: "left", left_reason: "self" });
    }
    return { view: "left" as const };
  },
});

// ── Media ──────────────────────────────────────────────────────────────────

/** Who the media token is for, or why not. A query so the hash, the status
 *  and the huddle are read at one instant. */
export const authForGuestToken = internalQuery({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return { ok: false as const, reason: "Not a guest of this call" };
    if (guest.status !== "admitted") {
      return {
        ok: false as const,
        reason: guest.status === "removed" ? "You were removed from this call" : "You have not been let in",
      };
    }
    if (!(await huddleAlive(ctx, guest.room_key, Date.now()))) {
      return { ok: false as const, reason: "This call has ended" };
    }
    if (!(await teamHasFeature(ctx, guest.team_id, "calls"))) {
      return { ok: false as const, reason: LINK_REFUSAL_TEXT.unavailable };
    }
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
 *  tell a guest from a teammate or an agent (callParticipantKind); a surface
 *  that shows a participant's name must ask it first, since the name itself
 *  is whatever the guest typed. */
export const mintGuestToken = action({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args): Promise<{ url: string; token: string; identity: string; name: string }> => {
    const cfg = livekitConfigFromEnv();
    if (!cfg) throw new Error("Calling is not configured");
    const auth = await ctx.runQuery(internal.callGuests.authForGuestToken, args);
    if (!auth.ok) throw new Error(auth.reason);
    const token = await signLivekitJwt({
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
      identity: auth.identity,
      name: auth.name,
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
 *  a huddle that is still running. Everyone else with a guest identity is
 *  somebody the rows have already put out. */
export const allowedGuestIdentities = internalQuery({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<string[]> => {
    if (!(await huddleAlive(ctx, args.room_key, Date.now()))) return [];
    return (await guestRows(ctx, args.room_key, "admitted")).map((g) => guestIdentity(String(g._id)));
  },
});

/** Make the media room agree with the rows: list who LiveKit has in it, and
 *  remove every guest identity the rows do not allow. Then look again down
 *  the tail (lib/callGuestAdmission says why one eject is not enough). A
 *  LiveKit that does not answer is tried again on the next step; the minute
 *  sweep covers a tail that ran out while it was down. */
export const enforceGuestRoster = internalAction({
  args: { room_key: v.string(), tail: v.number() },
  handler: async (ctx, args) => {
    const cfg = livekitConfigFromEnv();
    if (!cfg) return { removed: 0 };
    let removed = 0;
    try {
      const allowed = new Set(await ctx.runQuery(internal.callGuests.allowedGuestIdentities, { room_key: args.room_key }));
      for (const p of await listParticipants(cfg, args.room_key)) {
        if (!isGuestIdentity(p.identity) || allowed.has(p.identity)) continue;
        await removeParticipant(cfg, args.room_key, p.identity);
        removed++;
      }
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

/** Every minute, every room with a guest admitted: end the admissions of a
 *  huddle that is over (nobody may be left to notice: the last teammate's
 *  tab died, a script stopped beating), put out a guest whose page has been
 *  quiet past GUEST_ADMISSION_LAPSE_MS, and check the media room. The one
 *  path that needs nobody's cooperation, guest's or teammate's. */
export const sweepGuestRooms = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const admitted = await ctx.db
      .query("call_guests")
      .withIndex("by_status", (q) => q.eq("status", "admitted"))
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
      const gone = guests.filter((g) => now - g.last_seen >= GUEST_ADMISSION_LAPSE_MS);
      for (const g of gone) await ctx.db.patch(g._id, { status: "left", left_reason: "lapsed" });
      lapsed += gone.length;
      await checkGuestRoster(ctx, roomKey, { once: gone.length === 0 });
    }
    return { rooms: rooms.size, ended, lapsed };
  },
});
