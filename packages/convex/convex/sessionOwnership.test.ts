import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  performSetSessionOwner,
  performSetSessionOwners,
  performAddSessionOwner,
  performRemoveSessionOwner,
} from "./sessionOwnership";

// Fixtures: Mr Bot runs a team-visible session; Jason and Ashot are teammates.
const TEAM = "teams_1";
const BOT = "users_bot";
const JASON = "users_jason";
const ASHOT = "users_ashot";
const OUTSIDER = "users_outsider";

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: BOT, name: "Mr Bot", email: "bot@union.ai", is_bot: true },
      { _id: JASON, name: "Jason Benn", email: "jason@union.ai" },
      { _id: ASHOT, name: "Ashot P", email: "ashot@union.ai" },
      { _id: OUTSIDER, name: "Stranger", email: "stranger@example.com" },
    ],
    team_memberships: [
      { _id: "tm_1", user_id: BOT, team_id: TEAM, visibility: "full" },
      { _id: "tm_2", user_id: JASON, team_id: TEAM, visibility: "full" },
      { _id: "tm_3", user_id: ASHOT, team_id: TEAM, visibility: "full" },
    ],
    conversations: [
      {
        _id: "jx1abcd_convex_id",
        short_id: "jx1abcd",
        session_id: "sess-uuid-1",
        user_id: BOT,
        team_id: TEAM,
        is_private: false,
        status: "active",
      },
      {
        _id: "jx2abcd_convex_id",
        short_id: "jx2abcd",
        session_id: "sess-uuid-2",
        user_id: BOT,
        team_id: undefined,
        is_private: true,
        status: "active",
      },
    ],
    managed_sessions: [],
  });
}

describe("performSetSessionOwner", () => {
  test("runner assigns owner by exact email (Mr Bot self-owns onto Jason)", async () => {
    const db = fixtures();
    const result = await performSetSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: "jason@union.ai",
    });
    expect(result.ok).toBe(true);
    expect(result.short_id).toBe("jx1abcd");
    expect(result.owner?.email).toBe("jason@union.ai");
    expect(db._tables.conversations[0].owner_user_id).toBe(JASON);
  });

  test("teammate claims a team-visible session with 'me'", async () => {
    const db = fixtures();
    const result = await performSetSessionOwner({ db }, ASHOT as any, {
      session_id: "jx1abcd",
      owner: "me",
    });
    expect(result.owner?.user_id).toBe(ASHOT);
    expect(db._tables.conversations[0].owner_user_id).toBe(ASHOT);
  });

  test("owner resolves by unique name substring, case-insensitive", async () => {
    const db = fixtures();
    const result = await performSetSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: "jason",
    });
    expect(result.owner?.user_id).toBe(JASON);
  });

  test("disown clears the owner", async () => {
    const db = fixtures();
    db._tables.conversations[0].owner_user_id = JASON;
    const result = await performSetSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: null,
    });
    expect(result.owner).toBeNull();
    // patch with undefined removes the field in convex; the fake db assigns it
    expect(db._patched[0].patch).toEqual({ owner_user_id: undefined });
  });

  test("current owner can reassign (owner has owner-level access)", async () => {
    const db = fixtures();
    // Private, teamless session run by BOT but owned by JASON: only the
    // runner and the owner can touch it.
    db._tables.conversations[1].owner_user_id = JASON;
    const result = await performSetSessionOwner({ db }, JASON as any, {
      session_id: "jx2abcd",
      owner: "me",
    });
    expect(result.owner?.user_id).toBe(JASON);
  });

  test("non-teammate cannot set an owner", async () => {
    const db = fixtures();
    await expect(
      performSetSessionOwner({ db }, OUTSIDER as any, { session_id: "jx1abcd", owner: "me" })
    ).rejects.toThrow(/No session found/);
  });

  test("teamless session rejects a named owner but allows 'me' for a human runner", async () => {
    const db = fixtures();
    await expect(
      performSetSessionOwner({ db }, BOT as any, { session_id: "jx2abcd", owner: "jason@union.ai" })
    ).rejects.toThrow(/has no team/);
    // A human runner claims their own teamless session fine.
    db._tables.conversations.push({
      _id: "jx3abcd_convex_id",
      short_id: "jx3abcd",
      session_id: "sess-uuid-3",
      user_id: JASON,
      team_id: undefined,
      is_private: true,
      status: "active",
    });
    const result = await performSetSessionOwner({ db }, JASON as any, {
      session_id: "jx3abcd",
      owner: "me",
    });
    expect(result.owner?.user_id).toBe(JASON);
  });

  test("a bot can never BE the owner — neither via 'me' nor by email — but may assign humans", async () => {
    const db = fixtures();
    // Mr Bot claiming its own session with "me" is rejected.
    await expect(
      performSetSessionOwner({ db }, BOT as any, { session_id: "jx2abcd", owner: "me" })
    ).rejects.toThrow(/agent account/);
    // A human assigning the bot as owner is rejected too.
    await expect(
      performSetSessionOwner({ db }, JASON as any, { session_id: "jx1abcd", owner: "bot@union.ai" })
    ).rejects.toThrow(/agent account/);
    expect(db._tables.conversations[0].owner_user_id).toBeUndefined();
    // The Aivery flow survives: the bot CALLS setSessionOwner to park on a human.
    const result = await performSetSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: "jason@union.ai",
    });
    expect(result.owner?.user_id).toBe(JASON);
  });

  test("ambiguous substring match is rejected with the candidates", async () => {
    const db = fixtures();
    // "union.ai" appears in every member email → ambiguous.
    await expect(
      performSetSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "union.ai" })
    ).rejects.toThrow(/matches multiple team members/);
  });

  test("unknown member errors clearly", async () => {
    const db = fixtures();
    await expect(
      performSetSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "nobody@nowhere.com" })
    ).rejects.toThrow(/No team member found matching/);
  });

  test("resolves by session uuid as well as short id", async () => {
    const db = fixtures();
    const result = await performSetSessionOwner({ db }, BOT as any, {
      session_id: "sess-uuid-1",
      owner: "ashot@union.ai",
    });
    expect(result.owner?.user_id).toBe(ASHOT);
  });
});

