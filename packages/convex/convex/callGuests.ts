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
//   the huddle ends       -> left      (left_reason "huddle_ended", settled by
//                                       callRooms.expireRoomGrants or the
//                                       guest's own next beat)
//
// AN ADMISSION IS FOR ONE HUDDLE, the way an accepted ring is: it lasts while
// that huddle runs (somebody seated, or the room inside its grace) and dies
// with it, so a guest from Tuesday's meeting cannot walk into Wednesday's with
// the secret still in their browser. It does NOT hang on the link: a link that
// expires or is revoked mid-meeting stops new knocks and closes the door on
// people still waiting at it, and leaves the people already inside alone.
// Removing someone is its own act (removeGuest), because revoking a link to
// stop it spreading should not hang up on the client you are talking to.
//
// Presence is the seat lease (isGuestPresent, CALL_MEMBER_STALE_MS): the
// guest's page beats while it is open. A knock from a closed page drops off
// the door within one window; an admitted guest whose page blinked stays
// admitted and simply reconnects, since presence decides what the room shows
// and the admission decides what the server allows.
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalAction,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  authorizeRoomInviter,
  authorizeRoomMembership,
  liveMembers,
  liveSeat,
  parseRoomKey,
  readRoomState,
} from "./callRooms";
import { liveTranscriptFor } from "./callChat";
import { HUDDLE_GRACE_MS } from "./transcripts";
import { teamFeatureOffMessage, teamHasFeature } from "./teamFeatures";
import { bucketTs } from "./presenceState";
import { signLivekitJwt } from "./lib/livekitJwt";
import { livekitConfigFromEnv, removeParticipant } from "./lib/livekitServer";
import { sha256Hex } from "./lib/hash";
import { newSlug } from "./lib/slug";
import { isRoomRecording } from "./lib/callRecordingRuns";
import {
  GUEST_DENY_COOLDOWN_MS,
  GUEST_KNOCKS_PER_LINK_PER_MINUTE,
  GUEST_LINK_MAX_TTL_MS,
  GUEST_LINK_MIN_TTL_MS,
  GUEST_LINK_TTL_MS,
  GUEST_REKNOCK_MIN_MS,
  MAX_ROOM_GUESTS,
  MAX_WAITING_GUESTS,
  guestIdentity,
  guestJoinPath,
  isGuestPresent,
  normalizeGuestName,
  type CallGuestView,
} from "@codecast/shared/contracts";

// The link token is the whole secret of a link, and the guest secret the
// whole proof of a guest; both are far past guessing (~143 and ~190 bits).
const LINK_TOKEN_LENGTH = 24;
const GUEST_SECRET_LENGTH = 32;

// ── Pure rules (exported for tests) ───────────────────────────────────────

/** Does this link still let new people knock? */
export function linkOpen(link: Pick<Doc<"call_guest_links">, "revoked_at" | "expires_at">, now: number): boolean {
  return !link.revoked_at && now < link.expires_at;
}

/** Why a link refuses a new knock, in the words its page shows, or null. */
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
 *  room's answer and only matters to an admitted guest; `linkRevoked` only to
 *  one still waiting. */
