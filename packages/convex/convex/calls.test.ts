import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  CALL_INVITE_TTL_MS,
  CALL_KNOCK_TTL_MS,
  CALL_MEMBER_STALE_MS,
  signLivekitJwt,
} from "./calls";

function b64urlToJson(part: string): any {
  const pad = part.length % 4 === 0 ? "" : "=".repeat(4 - (part.length % 4));
  return JSON.parse(
    Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString(
      "utf8",
    ),
  );
}

describe("signLivekitJwt", () => {
  test("produces a verifiable HS256 token with the LiveKit video grant", async () => {
    const token = await signLivekitJwt({
      apiKey: "APIkey123",
      apiSecret: "secret456",
      identity: "user-1",
      name: "Ashot",
      room: "dm:a:b",
      metadata: JSON.stringify({ image: "https://x/y.png" }),
      ttlSeconds: 3600,
      nowSeconds: 1_800_000_000,
    });
    const [h, p, s] = token.split(".");
    expect(b64urlToJson(h)).toEqual({ alg: "HS256", typ: "JWT" });
    const payload = b64urlToJson(p);
    expect(payload.iss).toBe("APIkey123");
    expect(payload.sub).toBe("user-1");
    expect(payload.name).toBe("Ashot");
    expect(payload.nbf).toBe(1_800_000_000 - 10);
    expect(payload.exp).toBe(1_800_000_000 + 3600);
    expect(payload.video).toEqual({
      room: "dm:a:b",
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
    });
    // Independent signature check with node crypto — the token must verify
    // against the same secret LiveKit would use.
    const expected = createHmac("sha256", "secret456")
      .update(`${h}.${p}`)
      .digest("base64url");
    expect(s).toBe(expected);
  });

  test("token is scoped to exactly one room", async () => {
    const token = await signLivekitJwt({
      apiKey: "k",
      apiSecret: "s",
      identity: "u",
      name: "n",
      room: "channel:ch1",
      nowSeconds: 1_800_000_000,
    });
    const payload = b64urlToJson(token.split(".")[1]);
    expect(payload.video.room).toBe("channel:ch1");
    expect(payload.video.roomAdmin).toBeUndefined();
    expect(payload.video.roomCreate).toBeUndefined();
  });
});

describe("lease constants", () => {
  test("stale window comfortably exceeds the heartbeat", () => {
    // Three missed 15s heartbeats before a member reads as gone — same
    // two-missed-beats-plus-slack philosophy as PRESENCE_FRESH_MS.
    expect(CALL_MEMBER_STALE_MS).toBe(45_000);
    expect(CALL_INVITE_TTL_MS).toBe(45_000);
  });
});