// ── Multi-owner: the owner SET (session_owners) is canonical ─────────────────
// A session can sit in several teammates' inboxes at once. owner_user_id is only
// a denormalized cache of the PRIMARY (first-added) owner, resynced after every
// write — these tests pin both the set and the cache.

const ownerIds = (db: any) =>
  (db._tables.session_owners ?? []).map((r: any) => r.user_id);
const primaryCache = (db: any) =>
  db._tables.conversations.find((c: any) => c._id === "jx1abcd_convex_id").owner_user_id;

describe("multi-owner session ownership", () => {
  test("addSessionOwner accumulates owners instead of replacing them", async () => {
    const db = fixtures();
    await performAddSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: "jason@union.ai",
    });
    const result = await performAddSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: "ashot@union.ai",
    });

    expect(ownerIds(db).sort()).toEqual([ASHOT, JASON].sort());
    expect(result.owners.map((o) => o.user_id).sort()).toEqual([ASHOT, JASON].sort());
    // Only the newly-added owner is notified — Jason isn't re-pinged.
    expect(result.added.map(String)).toEqual([ASHOT]);
    // Cache tracks the FIRST-added owner.
    expect(primaryCache(db)).toBe(JASON);
  });

  test("adding an existing owner is idempotent and notifies nobody", async () => {
    const db = fixtures();
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });
    const result = await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });

    expect(ownerIds(db)).toEqual([JASON]);
    expect(result.added.map(String)).toEqual([]);
  });

  test("removeSessionOwner drops one owner and leaves the rest", async () => {
    const db = fixtures();
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "ashot@union.ai" });

    const result = await performRemoveSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: "jason@union.ai",
    });

    expect(result.removed.map(String)).toEqual([JASON]);
    expect(ownerIds(db)).toEqual([ASHOT]);
    // Primary cache re-derives to the surviving owner — never left dangling.
    expect(primaryCache(db)).toBe(ASHOT);
  });

  test("removing the last owner clears the primary cache", async () => {
    const db = fixtures();
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });
    await performRemoveSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });

    expect(ownerIds(db)).toEqual([]);
    expect(primaryCache(db)).toBeUndefined();
  });

  test("setSessionOwners replaces the whole set, reporting added and removed", async () => {
    const db = fixtures();
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });

    const result = await performSetSessionOwners({ db }, BOT as any, {
      session_id: "jx1abcd",
      owners: ["ashot@union.ai"],
    });

    expect(result.added.map(String)).toEqual([ASHOT]);
    expect(result.removed.map(String)).toEqual([JASON]);
    expect(ownerIds(db)).toEqual([ASHOT]);
    expect(primaryCache(db)).toBe(ASHOT);
  });

  test("setSessionOwners with an empty list disowns everyone", async () => {
    const db = fixtures();
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "ashot@union.ai" });

    const result = await performSetSessionOwners({ db }, BOT as any, {
      session_id: "jx1abcd",
      owners: [],
    });

    expect(result.removed.map(String).sort()).toEqual([ASHOT, JASON].sort());
    expect(ownerIds(db)).toEqual([]);
    expect(primaryCache(db)).toBeUndefined();
  });

  test("a bot may assign owners but may never BE one", async () => {
    const db = fixtures();
    await expect(
      performAddSessionOwner({ db }, JASON as any, { session_id: "jx1abcd", owner: "bot@union.ai" }),
    ).rejects.toThrow(/agent account/);
    expect(ownerIds(db)).toEqual([]);
  });

  test("the back-compat single-owner form still REPLACES the set", async () => {
    const db = fixtures();
    await performAddSessionOwner({ db }, BOT as any, { session_id: "jx1abcd", owner: "jason@union.ai" });

    const result = await performSetSessionOwner({ db }, BOT as any, {
      session_id: "jx1abcd",
      owner: "ashot@union.ai",
    });

    expect(result.owner?.user_id).toBe(ASHOT);
    expect(ownerIds(db)).toEqual([ASHOT]);
  });
});