export function guestView(
  row: Pick<Doc<"call_guests">, "status" | "left_reason">,
  opts: { huddleRunning: boolean; linkRevoked: boolean },
): CallGuestView {
  switch (row.status) {
    case "waiting":
      return opts.linkRevoked ? "closed" : "waiting";
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

/** The guest this id and secret prove, or null for anything else: an id of
 *  another table, a row that does not exist, a wrong secret. The one door for
 *  every public guest function, and for anything a guest may do in a call
 *  (stopping a recording), so no caller compares hashes on its own. */
export async function guestBySecret(
  ctx: any,
  guestId: string,
  secret: string,
): Promise<Doc<"call_guests"> | null> {
  const id = ctx.db.normalizeId("call_guests", guestId);
  if (!id) return null;
  const row: Doc<"call_guests"> | null = await ctx.db.get(id);
  if (!row) return null;
  return (await secretMatches(row, secret)) ? row : null;
}

/** Is a huddle running in this room, for the purposes of an admission?
 *  Somebody from the team is seated, or the room emptied less than the grace
 *  ago (the same window that keeps the huddle's record and grants alive:
 *  transcripts.resumeOrEndHuddle). A guest alone never keeps a huddle going,
 *  the same rule acceptedInviteGrant applies to a rung-in teammate. */
export async function huddleRunning(ctx: any, roomKey: string, now: number): Promise<boolean> {
  const rows: Doc<"call_members">[] = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  if (liveMembers(rows, now).length > 0) return true;
  const t = await liveTranscriptFor(ctx, roomKey);
  return !!t?.idle_since && now - t.idle_since < HUDDLE_GRACE_MS;
}

/** The guests a room shows right now: at the door (on a link nobody revoked)
 *  and inside, each present by its lease. Sorted by id so a subscription that
 *  carries them stays byte-stable between beats. */
export async function roomGuests(
  ctx: any,
  roomKey: string,
  now: number,
): Promise<{ waiting: Doc<"call_guests">[]; admitted: Doc<"call_guests">[] }> {
  const read = async (status: "waiting" | "admitted"): Promise<Doc<"call_guests">[]> =>
    (
      await ctx.db
        .query("call_guests")
        .withIndex("by_room_status", (q: any) => q.eq("room_key", roomKey).eq("status", status))
        .collect()
    )
      .filter((g: Doc<"call_guests">) => isGuestPresent(g, now))
      .sort((a: Doc<"call_guests">, b: Doc<"call_guests">) => String(a._id).localeCompare(String(b._id)));
  const waitingRows = await read("waiting");
  const revoked = new Map<string, boolean>();
  const waiting: Doc<"call_guests">[] = [];
  for (const g of waitingRows) {
    const key = String(g.link_id);
    if (!revoked.has(key)) revoked.set(key, !!(await ctx.db.get(g.link_id))?.revoked_at);
    if (!revoked.get(key)) waiting.push(g);
  }
  return { waiting, admitted: await read("admitted") };
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

async function inviterOf(ctx: any, link: Doc<"call_guest_links">) {
  const u = await ctx.db.get(link.created_by);
  return {
    name: (u?.name || u?.email || "A teammate") as string,
    image: (u?.image ?? u?.github_avatar_url ?? null) as string | null,
  };
}

async function linkByToken(ctx: any, token: string): Promise<Doc<"call_guest_links"> | null> {
  if (typeof token !== "string" || token.length < 8 || token.length > 64) return null;
  return await ctx.db
    .query("call_guest_links")
    .withIndex("by_token", (q: any) => q.eq("token", token))
    .unique();
}

const LINK_REFUSAL_TEXT: Record<"not_found" | "revoked" | "expired", string> = {
  not_found: "This link isn't valid. Ask whoever sent it for a new one.",
  revoked: "This link was turned off. Ask whoever sent it for a new one.",
  expired: "This link has expired. Ask whoever sent it for a new one.",
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
 *  channel room's own wall, as it does for ringing a teammate in. */
async function requireDoorkeeper(ctx: any, userId: Id<"users">, roomKey: string, now: number) {
  const seat = await liveSeat(ctx, userId, roomKey, now);
  if (!seat) throw new Error("Only someone in the huddle can do that");
  const auth = await authorizeRoomInviter(ctx, userId, roomKey);
  if (!auth.ok) throw new Error(`Cannot answer the door: ${auth.reason}`);
  return seat;
}

async function guestForRoom(ctx: any, guestId: string): Promise<Doc<"call_guests">> {
  const id = ctx.db.normalizeId("call_guests", guestId);
  const row: Doc<"call_guests"> | null = id ? await ctx.db.get(id) : null;
  if (!row) throw new Error("Guest not found");
  return row;
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
      for (const l of mine) await ctx.db.patch(l._id, { revoked_at: now, revoked_by: userId });
    }
    const token = newSlug(LINK_TOKEN_LENGTH);
    const expires_at = now + clampLinkTtl(args.ttl_ms);
    const link_id = await ctx.db.insert("call_guest_links", {
      room_key: args.room_key,
      team_id: auth.teamId,
      token,
      created_by: userId,
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
      const creator = await ctx.db.get(l.created_by);
      out.push({
        link_id: l._id,
        token: l.token,
        path: guestJoinPath(l.token),
        created_by: String(l.created_by),
        created_by_name: creator?.name || creator?.email || "A teammate",
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
    if (link.revoked_at) return { revoked: true };
    await ctx.db.patch(link._id, { revoked_at: Date.now(), revoked_by: userId });
    return { revoked: true };
  },
});

/** Let a waiting guest in. Pressing twice, or two people pressing at once,
 *  admits them once. */
export const admitGuest = mutation({
  args: { guest_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const guest = await guestForRoom(ctx, args.guest_id);
    await requireDoorkeeper(ctx, userId, guest.room_key, now);
    if (guest.status === "admitted") return { status: "admitted" as const };
    if (guest.status !== "waiting" || !isGuestPresent(guest, now)) {
      throw new Error(`${guest.name} is no longer at the door`);
    }
    if ((await ctx.db.get(guest.link_id))?.revoked_at) {
      throw new Error("That guest's link was turned off");
    }
    const { admitted } = await roomGuests(ctx, guest.room_key, now);
    if (admitted.length >= MAX_ROOM_GUESTS) {
      throw new Error(`A huddle holds at most ${MAX_ROOM_GUESTS} guests at once`);
    }
    const live = await liveTranscriptFor(ctx, guest.room_key);
    await ctx.db.patch(guest._id, {
      status: "admitted",
      decided_by: userId,
      decided_at: now,
      ...(live ? { transcript_id: live._id } : {}),
    });
    return { status: "admitted" as const };
  },
});

/** Turn a waiting guest away. They may ask again after a quiet minute. */
export const denyGuest = mutation({
  args: { guest_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const guest = await guestForRoom(ctx, args.guest_id);
    await requireDoorkeeper(ctx, userId, guest.room_key, now);
    if (guest.status !== "waiting") return { status: guest.status };
    await ctx.db.patch(guest._id, { status: "denied", decided_by: userId, decided_at: now });
    return { status: "denied" as const };
  },
});

/** Put a guest out: at the door or inside. The row is done for good (a new
 *  knock needs a new row, which the room sees as somebody new), and the media
 *  server drops them now rather than at their token's expiry. */
export const removeGuest = mutation({
  args: { guest_id: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const guest = await guestForRoom(ctx, args.guest_id);
    await requireDoorkeeper(ctx, userId, guest.room_key, now);
    if (guest.status === "removed") return { status: "removed" as const };
    await ctx.db.patch(guest._id, { status: "removed", decided_by: userId, decided_at: now });
    if (guest.status === "admitted") {
      await ctx.scheduler.runAfter(0, internal.callGuests.ejectGuest, {
        room_key: guest.room_key,
        identity: guestIdentity(String(guest._id)),
      });
    }
    return { status: "removed" as const };
  },
});

// ── The guest's side (no account) ──────────────────────────────────────────

/** What a link's page shows before the guest types anything: which meeting,
 *  who invited them, whether anybody is there yet, and the notice. Never the
 *  team, the members, or anything the creator could not see themselves. */
export const describeGuestLink = query({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const link = await linkByToken(ctx, args.token);
    const refusal = linkRefusal(link, now);
    if (refusal || !link) return { ok: false as const, reason: refusal ?? ("not_found" as const) };
    if (!(await teamHasFeature(ctx, link.team_id, "calls"))) {
      return { ok: false as const, reason: "unavailable" as const };
    }
    return {
      ok: true as const,
      title: await linkTitle(ctx, link),
      inviter: await inviterOf(ctx, link),
      expires_at: link.expires_at,
      live: await huddleRunning(ctx, link.room_key, now),
      ...(await roomNotice(ctx, link.room_key)),
    };
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
    const refusal = linkRefusal(link, now);
    if (refusal || !link) throw new Error(LINK_REFUSAL_TEXT[refusal ?? "not_found"]);
    if (!(await teamHasFeature(ctx, link.team_id, "calls"))) throw new Error(teamFeatureOffMessage("calls"));
    const name = normalizeGuestName(args.name);
    if (!name) throw new Error("Type the name the room should see");

    const prior =
      args.guest_id && args.secret ? await guestBySecret(ctx, args.guest_id, args.secret) : null;
    // A row from another link is somebody else's door: the browser held on to
    // an old guest id, and this knock starts fresh on the link it came in by.
    const mine = prior && String(prior.link_id) === String(link._id) ? prior : null;
    const { waiting } = await roomGuests(ctx, link.room_key, now);

    if (mine) {
      if (mine.status === "removed") throw new Error("You were removed from this call");
      if (mine.status === "admitted" && (await huddleRunning(ctx, link.room_key, now))) {
        await ctx.db.patch(mine._id, { last_seen: now });
        return { guest_id: String(mine._id), secret: null, status: "admitted" as const };
      }
      if (mine.status === "denied" && now - (mine.decided_at ?? 0) < GUEST_DENY_COOLDOWN_MS) {
        throw new Error("The room said not now. You can ask again in a minute.");
      }
      const atDoor = mine.status === "waiting" && isGuestPresent(mine, now);
      if (!atDoor && waiting.length >= MAX_WAITING_GUESTS) {
        throw new Error("Too many people are waiting to join. Try again in a minute.");
      }
      await ctx.db.patch(mine._id, {
        status: "waiting",
        name,
        // A knock the room is already showing is refreshed at most every few
        // seconds: the door's signature is this stamp, and a page that
        // knocks on a loop must not make it flicker.
        knocked_at: atDoor && now - mine.knocked_at < GUEST_REKNOCK_MIN_MS ? mine.knocked_at : now,
        last_seen: now,
        notice_accepted_at: now,
        decided_by: undefined,
        decided_at: undefined,
        left_reason: undefined,
      });
      return { guest_id: String(mine._id), secret: null, status: "waiting" as const };
    }

    // A new person at the door: the link's rate and the room's queue both
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
    if (waiting.length >= MAX_WAITING_GUESTS) {
      throw new Error("Too many people are waiting to join. Try again in a minute.");
    }
    const secret = newSlug(GUEST_SECRET_LENGTH);
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
    });
    return { guest_id: String(guestId), secret, status: "waiting" as const };
  },
});

/** The guest page's beat, every CALL_HEARTBEAT_MS while it is open, at the
 *  door and inside. Keeps the lease, puts a returning page back at the door
 *  (a knock whose lease lapsed is refreshed as a new knock), records the
 *  huddle's call record on the row once there is one, and settles an
 *  admission whose huddle has ended. Returns what the page should show. */
export const guestHeartbeat = mutation({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return null;
    const now = Date.now();
    const link = await ctx.db.get(guest.link_id);
    const running = await huddleRunning(ctx, guest.room_key, now);
    if (guest.status === "admitted") {
      if (!running) {
        // Everybody from the team is gone past the grace: the admission was
        // for that huddle. A page still connected is put out of the media
        // room too, so a guest alone cannot become the next huddle.
        await ctx.db.patch(guest._id, { status: "left", left_reason: "huddle_ended" });
        await ctx.scheduler.runAfter(0, internal.callGuests.ejectGuest, {
          room_key: guest.room_key,
          identity: guestIdentity(String(guest._id)),
        });
        return { view: "ended" as const };
      }
      const live = guest.transcript_id ? null : await liveTranscriptFor(ctx, guest.room_key);
      await ctx.db.patch(guest._id, { last_seen: now, ...(live ? { transcript_id: live._id } : {}) });
      return { view: "admitted" as const };
    }
    if (guest.status === "waiting" && !link?.revoked_at) {
      await ctx.db.patch(guest._id, {
        last_seen: now,
        ...(isGuestPresent(guest, now) ? {} : { knocked_at: now }),
      });
    }
    return { view: guestView(guest, { huddleRunning: running, linkRevoked: !!link?.revoked_at }) };
  },
});

/** Everything the guest's page renders after knocking, reactive: where they
 *  stand, the meeting's name, whether anybody is there, and the notice, which
 *  stays true while they are inside (a recording started mid-call shows up
 *  here as it starts). Null for a wrong id or secret: the page starts over. */
export const getGuestState = query({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return null;
    const now = Date.now();
    const link = await ctx.db.get(guest.link_id);
    if (!link) return null;
    const live = await huddleRunning(ctx, guest.room_key, now);
    const view = guestView(guest, { huddleRunning: live, linkRevoked: !!link.revoked_at });
    return {
      view,
      name: guest.name,
      // When a turned-away guest may knock again; null otherwise.
      retry_at: guest.status === "denied" ? (guest.decided_at ?? 0) + GUEST_DENY_COOLDOWN_MS : null,
      // A guest who left or whose huddle ended may knock again on a link that
      // is still open; their page offers it only then.
      link_open: linkOpen(link, now),
      title: await linkTitle(ctx, link),
      inviter: await inviterOf(ctx, link),
      live,
      ...(await roomNotice(ctx, guest.room_key)),
    };
  },
});