// joinRoom regression: a rejoin after the lease lapsed must not patch the row
// the in-mutation sweep just deleted. Exercises the handler against a tiny
// fake db (same shape as callRooms.test.ts) with a stale own row present.
import { CALL_MEMBER_STALE_MS as STALE } from "./callRooms";
describe("joinRoom rejoin after lease lapse", () => {
  test("sweeps the stale own row before deciding refresh vs insert", async () => {
    const now = Date.now();
    const rows: any[] = [
      { _id: "cm1", room_key: "channel:ch1", team_id: "t1", user_id: "u1", user_name: "U", joined_at: now - 100_000, last_seen: now - STALE - 1000, muted: true, camera: false, sharing: false },
    ];
    const deleted: string[] = [];
    const patched: string[] = [];
    const inserted: any[] = [];
    const ctx: any = {
      db: {
        query: (_t: string) => ({
          withIndex: (_i: string, builder: any) => {
            const eqs: Array<[string, any]> = [];
            builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
            const hit = rows.filter((r) => !deleted.includes(r._id) && eqs.every(([f, v]) => String(r[f]) === String(v)));
            return { collect: async () => hit, unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
          },
        }),
        get: async (id: string) => (id === "u1" ? { _id: "u1", name: "U" } : id === "ch1" ? { _id: "ch1", team_id: "t1" } : id === "t1" ? { _id: "t1", name: "T", features: { calls: true, chat: true } } : rows.find((r) => r._id === id) ?? null),
        delete: async (id: string) => { deleted.push(id); },
        patch: async (id: string) => { if (deleted.includes(id)) throw new Error("Update on nonexistent document ID " + id); patched.push(id); },
        insert: async (_t: string, doc: any) => { inserted.push(doc); return "cm2"; },
      },
    };
    // Membership rows for authorizeRoom (channel room → team member).
    rows.push({ _id: "m1", user_id: "u1", team_id: "t1" });
    const { joinRoom } = await import("./calls");
    // convex-test-free invocation: reach the handler through the function's
    // exported config (works for the pure-db logic under test).
    const handler = (joinRoom as any)._handler ?? (joinRoom as any).handler;
    // getAuthUserId reads ctx.auth; provide the identity shape it expects.
    ctx.auth = { getUserIdentity: async () => ({ subject: "u1|sess", tokenIdentifier: "x" }) };
    await handler(ctx, { room_key: "channel:ch1", muted: true });
    expect(deleted).toContain("cm1");
    expect(patched).not.toContain("cm1");
    expect(inserted).toHaveLength(1);
  });
});

// THE EXPLICIT-JOIN STAMP. A burst seats everyone who hears it, so being in the
// room says nothing about whether a conversation started — and the microphone
// stopped answering that question when auto-listen went hot. `walkie_join` is
// the intent, recorded rather than inferred, and both sides read it back off
// the roster they already subscribe to.
describe("joinRoom: stamping a deliberate step into a burst", () => {
  function stampCtx(existing?: any) {
    const now = Date.now();
    const rows: any[] = [{ _id: "m1", user_id: "u1", team_id: "t1" }];
    if (existing) {
      rows.push({
        _id: "cm1", room_key: "channel:ch1", team_id: "t1", user_id: "u1", user_name: "U",
        joined_at: now - 5_000, last_seen: now - 1_000, muted: true, camera: false, sharing: false,
        ...existing,
      });
    }
    const patches: any[] = [];
    const inserted: any[] = [];
    const ctx: any = {
      auth: { getUserIdentity: async () => ({ subject: "u1|sess", tokenIdentifier: "x" }) },
      db: {
        query: (_t: string) => ({
          withIndex: (_i: string, builder: any) => {
            const eqs: Array<[string, any]> = [];
            builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
            const hit = rows.filter((r) => eqs.every(([f, v]) => String(r[f]) === String(v)));
            return { collect: async () => hit, unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
          },
        }),
        get: async (id: string) =>
          id === "u1" ? { _id: "u1", name: "U" }
          : id === "ch1" ? { _id: "ch1", team_id: "t1" }
          : id === "t1" ? { _id: "t1", name: "T", features: { calls: true, chat: true } }
          : rows.find((r) => r._id === id) ?? null,
        delete: async () => {},
        patch: async (_id: string, doc: any) => { patches.push(doc); },
        insert: async (_t: string, doc: any) => { inserted.push(doc); return "cm2"; },
      },
    };
    return { ctx, patches, inserted };
  }

  async function join(ctx: any, args: any) {
    const { joinRoom } = await import("./calls");
    const handler = (joinRoom as any)._handler ?? (joinRoom as any).handler;
    return handler(ctx, { room_key: "channel:ch1", ...args });
  }

  test("an ordinary join carries no stamp", async () => {
    const { ctx, inserted } = stampCtx();
    await join(ctx, { muted: true });
    expect(inserted[0].walkie_joined_at).toBeUndefined();
  });

  test("a deliberate step into a burst stamps the new seat", async () => {
    const { ctx, inserted } = stampCtx();
    const before = Date.now();
    await join(ctx, { muted: false, walkie_join: true });
    expect(inserted[0].walkie_joined_at).toBeGreaterThanOrEqual(before);
    expect(inserted[0].muted).toBe(false);
  });

  test("stepping in from a seat the walkie already took stamps that seat", async () => {
    // The real shape of Join live: auto-listen seated this person before they
    // decided anything, so the deliberate gesture finds a row rather than
    // making one. Stamping only on insert would have missed every upgrade the
    // feature actually produces.
    const { ctx, patches } = stampCtx({ muted: false });
    await join(ctx, { muted: false, walkie_join: true });
    expect(patches[0].walkie_joined_at).toBeGreaterThan(0);
  });

  test("keeps the FIRST moment somebody stepped in", async () => {
    // A heartbeat recovery re-takes the seat through this same mutation. The
    // conversation started when they pressed the button, not when the network
    // hiccupped.
    const { ctx, patches } = stampCtx({ walkie_joined_at: 1_000 });
    await join(ctx, { walkie_join: true });
    expect(patches[0].walkie_joined_at).toBe(1_000);
  });

  test("an ordinary rejoin never erases a stamp already there", async () => {
    // Only leaving ends a call, and leaving deletes the row. Nothing else may
    // take the stamp back — a mute or a lease refresh would otherwise demote a
    // live conversation to a burst on both people's screens.
    const { ctx, patches } = stampCtx({ walkie_joined_at: 1_000 });
    await join(ctx, { muted: true });
    expect(patches[0].walkie_joined_at).toBe(1_000);
  });
});

// invite fan-out: one mutation rings many. Each recipient gets their own row
// and their own outcome; teammates outside the room's anchor are rung (the
// ring is their grant); strangers to the team are refused per row, never by
// failing the whole batch.
// A tiny fake db shared by the mutation tests below (same shape as
// callRooms.test.ts): rows per table, eq-only index queries, live patch/delete.
function fakeCtx() {
  const now = Date.now();
  const rows: Record<string, any[]> = {
    // chat on too: a channel's huddle room opens through the chat room's
    // own door (canAccessChannel), which needs the chat feature.
    teams: [{ _id: "t1", name: "T", features: { calls: true, chat: true } }],
    team_memberships: [
      { _id: "m1", user_id: "ua", team_id: "t1" },
      { _id: "m2", user_id: "ub", team_id: "t1" },
      { _id: "m3", user_id: "uc", team_id: "t1" },
      // ud is on another team entirely
      { _id: "m4", user_id: "ud", team_id: "t2" },
    ],
    users: [
      { _id: "ua", name: "Ann" },
      { _id: "ub", name: "Bob", status: "busy" },
      { _id: "uc", name: "Cy" },
      { _id: "ud", name: "Dee" },
    ],
    call_invites: [],
    call_members: [],
  };
  const inserted: any[] = [];
  const scheduled: any[] = [];
  const ctx: any = {
    auth: { getUserIdentity: async () => ({ subject: "ua|sess", tokenIdentifier: "x" }) },
    scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push({ fn, args }); } },
    db: {
      query: (t: string) => ({
        withIndex: (_i: string, builder: any) => {
          const eqs: Array<[string, any]> = [];
          builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
          const hit = (rows[t] ?? []).filter((r) => eqs.every(([f, v]) => String(r[f]) === String(v)));
          return { collect: async () => hit, unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
        },
      }),
      get: async (id: string) => {
        for (const list of Object.values(rows)) {
          const r = list.find((x) => String(x._id) === String(id));
          if (r) return r;
        }
        return null;
      },
      insert: async (t: string, doc: any) => {
        const _id = `${t}-${(rows[t] ??= []).length + 1}`;
        rows[t].push({ _id, ...doc });
        inserted.push({ t, doc });
        return _id;
      },
      patch: async (id: string, patch: any) => {
        for (const list of Object.values(rows)) {
          const r = list.find((x) => String(x._id) === String(id));
          if (r) Object.assign(r, patch);
        }
      },
      delete: async (id: string) => {
        for (const list of Object.values(rows)) {
          const i = list.findIndex((x) => String(x._id) === String(id));
          if (i >= 0) list.splice(i, 1);
        }
      },
    },
  };
  return { ctx, rows, inserted, scheduled, now };
}

describe("invite fan-out", () => {

  async function handler() {
    const { invite } = await import("./calls");
    return (invite as any)._handler ?? (invite as any).handler;
  }

  test("rings every recipient with one row each and reports per recipient", async () => {
    const { ctx, rows } = fakeCtx();
    const res = await (await handler())(ctx, {
      room_key: "dm:ua:ub",
      to_users: ["ub", "uc", "ud"],
      anchor_title: "design sync",
    });
    // ub (member) and uc (teammate, not in the pair) ring; ud is refused.
    const ringing = rows.call_invites.filter((i) => i.status === "ringing");
    expect(ringing.map((i) => i.to_user).sort()).toEqual(["ub", "uc"]);
    expect(ringing.every((i) => i.room_key === "dm:ua:ub")).toBe(true);
    // A people room's context line is server-derived PER RECIPIENT: everyone
    // in the room besides the recipient and the caller. ub (the 1:1's other
    // member) needs none; uc (a guest into ua+ub) is told who is in there.
    const byTo = Object.fromEntries(ringing.map((i) => [i.to_user, i]));
    expect(byTo.ub.anchor_title).toBeUndefined();
    expect(byTo.uc.anchor_title).toBe("with Bob");
    const byUser = Object.fromEntries(res.results.map((r: any) => [r.to_user, r]));
    expect(byUser.ub.busy).toBe(true); // manual busy: rang quietly
    expect(byUser.uc.busy).toBe(false);
    expect(byUser.ud.refused).toBeTruthy();
  });

  test("the single `to_user` form still rings, and both forms dedupe", async () => {
    const { ctx, rows } = fakeCtx();
    await (await handler())(ctx, { room_key: "dm:ua:ub", to_user: "ub", to_users: ["ub"] });
    expect(rows.call_invites.filter((i) => i.to_user === "ub")).toHaveLength(1);
  });

  test("re-ringing refreshes the same row instead of minting a second", async () => {
    const { ctx, rows } = fakeCtx();
    const h = await handler();
    await h(ctx, { room_key: "dm:ua:ub", to_users: ["ub"] });
    await h(ctx, { room_key: "dm:ua:ub", to_users: ["ub", "uc"] });
    expect(rows.call_invites.filter((i) => i.to_user === "ub")).toHaveLength(1);
    expect(rows.call_invites.filter((i) => i.to_user === "uc")).toHaveLength(1);
  });

  test("refuses ringing yourself, nobody, or more than the roster cap", async () => {
    const { ctx } = fakeCtx();
    const h = await handler();
    await expect(h(ctx, { room_key: "dm:ua:ub", to_users: ["ua"] })).rejects.toThrow(/yourself/);
    await expect(h(ctx, { room_key: "dm:ua:ub", to_users: [] })).rejects.toThrow(/Nobody/);
    const many = Array.from({ length: 10 }, (_, i) => `x${i}`);
    await expect(h(ctx, { room_key: "dm:ua:ub", to_users: many })).rejects.toThrow(/at most/);
  });

  test("a caller who may not be in the room cannot ring anyone into it", async () => {
    const { ctx } = fakeCtx();
    // ua is not part of dm:ub:uc and holds no grant.
    await expect((await handler())(ctx, { room_key: "dm:ub:uc", to_users: ["ub"] })).rejects.toThrow(/Cannot invite/);
  });

  test("an unused grant is not a seat: holding one lets you join, not widen", async () => {
    // ua holds an accepted invite into dm:ub:uc and ub is live in the room.
    // ua may JOIN through that grant, but has not — and the authority to ring
    // more people in is being IN the room (or being one of its own people),
    // which an unclaimed grant is not. Once ua actually sits down they may
    // ring, as the walk-in test below shows.
    const { ctx, rows, now } = fakeCtx();
    rows.call_invites = [
      { _id: "g1", room_key: "dm:ub:uc", team_id: "t1", from_user: "ub", to_user: "ua", status: "accepted", created_at: now - 60_000, responded_at: now - 30_000 },
    ];
    rows.call_members = [
      { _id: "cm-ub", room_key: "dm:ub:uc", team_id: "t1", user_id: "ub", joined_at: now - 60_000, last_seen: now - 1000 },
    ];
    await expect((await handler())(ctx, { room_key: "dm:ub:uc", to_users: ["uc"] })).rejects.toThrow(/Cannot invite/);
  });

  test("a live occupant may ring teammates in, membership or not", async () => {
    // The walk-in rule (ct-44940). ua is a third party to dm:ub:uc who walked
    // in through the open door and is sitting there; the room is LOCKED,
    // which is precisely when a knocker needs somebody inside to admit them.
    const { ctx, rows, now } = fakeCtx();
    rows.users.push({ _id: "ue", name: "Eve" });
    rows.team_memberships.push({ _id: "m5", user_id: "ue", team_id: "t1" });
    rows.call_members = [
      { _id: "cm-ua", room_key: "dm:ub:uc", team_id: "t1", user_id: "ua", joined_at: now - 30_000, last_seen: now },
    ];
    rows.call_room_state = [{ _id: "rs1", room_key: "dm:ub:uc", team_id: "t1", locked: true, locked_by: "ua", updated_at: now }];
    const res = await (await handler())(ctx, { room_key: "dm:ub:uc", to_users: ["ue", "ud"] });
    const ringing = rows.call_invites.filter((i) => i.status === "ringing");
    expect(ringing.map((i) => i.to_user)).toEqual(["ue"]);
    // The ring bills to the room's own team, taken from the caller's seat.
    expect(ringing[0].team_id).toBe("t1");
    // The outer wall is untouched: ud is on another team and is refused per
    // row, exactly as for a member caller.
    const byUser = Object.fromEntries(res.results.map((r: any) => [r.to_user, r]));
    expect(byUser.ud.refused).toBeTruthy();
  });

  test("a session huddle's walk-in may ring too", async () => {
    const { ctx, rows, now } = fakeCtx();
    // ub owns a private conversation; ua walked into the live huddle about it.
    rows.conversations = [{ _id: "cv1", user_id: "ub", team_id: "t1", is_private: true }];
    rows.call_members = [
      { _id: "cm-ua", room_key: "session:cv1", team_id: "t1", user_id: "ua", joined_at: now - 30_000, last_seen: now },
    ];
    await (await handler())(ctx, { room_key: "session:cv1", to_users: ["uc"] });
    expect(rows.call_invites.map((i) => i.to_user)).toEqual(["uc"]);
  });

  test("a walk-in cannot widen a CHANNEL room the channel excludes them from", async () => {
    // The chain-invite wall, and the reason channel rooms keep membership
    // authority: ua was rung into a private channel's room and is sitting in
    // it, but the channel is still the authority on who belongs there.
    const { ctx, rows, now } = fakeCtx();
    rows.chat_channels = [{ _id: "chp", team_id: "t1", name: "founders", kind: "private" }];
    rows.chat_channel_members = [{ _id: "cmb1", channel_id: "chp", user_id: "ub" }];
    rows.call_members = [
      { _id: "cm-ua", room_key: "channel:chp", team_id: "t1", user_id: "ua", joined_at: now - 30_000, last_seen: now },
      { _id: "cm-ub", room_key: "channel:chp", team_id: "t1", user_id: "ub", joined_at: now - 60_000, last_seen: now },
    ];
    await expect((await handler())(ctx, { room_key: "channel:chp", to_users: ["uc"] }))
      .rejects.toThrow(/Cannot invite/);
    // The channel's own member, sitting in the same room, still may.
    ctx.auth = { getUserIdentity: async () => ({ subject: "ub|sess", tokenIdentifier: "x" }) };
    await (await handler())(ctx, { room_key: "channel:chp", to_users: ["uc"] });
    expect(rows.call_invites.map((i) => i.to_user)).toEqual(["uc"]);
  });

  test("a stale seat is no seat: the lease governs who may ring", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.call_members = [
      { _id: "cm-ua", room_key: "dm:ub:uc", team_id: "t1", user_id: "ua", joined_at: now - 300_000, last_seen: now - STALE - 1000 },
    ];
    await expect((await handler())(ctx, { room_key: "dm:ub:uc", to_users: ["ub"] }))
      .rejects.toThrow(/Cannot invite/);
  });

  test("a re-ring into a DIFFERENT room cancels the old ring and mints a fresh one", async () => {
    const { ctx, rows } = fakeCtx();
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    const h = await handler();
    await h(ctx, { room_key: "dm:ua:ub", to_users: ["ub"] });
    const first = rows.call_invites.find((i) => i.to_user === "ub");
    await h(ctx, { room_key: "channel:ch1", to_users: ["ub"] });
    const forUb = rows.call_invites.filter((i) => i.to_user === "ub");
    expect(first.status).toBe("cancelled");
    const fresh = forUb.find((i) => i.status === "ringing");
    expect(fresh._id).not.toBe(first._id); // new id → the phone rings again
    expect(fresh.room_key).toBe("channel:ch1");
  });

  test("settled rows older than ten minutes are swept on the next invite", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.call_invites = [
      { _id: "old1", room_key: "dm:ua:ub", team_id: "t1", from_user: "ua", to_user: "ub", status: "declined", created_at: now - 3_600_000, responded_at: now - 3_600_000 },
      { _id: "new1", room_key: "dm:ua:ub", team_id: "t1", from_user: "ua", to_user: "uc", status: "cancelled", created_at: now - 20_000, responded_at: now - 20_000 },
    ];
    await (await handler())(ctx, { room_key: "dm:ua:ub", to_users: ["ub"] });
    expect(rows.call_invites.find((i) => i._id === "old1")).toBeUndefined();
    expect(rows.call_invites.find((i) => i._id === "new1")).toBeDefined();
  });

    test("channel/session rooms keep the caller's line, capped at 140 chars", async () => {
    const { ctx, rows } = fakeCtx();
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    await (await handler())(ctx, {
      room_key: "channel:ch1",
      to_users: ["ub"],
      anchor_title: "#design " + "x".repeat(400),
    });
    const inv = rows.call_invites[0];
    expect(inv.anchor_title.length).toBe(140);
  });

  test("skips recipients already seated in the room", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.call_members = [
      { _id: "cm1", room_key: "dm:ua:ub", team_id: "t1", user_id: "ub", last_seen: now - 1000, joined_at: now - 5000 },
    ];
    const res = await (await handler())(ctx, { room_key: "dm:ua:ub", to_users: ["ub", "uc"] });
    expect(rows.call_invites.map((i) => i.to_user)).toEqual(["uc"]);
    const byUser = Object.fromEntries(res.results.map((r: any) => [r.to_user, r]));
    expect(byUser.ub.in_room).toBe(true);
  });

  test("a decline cools re-ringing down; a cancelled ring does not", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.call_invites = [
      { _id: "i1", room_key: "dm:ua:ub", team_id: "t1", from_user: "ua", to_user: "ub", status: "declined", created_at: now - 10_000, responded_at: now - 10_000 },
      { _id: "i2", room_key: "dm:ua:uc", team_id: "t1", from_user: "ua", to_user: "uc", status: "cancelled", created_at: now - 10_000, responded_at: now - 10_000 },
    ];
    const res = await (await handler())(ctx, { room_key: "dm:ua:ub", to_users: ["ub", "uc"] });
    const byUser = Object.fromEntries(res.results.map((r: any) => [r.to_user, r]));
    expect(byUser.ub.cooldown).toBe(true);
    expect(byUser.uc.cooldown).toBe(false);
    expect(rows.call_invites.filter((i) => i.status === "ringing").map((i) => i.to_user)).toEqual(["uc"]);
  });
});