// ── Owner-ref resolution by user id (the web owners picker path) ─────────────
// The CLI passes an email/name/"me"; the web multi-select passes each roster
// member's _id directly. resolveOwnerRef must accept a raw user id, allow
// self-claim without a team, and require team membership for anyone else.
describe("owner ref resolution by user id", () => {
  const XTEAM = "teams_x";
  const RUNNER = "a".repeat(32); // id-shaped so the id branch triggers
  const MATE = "b".repeat(32);
  const OUTSIDER = "c".repeat(32);
  const idDb = () =>
    makeFakeDb({
      users: [
        { _id: RUNNER, name: "Runner", email: "runner@x.ai" },
        { _id: MATE, name: "Mate", email: "mate@x.ai" },
        { _id: OUTSIDER, name: "Outsider", email: "out@x.ai" },
      ],
      team_memberships: [
        { _id: "mx1", user_id: RUNNER, team_id: XTEAM, visibility: "full" },
        { _id: "mx2", user_id: MATE, team_id: XTEAM, visibility: "full" },
      ],
      conversations: [
        { _id: "conv_team", short_id: "team1", session_id: "s-team", user_id: RUNNER, team_id: XTEAM, is_private: false, status: "active" },
        { _id: "conv_solo", short_id: "solo1", session_id: "s-solo", user_id: RUNNER, team_id: undefined, is_private: true, status: "active" },
      ],
      session_owners: [],
    });
  const owners = (db: any) => (db._tables.session_owners ?? []).map((r: any) => r.user_id);

  test("adds a team member passed by user id", async () => {
    const db = idDb();
    const result = await performAddSessionOwner({ db }, RUNNER as any, { session_id: "team1", owner: MATE });
    expect(result.added.map(String)).toEqual([MATE]);
    expect(owners(db)).toEqual([MATE]);
  });

  test("self-claim by user id works even on a teamless private session", async () => {
    const db = idDb();
    const result = await performAddSessionOwner({ db }, RUNNER as any, { session_id: "solo1", owner: RUNNER });
    expect(result.added.map(String)).toEqual([RUNNER]);
    expect(owners(db)).toEqual([RUNNER]);
  });

  test("adding a teammate to a teamless session is refused", async () => {
    const db = idDb();
    await expect(
      performAddSessionOwner({ db }, RUNNER as any, { session_id: "solo1", owner: MATE }),
    ).rejects.toThrow(/no team/);
    expect(owners(db)).toEqual([]);
  });

  test("adding a non-member by user id is refused", async () => {
    const db = idDb();
    await expect(
      performAddSessionOwner({ db }, RUNNER as any, { session_id: "team1", owner: OUTSIDER }),
    ).rejects.toThrow(/isn't a member/);
    expect(owners(db)).toEqual([]);
  });
});
