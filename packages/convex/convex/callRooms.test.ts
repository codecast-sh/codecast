import { describe, expect, test } from "bun:test";
import {
  authorizeRoom,
  expireRoomGrants,
  channelRoomKey,
  chatRoomKey,
  dmRoomKey,
  parseRoomKey,
  sessionRoomKey,
} from "./callRooms";
import { CALL_MEMBER_STALE_MS } from "@codecast/shared/contracts";

// Same tiny ctx.db stand-in as buckets.test.ts: per-table arrays and eq-only
// index filtering, which is all authorizeRoom queries need.
function fakeCtx(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    // Calls are a per-team opt-in; the fixture team has it on (the feature
    // gate itself is covered in "authorizeRoom feature gate" below).
    // Chat is on too: a channel's room is the chat room's door (canAccessChannel),
    // so channel rooms need chat on as well as calls.
    teams: [{ _id: "team1", name: "T1", features: { calls: true, chat: true } }, { _id: "team-off", name: "Off" }],
    team_memberships: [],
    chat_channels: [],
    chat_channel_members: [],
    call_invites: [],
    call_members: [],
    conversations: [],
    ...seed,
  };
  return {
    db: {
      query(table: string) {
        return {
          withIndex(_index: string, builder: (q: any) => any) {
            const eqs: Array<[string, any]> = [];
            builder({
              eq(field: string, value: any) {
                eqs.push([field, value]);
                return this;
              },
            });
            const rows = (tables[table] ?? []).filter((r) =>
              eqs.every(([f, v]) => String(r[f]) === String(v)),
            );
            return {
              collect: async () => rows,
              first: async () => rows[0] ?? null,
              unique: async () => {
                if (rows.length > 1) throw new Error("not unique");
                return rows[0] ?? null;
              },
            };
          },
        };
      },
      async get(id: string) {
        for (const rows of Object.values(tables)) {
          const row = rows.find((r) => String(r._id) === String(id));
          if (row) return row;
        }
        return null;
      },
    },
  };
}

describe("parseRoomKey", () => {
  test("parses each shape", () => {
    expect(parseRoomKey("dm:a:b")).toEqual({ kind: "dm", users: ["a", "b"] });
    // A people room is a set of any size from two up: a group thread's
    // huddle is the same shape as a 1:1 with more ids.
    expect(parseRoomKey("dm:a:b:c")).toEqual({ kind: "dm", users: ["a", "b", "c"] });
    expect(parseRoomKey("channel:ch1")).toEqual({ kind: "channel", channelId: "ch1" });
    expect(parseRoomKey("session:cv1")).toEqual({
      kind: "session",
      conversationId: "cv1",
    });
  });

  test("rejects malformed keys", () => {
    for (const bad of [
      "",
      "dm:a",
      "dm:a:a",
      "dm:b:a", // non-canonical order is a different (invalid) key, not an alias
      "dm:a:c:b",
      "dm:a:b:b",
      "dm:a::c",
      "dm:" + "abcdefghij".split("").join(":"), // eleven people: over the roster cap
      "channel:",
      "session:",
      "room:xyz",
      "x".repeat(300),
    ]) {
      expect(parseRoomKey(bad)).toBeNull();
    }
  });

  test("key builders emit canonical parseable keys", () => {
    expect(dmRoomKey("zed", "alice")).toBe("dm:alice:zed");
    expect(parseRoomKey(dmRoomKey("zed", "alice"))).not.toBeNull();
    // Group form: order and duplicates never matter to the caller.
    expect(dmRoomKey(["zed", "bob", "alice", "bob"])).toBe("dm:alice:bob:zed");
    expect(dmRoomKey("zed", ["bob", "alice"])).toBe("dm:alice:bob:zed");
    expect(parseRoomKey(dmRoomKey(["zed", "bob", "alice"]))).not.toBeNull();
    expect(parseRoomKey(channelRoomKey("c1"))).not.toBeNull();
    expect(parseRoomKey(sessionRoomKey("cv1"))).not.toBeNull();
  });

  test("a chat DM or group thread huddles in its member-set room; channels in their own", () => {
    expect(chatRoomKey({ id: "c1", kind: "dm", memberIds: ["me", "ann"] })).toBe("dm:ann:me");
    expect(chatRoomKey({ id: "c1", kind: "dm", memberIds: ["me", "ann", "bo"] })).toBe("dm:ann:bo:me");
    // Roster not known yet: never guess a people key.
    expect(chatRoomKey({ id: "c1", kind: "dm" })).toBe("channel:c1");
    expect(chatRoomKey({ id: "c1", kind: "private", memberIds: ["me", "ann"] })).toBe("channel:c1");
    expect(chatRoomKey({ id: "c1" })).toBe("channel:c1");
  });
});

