import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performSetSessionOwner } from "./sessionOwnership";

// Fixtures: Mr Bot runs a team-visible session; Jason and Ashot are teammates.
const TEAM = "teams_1";
const BOT = "users_bot";
const JASON = "users_jason";
const ASHOT = "users_ashot";
const OUTSIDER = "users_outsider";

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: BOT, name: "Mr Bot", email: "bot@union.ai" },
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

  test("teamless session rejects a named owner but allows 'me' for the runner", async () => {
    const db = fixtures();
    await expect(
      performSetSessionOwner({ db }, BOT as any, { session_id: "jx2abcd", owner: "jason@union.ai" })
    ).rejects.toThrow(/has no team/);
    const result = await performSetSessionOwner({ db }, BOT as any, {
      session_id: "jx2abcd",
      owner: "me",
    });
    expect(result.owner?.user_id).toBe(BOT);
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
