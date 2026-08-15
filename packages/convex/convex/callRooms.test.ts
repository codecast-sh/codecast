import { describe, expect, test } from "bun:test";
import {
  authorizeRoom,
  channelRoomKey,
  dmRoomKey,
  parseRoomKey,
  sessionRoomKey,
} from "./callRooms";

// Same tiny ctx.db stand-in as buckets.test.ts: per-table arrays and eq-only
// index filtering, which is all authorizeRoom queries need.
function fakeCtx(seed: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    team_memberships: [],
    chat_channels: [],
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
      "dm:a:b:c",
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
    expect(parseRoomKey(channelRoomKey("c1"))).not.toBeNull();
    expect(parseRoomKey(sessionRoomKey("cv1"))).not.toBeNull();
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