const TEAM = "team1";
const membership = (user: string, team = TEAM, visibility?: string) => ({
  _id: `m-${user}-${team}`,
  user_id: user,
  team_id: team,
  visibility,
});

describe("authorizeRoom dm", () => {
  test("allows a member of the pair sharing a team", async () => {
    const ctx = fakeCtx({
      team_memberships: [membership("ua"), membership("ub")],
    });
    const res = await authorizeRoom(ctx, "ua" as any, dmRoomKey("ua", "ub"));
    expect(res).toEqual({
      ok: true,
      teamId: TEAM,
      parsed: { kind: "dm", users: ["ua", "ub"] },
    } as any);
  });

  test("rejects a third party even in the same team", async () => {
    const ctx = fakeCtx({
      team_memberships: [membership("ua"), membership("ub"), membership("uc")],
    });
    const res = await authorizeRoom(ctx, "uc" as any, dmRoomKey("ua", "ub"));
    expect(res.ok).toBe(false);
  });

  test("rejects a pair with no shared team", async () => {
    const ctx = fakeCtx({
      team_memberships: [membership("ua", "team1"), membership("ub", "team2")],
    });
    const res = await authorizeRoom(ctx, "ua" as any, dmRoomKey("ua", "ub"));
    expect(res.ok).toBe(false);
  });

  test("a group room needs one team every member shares", async () => {
    const all = fakeCtx({
      team_memberships: [membership("ua"), membership("ub"), membership("uc")],
    });
    const key = dmRoomKey(["ua", "ub", "uc"]);
    expect((await authorizeRoom(all, "ub" as any, key)).ok).toBe(true);
    // Not in the set: refused even as a teammate.
    const ctxD = fakeCtx({
      team_memberships: [membership("ua"), membership("ub"), membership("uc"), membership("ud")],
    });
    expect((await authorizeRoom(ctxD, "ud" as any, key)).ok).toBe(false);
    // One member outside the team breaks the set.
    const split = fakeCtx({
      team_memberships: [membership("ua"), membership("ub"), membership("uc", "team2")],
    });
    expect((await authorizeRoom(split, "ua" as any, key)).ok).toBe(false);
  });
});

