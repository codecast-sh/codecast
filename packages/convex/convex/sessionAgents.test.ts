import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performListSessionAgents } from "./sessionAgents";

// The agents a session started, for its conversation's agents band: each
// child's state, whether the session still owns it, and its person owners.
const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme";
const LEAD = "l".repeat(32);

function world(flag: boolean) {
  const conv = (id: string, extra: Record<string, any>) => ({ _id: id, user_id: ME, team_id: TEAM, is_private: false, status: "active", title: id.slice(0, 4), message_count: 3, updated_at: 1, ...extra });
  return makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate", image: "m.png" }],
    team_memberships: [{ _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 }],
    teams: [{ _id: TEAM, name: "Acme", features: flag ? { session_owners: true } : {} }],
    conversations: [
      conv(LEAD, { title: "Lead" }),
      conv("a".repeat(32), { is_subagent: true, parent_conversation_id: LEAD, updated_at: 3 }),
      conv("b".repeat(32), { spawned_by_conversation_id: LEAD, parent_released_at: 5, owner_user_id: MATE, updated_at: 2 }),
    ],
    session_owners: [{ _id: "so1", conversation_id: "b".repeat(32), user_id: MATE, added_by: ME, added_at: 1 }],
    managed_sessions: [{ _id: "ms1", conversation_id: "a".repeat(32), agent_status: "working" }],
  });
}

describe("listSessionAgents", () => {
  test("flag on: each child with its state, whether the session still owns it, and its people", async () => {
    const agents = await performListSessionAgents({ db: world(true) } as any, ME as any, LEAD as any);
    expect(agents!.map((a) => [a.title, a.agent_status, a.owned_by_parent, a.owners.map((o) => o.name)])).toEqual([
      ["aaaa", "working", true, []],
      ["bbbb", null, false, ["Mate"]],
    ]);
  });
  test("flag off: the children all the same, with no owners read", async () => {
    const agents = await performListSessionAgents({ db: world(false) } as any, ME as any, LEAD as any);
    expect(agents!.map((a) => [a.title, a.owned_by_parent, a.owners.length])).toEqual([["aaaa", true, 0], ["bbbb", false, 0]]);
  });
});
