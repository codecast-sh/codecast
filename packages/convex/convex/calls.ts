// Huddles control plane. Convex owns everything except media: rooms (leased
// call_members rows), ringing (call_invites), authorization (callRooms.ts) and
// LiveKit access-token minting. Media itself flows browser ↔ LiveKit; if the
// LIVEKIT_* env vars are absent every query here still answers and the UI
// simply hides call affordances (getCallConfig.enabled === false).
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CALL_INVITE_TTL_MS,
  CALL_KNOCK_TTL_MS,
  CALL_MEMBER_STALE_MS,
  MAX_ROOM_MEMBERS,
  authorizeRoom,
  authorizeRoomInviter,
  authorizeRoomMembership,
  clearRoomState,
  expireRoomGrants,
  liveMembers,
  readRoomState,
  upsertRoomState,
  liveSeat,
  openRoomDoor,
  parseRoomKey,
} from "./callRooms";
import { isTeamMember } from "./privacy";
import { bucketTs } from "./presenceState";
import { teamFeatureOffMessage, teamHasFeature } from "./teamFeatures";
import { endLiveTranscriptsForRoom } from "./transcripts";
import {
  CALL_PUSH_CATEGORY,
  CALL_PUSH_SOUND,
  CALL_PUSH_TYPE_MISSED,
  CALL_PUSH_TYPE_RING,
} from "@codecast/shared/contracts";

export {
  CALL_HEARTBEAT_MS,
  CALL_INVITE_TTL_MS,
  CALL_KNOCK_TTL_MS,
  CALL_MEMBER_STALE_MS,
} from "./callRooms";

function inviteAlive(inv: Doc<"call_invites">, now: number): boolean {
  return inv.status === "ringing" && now - inv.created_at < CALL_INVITE_TTL_MS;
}

// The client-facing shape of a roster row. last_seen deliberately never
// leaves the server (it churns every heartbeat and shows nothing the UI
// paints); joined_at is bucketed so the row is byte-stable across pushes.
function projectMember(m: Doc<"call_members">) {
  return {
    room_key: m.room_key,
    user_id: m.user_id,
    user_name: m.user_name,
    user_image: m.user_image,
    joined_at: bucketTs(m.joined_at),
    muted: m.muted,
    camera: m.camera,
    sharing: m.sharing,
    // The one bit that turns a burst into a call, for everyone in the room.
    // Bucketed like joined_at and set once, so it never re-pushes the roster.
    walkie_joined_at: m.walkie_joined_at ? bucketTs(m.walkie_joined_at) : undefined,
  };
}

// Is calling available to the caller? Two gates: the deployment must have
// LiveKit configured (the secret never leaves env), and calls are a per-team
// opt-in — `teams` lists which of the caller's teams have it on so clients
// hide every call affordance for the rest. `enabled` is true when at least
// one of the caller's teams has calls (or, signed out, when the deployment
// is configured), so a single boolean still answers "show anything at all?".
export const getCallConfig = query({
  args: {},
  handler: async (ctx) => {
    const url = process.env.LIVEKIT_URL;
    const configured = !!(url && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    const userId = await getAuthUserId(ctx);
    let teams: string[] = [];
    if (configured && userId) {
      const memberships = await ctx.db
        .query("team_memberships")
        .withIndex("by_user_id", (q) => q.eq("user_id", userId))
        .collect();
      for (const m of memberships) {
        if (await teamHasFeature(ctx, m.team_id, "calls")) teams.push(String(m.team_id));
      }
    }
    const enabled = configured && (userId ? teams.length > 0 : true);
    return { enabled, url: enabled ? url : undefined, teams };
  },
});

// Occupancy for a set of rooms the caller can see (chips on channels,
// sessions, the team strip). Rooms the caller may not join return empty
// rather than erroring, so one bad key can't blank a whole chip row.
export const getRoomOccupancy = query({
  args: { room_keys: v.array(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return {};
    const now = Date.now();
    const keys = [...new Set(args.room_keys)].slice(0, 50);
    const out: Record<string, ReturnType<typeof projectMember>[]> = {};
    for (const key of keys) {
      const auth = await authorizeRoom(ctx, userId, key);
      if (!auth.ok) continue;
      const rows = await ctx.db
        .query("call_members")
        .withIndex("by_room", (q) => q.eq("room_key", key))
        .collect();
      const live = liveMembers(rows, now);
      if (live.length > 0) out[key] = live.map(projectMember);
    }
    return out;
  },
});

// Everything the ring pipeline needs about ME: invites ringing at me, my own
// outbound ring, and my current room membership. One subscription, mounted
// app-wide (useCallSync).
export const getMyCalls = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return { incoming: [], outgoing: [], membership: null };
    const now = Date.now();

    const ringingAtMe = await ctx.db
      .query("call_invites")
      .withIndex("by_to_status", (q) =>
        q.eq("to_user", userId).eq("status", "ringing"),
      )
      .collect();
    const incoming = await Promise.all(
      ringingAtMe.filter((i) => inviteAlive(i, now)).map(async (i) => {
        const from = await ctx.db.get(i.from_user);
        return {
          _id: i._id,
          room_key: i.room_key,
          from_user: i.from_user,
          from_name: from?.name ?? from?.email ?? "Teammate",
          from_image: from?.image ?? from?.github_avatar_url,
          anchor_title: i.anchor_title,
          created_at: bucketTs(i.created_at),
        };
      }),
    );

    const myRings = await ctx.db
      .query("call_invites")
      .withIndex("by_from_status", (q) =>
        q.eq("from_user", userId).eq("status", "ringing"),
      )
      .collect();
    // Recently-settled rows so the caller's dock can finish the sentence:
    // "declined" for a decline, "no answer" for a ring that hit its TTL.
    const settled = await Promise.all(
      (["declined", "expired"] as const).map((status) =>
        ctx.db
          .query("call_invites")
          .withIndex("by_from_status", (q) =>
            q.eq("from_user", userId).eq("status", status),
          )
          .collect(),
      ),
    ).then((lists) => lists.flat());
    const outgoing = await Promise.all(
      [
        ...myRings.filter((i) => inviteAlive(i, now)),
        ...settled.filter((i) => (i.responded_at ?? 0) > now - 30_000),
      ].map(async (i) => {
        // Enriched with the callee's name so the caller's stage can say
        // "ringing Sam…" / "Sam declined" without a second lookup (mirrors the
        // incoming projection above).
        const to = await ctx.db.get(i.to_user);
        return {
          _id: i._id,
          room_key: i.room_key,
          to_user: i.to_user,
          to_name: to?.name ?? to?.email ?? "Teammate",
          to_image: to?.image ?? to?.github_avatar_url,
          status: i.status,
          created_at: bucketTs(i.created_at),
        };
      }),
    );

    const myRooms = await ctx.db
      .query("call_members")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    const live = liveMembers(myRooms, now);
    return {
      incoming,
      outgoing,
      membership: live[0] ? projectMember(live[0]) : null,
    };
  },
});