describe("authorizeRoom invite grant", () => {
  // ub is not in dm:ua:uc, but ua rang ub into it while ua was inside.
  const key = dmRoomKey("ua", "uc");
  const now = Date.now();
  const seed = (overrides: Record<string, any[]> = {}) => fakeCtx({
    team_memberships: [membership("ua"), membership("ub"), membership("uc")],
    call_members: [
      { _id: "cm-ua", room_key: key, team_id: TEAM, user_id: "ua", joined_at: now - 120_000, last_seen: now - 1000 },
    ],
    call_invites: [
      { _id: "inv1", room_key: key, team_id: TEAM, from_user: "ua", to_user: "ub", status: "accepted", created_at: now - 60_000, responded_at: now - 30_000 },
    ],
    ...overrides,
  });

  test("an accepted ring admits a non-member while the huddle runs", async () => {
    const res = await authorizeRoom(seed(), "ub" as any, key);
    expect(res.ok).toBe(true);
    expect((res as any).teamId).toBe(TEAM);
  });

  test("the grant dies with the room: no live member, no entry", async () => {
    const empty = seed({
      call_members: [
        { _id: "cm-ua", room_key: key, team_id: TEAM, user_id: "ua", joined_at: now - 120_000, last_seen: now - CALL_MEMBER_STALE_MS - 1 },
      ],
    });
    expect((await authorizeRoom(empty, "ub" as any, key)).ok).toBe(false);
    // The guest's own fresh row does not count as "live" for their own grant.
    const onlyGuest = seed({
      call_members: [
        { _id: "cm-ub", room_key: key, team_id: TEAM, user_id: "ub", joined_at: now - 10_000, last_seen: now - 1000 },
      ],
    });
    expect((await authorizeRoom(onlyGuest, "ub" as any, key)).ok).toBe(false);
  });

  test("a grant from an earlier huddle does not open a later one", async () => {
    // The room restarting from empty is the "new huddle" moment: joinRoom
    // calls expireRoomGrants then, and the accepted row stops granting.
    const ctx = seed();
    const patched: Record<string, any> = {};
    (ctx.db as any).patch = async (id: string, p: any) => { patched[id] = p; };
    await expireRoomGrants(ctx, key);
    expect(patched.inv1.status).toBe("cancelled");
    const after = seed({
      call_invites: [
        { _id: "inv1", room_key: key, team_id: TEAM, from_user: "ua", to_user: "ub", status: "cancelled", created_at: now - 60_000, responded_at: now - 30_000 },
      ],
    });
    expect((await authorizeRoom(after, "ub" as any, key)).ok).toBe(false);
  });

  test("guests cannot keep each other's grants alive: no live MEMBER, no grant", async () => {
    // ua (the room member) left; ub and ud are both grant guests with fresh
    // leases. Neither passes the membership rules for dm:ua:uc, so neither
    // counts as proof the huddle still runs.
    const ctx = seed({
      team_memberships: [membership("ua"), membership("ub"), membership("uc"), membership("ud")],
      call_members: [
        { _id: "cm-ud", room_key: key, team_id: TEAM, user_id: "ud", joined_at: now - 60_000, last_seen: now - 1000 },
      ],
      call_invites: [
        { _id: "inv1", room_key: key, team_id: TEAM, from_user: "ua", to_user: "ub", status: "accepted", created_at: now - 60_000, responded_at: now - 30_000 },
        { _id: "inv2", room_key: key, team_id: TEAM, from_user: "ua", to_user: "ud", status: "accepted", created_at: now - 60_000, responded_at: now - 30_000 },
      ],
    });
    expect((await authorizeRoom(ctx, "ub" as any, key)).ok).toBe(false);
    // A live MEMBER (uc, in the dm set) restores the grant.
    const withMember = seed({
      team_memberships: [membership("ua"), membership("ub"), membership("uc")],
      call_members: [
        { _id: "cm-uc", room_key: key, team_id: TEAM, user_id: "uc", joined_at: now - 60_000, last_seen: now - 1000 },
      ],
    });
    expect((await authorizeRoom(withMember, "ub" as any, key)).ok).toBe(true);
  });

  test("leaving the team closes the grant door too", async () => {
    const gone = seed({
      team_memberships: [membership("ua"), membership("uc")], // ub removed
    });
    expect((await authorizeRoom(gone, "ub" as any, key)).ok).toBe(false);
  });

  test("a ring that was only ringing, declined or for another room grants nothing", async () => {
    for (const inv of [
      { status: "ringing" },
      { status: "declined", responded_at: now - 30_000 },
      { status: "accepted", responded_at: now - 30_000, room_key: "channel:elsewhere" },
    ]) {
      const ctx = seed({
        call_invites: [{ _id: "inv1", room_key: key, team_id: TEAM, from_user: "ua", to_user: "ub", created_at: now - 60_000, ...inv }],
      });
      expect((await authorizeRoom(ctx, "ub" as any, key)).ok).toBe(false);
    }
  });
});