/** The guest walks out, from the door or from inside. */
export const leaveCall = mutation({
  args: { guest_id: v.string(), secret: v.string() },
  handler: async (ctx, args) => {
    const guest = await guestBySecret(ctx, args.guest_id, args.secret);
    if (!guest) return null;
    if (guest.status === "waiting" || guest.status === "admitted") {
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
    if (!(await huddleRunning(ctx, guest.room_key, Date.now()))) {
      return { ok: false as const, reason: "This call has ended" };
    }
    if (!(await teamHasFeature(ctx, guest.team_id, "calls"))) {
      return { ok: false as const, reason: teamFeatureOffMessage("calls") };
    }
    return { ok: true as const, room_key: guest.room_key, identity: guestIdentity(String(guest._id)), name: guest.name };
  },
});

/** A LiveKit token for an admitted guest. Same lifetime as a member's (15
 *  minutes; a reconnect mints again, and that is where a removal or the
 *  huddle's end is enforced on a guest who is still connected).
 *
 *  What a guest may do: talk, show their camera, share a screen, and use the
 *  data channel (the room's reactions and hand raises ride it). A guest
 *  shares a screen because showing something is half of why you bring
 *  someone outside into a meeting. What a guest may NOT do is rename
 *  themselves: canUpdateOwnMetadata is off, so the name the room admitted is
 *  the name every face, transcript line and recording carries. The identity
 *  prefix (guest:) is set here and nowhere else, which is what lets every
 *  surface tell a guest from a teammate or an agent (callParticipantKind). */
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
      ttlSeconds: 15 * 60,
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

/** Drop a guest from the media server. Somebody already gone is fine. */
export const ejectGuest = internalAction({
  args: { room_key: v.string(), identity: v.string() },
  handler: async (_ctx, args) => {
    const cfg = livekitConfigFromEnv();
    if (!cfg) return;
    await removeParticipant(cfg, args.room_key, args.identity);
  },
});