async function requireUser(ctx: any): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  return userId;
}

// Sweep a room's dead rows while we're writing to it anyway.
async function sweepRoom(ctx: any, roomKey: string, now: number) {
  const rows = await ctx.db
    .query("call_members")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  for (const m of rows) {
    if (now - m.last_seen >= CALL_MEMBER_STALE_MS) await ctx.db.delete(m._id);
  }
}

export const joinRoom = mutation({
  args: {
    room_key: v.string(),
    muted: v.optional(v.boolean()),
    // "I am stepping into this burst on purpose." Optional and additive: an
    // older client never sends it and joins exactly as it always did. It is
    // only ever set, never cleared — the seat itself is what ends a call, and
    // leaving deletes the row and the stamp with it.
    walkie_join: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) throw new Error(`Cannot join room: ${auth.reason}`);
    const now = Date.now();
    const user = await ctx.db.get(userId);

    // Sweep the room's dead rows FIRST — a rejoin after >45s away is the
    // common case, and our own stale row must be gone before we decide
    // whether to refresh or insert (patching a row the sweep just deleted
    // threw "Update on nonexistent document").
    await sweepRoom(ctx, args.room_key, now);

    // Taking a seat in an EMPTY room starts a NEW huddle: the previous
    // huddle's invite grants die here (callRooms.acceptedInviteGrant relies
    // on this — an accepted invite means "that huddle never ended"). A guest
    // whose huddle is still running never reaches this: the room holds a
    // fresh lease, so it is not empty.
    const seated = await ctx.db
      .query("call_members")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .collect();
    if (liveMembers(seated, now).length === 0) {
      await expireRoomGrants(ctx, args.room_key);
      // A lock belongs to the huddle that set it, and so do the knocks at its
      // door: the next huddle in this room starts open, with nobody waiting.
      await clearRoomState(ctx, args.room_key);
      // Same reason: a transcript left "live" by the previous huddle (its
      // scribe's tab died without stop) must not swallow this new one.
      await endLiveTranscriptsForRoom(ctx, args.room_key);
    }

    // One huddle at a time: joining a room implicitly leaves every other —
    // simultaneous rooms would mean two live mic publishes and an incoherent
    // "in a huddle" presence signal.
    const mine = await ctx.db
      .query("call_members")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    let existing: Doc<"call_members"> | null = null;
    for (const m of mine) {
      if (m.room_key === args.room_key) existing = m;
      else await ctx.db.delete(m._id);
    }

    if (existing) {
      await ctx.db.patch(existing._id, {
        last_seen: now,
        muted: args.muted ?? existing.muted,
        // The FIRST deliberate step in is the one that counts: joining live and
        // then being re-seated by a heartbeat recovery must not keep moving the
        // moment the conversation started.
        walkie_joined_at: args.walkie_join
          ? (existing.walkie_joined_at ?? now)
          : existing.walkie_joined_at,
      });
      return { room_key: args.room_key };
    }
    await ctx.db.insert("call_members", {
      room_key: args.room_key,
      team_id: auth.teamId,
      user_id: userId,
      user_name: user?.name ?? user?.email ?? "Teammate",
      user_image: user?.image ?? user?.github_avatar_url ?? undefined,
      joined_at: now,
      last_seen: now,
      // Muted by default: joining is socially free (the Tandem shoulder-tap),
      // unmuting is the deliberate act.
      muted: args.muted ?? true,
      camera: false,
      sharing: false,
      walkie_joined_at: args.walkie_join ? now : undefined,
    });
    return { room_key: args.room_key };
  },
});

