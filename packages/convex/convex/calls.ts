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
  CALL_MEMBER_STALE_MS,
  authorizeRoom,
} from "./callRooms";
import { bucketTs } from "./presenceState";
import { teamHasFeature } from "./teamFeatures";
import {
  CALL_PUSH_CATEGORY,
  CALL_PUSH_SOUND,
  CALL_PUSH_TYPE_MISSED,
  CALL_PUSH_TYPE_RING,
} from "@codecast/shared/contracts";

export { CALL_HEARTBEAT_MS, CALL_INVITE_TTL_MS, CALL_MEMBER_STALE_MS } from "./callRooms";

function liveMembers(rows: Doc<"call_members">[], now: number) {
  return rows.filter((m) => now - m.last_seen < CALL_MEMBER_STALE_MS);
}

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
    // Recently-answered rows so the caller's dock can settle ("declined").
    const answered = await ctx.db
      .query("call_invites")
      .withIndex("by_from_status", (q) =>
        q.eq("from_user", userId).eq("status", "declined"),
      )
      .collect();
    const outgoing = await Promise.all(
      [
        ...myRings.filter((i) => inviteAlive(i, now)),
        ...answered.filter((i) => (i.responded_at ?? 0) > now - 30_000),
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
    for (const m of mine) {
      if (!args.room_key || m.room_key === args.room_key) await ctx.db.delete(m._id);
    }
    await settleOutboundRings(ctx, userId, args.room_key, now);
  },
});

export const invite = mutation({
  args: {
    room_key: v.string(),
    to_user: v.id("users"),
    anchor_title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    if (String(args.to_user) === String(userId)) {
      throw new Error("Cannot ring yourself");
    }
    // Both ends must be able to join: the caller now, and the recipient at
    // accept time — ring nobody into a room they'd bounce off of (and never
    // leak a session title to someone the feed filter would hide it from).
    const callerAuth = await authorizeRoom(ctx, userId, args.room_key);
    if (!callerAuth.ok) throw new Error(`Cannot invite: ${callerAuth.reason}`);
    const targetAuth = await authorizeRoom(ctx, args.to_user, args.room_key);
    if (!targetAuth.ok) throw new Error(`Recipient cannot join this room`);

    const now = Date.now();
    // Decline cooldown: a fresh decline/cancel means "not now" — re-ringing
    // inside the window is refused so a looping caller cannot ring forever
    // (each decline buys the recipient a quiet minute).
    const RE_RING_COOLDOWN_MS = 60_000;
    const settledFromMe = await Promise.all(
      (["declined", "cancelled"] as const).map((status) =>
        ctx.db
          .query("call_invites")
          .withIndex("by_from_status", (q) =>
            q.eq("from_user", userId).eq("status", status),
          )
          .collect(),
      ),
    );
    const recentlySettled = settledFromMe
      .flat()
      .some(
        (inv) =>
          String(inv.to_user) === String(args.to_user) &&
          (inv.responded_at ?? inv.created_at) > now - RE_RING_COOLDOWN_MS,
      );
    if (recentlySettled) return { busy: false, cooldown: true };

    // One active ring per (from, to): re-ringing REFRESHES the existing row in
    // place (same _id, so the recipient's toast/sound dedupe holds — a
    // delete+insert would mint a new id and re-fire the ring every call),
    // and stale rows for other pairs are swept while we're here.
    const priorFromMe = await ctx.db
      .query("call_invites")
      .withIndex("by_from_status", (q) =>
        q.eq("from_user", userId).eq("status", "ringing"),
      )
      .collect();
    let existing: Doc<"call_invites"> | null = null;
    for (const inv of priorFromMe) {
      if (String(inv.to_user) === String(args.to_user)) {
        if (inviteAlive(inv, now)) existing = inv;
        else await ctx.db.delete(inv._id);
      } else if (!inviteAlive(inv, now)) {
        await ctx.db.delete(inv._id);
      }
    }

    const target = await ctx.db.get(args.to_user);
    if (existing) {
      // Keep created_at: the original ring's TTL clock keeps running, so
      // hammering invite cannot extend a ring past CALL_INVITE_TTL_MS.
      await ctx.db.patch(existing._id, {
        room_key: args.room_key,
        anchor_title: args.anchor_title,
      });
      return { busy: target?.status === "busy", cooldown: false };
    }
    const inviteId = await ctx.db.insert("call_invites", {
      room_key: args.room_key,
      team_id: callerAuth.teamId,
      from_user: userId,
      to_user: args.to_user,
      status: "ringing",
      anchor_title: args.anchor_title,
      created_at: now,
    });
    // Ring the phone DIRECTLY — never through the pushRouter outbox: its
    // presence holds and away-debounce outlive the 45s invite TTL, and a call
    // is precisely the "reach them wherever they are" event the hold policy
    // exists to suppress. Manual "busy" is the closed door here too: no push.
    // Fresh inserts only — a re-ring refreshes the row above and the phone
    // already rang for it.
    const from = await ctx.db.get(userId);
    const fromName = from?.name || from?.email || "A teammate";
    // Two rings, one wins: a PushKit token means the phone runs the CallKit
    // binary — ring through APNs VoIP so a KILLED app puts up the lock-screen
    // call UI. Otherwise the notification ring (banner + bundled sound; a
    // backgrounded app answers from it, a force-quit one just sees the tray).
    // Never both: a CallKit call plus a banner is two rings for one call.
    if (target?.voip_push_token && target.notifications_enabled && target.status !== "busy") {
      await ctx.scheduler.runAfter(0, internal.apnsVoip.sendVoipRing, {
        voip_push_token: target.voip_push_token,
        user_id: args.to_user,
        invite_id: String(inviteId),
        room_key: args.room_key,
        caller_id: String(userId),
        caller_name: fromName,
        caller_image: from?.image ?? from?.github_avatar_url ?? undefined,
        anchor_title: args.anchor_title,
      });
    } else if (target?.push_token && target.notifications_enabled && target.status !== "busy") {
      await ctx.scheduler.runAfter(0, internal.notifications.sendPushNotification, {
        push_token: target.push_token,
        title: `${fromName} wants to huddle`,
        body: args.anchor_title ? `about: ${args.anchor_title}` : "Tap to join the huddle",
        sound: CALL_PUSH_SOUND,
        category_id: CALL_PUSH_CATEGORY,
        interruption_level: "time-sensitive",
        // APNs drops the ring if the phone is unreachable past the invite TTL —
        // a phone coming back online must not ring for a call that died.
        ttl: Math.ceil(CALL_INVITE_TTL_MS / 1000),
        data: { type: CALL_PUSH_TYPE_RING, invite_id: inviteId, room_key: args.room_key },
        user_id: args.to_user,
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
    return { busy: target?.status === "busy" };
  },
});

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
        body: inv.anchor_title ? `about: ${inv.anchor_title}` : "They rang while you were away",
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