// The call record's end is tied to the room's lease, not to the scribe's
// toggle: the last member out ends the room's live transcript; a room whose
// leases all went stale gets swept. Regression for calls that stayed "live"
// on the calls page forever after everyone hung up.
describe("transcript ends with the room", () => {
  function seat(rows: Record<string, any[]>, user: string, lastSeen: number) {
    rows.call_members.push({
      _id: `cm-${user}`, room_key: "channel:ch1", team_id: "t1", user_id: user,
      user_name: user, joined_at: lastSeen, last_seen: lastSeen,
      muted: true, camera: false, sharing: false,
    });
  }
  function transcript(rows: Record<string, any[]>) {
    rows.transcripts = [{
      _id: "tr1", room_key: "channel:ch1", team_id: "t1", started_by: "ua",
      status: "live", started_at: Date.now() - 60_000, routes: [], last_seq: 0,
    }];
  }
  async function fn(name: string) {
    const mod: any = await import("./calls");
    return mod[name]._handler ?? mod[name].handler;
  }

  test("leaving as the last member ends the transcript and schedules its summary", async () => {
    const { ctx, rows, scheduled, now } = fakeCtx();
    seat(rows, "ua", now);
    transcript(rows);
    await (await fn("leaveRoom"))(ctx, { room_key: "channel:ch1" });
    expect(rows.transcripts[0].status).toBe("ended");
    expect(rows.transcripts[0].ended_at).toBeGreaterThan(0);
    expect(scheduled.length).toBeGreaterThan(0);
  });

  test("leaving while others hold a fresh lease keeps the transcript live", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", now);
    seat(rows, "ub", now);
    transcript(rows);
    await (await fn("leaveRoom"))(ctx, { room_key: "channel:ch1" });
    expect(rows.transcripts[0].status).toBe("live");
  });

  test("the sweep ends a live transcript whose room leases all went stale", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", now - STALE - 1000);
    transcript(rows);
    const { sweepOrphanedLive } = await import("./transcripts");
    const h = (sweepOrphanedLive as any)._handler ?? (sweepOrphanedLive as any).handler;
    const res = await h(ctx, {});
    expect(res).toEqual({ checked: 1, ended: 1 });
    expect(rows.transcripts[0].status).toBe("ended");
    // Ended when the last lease was refreshed, not when the sweep ran.
    expect(rows.transcripts[0].ended_at).toBe(now - STALE - 1000);
  });

  test("the sweep leaves an occupied room's transcript alone", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", now);
    transcript(rows);
    const { sweepOrphanedLive } = await import("./transcripts");
    const h = (sweepOrphanedLive as any)._handler ?? (sweepOrphanedLive as any).handler;
    expect(await h(ctx, {})).toEqual({ checked: 1, ended: 0 });
    expect(rows.transcripts[0].status).toBe("live");
  });

  test("taking a seat in an emptied room ends the previous huddle's orphaned transcript", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ub", now - STALE - 1000);
    transcript(rows);
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    await (await fn("joinRoom"))(ctx, { room_key: "channel:ch1", muted: true });
    expect(rows.transcripts[0].status).toBe("ended");
  });
});