export const heartbeat = mutation({
  args: {
    room_key: v.string(),
    muted: v.optional(v.boolean()),
    camera: v.optional(v.boolean()),
    sharing: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db
      .query("call_members")
      .withIndex("by_user_room", (q) =>
        q.eq("user_id", userId).eq("room_key", args.room_key),
      )
      .unique();
    // A heartbeat for a row the sweep already removed is a no-op, not an
    // error: the client will notice via getMyCalls and reconnect or leave.
    if (!row) return { ok: false };
    const patch: Record<string, unknown> = { last_seen: Date.now() };
    if (args.muted !== undefined) patch.muted = args.muted;
    if (args.camera !== undefined) patch.camera = args.camera;
    if (args.sharing !== undefined) patch.sharing = args.sharing;
    await ctx.db.patch(row._id, patch);
    return { ok: true };
  },
});

// Hanging up settles every ring the caller left outstanding for that room:
// otherwise the callee's phone rings the full TTL for a call that no longer
// exists — and then gets a "missed huddle" push for it.
async function settleOutboundRings(
  ctx: any,
  userId: Id<"users">,
  roomKey: string | undefined,
  now: number,
) {
  const ringing = await ctx.db
    .query("call_invites")
    .withIndex("by_from_status", (q: any) =>
      q.eq("from_user", userId).eq("status", "ringing"),
    )
    .collect();
  for (const inv of ringing) {
    if (!roomKey || inv.room_key === roomKey) {
      await ctx.db.patch(inv._id, { status: "cancelled", responded_at: now });
    }
  }
}

export const leaveRoom = mutation({
  args: { room_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const mine = await ctx.db
      .query("call_members")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    const left = new Set<string>();
    for (const m of mine) {
      if (!args.room_key || m.room_key === args.room_key) {
        await ctx.db.delete(m._id);
        left.add(m.room_key);
      }
    }
    await settleOutboundRings(ctx, userId, args.room_key, now);
    // The last one out ends the room's transcript: the record must not sit
    // "live" on the calls page after everyone has hung up.
    for (const roomKey of left) {
      const seated = await ctx.db
        .query("call_members")
        .withIndex("by_room", (q) => q.eq("room_key", roomKey))
        .collect();
      if (liveMembers(seated, now).length === 0) {
        await endLiveTranscriptsForRoom(ctx, roomKey);
      }
    }
  },
});

