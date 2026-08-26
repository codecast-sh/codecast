import { describe, expect, test } from "bun:test";
import {
  authorizeRoom,
  authorizeRoomInviter,
  authorizeRoomMembership,
  authorizeRoomNoGrant,
  clearRoomState,
  expireRoomGrants,
  channelRoomKey,
  chatRoomKey,
  dmRoomKey,
  isRoomLocked,
  openRoomDoor,
  parseRoomKey,
  recRoomKey,
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
    call_room_state: [],
    call_knocks: [],
    conversations: [],
    // Recordings answer out of the transcript they started, and the routing
    // team comes off the user row.
    transcripts: [],
    users: [],
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
      async delete(id: string) {
        for (const rows of Object.values(tables)) {
          const i = rows.findIndex((r) => String(r._id) === String(id));
          if (i >= 0) return void rows.splice(i, 1);
        }
      },
    },
    tables,
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
    expect(parseRoomKey("rec:9f8e7d6c-1234-4abc-9def-0123456789ab")).toEqual({
      kind: "rec",
      recId: "9f8e7d6c-1234-4abc-9def-0123456789ab",
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
      "rec:",
      "rec:short",              // an id nobody would have generated
      "rec:a:b",                // a recording is one id, never a path
      "rec:has spaces here!!",  // the charset is the whole shape check
      "rec:" + "a".repeat(65),
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
    expect(parseRoomKey(recRoomKey("9f8e7d6c-1234-4abc-9def-0123456789ab"))).not.toBeNull();
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

  test("rejects a third party at an idle room, teammate or not", async () => {
    // Membership is what a room's KEY grants. An occupied room grants more
    // (see "authorizeRoom open door"), but nobody is in this one.
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
    // Not in the set: refused even as a teammate, the room being idle.
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
  //
  // The room is LOCKED throughout, which is what isolates the grant: an
  // unlocked live huddle admits any teammate through the open door, so a
  // grant test on an open room would pass for the wrong reason. A locked
  // room is also the case that matters — the grant is what keeps "add
  // people" working after somebody shuts the door.
  const key = dmRoomKey("ua", "uc");
  const now = Date.now();
  const seed = (overrides: Record<string, any[]> = {}) => fakeCtx({
    call_room_state: [{ _id: "rs1", room_key: key, team_id: TEAM, locked: true, locked_by: "ua", updated_at: now }],
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

// The third door: an occupied room. Everything here is new behaviour — before
// open rooms, every one of these cases was a refusal.
describe("authorizeRoom open door", () => {
  const now = Date.now();
  const key = dmRoomKey("ua", "ub");
  const seat = (user: string, roomKey = key, lastSeen = now - 1000, team = TEAM) => ({
    _id: `cm-${user}`, room_key: roomKey, team_id: team, user_id: user,
    joined_at: now - 60_000, last_seen: lastSeen,
  });
  const locked = (roomKey = key) => ({
    _id: "rs1", room_key: roomKey, team_id: TEAM, locked: true, locked_by: "ua", updated_at: now,
  });
  const everyone = [membership("ua"), membership("ub"), membership("uc"), membership("ud", "team2")];

  test("a teammate walks into a live unlocked dm huddle", async () => {
    // The headline change: uc is a third party to dm:ua:ub and holds no ring.
    const ctx = fakeCtx({ team_memberships: everyone, call_members: [seat("ua")] });
    const res = await authorizeRoom(ctx, "uc" as any, key);
    expect(res.ok).toBe(true);
    // The room's own billing team, taken from the live rows — the guest's
    // membership row lands beside everyone else's.
    expect((res as any).teamId).toBe(TEAM);
  });

  test("a people room is open at ANY size: a group huddle admits teammates too", async () => {
    // The decided product, and the case a reader is most likely to assume
    // otherwise: a group thread huddles in a `dm:` room of three or more
    // (chatRoomKey), and the open door draws no line at two people. A group
    // that wants privacy locks the room, exactly like a pair does.
    const groupKey = dmRoomKey(["ua", "ub", "uc"]);
    const roster = [...everyone, membership("ue")];
    const ctx = fakeCtx({ team_memberships: roster, call_members: [seat("ua", groupKey)] });
    // ue is on the billing team and named nowhere in the key.
    expect((await authorizeRoom(ctx, "ue" as any, groupKey)).ok).toBe(true);
    // The outer wall is untouched: ud is on another team.
    expect((await authorizeRoom(ctx, "ud" as any, groupKey)).ok).toBe(false);
    // Locked, the group is as private as a locked pair — and ue may knock,
    // which is the same question openRoomDoor answers with the lock ignored.
    const shut = fakeCtx({
      team_memberships: roster,
      call_members: [seat("ua", groupKey)],
      call_room_state: [locked(groupKey)],
    });
    expect((await authorizeRoom(shut, "ue" as any, groupKey)).ok).toBe(false);
    expect(await openRoomDoor(shut, "ue" as any, groupKey, { ignoreLock: true })).toBe(TEAM as any);
    expect(await openRoomDoor(shut, "ud" as any, groupKey, { ignoreLock: true })).toBeNull();
    // Membership still means what it always did one layer down: history and
    // the authority to ring people in read authorizeRoomNoGrant, which never
    // sees the open door.
    expect((await authorizeRoomNoGrant(ctx, "ue" as any, groupKey)).ok).toBe(false);
    expect((await authorizeRoomNoGrant(ctx, "ub" as any, groupKey)).ok).toBe(true);
  });

  test("the team wall holds: a stranger to the billing team is refused", async () => {
    const ctx = fakeCtx({ team_memberships: everyone, call_members: [seat("ua")] });
    expect((await authorizeRoom(ctx, "ud" as any, key)).ok).toBe(false);
  });

  test("a locked room shuts the open door", async () => {
    const ctx = fakeCtx({
      team_memberships: everyone,
      call_members: [seat("ua")],
      call_room_state: [locked()],
    });
    expect((await authorizeRoom(ctx, "uc" as any, key)).ok).toBe(false);
    // The room's own people are unaffected — a lock is not a wall against
    // the people whose room it is.
    expect((await authorizeRoom(ctx, "ub" as any, key)).ok).toBe(true);
    // An unlocked row is not a lock.
    const unlocked = fakeCtx({
      team_memberships: everyone,
      call_members: [seat("ua")],
      call_room_state: [{ ...locked(), locked: false }],
    });
    expect((await authorizeRoom(unlocked, "uc" as any, key)).ok).toBe(true);
  });

  test("an empty room is not a huddle", async () => {
    const stale = fakeCtx({
      team_memberships: everyone,
      call_members: [seat("ua", key, now - CALL_MEMBER_STALE_MS - 1)],
    });
    expect((await authorizeRoom(stale, "uc" as any, key)).ok).toBe(false);
    const never = fakeCtx({ team_memberships: everyone });
    expect((await authorizeRoom(never, "uc" as any, key)).ok).toBe(false);
  });

  test("a CHANNEL room keeps its wall even while live", async () => {
    // The open door's one exception. Both restricted kinds are covered: a
    // named private channel, and the channel-row form a group thread falls
    // back to when its roster is unavailable (chatRoomKey). The group
    // thread's ORDINARY room is a `dm:` key and is open — see the
    // any-size test above; these two layers are not the same rule.
    for (const kind of ["private", "dm"]) {
      const ctx = fakeCtx({
        chat_channels: [{ _id: "chp", team_id: TEAM, name: "", kind }],
        chat_channel_members: [{ _id: "cmb1", channel_id: "chp", user_id: "ua" }],
        team_memberships: everyone,
        call_members: [seat("ua", "channel:chp")],
      });
      expect((await authorizeRoom(ctx, "ub" as any, "channel:chp")).ok).toBe(false);
    }
  });

  test("a live session huddle admits a teammate who cannot see the conversation", async () => {
    // The room is joinable (they hear voices); the TITLE is what redacts, and
    // that is getLiveRooms' job, not the authorizer's.
    const ctx = fakeCtx({
      conversations: [{ _id: "cv1", user_id: "ua", team_id: TEAM, is_private: true }],
      team_memberships: everyone,
      call_members: [seat("ua", "session:cv1")],
    });
    expect((await authorizeRoom(ctx, "uc" as any, "session:cv1")).ok).toBe(true);
    // Still nobody outside the team.
    expect((await authorizeRoom(ctx, "ud" as any, "session:cv1")).ok).toBe(false);
  });

  test("the feature gate still runs after the open door", async () => {
    const ctx = fakeCtx({
      team_memberships: [membership("ua", "team-off"), membership("ub", "team-off"), membership("uc", "team-off")],
      call_members: [seat("ua", key, now - 1000, "team-off")],
    });
    const res = await authorizeRoom(ctx, "uc" as any, key);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not enabled for this team");
  });

  test("call history keeps the old rules: authorizeRoomNoGrant has no open door", async () => {
    const ctx = fakeCtx({ team_memberships: everyone, call_members: [seat("ua")] });
    expect((await authorizeRoomNoGrant(ctx, "uc" as any, key)).ok).toBe(false);
    // …and it is still membership for the room's own people.
    expect((await authorizeRoomNoGrant(ctx, "ub" as any, key)).ok).toBe(true);
  });

  test("ignoreLock answers 'would this room admit me if I knocked'", async () => {
    // getLiveRooms lists locked rooms and calls.knock guards on the same
    // question — both go through this one flag.
    const ctx = fakeCtx({
      team_memberships: everyone,
      call_members: [seat("ua")],
      call_room_state: [locked()],
    });
    expect(await openRoomDoor(ctx, "uc" as any, key)).toBeNull();
    expect(await openRoomDoor(ctx, "uc" as any, key, { ignoreLock: true })).toBe(TEAM as any);
    // A stranger to the team is refused with the lock ignored too.
    expect(await openRoomDoor(ctx, "ud" as any, key, { ignoreLock: true })).toBeNull();
    expect(await isRoomLocked(ctx, key)).toBe(true);
  });
});

describe("clearRoomState", () => {
  test("a room restarting from empty starts open with nobody waiting", async () => {
    const now = Date.now();
    const key = dmRoomKey("ua", "ub");
    const ctx = fakeCtx({
      team_memberships: [membership("ua"), membership("ub"), membership("uc")],
      call_room_state: [{ _id: "rs1", room_key: key, team_id: TEAM, locked: true, locked_by: "ua", updated_at: now }],
      call_knocks: [
        { _id: "k1", room_key: key, team_id: TEAM, from_user: "uc", created_at: now },
        { _id: "k2", room_key: "dm:ua:uc", team_id: TEAM, from_user: "ub", created_at: now },
      ],
    });
    await clearRoomState(ctx, key);
    expect((ctx as any).tables.call_room_state).toEqual([]);
    // Another room's knocks are untouched.
    expect((ctx as any).tables.call_knocks.map((k: any) => k._id)).toEqual(["k2"]);
  });
});

// Recordings. A `rec:` key is a room key that names no room, so the whole
// point of these tests is what stays SHUT: the doors a huddle opens must not
// open here, and the person who pressed record must be the only one who ever
// reaches what their microphone heard.
describe("authorizeRoom rec", () => {
  const REC = recRoomKey("9f8e7d6c-1234-4abc-9def-0123456789ab");
  const owner = { _id: "ua", name: "Ann", active_team_id: TEAM };
  // The row that makes the key someone's: a recording IS its transcript.
  const recording = (startedBy: string, team = TEAM, status = "live") => ({
    _id: "t-rec",
    room_key: REC,
    team_id: team,
    started_by: startedBy,
    status,
    started_at: Date.now() - 60_000,
    routes: [],
    last_seq: 0,
  });
  const team = () => ({
    users: [owner, { _id: "ub", name: "Bo", active_team_id: TEAM }],
    team_memberships: [membership("ua"), membership("ub")],
  });

  test("a fresh id belongs to whoever starts on it, filed under their team", async () => {
    const ctx = fakeCtx(team());
    const res = await authorizeRoom(ctx, "ua" as any, REC, { rec: true });
    expect(res.ok).toBe(true);
    // Routing, not access: the row lands where the owner's own history list
    // looks for it.
    if (res.ok) expect(String(res.teamId)).toBe(TEAM);
  });

  test("once started it is the creator's alone — a teammate is refused", async () => {
    const ctx = fakeCtx({ ...team(), transcripts: [recording("ua")] });
    expect((await authorizeRoom(ctx, "ua" as any, REC, { rec: true })).ok).toBe(true);
    const other = await authorizeRoom(ctx, "ub" as any, REC, { rec: true });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toBe("not your recording");
  });

  test("a recording that ended stays the creator's", async () => {
    const ctx = fakeCtx({ ...team(), transcripts: [recording("ua", TEAM, "ended")] });
    expect((await authorizeRoom(ctx, "ub" as any, REC, { rec: true })).ok).toBe(false);
  });

  test("a live recording outranks an older row that reused the id", async () => {
    // Ownership can never be taken by starting a second transcript on a key
    // somebody is recording under right now.
    const ctx = fakeCtx({
      ...team(),
      transcripts: [
        { ...recording("ub", TEAM, "ended"), _id: "t-old", started_at: Date.now() },
        recording("ua"),
      ],
    });
    expect((await authorizeRoom(ctx, "ua" as any, REC, { rec: true })).ok).toBe(true);
    expect((await authorizeRoom(ctx, "ub" as any, REC, { rec: true })).ok).toBe(false);
  });

  test("every door refuses a rec key unless the caller asks for one", async () => {
    // The default. joinRoom, invite, knock, the media token mint and occupancy
    // all call authorizeRoom plainly, so all of them refuse — including for
    // the owner, who has a recording and not a room.
    const ctx = fakeCtx({ ...team(), transcripts: [recording("ua")] });
    const plain = await authorizeRoom(ctx, "ua" as any, REC);
    expect(plain.ok).toBe(false);
    if (!plain.ok) expect(plain.reason).toBe("a recording is not a room");
  });

  test("no grant, no invitation, no walking in", async () => {
    const ctx = fakeCtx({ ...team(), transcripts: [recording("ua")] });
    expect((await authorizeRoomNoGrant(ctx, "ua" as any, REC)).ok).toBe(false);
    expect((await authorizeRoomInviter(ctx, "ua" as any, REC)).ok).toBe(false);
    expect((await authorizeRoomInviter(ctx, "ub" as any, REC)).ok).toBe(false);
  });

  test("the open door stays shut even if a seat row somehow existed", async () => {
    // Nothing can write one — joinRoom refuses the key — but the refusal is
    // structural rather than a consequence of an empty table, so a stray row
    // could never turn a recording into a huddle the team may walk into.
    const ctx = fakeCtx({
      ...team(),
      transcripts: [recording("ua")],
      call_members: [
        { _id: "cm1", room_key: REC, team_id: TEAM, user_id: "ua", joined_at: Date.now(), last_seen: Date.now() },
      ],
    });
    expect(await openRoomDoor(ctx, "ub" as any, REC)).toBeNull();
    expect(await openRoomDoor(ctx, "ub" as any, REC, { ignoreLock: true })).toBeNull();
    expect((await authorizeRoom(ctx, "ub" as any, REC, { rec: true })).ok).toBe(false);
  });

  test("recording needs no calls feature — it is nobody's huddle", async () => {
    const ctx = fakeCtx({
      users: [{ _id: "uc", name: "Cy", active_team_id: "team-off" }],
      team_memberships: [membership("uc", "team-off")],
      transcripts: [{ ...recording("uc", "team-off"), _id: "t-off" }],
    });
    expect((await authorizeRoom(ctx, "uc" as any, REC, { rec: true })).ok).toBe(true);
    // …and the huddle rules for that team are untouched by the exemption.
    expect((await authorizeRoom(ctx, "uc" as any, dmRoomKey("uc", "ud"))).ok).toBe(false);
  });

  test("a person with no team cannot file a recording anywhere", async () => {
    const ctx = fakeCtx({ users: [{ _id: "uz", name: "Zed" }] });
    const res = await authorizeRoom(ctx, "uz" as any, REC, { rec: true });
    expect(res.ok).toBe(false);
  });

  test("a stale active-team pointer files the recording somewhere the owner can see it", async () => {
    // active_team_id names a team they have left: routing falls through to a
    // team they are actually in, so their own list still finds the row.
    const ctx = fakeCtx({
      users: [{ _id: "ua", name: "Ann", active_team_id: "team-gone", team_id: "team-gone" }],
      team_memberships: [membership("ua")],
    });
    const res = await authorizeRoomMembership(ctx, "ua" as any, REC);
    expect(res.ok).toBe(true);
    if (res.ok) expect(String(res.teamId)).toBe(TEAM);
  });
});
