import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { LIST_OWNERS_FOR_CAP, performListOwnersFor } from "./sessionOwnership";

// The batched owners read the inbox cards draw their faces from: an inbox row
// carries no owner list under the session_owners model, so the cards on
// screen ask here, once. Each id goes through listOwners' own access check:
// one the caller cannot read is left out, never an error.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const OUTSIDER = "u".repeat(31) + "o";
const TEAM = "teams_acme";
const id = (n: number) => `c${String(n).padStart(31, "0")}`;
const PARENT = "p".repeat(32);

function world(count: number) {
  const conversations: any[] = [
    { _id: PARENT, short_id: "jxpar01", session_id: "sp", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "The lead", message_count: 3 },
  ];
  for (let i = 0; i < count; i++) {
    conversations.push({ _id: id(i), short_id: `jx${i}`, session_id: `s${i}`, user_id: ME, team_id: TEAM, is_private: false, status: "active", title: `S${i}`, message_count: 3 });
  }
  // id(0) co-owned by ME and MATE, id(2) a child its parent owns, and one private to MATE.
  const byId = (k: string) => conversations.find((c) => c._id === k);
  if (byId(id(0))) byId(id(0)).owner_user_id = ME;
  if (byId(id(2))) byId(id(2)).spawned_by_conversation_id = PARENT;
  conversations.push({ _id: "x".repeat(32), short_id: "jxpriv", session_id: "sx", user_id: MATE, team_id: TEAM, is_private: true, status: "active", title: "Private", message_count: 3 });
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@x.ai" }, { _id: MATE, name: "Mate", email: "mate@x.ai" }, { _id: OUTSIDER, name: "Out" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { session_owners: true } }],
    conversations,
    session_owners: [
      { _id: "so1", conversation_id: id(0), user_id: ME, added_by: ME, added_at: 1 },
      { _id: "so2", conversation_id: id(0), user_id: MATE, added_by: ME, added_at: 2 },
    ],
    org_roles: [], managed_sessions: [], messages: [], devices: [], anchors: [],
  });
}

describe("listOwnersFor: card faces for many sessions in one read", () => {
  test("each readable id resolves as listOwners does: people, role, parent session and implicit starter", async () => {
    const out = await performListOwnersFor({ db: world(3) } as any, ME as any, [id(0), id(1), id(2)]);
    expect(Object.keys(out).sort()).toEqual([id(0), id(1), id(2)]);
    expect(out[id(0)]).toMatchObject({ session_owners: true, implicit_starter: null, role: null, parent_session: null });
    expect((out[id(1)] as any).implicit_starter).toMatchObject({ user_id: ME, implicit: true });
    expect((out[id(0)] as any).people.map((p: any) => p.user_id)).toEqual([ME, MATE]);
    expect((out[id(2)] as any).parent_session).toMatchObject({ conversation_id: PARENT });
    expect((out[id(2)] as any).implicit_starter).toBeNull();
  });

  test("an id the caller cannot read, or that does not exist, is left out, never an error", async () => {
    const out = await performListOwnersFor({ db: world(2) } as any, ME as any, [id(0), "x".repeat(32), "nope"]);
    expect(Object.keys(out)).toEqual([id(0)]);
    expect(await performListOwnersFor({ db: world(2) } as any, OUTSIDER as any, [id(0), id(1)])).toEqual({});
  });

  test(`at most ${LIST_OWNERS_FOR_CAP} ids are read; duplicates count once`, async () => {
    const ids = Array.from({ length: LIST_OWNERS_FOR_CAP + 10 }, (_, i) => id(i));
    const out = await performListOwnersFor({ db: world(LIST_OWNERS_FOR_CAP + 10) } as any, ME as any, [id(0), ...ids]);
    expect(Object.keys(out).length).toBe(LIST_OWNERS_FOR_CAP);
    expect(out[id(LIST_OWNERS_FOR_CAP)]).toBeUndefined();
  });
});