// The door. Huddles are open by default (callRooms.openRoomDoor is covered in
// callRooms.test.ts); these are the exception and the way back in from it.
describe("lock, knock and the live-room list", () => {
  async function fn(name: string) {
    const mod: any = await import("./calls");
    return mod[name]._handler ?? mod[name].handler;
  }
  const as = (ctx: any, user: string) => {
    ctx.auth = { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "x" }) };
  };
  function seat(rows: Record<string, any[]>, user: string, roomKey: string, lastSeen: number, team = "t1") {
    (rows.call_members ??= []).push({
      _id: `cm-${user}-${roomKey}`, room_key: roomKey, team_id: team, user_id: user,
      user_name: user, joined_at: lastSeen, last_seen: lastSeen,
      muted: true, camera: false, sharing: false,
    });
  }

  test("only someone in the huddle may lock its door", async () => {
    const { ctx, rows, now } = fakeCtx();
    // ua is a member of dm:ua:ub but is not sitting in it.
    await expect((await fn("setRoomLocked"))(ctx, { room_key: "dm:ua:ub", locked: true }))
      .rejects.toThrow(/in the huddle/);
    seat(rows, "ua", "dm:ua:ub", now);
    await (await fn("setRoomLocked"))(ctx, { room_key: "dm:ua:ub", locked: true });
    expect(rows.call_room_state).toHaveLength(1);
    expect(rows.call_room_state[0]).toMatchObject({ locked: true, locked_by: "ua", team_id: "t1" });
    // A teammate who was walking in is now refused; the pair still get in.
    const { authorizeRoom } = await import("./callRooms");
    expect((await authorizeRoom(ctx, "uc" as any, "dm:ua:ub")).ok).toBe(false);
    expect((await authorizeRoom(ctx, "ub" as any, "dm:ua:ub")).ok).toBe(true);
  });

  test("toggling reuses the room's one row and reopens the door", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    const h = await fn("setRoomLocked");
    await h(ctx, { room_key: "dm:ua:ub", locked: true });
    await h(ctx, { room_key: "dm:ua:ub", locked: false });
    expect(rows.call_room_state).toHaveLength(1);
    expect(rows.call_room_state[0].locked).toBe(false);
    const { authorizeRoom } = await import("./callRooms");
    expect((await authorizeRoom(ctx, "uc" as any, "dm:ua:ub")).ok).toBe(true);
  });

  test("unlocking answers every knock at once", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_knocks = [
      { _id: "k1", room_key: "dm:ua:ub", team_id: "t1", from_user: "uc", created_at: now },
      { _id: "k2", room_key: "channel:ch1", team_id: "t1", from_user: "uc", created_at: now },
    ];
    const h = await fn("setRoomLocked");
    await h(ctx, { room_key: "dm:ua:ub", locked: true });
    expect(rows.call_knocks.map((k) => k._id)).toEqual(["k1", "k2"]);
    await h(ctx, { room_key: "dm:ua:ub", locked: false });
    expect(rows.call_knocks.map((k) => k._id)).toEqual(["k2"]);
  });

  test("a room restarting from empty starts open, with nobody at the door", async () => {
    // The same joinRoom branch that expires the previous huddle's grants.
    const { ctx, rows, now } = fakeCtx();
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    seat(rows, "ub", "channel:ch1", now - STALE - 1000);
    rows.call_room_state = [{ _id: "rs1", room_key: "channel:ch1", team_id: "t1", locked: true, locked_by: "ub", updated_at: now - 60_000 }];
    rows.call_knocks = [{ _id: "k1", room_key: "channel:ch1", team_id: "t1", from_user: "uc", created_at: now }];
    await (await fn("joinRoom"))(ctx, { room_key: "channel:ch1", muted: true });
    expect(rows.call_room_state).toEqual([]);
    expect(rows.call_knocks).toEqual([]);
  });

  test("a knock needs a locked door and a teammate behind it", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    const h = await fn("knock");
    // Open room: there is nothing to knock at.
    as(ctx, "uc");
    await expect(h(ctx, { room_key: "dm:ua:ub" })).rejects.toThrow(/just join it/);
    rows.call_room_state = [{ _id: "rs1", room_key: "dm:ua:ub", team_id: "t1", locked: true, locked_by: "ua", updated_at: now }];
    // Outside the billing team: refused with the lock ignored too.
    as(ctx, "ud");
    await expect(h(ctx, { room_key: "dm:ua:ub" })).rejects.toThrow(/Cannot knock/);
    // An empty room is not a huddle to knock at.
    as(ctx, "uc");
    await expect(h(ctx, { room_key: "dm:ub:uc" })).rejects.toThrow(/Cannot knock/);
    // The room's own people never knock — they walk in.
    as(ctx, "ub");
    await expect(h(ctx, { room_key: "dm:ua:ub" })).rejects.toThrow(/just join it/);
    as(ctx, "uc");
    await h(ctx, { room_key: "dm:ua:ub" });
    expect(rows.call_knocks).toHaveLength(1);
    expect(rows.call_knocks[0]).toMatchObject({ from_user: "uc", team_id: "t1" });
  });

  test("knocking again refreshes one row; dead knocks are swept", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_room_state = [{ _id: "rs1", room_key: "dm:ua:ub", team_id: "t1", locked: true, locked_by: "ua", updated_at: now }];
    rows.call_knocks = [
      { _id: "old", room_key: "dm:ua:ub", team_id: "t1", from_user: "ub", created_at: now - CALL_KNOCK_TTL_MS - 1 },
    ];
    as(ctx, "uc");
    const h = await fn("knock");
    await h(ctx, { room_key: "dm:ua:ub" });
    await h(ctx, { room_key: "dm:ua:ub" });
    // ub's expired knock swept, uc's single row refreshed rather than twinned.
    expect(rows.call_knocks).toHaveLength(1);
    expect(rows.call_knocks[0].from_user).toBe("uc");
  });

  test("only the people inside see who is waiting", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_knocks = [
      { _id: "k1", room_key: "dm:ua:ub", team_id: "t1", from_user: "uc", created_at: now },
      { _id: "k2", room_key: "dm:ua:ub", team_id: "t1", from_user: "ub", created_at: now - CALL_KNOCK_TTL_MS - 1 },
    ];
    const h = await fn("getRoomKnocks");
    const inside = await h(ctx, { room_key: "dm:ua:ub" });
    expect(inside).toHaveLength(1); // the expired one is filtered, never shown
    expect(inside[0]).toMatchObject({ from_user: "uc", from_name: "Cy" });
    // uc is knocking, not sitting: they learn nothing about the room.
    as(ctx, "uc");
    expect(await h(ctx, { room_key: "dm:ua:ub" })).toEqual([]);
  });

  // The room must be able to tell a second knock from the first, and the only
  // thing that distinguishes them is created_at: knocking again refreshes one
  // row rather than adding a second. Rounding that timestamp (as every other
  // room subscription does, for byte-stability across heartbeats) would round
  // the second knock onto the first and the room would never hear it.
  test("a second knock is visible: the waiting row carries its exact time", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", "dm:ua:ub", now);
    rows.call_knocks = [
      { _id: "k1", room_key: "dm:ua:ub", team_id: "t1", from_user: "uc", created_at: now - 12_345 },
    ];
    const read = await fn("getRoomKnocks");
    const first = await read(ctx, { room_key: "dm:ua:ub" });
    expect(first[0].created_at).toBe(now - 12_345);
    // uc knocks again, 12s later — the same minute, the same row, a new time.
    rows.call_knocks[0].created_at = now;
    const second = await read(ctx, { room_key: "dm:ua:ub" });
    expect(second[0].created_at).toBe(now);
    expect(second[0].created_at).not.toBe(first[0].created_at);
  });

  test("getLiveRooms lists every live huddle across my teams", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.teams.push({ _id: "t2", name: "T2", features: { calls: true, chat: true } });
    rows.teams.push({ _id: "t3", name: "T3", features: { calls: true, chat: true } });
    rows.team_memberships.push({ _id: "m5", user_id: "ua", team_id: "t2" });
    rows.team_memberships.push({ _id: "m6", user_id: "ub", team_id: "t2" });
    rows.team_memberships.push({ _id: "m7", user_id: "uc", team_id: "t3" });
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    // A room I am a third party to, in each of my teams; one locked.
    seat(rows, "ub", "dm:ub:uc", now);
    seat(rows, "ub", "channel:ch1", now);
    rows.call_room_state = [{ _id: "rs1", room_key: "channel:ch1", team_id: "t1", locked: true, locked_by: "ub", updated_at: now }];
    // A stale room: nobody is in it, so it is not a huddle.
    seat(rows, "uc", "dm:ua:uc", now - STALE - 1000);
    // A huddle in a team I am not on.
    seat(rows, "uc", "dm:uc:ud", now, "t3");

    const live = await (await fn("getLiveRooms"))(ctx, {});
    expect(live.map((r: any) => r.room_key)).toEqual(["channel:ch1", "dm:ub:uc"]);
    const byKey = Object.fromEntries(live.map((r: any) => [r.room_key, r]));
    // Locked rooms still LIST — seeing the room is what makes knocking possible.
    expect(byKey["channel:ch1"]).toMatchObject({ locked: true, redacted: false, title: "design" });
    expect(byKey["dm:ub:uc"]).toMatchObject({ locked: false, redacted: false, team_id: "t1" });
    expect(byKey["dm:ub:uc"].members.map((m: any) => m.user_id)).toEqual(["ub"]);
  });

  test("a group huddle lists for a teammate outside it, and locking turns Join into Knock", async () => {
    // The caller (ua) is named nowhere in a three-person room. The decided
    // product lists it with its roster and lets ua walk in; locking it leaves
    // the room listed — that is what makes knocking possible — and the same
    // teammate may then knock.
    const { ctx, rows, now } = fakeCtx();
    rows.users.push({ _id: "ue", name: "Eve" });
    rows.team_memberships.push({ _id: "m5", user_id: "ue", team_id: "t1" });
    const groupKey = "dm:ub:uc:ue";
    for (const u of ["ub", "uc", "ue"]) seat(rows, u, groupKey, now);

    const open = await (await fn("getLiveRooms"))(ctx, {});
    expect(open.map((r: any) => r.room_key)).toEqual([groupKey]);
    expect(open[0].members.map((m: any) => m.user_id)).toEqual(["ub", "uc", "ue"]);
    expect(open[0].locked).toBe(false);
    const { authorizeRoom } = await import("./callRooms");
    expect((await authorizeRoom(ctx, "ua" as any, groupKey)).ok).toBe(true);

    rows.call_room_state = [{ _id: "rs1", room_key: groupKey, team_id: "t1", locked: true, locked_by: "ub", updated_at: now }];
    const shut = await (await fn("getLiveRooms"))(ctx, {});
    expect(shut[0]).toMatchObject({ room_key: groupKey, locked: true });
    expect(shut[0].members).toHaveLength(3);
    expect((await authorizeRoom(ctx, "ua" as any, groupKey)).ok).toBe(false);
    await (await fn("knock"))(ctx, { room_key: groupKey });
    expect(rows.call_knocks.map((k: any) => k.from_user)).toEqual(["ua"]);

    // ud is on another team: the outer wall refuses them at every step.
    as(ctx, "ud");
    expect(await (await fn("getLiveRooms"))(ctx, {})).toEqual([]);
    await expect((await fn("knock"))(ctx, { room_key: groupKey })).rejects.toThrow(/Cannot knock/);
  });

  // ct-44995: the lock is a fact about the ROOM; Join versus Knock is a fact
  // about the VIEWER, and the two are not the same question. calls.knock
  // refuses anyone authorizeRoom admits ("this huddle is open — just join
  // it"), so a row that reported only `locked` handed the room's own people a
  // button the server was guaranteed to reject.
  test("a locked room reports can_join for the people its lock does not shut out", async () => {
    const { ctx, rows, now } = fakeCtx();
    // ua's own 1:1 with ub: ub is sitting in it and locks the door. The lock
    // was never meant to exclude ua — it is their DM.
    seat(rows, "ub", "dm:ua:ub", now);
    // A room ua is a third party to, joinable only through the open door.
    seat(rows, "ub", "dm:ub:uc", now);
    seat(rows, "uc", "dm:ub:uc", now);

    const read = await fn("getLiveRooms");
    const open = Object.fromEntries((await read(ctx, {})).map((r: any) => [r.room_key, r]));
    expect(open["dm:ua:ub"]).toMatchObject({ locked: false, can_join: true });
    expect(open["dm:ub:uc"]).toMatchObject({ locked: false, can_join: true });

    rows.call_room_state = [
      { _id: "rs1", room_key: "dm:ua:ub", team_id: "t1", locked: true, locked_by: "ub", updated_at: now },
      { _id: "rs2", room_key: "dm:ub:uc", team_id: "t1", locked: true, locked_by: "ub", updated_at: now },
    ];
    const shut = Object.fromEntries((await read(ctx, {})).map((r: any) => [r.room_key, r]));
    // The member walks in through a locked door; the walk-in no longer can.
    expect(shut["dm:ua:ub"]).toMatchObject({ locked: true, can_join: true });
    expect(shut["dm:ub:uc"]).toMatchObject({ locked: true, can_join: false });
    // And the row agrees with the mutation behind each button, which is the
    // whole point: knocking is refused exactly where can_join is true.
    await expect((await fn("knock"))(ctx, { room_key: "dm:ua:ub" }))
      .rejects.toThrow(/just join it/);
    await (await fn("knock"))(ctx, { room_key: "dm:ub:uc" });
    expect(rows.call_knocks.map((k: any) => k.from_user)).toEqual(["ua"]);
  });

  test("a guest holding a live grant may still join a room that locked behind them", async () => {
    // The grant survives a lock — whoever was rung in was let in deliberately
    // — so their row must offer Join, not a knock the server refuses.
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ub", "dm:ub:uc", now);
    seat(rows, "uc", "dm:ub:uc", now);
    rows.call_room_state = [
      { _id: "rs1", room_key: "dm:ub:uc", team_id: "t1", locked: true, locked_by: "ub", updated_at: now },
    ];
    const read = await fn("getLiveRooms");
    expect((await read(ctx, {}))[0]).toMatchObject({ locked: true, can_join: false });

    rows.call_invites = [
      { _id: "i1", room_key: "dm:ub:uc", team_id: "t1", from_user: "ub", to_user: "ua",
        status: "accepted", created_at: now - 5_000, responded_at: now - 4_000 },
    ];
    expect((await read(ctx, {}))[0]).toMatchObject({ locked: true, can_join: true });
    await expect((await fn("knock"))(ctx, { room_key: "dm:ub:uc" }))
      .rejects.toThrow(/just join it/);
  });

  test("a private channel huddle stays off a non-member's list", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.chat_channels = [{ _id: "chp", team_id: "t1", name: "founders", kind: "private" }];
    rows.chat_channel_members = [{ _id: "cmb1", channel_id: "chp", user_id: "ub" }];
    seat(rows, "ub", "channel:chp", now);
    // ua is on the team and not in the channel: neither the room nor its
    // roster nor its name reaches them.
    expect(await (await fn("getLiveRooms"))(ctx, {})).toEqual([]);
  });

  test("a session huddle I cannot see lists without its title", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.conversations = [
      { _id: "cvp", user_id: "ub", team_id: "t1", is_private: true, title: "Secret refactor" },
      { _id: "cvs", user_id: "ub", team_id: "t1", is_private: false, title: "Shared work" },
    ];
    seat(rows, "ub", "session:cvp", now);
    seat(rows, "uc", "session:cvs", now);
    const live = await (await fn("getLiveRooms"))(ctx, {});
    const byKey = Object.fromEntries(live.map((r: any) => [r.room_key, r]));
    // Joinable either way — the team wall holds and the voices are audible.
    expect(byKey["session:cvp"]).toMatchObject({ redacted: true, title: undefined });
    expect(JSON.stringify(byKey["session:cvp"])).not.toContain("Secret refactor");
    expect(byKey["session:cvs"]).toMatchObject({ redacted: false, title: "Shared work" });
  });

  test("a heartbeat does not re-push the team-wide list", async () => {
    // Byte-stability is the contract: every client on the team holds this
    // subscription while any huddle runs.
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ub", "dm:ub:uc", now - 30_000);
    const h = await fn("getLiveRooms");
    const before = await h(ctx, {});
    rows.call_members[0].last_seen = now; // the 15s heartbeat, and nothing else
    expect(await h(ctx, {})).toEqual(before);
  });
});

