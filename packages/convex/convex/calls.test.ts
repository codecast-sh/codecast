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
describe("invite fan-out", () => {
  function inviteCtx() {
    const now = Date.now();
    const rows: Record<string, any[]> = {
      teams: [{ _id: "t1", name: "T", features: { calls: true } }],
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

  async function handler() {
    const { invite } = await import("./calls");
    return (invite as any)._handler ?? (invite as any).handler;
  }

  test("rings every recipient with one row each and reports per recipient", async () => {
    const { ctx, rows } = inviteCtx();
    const res = await (await handler())(ctx, {
      room_key: "dm:ua:ub",
      to_users: ["ub", "uc", "ud"],
      anchor_title: "design sync",
    });
    // ub (member) and uc (teammate, not in the pair) ring; ud is refused.
    const ringing = rows.call_invites.filter((i) => i.status === "ringing");
    expect(ringing.map((i) => i.to_user).sort()).toEqual(["ub", "uc"]);
    expect(ringing.every((i) => i.room_key === "dm:ua:ub" && i.anchor_title === "design sync")).toBe(true);
    const byUser = Object.fromEntries(res.results.map((r: any) => [r.to_user, r]));
    expect(byUser.ub.busy).toBe(true); // manual busy: rang quietly
    expect(byUser.uc.busy).toBe(false);
    expect(byUser.ud.refused).toBeTruthy();
    // Historic single-recipient mirror.
    expect(res.busy).toBe(true);
  });

  test("the single `to_user` form still rings, and both forms dedupe", async () => {
    const { ctx, rows } = inviteCtx();
    await (await handler())(ctx, { room_key: "dm:ua:ub", to_user: "ub", to_users: ["ub"] });
    expect(rows.call_invites.filter((i) => i.to_user === "ub")).toHaveLength(1);
  });

  test("re-ringing refreshes the same row instead of minting a second", async () => {
    const { ctx, rows } = inviteCtx();
    const h = await handler();
    await h(ctx, { room_key: "dm:ua:ub", to_users: ["ub"] });
    await h(ctx, { room_key: "dm:ua:ub", to_users: ["ub", "uc"] });
    expect(rows.call_invites.filter((i) => i.to_user === "ub")).toHaveLength(1);
    expect(rows.call_invites.filter((i) => i.to_user === "uc")).toHaveLength(1);
  });

  test("refuses ringing yourself, nobody, or more than the roster cap", async () => {
    const { ctx } = inviteCtx();
    const h = await handler();
    await expect(h(ctx, { room_key: "dm:ua:ub", to_users: ["ua"] })).rejects.toThrow(/yourself/);
    await expect(h(ctx, { room_key: "dm:ua:ub", to_users: [] })).rejects.toThrow(/Nobody/);
    const many = Array.from({ length: 10 }, (_, i) => `x${i}`);
    await expect(h(ctx, { room_key: "dm:ua:ub", to_users: many })).rejects.toThrow(/at most/);
  });

  test("a caller who may not be in the room cannot ring anyone into it", async () => {
    const { ctx } = inviteCtx();
    // ua is not part of dm:ub:uc and holds no grant.
    await expect((await handler())(ctx, { room_key: "dm:ub:uc", to_users: ["ub"] })).rejects.toThrow(/Cannot invite/);
  });
});
