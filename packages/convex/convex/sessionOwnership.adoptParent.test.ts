import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performApplyOwnersChange } from "./sessionOwnership";

// Adopting a parent (adopt_parent): a person drags one session onto another
// in the sidebar and the dragged one becomes that session's worker. The write
// nests it (parent_conversation_id), clears any release, takes the dragger's
// own owner row off, and refuses a loop, a dead or unreadable target, a
// session off the owners model and a person who may not edit its owners.

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

describe("adopt_parent", () => {
  test("nests it under the target, clears a release and takes the dragger's row off", async () => {
    const db = fixtures(true, { parent_conversation_id: "x".repeat(32), parent_released_at: 50 });
    addRow(db, ME, 1);
    addRow(db, MATE, 2);
    const res = await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
    expect(conv(db).parent_conversation_id).toBe(LEAD);
    expect(conv(db).parent_released_at).toBeUndefined();
    expect(conv(db).is_subagent).toBeUndefined();
    expect(conv(db).owners_changed_at).toBeGreaterThan(0);
    expect(people(db)).toEqual([MATE]);
    expect(res.removed).toEqual([ME as any]);
  });

  test("takes a short id too", async () => {
    const db = fixtures();
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: "jxlead1" });
    expect(conv(db).parent_conversation_id).toBe(LEAD);
  });

  test("refuses the session itself", async () => {
    const db = fixtures();
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: S })).rejects.toThrow(/itself/);
    expect(conv(db).parent_conversation_id).toBeUndefined();
  });

  test("refuses a target nested under the dragged session, at any depth", async () => {
    const db = fixtures(true, {}, {}, [
      { _id: CHILD, short_id: "jxchild", parent_conversation_id: S },
      { _id: GRANDCHILD, short_id: "jxgrand", parent_conversation_id: CHILD },
    ]);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: CHILD })).rejects.toThrow(/already works for this one/);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: GRANDCHILD })).rejects.toThrow(/already works for this one/);
    expect(conv(db).parent_conversation_id).toBeUndefined();
  });

  test("refuses a killed target", async () => {
    const db = fixtures(true, {}, { inbox_killed_at: 10 });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/killed/);
  });

  test("refuses a deleted target", async () => {
    const db = fixtures();
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: "d".repeat(32) })).rejects.toThrow(/No session you can read/);
  });

  test("refuses a target the actor cannot read", async () => {
    const db = fixtures(true, {}, {}, [{ _id: PRIVATE, short_id: "jxpriv1", user_id: OUTSIDER, team_id: OTHER_TEAM, is_private: true }]);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: PRIVATE })).rejects.toThrow(/No session you can read/);
    expect(conv(db).parent_conversation_id).toBeUndefined();
  });

  test("refuses a session off the owners model", async () => {
    const db = fixtures(false);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/Session owners/);
    expect(conv(db).parent_conversation_id).toBeUndefined();
  });

  test("refuses a teammate who may not edit its owners", async () => {
    const db = fixtures();
    addRow(db, ME, 1);
    addRow(db, MATE, 1, LEAD);
    await expect(performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/Only its owners/);
    expect(conv(db).parent_conversation_id).toBeUndefined();
    expect(people(db)).toEqual([ME]);
  });

  test("takes the role off: the session it works for answers it now", async () => {
    const db = fixtures(true, { org_role_id: "role_x", org_role_hold: "filed", role_started: true });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
    expect(conv(db).org_role_id).toBeUndefined();
    expect(conv(db).role_started).toBeUndefined();
  });

  test("tells the session it now works for the parent, when the dragger was its only owner", async () => {
    const db = fixtures(true, { owner_user_id: ME });
    addRow(db, ME, 1);
    const res = await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
    expect(res.reports_to).toMatchObject({ kind: "session", short_id: "jxlead1" });
    expect(told(db).some((c) => c.includes("You now report to session jxlead1 “jxlead1”"))).toBe(true);
  });

  test("an undo puts a released parent back released", async () => {
    const db = fixtures(true, { parent_conversation_id: "x".repeat(32), parent_released_at: 50 });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD, release_parent: true });
    expect(conv(db).parent_conversation_id).toBe(LEAD);
    expect(conv(db).parent_released_at).toBeGreaterThan(0);
  });

  test("refuses a target off the owners model", async () => {
    const db = fixtures(true, {}, { team_id: NOFLAG_TEAM });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/not under session owners/);
  });

  test("refuses a target the actor neither owns nor runs", async () => {
    const db = fixtures(true, {}, { user_id: MATE });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/own or run/);
    addRow(db, ME, 1, LEAD);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
    expect(conv(db).parent_conversation_id).toBe(LEAD);
  });

  test("refuses a target whose runner cannot open the session", async () => {
    const db = fixtures(true, { is_private: true }, { user_id: MATE });
    addRow(db, ME, 1, LEAD);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/runner cannot open/);
    expect(conv(db).parent_conversation_id).toBeUndefined();
  });

  test("refuses a role's standing session", async () => {
    const db = fixtures(true, { standing_role_id: "role_x" });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/own session/);
    expect(conv(db).parent_conversation_id).toBeUndefined();
  });

  test("refuses a closed target", async () => {
    const db = fixtures(true, {}, { inbox_closed_at: 10, inbox_dismissed_at: 10 });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/closed/);
  });

  test("an undo of an adopt that found no parent detaches it exactly", async () => {
    const db = fixtures();
    addRow(db, ME, 1);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, detach_parent: true, restore: [{ user_id: ME, added_by: ME, added_at: 1 }] });
    expect(conv(db).parent_conversation_id).toBeUndefined();
    expect(conv(db).parent_released_at).toBeUndefined();
    expect(people(db)).toEqual([ME]);
  });

  test("neither the adopt's report line nor its undo's answers a standing wait", async () => {
    // A fresh row, so the line is delivered now rather than deferred.
    const db = fixtures(true, { updated_at: Date.now(), thread_state: "Waiting on your pick", thread_state_status: "blocked" });
    addRow(db, ME, 1);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
    expect(conv(db).thread_state_status).toBe("blocked");
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, detach_parent: true, restore: [{ user_id: ME, added_by: ME, added_at: 1 }] });
    expect(conv(db).thread_state_status).toBe("blocked");
  });

  test("only someone who may edit its owners may detach it", async () => {
    const db = fixtures(true, { parent_conversation_id: LEAD });
    addRow(db, ME, 1);
    await expect(performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, detach_parent: true })).rejects.toThrow(/Only its owners/);
    expect(conv(db).parent_conversation_id).toBe(LEAD);
  });

  test("refuses to adopt or detach a session nested by how it runs", async () => {
    for (const over of [{ is_subagent: true }, { is_workflow_sub: true }, { parent_message_uuid: "plan-handoff" }]) {
      const db = fixtures(true, { parent_conversation_id: CHILD, ...over }, {}, [{ _id: CHILD, short_id: "jxchild" }]);
      await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD })).rejects.toThrow(/by how it was started/);
      await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, detach_parent: true })).rejects.toThrow(/by how it was started/);
      expect(conv(db).parent_conversation_id).toBe(CHILD);
    }
  });

  test("the undo of an adopt off a dead or released parent is a detach, and it is taken", async () => {
    for (const old of [{ inbox_killed_at: 10 }, { released: true }]) {
      const released = "released" in old;
      const db = fixtures(true, { parent_conversation_id: CHILD, ...(released ? { parent_released_at: 5 } : {}) }, {}, [{ _id: CHILD, short_id: "jxchild", ...(released ? {} : old) }]);
      addRow(db, ME, 1);
      await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, adopt_parent: LEAD });
      await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, detach_parent: true, restore: [{ user_id: ME, added_by: ME, added_at: 1 }] });
      expect(conv(db).parent_conversation_id).toBeUndefined();
      expect(conv(db).parent_released_at).toBeUndefined();
      expect(people(db)).toEqual([ME]);
    }
  });

  test("someone who does not run it undoes by rejoining, then detaching", async () => {
    const db = fixtures();
    addRow(db, MATE, 1);
    addRow(db, MATE, 1, LEAD);
    await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, adopt_parent: LEAD });
    expect(people(db)).toEqual([]);
    await expect(performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, detach_parent: true })).rejects.toThrow(/Only its owners/);
    await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, add: [MATE] });
    await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, detach_parent: true, restore: [{ user_id: MATE, added_by: MATE, added_at: 1 }] });
    expect(conv(db).parent_conversation_id).toBeUndefined();
    expect(people(db)).toEqual([MATE]);
  });
});

