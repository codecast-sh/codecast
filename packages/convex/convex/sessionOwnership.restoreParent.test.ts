import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performApplyOwnersChange, performListOwners } from "./sessionOwnership";

// Putting the parent back (restore_parent): a person took a worker over and
// hands it back to the session it was nested under. Subagents included (an
// adopt refuses them). A dead or closed parent is refused, and the role a
// change took off is recorded so the owners menu offers it back.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const OUTSIDER = "u".repeat(31) + "o";
const TEAM = "teams_acme" as any;
const OTHER_TEAM = "teams_other" as any;
const NOFLAG_TEAM = "teams_noflag" as any;
const S = "c".repeat(32);
const LEAD = "p".repeat(32);
const CHILD = "k".repeat(32);
const GRANDCHILD = "g".repeat(32);
const PRIVATE = "v".repeat(32);

function fixtures(on = true, over: Record<string, any> = {}, leadOver: Record<string, any> = {}, extraConvs: any[] = []) {
  const conv = (id: string, short: string, rest: Record<string, any> = {}) => ({
    _id: id, short_id: short, session_id: short, user_id: ME, team_id: TEAM, is_private: false, status: "active",
    title: short, agent_type: "claude_code", message_count: 3, ...rest,
  });
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: OUTSIDER, name: "Out", email: "out@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
      { _id: "m3", user_id: OUTSIDER, team_id: OTHER_TEAM, role: "admin", joined_at: 1 },
      { _id: "m4", user_id: ME, team_id: NOFLAG_TEAM, role: "admin", joined_at: 1 },
    ],
    teams: [
      { _id: TEAM, name: "Acme", features: { org: true, ...(on ? { session_owners: true } : {}) } },
      { _id: OTHER_TEAM, name: "Other", features: { org: true, session_owners: true } },
      { _id: NOFLAG_TEAM, name: "No flag", features: { org: true } },
    ],
    counters: [],
    org_roles: [],
    conversations: [
      conv(S, "jxsess1", over),
      conv(LEAD, "jxlead1", leadOver),
      ...extraConvs.map((c) => conv(c._id, c.short_id, c)),
    ],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    pending_messages: [],
    devices: [],
    anchors: [],
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const conv = (db: any, id = S) => db._tables.conversations.find((c: any) => c._id === id);
const people = (db: any) => db._tables.session_owners.filter((r: any) => r.conversation_id === S).map((r: any) => r.user_id).sort();
const addRow = (db: any, user: string, at: number, conversation = S) => db._tables.session_owners.push({ _id: `so_${conversation}_${user}`, conversation_id: conversation, user_id: user, added_by: user, added_at: at });
const told = (db: any) => db._tables.pending_messages.filter((m: any) => m.conversation_id === S).map((m: any) => String(m.content));


const ROLE = "orgroles_evals" as any;
const roleRow = { _id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead", team_id: TEAM, status: "active", owner_user_id: ME };

describe("restore_parent", () => {
  test("a taken-over subagent goes back to its parent, and the taker stays", async () => {
    const db = fixtures(true, { parent_conversation_id: LEAD, is_subagent: true });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, take_over: true });
    expect(conv(db).parent_released_at).toBeGreaterThan(0);
    const read: any = await performListOwners(ctxOf(db), ME as any, S, { origin: true });
    expect(read.parent_session).toBeNull();
    expect(read.released_parent).toEqual({ conversation_id: LEAD, short_id: "jxlead1", title: "jxlead1" });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore_parent: true });
    expect(conv(db).parent_released_at).toBeUndefined();
    expect(conv(db).parent_conversation_id).toBe(LEAD);
    expect(people(db)).toEqual([ME]);
    const back: any = await performListOwners(ctxOf(db), ME as any, S, { origin: true });
    expect(back.parent_session?.conversation_id).toBe(LEAD);
    expect(back.released_parent).toBeNull();
  });

  test("refuses a session with no released parent", async () => {
    const db = fixtures(true, { parent_conversation_id: LEAD });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore_parent: true })).rejects.toThrow(/no session to go back to/);
  });

  test("refuses a killed or closed parent, and the read offers neither", async () => {
    for (const leadOver of [{ inbox_killed_at: 10 }, { inbox_closed_at: 10, inbox_dismissed_at: 10 }]) {
      const db = fixtures(true, { parent_conversation_id: LEAD, parent_released_at: 5 }, leadOver);
      addRow(db, ME, 1);
      await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore_parent: true })).rejects.toThrow(/killed|closed/);
      const read: any = await performListOwners(ctxOf(db), ME as any, S, { origin: true });
      expect(read.released_parent).toBeNull();
    }
  });

  test("refuses a parent the caller neither owns nor runs, and the read does not offer it", async () => {
    const db = fixtures(true, { parent_conversation_id: LEAD, parent_released_at: 5 }, { user_id: MATE });
    addRow(db, ME, 1);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore_parent: true })).rejects.toThrow(/own or run/);
    const read: any = await performListOwners(ctxOf(db), ME as any, S, { origin: true });
    expect(read.released_parent).toBeNull();
  });

  test("the inbox cards' read leaves where-it-came-from out", async () => {
    const db = fixtures(true, { parent_conversation_id: LEAD, parent_released_at: 5 });
    addRow(db, ME, 1);
    const read: any = await performListOwners(ctxOf(db), ME as any, S);
    expect("released_parent" in read).toBe(false);
    expect("spawned_by" in read).toBe(false);
  });

  test("a take-over records the role it took off; that role coming back clears it", async () => {
    const db = fixtures(true, { org_role_id: ROLE });
    db._tables.org_roles.push(roleRow);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, take_over: true });
    expect(conv(db).released_role_id).toBe(ROLE);
    const read: any = await performListOwners(ctxOf(db), ME as any, S, { origin: true });
    expect(read.released_role).toEqual({ role_id: ROLE, short_id: "or-1", handle: "evals", name: "Eval Suite lead" });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, role: ROLE });
    expect(conv(db).released_role_id).toBeUndefined();
  });

  test("a spawner already nested under this session is named but not adoptable (a loop)", async () => {
    const db = fixtures(true, { spawned_by_conversation_id: LEAD }, { parent_conversation_id: S });
    const read: any = await performListOwners(ctxOf(db), ME as any, S, { origin: true });
    expect(read.spawned_by?.adoptable).toBe(false);
  });

  test("names the session that spawned a peer, adoptable by a viewer who runs it", async () => {
    const db = fixtures(true, { spawned_by_conversation_id: LEAD });
    const read: any = await performListOwners(ctxOf(db), ME as any, S, { origin: true });
    expect(read.spawned_by).toEqual({ conversation_id: LEAD, short_id: "jxlead1", title: "jxlead1", adoptable: true });
  });
});