// Requirement 5 of the open-rooms design, verified rather than assumed: the
// team strip (teams.getTeamMembers) hands the viewer a member's room KEY only
// when authorizeRoom says they could join it, so the open door reaches the
// strip with no code change there.
describe("team strip inherits the open door", () => {
  const now = Date.now();
  const tables = () => ({
    teams: [{ _id: "t1", name: "T", features: { calls: true, chat: true } }],
    team_memberships: [
      { _id: "m1", user_id: "ua", team_id: "t1" },
      { _id: "m2", user_id: "ub", team_id: "t1" },
      { _id: "m3", user_id: "uc", team_id: "t1" },
    ],
    users: [
      { _id: "ua", name: "Ann" },
      { _id: "ub", name: "Bob" },
      { _id: "uc", name: "Cy" },
    ],
    // ua and ub are huddling in their own 1:1 room; uc is a third party.
    call_members: [
      { _id: "cm-ua", room_key: "dm:ua:ub", team_id: "t1", user_id: "ua", user_name: "Ann", joined_at: now - 60_000, last_seen: now, muted: true, camera: false, sharing: false },
    ],
    call_room_state: [] as any[],
    user_presence: [] as any[],
    devices: [] as any[],
    conversations: [] as any[],
  });

  async function stripFor(rows: ReturnType<typeof tables>) {
    const { makeFakeDb } = await import("./testDb");
    const { getTeamMembers } = await import("./teams");
    const ctx: any = {
      db: makeFakeDb(rows as any),
      auth: { getUserIdentity: async () => ({ subject: "uc|sess", tokenIdentifier: "x" }) },
    };
    const h = (getTeamMembers as any)._handler ?? (getTeamMembers as any).handler;
    const members = await h(ctx, { team_id: "t1" });
    return members.find((m: any) => String(m._id) === "ua");
  }

  test("an unlocked huddle names its room to the whole team", async () => {
    const ann = await stripFor(tables());
    expect(ann.in_huddle).toBe(true);
    expect(ann.in_room_key).toBe("dm:ua:ub");
  });

  test("a locked huddle falls back to the bare 'in a huddle' signal", async () => {
    const rows = tables();
    rows.call_room_state = [
      { _id: "rs1", room_key: "dm:ua:ub", team_id: "t1", locked: true, locked_by: "ua", updated_at: now },
    ];
    const ann = await stripFor(rows);
    expect(ann.in_huddle).toBe(true);
    expect(ann.in_room_key).toBeUndefined();
  });
});