// Ring people into a room. One mutation, one or many recipients (`to_users`;
// `to_user` is the historic single form and still works): a group start rings
// everyone in one round trip, and "add people" mid-call is the same call on
// the room you are already in. Per-recipient outcomes come back keyed by user
// so the caller's dock can say who rang, who is on quiet hours and who is in
// a decline cooldown.
export const invite = mutation({
  args: {
    room_key: v.string(),
    to_user: v.optional(v.id("users")),
    to_users: v.optional(v.array(v.id("users"))),
    anchor_title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const recipients = [...new Set([
      ...(args.to_user ? [args.to_user] : []),
      ...(args.to_users ?? []),
    ].map(String))] as Id<"users">[];
    if (recipients.length === 0) throw new Error("Nobody to ring");
    if (recipients.some((id) => String(id) === String(userId))) {
      throw new Error("Cannot ring yourself");
    }
    if (recipients.length > MAX_ROOM_MEMBERS) {
      throw new Error(`A huddle rings at most ${MAX_ROOM_MEMBERS} people at once`);
    }
    // The authority to ADD people is being IN the room, or being one of its
    // own people. A live occupant may ring: they are the person a knocker is
    // asking to be let in by, and they can already lock the door — a walk-in
    // who could shut the room but not open it was the inconsistency this
    // rule removes. Chain-invite stays contained by the two walls that were
    // always doing the work: a CHANNEL room keeps membership authority
    // (authorizeRoomInviter excludes it), so nobody walks into a channel's
    // room and fills it with people the channel excludes; and every
    // recipient must be a teammate, checked per row below. An unused grant
    // is not a seat: holding one lets you join, not widen.
    //
    // The recipient needs no membership at all — the ring IS their grant
    // (callRooms.acceptedInviteGrant) — but the team wall holds for them too.
    const callerAuth = await authorizeRoomInviter(ctx, userId, args.room_key);
    if (!callerAuth.ok) throw new Error(`Cannot invite: ${callerAuth.reason}`);

    const now = Date.now();
    const from = await ctx.db.get(userId);
    const fromName = from?.name || from?.email || "A teammate";
    // Whoever already holds a seat needs no ring — a toast for the room you
    // are sitting in is noise (the picker excludes them client-side; the
    // server rule is what makes every entry point behave).
    const seated = new Set(
      liveMembers(
        await ctx.db
          .query("call_members")
          .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
          .collect(),
        now,
      ).map((m) => String(m.user_id)),
    );
    // The ring's context line, per recipient. For a people room the server
    // owns it: "with <everyone in the room besides you and the caller>" — a
    // caller-written line would name the recipient to themselves, and a
    // guest rung into a 1:1 would get no context at all. Channel and session
    // rooms keep the caller's line ("#design", "about: <title>"), capped so
    // a hostile length cannot sink the APNs payload.
    const cap = (t: string | undefined) => t && t.slice(0, 140);
    const parsed = parseRoomKey(args.room_key);
    const roomNames = new Map<string, string>();
    if (parsed?.kind === "dm") {
      for (const id of parsed.users) {
        const u = await ctx.db.get(id as Id<"users">);
        // Split only real names — "a teammate".split would read as "a".
        roomNames.set(id, u?.name?.trim().split(/\s+/)[0] || u?.email || "a teammate");
      }
    }
    const lineFor = (toUser: Id<"users">): string | undefined => {
      if (parsed?.kind !== "dm") return cap(args.anchor_title);
      const others = parsed.users.filter(
        (id) => id !== String(toUser) && id !== String(userId),
      );
      if (others.length === 0) return undefined;
      return cap(`with ${others.map((id) => roomNames.get(id)).join(", ")}`);
    };

    // Every ring the caller has out or recently settled, read once for the
    // whole batch: the cooldown check and the refresh-vs-insert decision below
    // both filter this list per recipient.
    const priorFromMe = await Promise.all(
      (["ringing", "declined"] as const).map((status) =>
        ctx.db
          .query("call_invites")
          .withIndex("by_from_status", (q) =>
            q.eq("from_user", userId).eq("status", status),
          )
          .collect(),
      ),
    ).then((lists) => lists.flat());
    // Stale rings for anyone are swept while we're here — and so are old
    // SETTLED rows: nothing else ever deletes declined/cancelled/expired
    // invites, and getMyCalls reads whole status buckets per run, so an
    // unbounded history would make every ring event dearer forever. Ten
    // minutes comfortably clears the 30s settle display and the 60s decline
    // cooldown; accepted rows are grants and are settled (then swept here)
    // only when their room restarts from empty.
    const SETTLED_ROW_TTL_MS = 10 * 60_000;
    for (const inv of priorFromMe) {
      if (inv.status === "ringing" && !inviteAlive(inv, now)) await ctx.db.delete(inv._id);
    }
    const oldSettled = await Promise.all(
      (["declined", "cancelled", "expired"] as const).map((status) =>
        ctx.db
          .query("call_invites")
          .withIndex("by_from_status", (q) =>
            q.eq("from_user", userId).eq("status", status),
          )
          .collect(),
      ),
    ).then((lists) => lists.flat());
    for (const inv of oldSettled) {
      if ((inv.responded_at ?? inv.created_at) < now - SETTLED_ROW_TTL_MS) {
        await ctx.db.delete(inv._id);
      }
    }

    const results: Array<{
      to_user: Id<"users">;
      busy: boolean;
      cooldown: boolean;
      in_room?: boolean;
      refused?: string;
    }> = [];
    for (const toUser of recipients) {
      if (seated.has(String(toUser))) {
        results.push({ to_user: toUser, busy: false, cooldown: false, in_room: true });
        continue;
      }
      if (!(await isTeamMember(ctx, toUser, callerAuth.teamId))) {
        results.push({ to_user: toUser, busy: false, cooldown: false, refused: "not a teammate" });
        continue;
      }
      results.push(await ringOne(ctx, {
        userId,
        toUser,
        roomKey: args.room_key,
        teamId: callerAuth.teamId,
        anchorTitle: lineFor(toUser),
        fromName,
        fromImage: from?.image ?? from?.github_avatar_url ?? undefined,
        priorFromMe: priorFromMe.filter((inv) => String(inv.to_user) === String(toUser)),
        now,
      }));
    }
    return { results };
  },
});

