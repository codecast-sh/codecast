// Huddles control plane. Convex owns everything except media: rooms (leased
// call_members rows), ringing (call_invites), authorization (callRooms.ts) and
// LiveKit access-token minting. Media itself flows browser ↔ LiveKit; if the
// LIVEKIT_* env vars are absent every query here still answers and the UI
// simply hides call affordances (getCallConfig.enabled === false).
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  action,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { authorizeRoom } from "./callRooms";
import { bucketTs } from "./presenceState";

// Room membership is a lease: the dock heartbeats every CALL_HEARTBEAT_MS
// while connected, readers ignore rows older than CALL_MEMBER_STALE_MS, so a
// crashed client leaves by silence. Stale rows are deleted opportunistically
// by whatever mutation next touches the room — no cron.
export const CALL_HEARTBEAT_MS = 15_000;
export const CALL_MEMBER_STALE_MS = 45_000;
// A ring that was neither answered nor cancelled inside this window reads as
// expired everywhere (missed call), even while the row still exists.
export const CALL_INVITE_TTL_MS = 45_000;

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

// Is calling configured at all? Public and cheap; the secret never leaves env.
export const getCallConfig = query({
  args: {},
  handler: async () => {
    const url = process.env.LIVEKIT_URL;
    const enabled = !!(url && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
    return { enabled, url: enabled ? url : undefined };
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
    const outgoing = [
      ...myRings.filter((i) => inviteAlive(i, now)),
      ...answered.filter((i) => (i.responded_at ?? 0) > now - 30_000),
    ].map((i) => ({
      _id: i._id,
      room_key: i.room_key,
      to_user: i.to_user,
      status: i.status,
      created_at: bucketTs(i.created_at),
    }));

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

    await sweepRoom(ctx, args.room_key, now);

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

export const leaveRoom = mutation({
  args: { room_key: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const mine = await ctx.db
      .query("call_members")
      .withIndex("by_user", (q) => q.eq("user_id", userId))
      .collect();
    for (const m of mine) {
      if (!args.room_key || m.room_key === args.room_key) await ctx.db.delete(m._id);
    }
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
    // One active ring per (from, to): re-ringing refreshes rather than stacks,
    // and any stale/answered rows for the pair are swept while we're here.
    const priorFromMe = await ctx.db
      .query("call_invites")
      .withIndex("by_from_status", (q) =>
        q.eq("from_user", userId).eq("status", "ringing"),
      )
      .collect();
    for (const inv of priorFromMe) {
      if (String(inv.to_user) === String(args.to_user) || !inviteAlive(inv, now)) {
        await ctx.db.delete(inv._id);
      }
    }

    const target = await ctx.db.get(args.to_user);
    await ctx.db.insert("call_invites", {
      room_key: args.room_key,
      team_id: callerAuth.teamId,
      from_user: userId,
      to_user: args.to_user,
      status: "ringing",
      anchor_title: args.anchor_title,
      created_at: now,
    });
    // Manual "busy" rings quietly on the recipient's side; tell the caller so
    // their dock can say "rang quietly" instead of implying a normal ring.
    return { busy: target?.status === "busy" };
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
    });
    return { url, token };
  },
});