// Every huddle transcribes, so several seated clients ask to scribe one room
// and transcripts.start is the arbiter. One live run per room: the first
// asker owns it, the rest are observers, a scribe whose seat lease died is
// replaced, and "stop transcribing" is a fact about the room.
describe("who scribes", () => {
  async function fn(mod: "./calls" | "./transcripts", name: string) {
    const m: any = await import(mod);
    return m[name]._handler ?? m[name].handler;
  }
  const as = (ctx: any, user: string) => {
    ctx.auth = { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "x" }) };
  };
  function seat(rows: Record<string, any[]>, user: string, lastSeen: number) {
    rows.call_members.push({
      _id: `cm-${user}`, room_key: "channel:ch1", team_id: "t1", user_id: user,
      user_name: user, joined_at: lastSeen, last_seen: lastSeen,
      muted: true, camera: false, sharing: false,
    });
  }
  function room(rows: Record<string, any[]>) {
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    rows.transcripts = [];
    rows.call_room_state = [];
  }

  test("the first asker scribes; the next seated asker observes", async () => {
    const { ctx, rows, now } = fakeCtx();
    room(rows); seat(rows, "ua", now); seat(rows, "ub", now);
    const start = await fn("./transcripts", "start");
    const first = await start(ctx, { room_key: "channel:ch1", auto: true });
    expect(first.role).toBe("scribe");
    expect(first.existing).toBe(false);
    as(ctx, "ub");
    const second = await start(ctx, { room_key: "channel:ch1", auto: true });
    expect(second).toEqual({ transcript_id: first.transcript_id, existing: true, role: "observer" });
    expect(rows.transcripts).toHaveLength(1);
    expect(rows.transcripts[0].started_by).toBe("ua");
  });

  test("the scribe's own run resumes after a reload", async () => {
    const { ctx, rows, now } = fakeCtx();
    room(rows); seat(rows, "ua", now); seat(rows, "ub", now);
    const start = await fn("./transcripts", "start");
    const first = await start(ctx, { room_key: "channel:ch1" });
    const again = await start(ctx, { room_key: "channel:ch1", auto: true });
    expect(again).toEqual({ transcript_id: first.transcript_id, existing: true, role: "scribe" });
  });

  test("a scribe whose seat lease died is replaced, and the run continues under the new scribe", async () => {
    const { ctx, rows, now } = fakeCtx();
    room(rows); seat(rows, "ua", now - STALE - 1000); seat(rows, "ub", now);
    rows.transcripts = [{
      _id: "tr1", room_key: "channel:ch1", team_id: "t1", started_by: "ua",
      status: "live", started_at: now - 60_000, routes: [], last_seq: 4,
    }];
    as(ctx, "ub");
    const res = await (await fn("./transcripts", "start"))(ctx, { room_key: "channel:ch1", auto: true });
    expect(res).toEqual({ transcript_id: "tr1", existing: true, role: "scribe" });
    // The row was adopted, not forked: same run, same numbering, new owner —
    // which is what lets ub's appends through requireOwnLiveTranscript.
    expect(rows.transcripts).toHaveLength(1);
    expect(rows.transcripts[0].started_by).toBe("ub");
    expect(rows.transcripts[0].last_seq).toBe(4);
  });

  test("the room's opt-out answers an auto start with off, and a manual start still runs", async () => {
    const { ctx, rows, now } = fakeCtx();
    room(rows); seat(rows, "ua", now); seat(rows, "ub", now);
    await (await fn("./calls", "setRoomTranscribeOff"))(ctx, { room_key: "channel:ch1", off: true });
    expect(rows.call_room_state[0]).toMatchObject({ transcribe_off: true, locked: false, team_id: "t1" });
    const start = await fn("./transcripts", "start");
    expect(await start(ctx, { room_key: "channel:ch1", auto: true })).toEqual({
      transcript_id: null, existing: false, role: "off",
    });
    expect(rows.transcripts).toHaveLength(0);
    expect((await start(ctx, { room_key: "channel:ch1" })).role).toBe("scribe");
  });

  test("only someone in the huddle may turn its transcription off", async () => {
    const { ctx, rows } = fakeCtx();
    room(rows);
    await expect((await fn("./calls", "setRoomTranscribeOff"))(ctx, { room_key: "channel:ch1", off: true }))
      .rejects.toThrow(/in the huddle/);
  });

  test("the opt-out shares the lock's row and shows in the live-room list", async () => {
    const { ctx, rows, now } = fakeCtx();
    room(rows); seat(rows, "ua", now);
    await (await fn("./calls", "setRoomLocked"))(ctx, { room_key: "channel:ch1", locked: true });
    await (await fn("./calls", "setRoomTranscribeOff"))(ctx, { room_key: "channel:ch1", off: true });
    expect(rows.call_room_state).toHaveLength(1);
    expect(rows.call_room_state[0]).toMatchObject({ locked: true, transcribe_off: true });
    const list = await (await fn("./calls", "getLiveRooms"))(ctx, {});
    expect(list.find((r: any) => r.room_key === "channel:ch1")).toMatchObject({ locked: true, transcribe_off: true });
  });
});