// One recipient of a ring: cooldown, refresh-or-insert, and the phone.
async function ringOne(
  ctx: any,
  opts: {
    userId: Id<"users">;
    toUser: Id<"users">;
    roomKey: string;
    teamId: Id<"teams">;
    anchorTitle?: string;
    fromName: string;
    fromImage?: string;
    priorFromMe: Doc<"call_invites">[];
    now: number;
  },
): Promise<{ to_user: Id<"users">; busy: boolean; cooldown: boolean }> {
  const { userId, toUser, roomKey, now } = opts;
  // Decline cooldown: a fresh DECLINE means "not now" — re-ringing inside
  // the window is refused so a looping caller cannot ring forever (each
  // decline buys the recipient a quiet minute). Cancelled rings don't count:
  // hanging up settles every outstanding ring as cancelled, and ending a
  // huddle must not lock its people out of the next one.
  const RE_RING_COOLDOWN_MS = 60_000;
  const recentlyDeclined = opts.priorFromMe.some(
    (inv) =>
      inv.status === "declined" &&
      (inv.responded_at ?? inv.created_at) > now - RE_RING_COOLDOWN_MS,
  );
  if (recentlyDeclined) return { to_user: toUser, busy: false, cooldown: true };

  // One active ring per (from, to). Re-ringing into the SAME room refreshes
  // the row in place (same _id, so the recipient's toast/sound dedupe holds
  // — a delete+insert would re-fire the ring every call), and keeps
  // created_at so hammering invite cannot extend a ring past its TTL. A ring
  // into a DIFFERENT room is a different call: the old ring settles as
  // cancelled and a fresh row rings properly — patching the room under a
  // toast the recipient already saw would land their Join in the wrong room.
  const existing = opts.priorFromMe.find(
    (inv) => inv.status === "ringing" && inviteAlive(inv, now),
  );
  const target = await ctx.db.get(toUser);
  if (existing && existing.room_key === roomKey) {
    await ctx.db.patch(existing._id, {
      anchor_title: opts.anchorTitle,
    });
    return { to_user: toUser, busy: target?.status === "busy", cooldown: false };
  }
  if (existing) {
    await ctx.db.patch(existing._id, { status: "cancelled", responded_at: now });
  }
  const inviteId = await ctx.db.insert("call_invites", {
    room_key: roomKey,
    team_id: opts.teamId,
    from_user: userId,
    to_user: toUser,
    status: "ringing",
    anchor_title: opts.anchorTitle,
    created_at: now,
  });
  // Ring the phone DIRECTLY — never through the pushRouter outbox: its
  // presence holds and away-debounce outlive the 45s invite TTL, and a call
  // is precisely the "reach them wherever they are" event the hold policy
  // exists to suppress. Manual "busy" is the closed door here too: no push.
  // Fresh inserts only — a re-ring refreshes the row above and the phone
  // already rang for it.
  // Two rings, one wins: a PushKit token means the phone runs the CallKit
  // binary — ring through APNs VoIP so a KILLED app puts up the lock-screen
  // call UI. Otherwise the notification ring (banner + bundled sound; a
  // backgrounded app answers from it, a force-quit one just sees the tray).
  // Never both: a CallKit call plus a banner is two rings for one call.
  if (target?.voip_push_token && target.notifications_enabled && target.status !== "busy") {
    await ctx.scheduler.runAfter(0, internal.apnsVoip.sendVoipRing, {
      voip_push_token: target.voip_push_token,
      user_id: toUser,
      invite_id: String(inviteId),
      room_key: roomKey,
      caller_id: String(userId),
      caller_name: opts.fromName,
      caller_image: opts.fromImage,
      anchor_title: opts.anchorTitle,
    });
  } else if (target?.push_token && target.notifications_enabled && target.status !== "busy") {
    await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
      push_token: target.push_token,
      title: `${opts.fromName} wants to huddle`,
      body: opts.anchorTitle || "Tap to join the huddle",
      sound: CALL_PUSH_SOUND,
      category_id: CALL_PUSH_CATEGORY,
      interruption_level: "time-sensitive",
      // APNs drops the ring if the phone is unreachable past the invite TTL —
      // a phone coming back online must not ring for a call that died.
      ttl: Math.ceil(CALL_INVITE_TTL_MS / 1000),
      data: { type: CALL_PUSH_TYPE_RING, invite_id: inviteId, room_key: roomKey },
      user_id: toUser,
    });
  }
  // The ring's afterlife: at TTL, an unanswered invite becomes a missed-call
  // push (quiet, default sound) so a closed app learns someone tried.
  await ctx.scheduler.runAfter(
    CALL_INVITE_TTL_MS + 2_000,
    internal.calls.sweepMissedInvite,
    { invite_id: inviteId },
  );
  // Manual "busy" rings quietly on the recipient's side; tell the caller so
  // their dock can say "rang quietly" instead of implying a normal ring.
  return { to_user: toUser, busy: target?.status === "busy", cooldown: false };
}