describe("authorizeRoom channel", () => {
  const channel = { _id: "ch1", team_id: TEAM, name: "general" };

  test("allows a team member, rejects an outsider and archived channels", async () => {
    const ctx = fakeCtx({
      chat_channels: [channel],
      team_memberships: [membership("ua")],
    });
    expect((await authorizeRoom(ctx, "ua" as any, "channel:ch1")).ok).toBe(true);
    expect((await authorizeRoom(ctx, "ux" as any, "channel:ch1")).ok).toBe(false);

    const archived = fakeCtx({
      chat_channels: [{ ...channel, archived_at: 123 }],
      team_memberships: [membership("ua")],
    });
    expect((await authorizeRoom(archived, "ua" as any, "channel:ch1")).ok).toBe(false);
  });

  test("a private channel or group thread admits its members only", async () => {
    for (const kind of ["private", "dm"]) {
      const ctx = fakeCtx({
        chat_channels: [{ _id: "chp", team_id: TEAM, name: "", kind }],
        chat_channel_members: [{ _id: "cmb1", channel_id: "chp", user_id: "ua" }],
        team_memberships: [membership("ua"), membership("ub")],
      });
      expect((await authorizeRoom(ctx, "ua" as any, "channel:chp")).ok).toBe(true);
      // A teammate who is not in the room: the door that used to be open.
      expect((await authorizeRoom(ctx, "ub" as any, "channel:chp")).ok).toBe(false);
    }
  });

  test("a channel room in a team with chat off is refused (the chat door is shut)", async () => {
    const ctx = fakeCtx({
      teams: [{ _id: TEAM, name: "T1", features: { calls: true } }],
      chat_channels: [channel],
      team_memberships: [membership("ua")],
    });
    expect((await authorizeRoom(ctx, "ua" as any, "channel:ch1")).ok).toBe(false);
  });

  test("a membership row without team membership is not enough", async () => {
    const ctx = fakeCtx({
      chat_channels: [{ _id: "chp", team_id: TEAM, name: "", kind: "private" }],
      chat_channel_members: [{ _id: "cmb1", channel_id: "chp", user_id: "ux" }],
      team_memberships: [membership("ua")],
    });
    expect((await authorizeRoom(ctx, "ux" as any, "channel:chp")).ok).toBe(false);
  });
});

describe("authorizeRoom session", () => {
  const conv = (over: Record<string, any> = {}) => ({
    _id: "cv1",
    user_id: "owner",
    team_id: TEAM,
    is_private: false,
    ...over,
  });

  test("owner may huddle about their own session", async () => {
    const ctx = fakeCtx({ conversations: [conv({ is_private: true })] });
    const res = await authorizeRoom(ctx, "owner" as any, "session:cv1");
    expect(res.ok).toBe(true);
  });

  test("teammate allowed only when the conversation is team-visible", async () => {
    const shared = fakeCtx({
      conversations: [conv()],
      team_memberships: [membership("owner"), membership("mate")],
    });
    expect((await authorizeRoom(shared, "mate" as any, "session:cv1")).ok).toBe(true);

    const priv = fakeCtx({
      conversations: [conv({ is_private: true })],
      team_memberships: [membership("owner"), membership("mate")],
    });
    expect((await authorizeRoom(priv, "mate" as any, "session:cv1")).ok).toBe(false);
  });

  test("hidden-visibility owners keep their sessions out of huddles", async () => {
    const ctx = fakeCtx({
      conversations: [conv()],
      team_memberships: [membership("owner", TEAM, "hidden"), membership("mate")],
    });
    expect((await authorizeRoom(ctx, "mate" as any, "session:cv1")).ok).toBe(false);
  });

  test("non-member and missing rows reject", async () => {
    const ctx = fakeCtx({ conversations: [conv()] });
    expect((await authorizeRoom(ctx, "mate" as any, "session:cv1")).ok).toBe(false);
    expect((await authorizeRoom(ctx, "owner" as any, "session:none")).ok).toBe(false);
    expect(
      (await authorizeRoom(ctx, "owner" as any, "session:cv1")).ok,
    ).toBe(true);
  });
});

describe("authorizeRoom feature gate", () => {
  test("a room in a team without calls is refused even for a member", async () => {
    const ctx = fakeCtx({
      team_memberships: [membership("ua", "team-off"), membership("ub", "team-off")],
      chat_channels: [{ _id: "ch-off", team_id: "team-off", name: "general" }],
    });
    const dm = await authorizeRoom(ctx, "ua" as any, dmRoomKey("ua", "ub"));
    expect(dm.ok).toBe(false);
    if (!dm.ok) expect(dm.reason).toContain("not enabled for this team");
    const ch = await authorizeRoom(ctx, "ua" as any, channelRoomKey("ch-off"));
    expect(ch.ok).toBe(false);
  });
});