// THE CONNECTION HELD OPEN AHEAD OF THE FIRST WORD.
//
// Being heard live is gated on a media connection that takes seconds to build,
// so opening a DM or resting on a face connects early and publishes nothing.
// That leaves a row in this table for somebody who is not in the room, and
// every test here is about the row saying so — because each reader that
// believed it would tell a lie: "X hears you" over silence, an occupancy chip
// on an empty room, an invite grant carried by nobody, a room whose lease never
// lapses.
//
// The rule lives in `liveMembers` rather than in each reader. It is the one
// question every reader of this table already asks, so there is no reader that
// has to remember it and no new one that can forget.
describe("prewarm: a connection held open by somebody who is not here", () => {
  const now = Date.now();
  const seat = (over: Record<string, unknown> = {}) => ({
    _id: "cmX", room_key: "channel:ch1", team_id: "t1", user_id: "u1", user_name: "U",
    joined_at: now - 1_000, last_seen: now - 1_000, muted: true, camera: false, sharing: false,
    ...over,
  });

  test("liveMembers drops it, so no reader can count it", async () => {
    const { liveMembers } = await import("./callRooms");
    expect(liveMembers([seat()], now)).toHaveLength(1);
    expect(liveMembers([seat({ prewarm: true })], now)).toHaveLength(0);
    // And a room holding nothing but prewarms is EMPTY, which is what lets the
    // next real join start a new huddle rather than inherit a dead one's
    // grants, lock and live transcript.
    expect(liveMembers([seat({ prewarm: true }), seat({ _id: "cmY", prewarm: true })], now)).toHaveLength(0);
  });

  // Keyed by TABLE, unlike the older fakes above, because these tests assert on
  // what was deleted. A `by_user` scan that also matches the membership row and
  // a transcript sweep that also matches a seat both read as the mutation
  // deleting things it never touched.
  function prewarmCtx(rows: any[]) {
    const tables: Record<string, any[]> = {
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "t1" }],
      call_members: rows,
    };
    const deleted: string[] = [];
    const patches: any[] = [];
    const inserted: any[] = [];
    const ctx: any = {
      auth: { getUserIdentity: async () => ({ subject: "u1|sess", tokenIdentifier: "x" }) },
      db: {
        query: (t: string) => ({
          withIndex: (_i: string, builder: any) => {
            const eqs: Array<[string, any]> = [];
            builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
            const hit = (tables[t] ?? []).filter(
              (r) => !deleted.includes(r._id) && eqs.every(([f, v]) => String(r[f]) === String(v)),
            );
            return { collect: async () => hit, unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
          },
        }),
        get: async (id: string) =>
          id === "u1" ? { _id: "u1", name: "U" }
          : id === "ch1" ? { _id: "ch1", team_id: "t1" }
          : id === "ch2" ? { _id: "ch2", team_id: "t1" }
          : id === "t1" ? { _id: "t1", name: "T", features: { calls: true, chat: true } }
          : Object.values(tables).flat().find((r) => r._id === id) ?? null,
        delete: async (id: string) => { deleted.push(id); },
        patch: async (id: string, doc: any) => { patches.push({ id, ...doc }); },
        insert: async (t: string, doc: any) => { inserted.push({ _table: t, ...doc }); return "cmNew"; },
      },
    };
    return { ctx, deleted, patches, inserted };
  }

  async function join(ctx: any, args: any) {
    const { joinRoom } = await import("./calls");
    const handler = (joinRoom as any)._handler ?? (joinRoom as any).handler;
    return handler(ctx, { room_key: "channel:ch1", ...args });
  }

  test("writes a row that says what it is: flagged, muted, unstamped", async () => {
    const { ctx, inserted } = prewarmCtx([]);
    const res = await join(ctx, { prewarm: true });
    expect(res).toEqual({ room_key: "channel:ch1", prewarm: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].prewarm).toBe(true);
    expect(inserted[0].muted).toBe(true);
    // Nobody stepped into anything. The stamp is what turns a burst into a
    // call on both sides' surfaces.
    expect(inserted[0].walkie_joined_at).toBeUndefined();
  });

  test("takes nothing: no sweep, no eviction, no room reset", async () => {
    const { ctx, deleted, patches } = prewarmCtx([]);
    await join(ctx, { prewarm: true });
    // A real join sweeps the room's dead rows, expires the last huddle's
    // grants, clears its lock and ends its transcript. A guess about what
    // somebody might do next earns none of that.
    expect(deleted).toEqual([]);
    expect(patches).toEqual([]);
  });

  test("a real seat anywhere refuses it, so a hover can never hang up a call", async () => {
    // The hazard this exists for: joining a room implicitly leaves every other
    // one, and prewarm is fired by a pointer resting on a face. Without the
    // refusal, moving a mouse across the avatar bar during a call would delete
    // the seat that call is running on.
    const { ctx, deleted, inserted } = prewarmCtx([
      seat({ _id: "live1", room_key: "channel:ch2", last_seen: now }),
    ]);
    const res = await join(ctx, { prewarm: true });
    expect(res).toEqual({ room_key: "channel:ch1", prewarm: false });
    expect(deleted).toEqual([]);
    expect(inserted).toEqual([]);
  });

  test("one at a time: a second room drops the first", async () => {
    const { ctx, deleted, inserted } = prewarmCtx([
      seat({ _id: "warm1", room_key: "channel:ch2", last_seen: now, prewarm: true }),
    ]);
    await join(ctx, { prewarm: true });
    expect(deleted).toEqual(["warm1"]);
    expect(inserted).toHaveLength(1);
  });

  test("the press turns it into a seat: the flag clears and the clock restarts", async () => {
    // The row the connection was held on is the row the join lands on, so
    // clearing the flag here is what makes "X hears you" turn true on the same
    // round trip that opens the microphone.
    const { ctx, patches } = prewarmCtx([
      seat({ _id: "warm1", last_seen: now, prewarm: true, joined_at: now - 80_000 }),
    ]);
    const before = Date.now();
    await join(ctx, { muted: false, walkie_join: true });
    expect(patches).toHaveLength(1);
    expect(patches[0].prewarm).toBeUndefined();
    expect(patches[0].muted).toBe(false);
    expect(patches[0].walkie_joined_at).toBeGreaterThanOrEqual(before);
    // The huddle started when the person did, not when the connection opened
    // a minute and a half earlier.
    expect(patches[0].joined_at).toBeGreaterThanOrEqual(before);
  });

  test("an ordinary join carries no flag at all", async () => {
    const { ctx, inserted } = prewarmCtx([]);
    await join(ctx, { muted: false });
    expect(inserted[0].prewarm).toBeUndefined();
  });
});