// Runs once per fresh invite, TTL+2s after creation. An invite still "ringing"
// past its TTL was never answered anywhere — settle it and tell the recipient
// they were wanted. Answered/declined invites make this a no-op.
export const sweepMissedInvite = internalMutation({
  args: { invite_id: v.id("call_invites") },
  handler: async (ctx, args) => {
    const inv = await ctx.db.get(args.invite_id);
    if (!inv || inv.status !== "ringing") return;
    const now = Date.now();
    if (inviteAlive(inv, now)) return; // refreshed rings keep their clock; be safe
    await ctx.db.patch(inv._id, { status: "expired", responded_at: now });
    const target = await ctx.db.get(inv.to_user);
    const from = await ctx.db.get(inv.from_user);
    if (target?.push_token && target.notifications_enabled) {
      await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
        push_token: target.push_token,
        title: `Missed huddle from ${from?.name || from?.email || "a teammate"}`,
        body: inv.anchor_title || "They rang while you were away",
        data: { type: CALL_PUSH_TYPE_MISSED, room_key: inv.room_key },
        user_id: inv.to_user,
      });
    }
  },
});

export const respondInvite = mutation({
  args: {
    invite_id: v.id("call_invites"),
    accept: v.boolean(),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const inv = await ctx.db.get(args.invite_id);
    if (!inv || String(inv.to_user) !== String(userId)) {
      throw new Error("Invite not found");
    }
    const now = Date.now();
    // Already answered on another device: let the second device join too —
    // stomping the row to "expired" showed "That ring expired" to someone who
    // just accepted on their laptop.
    if (inv.status === "accepted") return { room_key: inv.room_key, expired: false };
    if (inv.status !== "ringing") return { room_key: inv.room_key, expired: true };
    if (!inviteAlive(inv, now)) {
      await ctx.db.patch(inv._id, { status: "expired", responded_at: now });
      return { room_key: inv.room_key, expired: true };
    }
    await ctx.db.patch(inv._id, {
      status: args.accept ? "accepted" : "declined",
      responded_at: now,
    });
    return { room_key: inv.room_key, expired: false };
  },
});

export const cancelInvite = mutation({
  args: { invite_id: v.id("call_invites") },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const inv = await ctx.db.get(args.invite_id);
    if (!inv || String(inv.from_user) !== String(userId)) return;
    await ctx.db.patch(inv._id, { status: "cancelled", responded_at: Date.now() });
  },
});

// ── The door: lock, knock, live rooms ─────────────────────────────────────
// Huddles are open by default (callRooms.openRoomDoor). What follows is the
// exception and the way back in from it: a lock, a knock at a locked door,
// and the list that makes an occupied room visible in the first place.

// Whoever is INSIDE right now owns the door — not the room's members and not
// whoever started the huddle, both of whom may have left. Returns the seat so
// callers reuse its billing team.
async function requireSeated(
  ctx: any,
  userId: Id<"users">,
  roomKey: string,
  now: number,
): Promise<Doc<"call_members">> {
  const seat = await liveSeat(ctx, userId, roomKey, now);
  if (!seat) throw new Error("Only someone in the huddle can do that");
  return seat;
}

// Knocks expire like rings and nothing sweeps them on a timer: every mutation
// that touches the door clears the dead ones and returns the rest.
async function sweepKnocks(
  ctx: any,
  roomKey: string,
  now: number,
): Promise<Doc<"call_knocks">[]> {
  const rows: Doc<"call_knocks">[] = await ctx.db
    .query("call_knocks")
    .withIndex("by_room", (q: any) => q.eq("room_key", roomKey))
    .collect();
  const alive: Doc<"call_knocks">[] = [];
  for (const k of rows) {
    if (now - k.created_at >= CALL_KNOCK_TTL_MS) await ctx.db.delete(k._id);
    else alive.push(k);
  }
  return alive;
}

export const setRoomLocked = mutation({
  args: { room_key: v.string(), locked: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const seat = await requireSeated(ctx, userId, args.room_key, now);
    await upsertRoomState(ctx, args.room_key, seat, { locked: args.locked }, now);
    // Unlocking answers every knock at once: the door is simply open now, and
    // a leftover knock would ask the room to admit someone already inside it.
    const waiting = await sweepKnocks(ctx, args.room_key, now);
    if (!args.locked) {
      for (const k of waiting) await ctx.db.delete(k._id);
    }
    return { locked: args.locked };
  },
});

