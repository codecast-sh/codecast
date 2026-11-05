import { getFunctionName } from "convex/server";
import { describe, expect, test } from "bun:test";
import {
  CALL_INVITE_TTL_MS,
  CALL_KNOCK_TTL_MS,
  CALL_MEMBER_STALE_MS,
} from "./calls";

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
import { HUDDLE_GRACE_MS } from "./transcripts";
import { fakeCtx } from "./calls.testkit";
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
            return { collect: async () => hit, take: async (n: number) => hit.slice(0, n), unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
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

// THE DEAD LEAVE WITH THE LIVING'S BEAT (pl-756 F5 a). A lapsed row is hidden
// by liveMembers but stayed on disk until the next join into its room, and a
// room nobody joins is where a dead seat is noticed. The heartbeat, which any
// live member sends every 15s, sweeps the room it beats in.
describe("heartbeat sweeps the room it beats in", () => {
  function beatCtx(rows: any[]) {
    const deleted: string[] = [];
    const patched: Array<{ id: string; doc: any }> = [];
    const ctx: any = {
      auth: { getUserIdentity: async () => ({ subject: "u1|sess", tokenIdentifier: "x" }) },
      db: {
        query: (_t: string) => ({
          withIndex: (_i: string, builder: any) => {
            const eqs: Array<[string, any]> = [];
            builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
            const hit = rows.filter((r) => !deleted.includes(r._id) && eqs.every(([f, v]) => String(r[f]) === String(v)));
            return { collect: async () => hit, take: async (n: number) => hit.slice(0, n), unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
          },
        }),
        get: async (id: string) => rows.find((r) => r._id === id) ?? null,
        delete: async (id: string) => { deleted.push(id); },
        patch: async (id: string, doc: any) => {
          if (deleted.includes(id)) throw new Error("Update on nonexistent document ID " + id);
          patched.push({ id, doc });
        },
        insert: async () => { throw new Error("a heartbeat inserts nothing"); },
      },
    };
    return { ctx, deleted, patched };
  }
  const seat = (id: string, user: string, lastSeen: number, over: Record<string, unknown> = {}) => ({
    _id: id, room_key: "dm:u1:u2", team_id: "t1", user_id: user, user_name: user,
    joined_at: lastSeen - 60_000, last_seen: lastSeen, muted: true, camera: false, sharing: false, ...over,
  });

  test("a live member's beat deletes every lapsed row in its room and touches nothing fresh", async () => {
    const now = Date.now();
    const rows = [
      seat("mine", "u1", now - 14_000),
      seat("dead", "u2", now - STALE - 1),
      seat("fresh", "u3", now - 10_000),
      // A prewarm whose hold lapsed is a dead row like any other.
      seat("warm", "u4", now - STALE - 5_000, { prewarm: true }),
      // A lease one beat from lapsing is still a seat: nobody is evicted early.
      seat("late", "u5", now - STALE + 1_000),
    ];
    const { ctx, deleted, patched } = beatCtx(rows);
    const { heartbeat } = await import("./calls");
    const h = (heartbeat as any)._handler ?? (heartbeat as any).handler;
    expect(await h(ctx, { room_key: "dm:u1:u2", muted: true })).toEqual({ ok: true });
    expect(deleted.sort()).toEqual(["dead", "warm"]);
    expect(patched.map((p) => p.id)).toEqual(["mine"]);
  });

  test("our own row is refreshed BEFORE the sweep, so a beat that arrives late keeps its seat", async () => {
    // Laptop asleep 46s: the beat lands just past the lease. The row is ours
    // and we are demonstrably alive, so the sweep must see it fresh.
    const now = Date.now();
    const rows = [seat("mine", "u1", now - STALE - 1_000)];
    const { ctx, deleted, patched } = beatCtx(rows);
    const { heartbeat } = await import("./calls");
    const h = (heartbeat as any)._handler ?? (heartbeat as any).handler;
    // The fake patch does not write through, so mirror it: a real db reads
    // the fresh last_seen back in the sweep's collect.
    ctx.db.patch = async (id: string, doc: any) => { rows[0].last_seen = doc.last_seen; patched.push({ id, doc }); };
    expect(await h(ctx, { room_key: "dm:u1:u2" })).toEqual({ ok: true });
    expect(patched.map((p) => p.id)).toEqual(["mine"]);
    expect(deleted).toEqual([]);
  });

  test("a beat for a row already swept still sweeps the room and answers ok:false", async () => {
    // The client's recovery join follows ok:false; meanwhile the dead peer
    // beside it must not wait for that join to be cleared.
    const now = Date.now();
    const rows = [seat("dead", "u2", now - STALE - 1)];
    const { ctx, deleted, patched } = beatCtx(rows);
    const { heartbeat } = await import("./calls");
    const h = (heartbeat as any)._handler ?? (heartbeat as any).handler;
    expect(await h(ctx, { room_key: "dm:u1:u2" })).toEqual({ ok: false });
    expect(deleted).toEqual(["dead"]);
    expect(patched).toEqual([]);
  });
});

describe("joinRoom answers the joiner's ring into the room", () => {
  // A seat taken by any path (the channel's Join, a face, another device) left
  // the invite ringing, so "Samvit is calling" sat over a call the person could
  // already hear (2026-11-04).
  async function join(roomKey: string, extra: Record<string, unknown> = {}) {
    const now = Date.now();
    const rows: any[] = [
      { _id: "m1", user_id: "u1", team_id: "t1" },
      { _id: "inv-here", to_user: "u1", status: "ringing", room_key: roomKey, created_at: now - 2_000 },
      { _id: "inv-there", to_user: "u1", status: "ringing", room_key: "channel:other", created_at: now - 2_000 },
    ];
    const patches: Record<string, any> = {};
    const ctx: any = {
      auth: { getUserIdentity: async () => ({ subject: "u1|sess", tokenIdentifier: "x" }) },
      scheduler: { runAfter: async () => {} },
      db: {
        query: (_t: string) => ({
          withIndex: (_i: string, builder: any) => {
            const eqs: Array<[string, any]> = [];
            builder({ eq(f: string, v: any) { eqs.push([f, v]); return this; } });
            const hit = rows.filter((r) => eqs.every(([f, v]) => String(r[f]) === String(v)));
            return { collect: async () => hit, take: async (n: number) => hit.slice(0, n), unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
          },
        }),
        get: async (id: string) => (id === "u1" ? { _id: "u1", name: "U" } : id === "ch1" ? { _id: "ch1", team_id: "t1" } : id === "t1" ? { _id: "t1", name: "T", features: { calls: true, chat: true } } : rows.find((r) => r._id === id) ?? null),
        delete: async () => {},
        patch: async (id: string, p: any) => { patches[id] = { ...(patches[id] ?? {}), ...p }; },
        insert: async () => "cm-new",
      },
    };
    const { joinRoom } = await import("./calls");
    const handler = (joinRoom as any)._handler ?? (joinRoom as any).handler;
    await handler(ctx, { room_key: roomKey, muted: true, ...extra });
    return patches;
  }

  test("a seat in a channel huddle accepts the ring into it, and only that one", async () => {
    const patches = await join("channel:ch1");
    expect(patches["inv-here"]).toMatchObject({ status: "accepted" });
    expect(patches["inv-there"]).toBeUndefined();
  });

  test("a prewarm seat answers nothing", async () => {
    const patches = await join("channel:ch1", { prewarm: true });
    expect(patches["inv-here"]).toBeUndefined();
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
            return { collect: async () => hit, take: async (n: number) => hit.slice(0, n), unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
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

  test("a seat stores the languages this device is set to", async () => {
    const { ctx, inserted } = stampCtx();
    await join(ctx, { muted: true, languages: ["ja-JP", "en"] });
    expect(inserted[0].languages).toEqual(["ja", "en"]);
  });

  test("an older client that sends no languages still joins", async () => {
    const { ctx, inserted } = stampCtx();
    await join(ctx, { muted: true });
    expect(inserted[0].languages).toBeUndefined();
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

  test("getMyCalls keeps an accepted ring in the caller's outgoing for its seat's round trip", async () => {
    const { ctx, rows, now } = fakeCtx();
    rows.call_invites = [
      { _id: "a1", room_key: "dm:ua:ub", team_id: "t1", from_user: "ua", to_user: "ub", status: "accepted", created_at: now - 8_000, responded_at: now - 2_000 },
      { _id: "a2", room_key: "dm:ua:uc", team_id: "t1", from_user: "ua", to_user: "uc", status: "accepted", created_at: now - 90_000, responded_at: now - 60_000 },
      { _id: "c1", room_key: "dm:ua:ud", team_id: "t1", from_user: "ua", to_user: "ud", status: "cancelled", created_at: now - 8_000, responded_at: now - 2_000 },
    ];
    const { getMyCalls } = await import("./calls");
    const res = await ((getMyCalls as any)._handler ?? (getMyCalls as any).handler)(ctx, {});
    expect(res.outgoing.map((r: any) => [String(r.to_user), r.status])).toEqual([["ub", "accepted"]]);
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

// The call record is the huddle: its end is tied to the room standing empty,
// never to the transcription switch, and a room emptied for less than the
// grace (a rejoin, a dropped connection, a hop to another room) is the same
// huddle. Regressions: calls that stayed "live" forever after everyone hung
// up, and one conversation split into several records seconds apart.
describe("transcript ends with the room", () => {
  function seat(rows: Record<string, any[]>, user: string, lastSeen: number) {
    rows.call_members.push({
      _id: `cm-${user}`, room_key: "channel:ch1", team_id: "t1", user_id: user,
      user_name: user, joined_at: lastSeen, last_seen: lastSeen,
      muted: true, camera: false, sharing: false,
    });
  }
  function transcript(rows: Record<string, any[]>, over: Record<string, unknown> = {}) {
    rows.transcripts = [{
      _id: "tr1", room_key: "channel:ch1", team_id: "t1", started_by: "ua",
      status: "live", started_at: Date.now() - 600_000, routes: [], last_seq: 0, ...over,
    }];
  }
  async function fn(name: string) {
    const mod: any = await import("./calls");
    return mod[name]._handler ?? mod[name].handler;
  }
  async function tfn(name: string) {
    const mod: any = await import("./transcripts");
    return mod[name]._handler ?? mod[name].handler;
  }
  const scheduledNames = (scheduled: any[]) => scheduled.map((x) => getFunctionName(x.fn));

  test("the last one out starts the grace; the record ends where the room emptied", async () => {
    const { ctx, rows, scheduled, now } = fakeCtx();
    seat(rows, "ua", now);
    transcript(rows);
    await (await fn("leaveRoom"))(ctx, { room_key: "channel:ch1" });
    expect(rows.transcripts[0].status).toBe("live");
    expect(rows.transcripts[0].idle_since).toBeGreaterThanOrEqual(now);
    expect(scheduledNames(scheduled)).toContain("transcripts:endIdleTranscript");
    // The grace runs out with nobody back.
    rows.transcripts[0].idle_since = now - HUDDLE_GRACE_MS;
    expect(await (await tfn("endIdleTranscript"))(ctx, { transcript_id: "tr1" })).toEqual({ ended: true });
    expect(rows.transcripts[0].status).toBe("ended");
    expect(rows.transcripts[0].ended_at).toBe(now - HUDDLE_GRACE_MS);
    expect(scheduledNames(scheduled)).toContain("transcripts:generateSummary");
  });

  test("leaving while others hold a fresh lease keeps the transcript live", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", now);
    seat(rows, "ub", now);
    transcript(rows);
    await (await fn("leaveRoom"))(ctx, { room_key: "channel:ch1" });
    expect(rows.transcripts[0].status).toBe("live");
    expect(rows.transcripts[0].idle_since).toBeUndefined();
  });

  test("coming back inside the grace carries on the same huddle", async () => {
    const { ctx, rows, now } = fakeCtx();
    transcript(rows, { idle_since: now - 60_000 });
    rows.call_room_state = [{ _id: "rs1", room_key: "channel:ch1", team_id: "t1", transcribe_off: true, updated_at: now - 90_000 }];
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    await (await fn("joinRoom"))(ctx, { room_key: "channel:ch1", muted: true });
    expect(rows.transcripts[0].status).toBe("live");
    expect(rows.transcripts[0].idle_since).toBeUndefined();
    // Same huddle, same switch: it was off and it stays off.
    expect(rows.call_room_state[0].transcribe_off).toBe(true);
    // The grace check that fires later finds somebody back and leaves it be.
    rows.transcripts[0].idle_since = undefined;
    expect(await (await tfn("endIdleTranscript"))(ctx, { transcript_id: "tr1" })).toEqual({ ended: false });
  });

  test("taking a seat after the grace ends the previous huddle where it went quiet", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ub", now - HUDDLE_GRACE_MS - 1000);
    transcript(rows);
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    await (await fn("joinRoom"))(ctx, { room_key: "channel:ch1", muted: true });
    expect(rows.transcripts[0].status).toBe("ended");
    expect(rows.transcripts[0].ended_at).toBe(now - HUDDLE_GRACE_MS - 1000);
  });

  test("the sweep ends a huddle whose room has been empty past the grace", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", now - HUDDLE_GRACE_MS - 1000);
    transcript(rows);
    const res = await (await tfn("sweepOrphanedLive"))(ctx, {});
    expect(res).toEqual({ checked: 1, ended: 1 });
    expect(rows.transcripts[0].status).toBe("ended");
    // Ended when the last lease was refreshed, not when the sweep ran.
    expect(rows.transcripts[0].ended_at).toBe(now - HUDDLE_GRACE_MS - 1000);
  });

  test("the sweep leaves an occupied room's transcript alone", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", now);
    transcript(rows);
    expect(await (await tfn("sweepOrphanedLive"))(ctx, {})).toEqual({ checked: 1, ended: 0 });
    expect(rows.transcripts[0].status).toBe("live");
  });

  test("switching transcription back on resumes the record under the presser", async () => {
    const { ctx, rows, now } = fakeCtx();
    seat(rows, "ua", now);
    seat(rows, "ub", now);
    transcript(rows, { started_by: "ub" });
    rows.call_room_state = [{ _id: "rs1", room_key: "channel:ch1", team_id: "t1", transcribe_off: true, updated_at: now - 1000 }];
    rows.chat_channels = [{ _id: "ch1", team_id: "t1", name: "design" }];
    await (await fn("setRoomTranscribeOff"))(ctx, { room_key: "channel:ch1", off: false });
    expect(rows.transcripts).toHaveLength(1);
    expect(rows.transcripts[0].started_by).toBe("ua");
    expect((rows.call_chat_messages ?? []).map((r: any) => [r.event, r.transcript_id])).toEqual([["transcribe_on", "tr1"]]);
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
    expect(again).toMatchObject({ transcript_id: first.transcript_id, existing: true, role: "scribe" });
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
    expect(res).toMatchObject({ transcript_id: "tr1", existing: true, role: "scribe" });
    // The new scribe times its words on the record's clock, a minute in, so
    // its first line does not sort before everything already said.
    expect(res.elapsed_ms).toBeGreaterThanOrEqual(60_000);
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
  function prewarmCtx(rows: any[], recordings: any[] = []) {
    const tables: Record<string, any[]> = {
      team_memberships: [{ _id: "m1", user_id: "u1", team_id: "t1" }],
      call_members: rows,
      call_recordings: recordings,
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
            return { collect: async () => hit, take: async (n: number) => hit.slice(0, n), unique: async () => hit[0] ?? null, first: async () => hit[0] ?? null };
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

  async function leave(ctx: any, args: any) {
    const { leaveRoom } = await import("./calls");
    const handler = (leaveRoom as any)._handler ?? (leaveRoom as any).handler;
    return handler(ctx, { room_key: "channel:ch1", ...args });
  }

  test("letting a prewarm go never touches a seat in that room", async () => {
    // The desktop case: the main window warmed the room on a hover, the voice
    // host then sat in it on the same (user, room) row, and the main window's
    // idle release came 90s later. Deleting the seat and stamping a hang-up
    // made the person's next heartbeat leave their own call.
    const { ctx, deleted, inserted } = prewarmCtx([
      seat({ _id: "live1", room_key: "channel:ch1", last_seen: now }),
    ]);
    await leave(ctx, { prewarm: true });
    expect(deleted).toEqual([]);
    expect(inserted).toEqual([]);
  });

  test("letting a prewarm go drops its row and records no hang-up", async () => {
    const { ctx, deleted, inserted } = prewarmCtx([
      seat({ _id: "warm1", room_key: "channel:ch1", last_seen: now, prewarm: true }),
    ]);
    await leave(ctx, { prewarm: true });
    expect(deleted).toContain("warm1");
    expect(inserted.filter((r) => r._table === "call_hangups")).toEqual([]);
  });

  test("a recorded room refuses it: everyone in a recording is told, and a prewarm is nobody", async () => {
    // The client skips recorded rooms on its own; this is the server's half,
    // so an older bundle cannot drop a muted, unseated tile into the composite.
    for (const status of ["starting", "recording"]) {
      const { ctx, inserted, deleted } = prewarmCtx([], [
        { _id: `rec-${status}`, room_key: "channel:ch1", kind: "composite", status },
      ]);
      const res = await join(ctx, { prewarm: true });
      expect(res).toEqual({ room_key: "channel:ch1", prewarm: false });
      expect(inserted).toEqual([]);
      expect(deleted).toEqual([]);
    }
  });

  test("a room whose recording ended, or another room recording, still takes it", async () => {
    const { ctx, inserted } = prewarmCtx([], [
      { _id: "recDone", room_key: "channel:ch1", kind: "composite", status: "ready" },
      { _id: "recStop", room_key: "channel:ch1", kind: "composite", status: "stopping" },
      { _id: "recElse", room_key: "channel:ch2", kind: "composite", status: "recording" },
    ]);
    const res = await join(ctx, { prewarm: true });
    expect(res).toEqual({ room_key: "channel:ch1", prewarm: true });
    expect(inserted).toHaveLength(1);
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
