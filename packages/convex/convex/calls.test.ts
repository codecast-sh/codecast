import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  CALL_INVITE_TTL_MS,
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