// The huddle's transcription switch. Every huddle transcribes unless someone
// inside says otherwise: the scribe is whichever deliberate participant's
// client got there first (transcripts.start arbitrates), so stopping has to
// be written on the room — a flag one client holds would just be overruled by
// the next client to look. Anyone seated may flip it either way; turning it
// back on is what a manual Transcribe toggle does before it starts.
export const setRoomTranscribeOff = mutation({
  args: { room_key: v.string(), off: v.boolean() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const seat = await requireSeated(ctx, userId, args.room_key, now);
    await upsertRoomState(ctx, args.room_key, seat, { transcribe_off: args.off }, now);
    return { transcribe_off: args.off };
  },
});

// A knock at a locked door. Two conditions, and together they say exactly
// "somebody who WOULD have walked in, had it not been locked": the open door
// admits them but for the lock, and no other door does either. Admitting is
// not new machinery — someone inside rings the knocker with `invite` and the
// accepted-invite grant lets them in.
export const knock = mutation({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const teamId = await openRoomDoor(ctx, userId, args.room_key, {
      ignoreLock: true,
    });
    if (!teamId) throw new Error("Cannot knock at this huddle");
    if (!(await teamHasFeature(ctx, teamId, "calls"))) {
      throw new Error(teamFeatureOffMessage("calls"));
    }
    if ((await authorizeRoom(ctx, userId, args.room_key)).ok) {
      throw new Error("This huddle is open — just join it");
    }
    const waiting = await sweepKnocks(ctx, args.room_key, now);
    const mine = waiting.find((k) => String(k.from_user) === String(userId));
    // Refresh, never duplicate — one person at the door is one knock, and
    // hammering it cannot flood the room's toasts (same rule as re-ringing).
    if (mine) {
      await ctx.db.patch(mine._id, { created_at: now });
      return { ok: true };
    }
    await ctx.db.insert("call_knocks", {
      room_key: args.room_key,
      team_id: teamId,
      from_user: userId,
      created_at: now,
    });
    return { ok: true };
  },
});

// Who is waiting outside MY room. Only the people inside can read it: a knock
// is a gesture at one door, not a team-wide event. Bucketed and sorted like
// every other room subscription so heartbeats do not re-push it.
export const getRoomKnocks = query({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    if (!(await liveSeat(ctx, userId, args.room_key, now))) return [];
    const rows = await ctx.db
      .query("call_knocks")
      .withIndex("by_room", (q) => q.eq("room_key", args.room_key))
      .collect();
    const waiting = await Promise.all(
      rows
        .filter((k) => now - k.created_at < CALL_KNOCK_TTL_MS)
        .map(async (k) => {
          const u = await ctx.db.get(k.from_user);
          return {
            from_user: k.from_user,
            from_name: u?.name ?? u?.email ?? "Teammate",
            from_image: u?.image ?? u?.github_avatar_url ?? undefined,
            // NOT bucketed, unlike every other timestamp on a room
            // subscription. Bucketing exists to keep a result byte-identical
            // across heartbeats, and this result already is: it derives only
            // from call_knocks rows, which change only when somebody knocks.
            // A re-knock PATCHES its row (above), so created_at is the ONLY
            // field that moves — and the 60s bucket would round the second
            // knock onto the first, leaving the room with no way to tell that
            // someone tried again.
            created_at: k.created_at,
          };
        }),
    );
    return waiting.sort((a, b) => String(a.from_user).localeCompare(String(b.from_user)));
  },
});

// Every huddle running right now in one of my teams — the list that makes
// open rooms a product rather than a permission. A LOCKED room still lists:
// seeing it and knocking is the whole point, so membership widens the door.
// `locked` is a fact about the ROOM and never the client's Join-versus-Knock
// input — `can_join` is (see below).
//
// This is a team-wide subscription that every client holds while a huddle
// runs, so its result must be byte-identical between heartbeats: rooms sorted
// by key, rosters sorted by user, every timestamp bucketed (projectMember
// already drops last_seen). See the wakeSig discipline on call_members.
export const getLiveRooms = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return [];
    const now = Date.now();
    const memberships = await ctx.db
      .query("team_memberships")
      .withIndex("by_user_id", (q) => q.eq("user_id", userId))
      .collect();
    const byRoom = new Map<string, Doc<"call_members">[]>();
    for (const m of memberships) {
      if (!(await teamHasFeature(ctx, m.team_id, "calls"))) continue;
      const rows = await ctx.db
        .query("call_members")
        .withIndex("by_team", (q) => q.eq("team_id", m.team_id))
        .collect();
      // Stale rows are not a huddle: nothing sweeps a room nobody is writing
      // to, so the reader filters rather than trusting the table.
      for (const row of liveMembers(rows, now)) {
        const list = byRoom.get(row.room_key);
        if (list) list.push(row);
        else byRoom.set(row.room_key, [row]);
      }
    }

    const out = [];
    for (const roomKey of [...byRoom.keys()].sort()) {
      const live = byRoom.get(roomKey)!;
      const seated = live.some((m) => String(m.user_id) === String(userId));
      const membership = await authorizeRoomMembership(ctx, userId, roomKey);
      const listed =
        seated ||
        membership.ok ||
        !!(await openRoomDoor(ctx, userId, roomKey, { ignoreLock: true }));
      if (!listed) continue;
      // The room is joinable either way — the team wall holds and the people
      // inside are audible. Its LABEL is a different question: a session room
      // whose conversation this viewer cannot see lists as "a huddle", so no
      // title-bearing field leaves the server for it.
      const parsed = parseRoomKey(roomKey);
      const redacted = parsed?.kind === "session" && !membership.ok;
      let title: string | undefined;
      if (parsed?.kind === "session" && !redacted) {
        const conv = await ctx.db.get(parsed.conversationId as Id<"conversations">);
        title = conv?.title;
      } else if (parsed?.kind === "channel") {
        const channel = await ctx.db.get(parsed.channelId as Id<"chat_channels">);
        title = channel?.name;
      }
      // Join or Knock is a question about the VIEWER, not about the room.
      // The lock shuts the OPEN DOOR and nothing else, so a member of the
      // room and a guest holding a live grant both still walk into a locked
      // one. Answer it with the very authorizer `knock` guards on — knock
      // refuses anyone authorizeRoom admits, with "just join it" — so the
      // button a client renders can never disagree with the mutation behind
      // it. Byte-stable like `locked`: it moves only when a lock, a
      // membership or the room's occupancy does, never with the clock.
      const canJoin = (await authorizeRoom(ctx, userId, roomKey)).ok;
      const state = await readRoomState(ctx, roomKey);
      out.push({
        room_key: roomKey,
        team_id: live[0].team_id,
        locked: !!state?.locked,
        // The huddle said "don't transcribe": what keeps every seated client's
        // auto-scribe from starting it again.
        transcribe_off: !!state?.transcribe_off,
        can_join: canJoin,
        redacted,
        title,
        members: live
          .slice()
          .sort((a, b) => String(a.user_id).localeCompare(String(b.user_id)))
          .map(projectMember),
      });
    }
    return out;
  },
});

// ── LiveKit access token ──────────────────────────────────────────────────
// The media server trusts any JWT signed with LIVEKIT_API_SECRET, so this
// action is the media-plane gate: authorization runs through the exact same
// authorizeRoom as joinRoom, then we sign a token scoped to that one room.
// Signed with Web Crypto HMAC-SHA256 — no server SDK dependency.

export const authForToken = internalQuery({
  args: { room_key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) return null;
    const auth = await authorizeRoom(ctx, userId, args.room_key);
    if (!auth.ok) return null;
    const user = await ctx.db.get(userId);
    return {
      user_id: String(userId),
      name: user?.name ?? user?.email ?? "Teammate",
      image: user?.image ?? user?.github_avatar_url ?? undefined,
    };
  },
});

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signLivekitJwt(opts: {
  apiKey: string;
  apiSecret: string;
  identity: string;
  name: string;
  room: string;
  metadata?: string;
  ttlSeconds?: number;
  nowSeconds?: number;
}): Promise<string> {
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: opts.apiKey,
    sub: opts.identity,
    nbf: now - 10,
    exp: now + (opts.ttlSeconds ?? 6 * 3600),
    name: opts.name,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    video: {
      room: opts.room,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    },
  };
  const enc = new TextEncoder();
  const signingInput = `${b64url(enc.encode(JSON.stringify(header)))}.${b64url(
    enc.encode(JSON.stringify(payload)),
  )}`;
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(opts.apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(signingInput)),
  );
  return `${signingInput}.${b64url(sig)}`;
}

export const mintAccessToken = action({
  args: { room_key: v.string() },
  handler: async (ctx, args): Promise<{ url: string; token: string }> => {
    const url = process.env.LIVEKIT_URL;
    const apiKey = process.env.LIVEKIT_API_KEY;
    const apiSecret = process.env.LIVEKIT_API_SECRET;
    if (!url || !apiKey || !apiSecret) throw new Error("Calling is not configured");
    const grant = await ctx.runQuery(internal.calls.authForToken, {
      room_key: args.room_key,
    });
    if (!grant) throw new Error("Not authorized for this room");
    const token = await signLivekitJwt({
      apiKey,
      apiSecret,
      identity: grant.user_id,
      name: grant.name,
      room: args.room_key,
      metadata: grant.image ? JSON.stringify({ image: grant.image }) : undefined,
      // Short-lived: the SFU trusts the JWT alone, so a long token would keep
      // working after team removal or the session going private. livekit-client
      // reconnects re-mint (callManager), so 15 minutes costs nothing.
      ttlSeconds: 15 * 60,
    });
    return { url, token };
  },
});
