import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import {
  performAddSessionOwner,
  performApplyOwnersChange,
  performListOwners,
  performRemoveSessionOwner,
  performReparentSession,
} from "./sessionOwnership";
import { performCreateRole } from "./orgRoles";

// The owner model behind the session_owners team feature (shared
// contracts/sessionOwners): people, one role, the parent session and the
// implicit starter, changed in one transaction, and today's behaviour when
// the feature is off.

const ME = "u".repeat(31) + "m"; // team admin, runs the sessions
const MATE = "u".repeat(31) + "t";
const THIRD = "u".repeat(31) + "z";
const BOT = "u".repeat(31) + "b";
const TEAM = "teams_acme" as any;
const S = "c".repeat(32);
const PARENT = "p".repeat(32);

function fixtures(on: boolean, convOver: Record<string, any> = {}, extra: Record<string, any[]> = {}) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: THIRD, name: "Third", email: "third@x.ai" },
      { _id: BOT, name: "Bot", email: "bot@x.ai", is_bot: true },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
      { _id: "m3", user_id: THIRD, team_id: TEAM, role: "member", joined_at: 1 },
      { _id: "m4", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true, ...(on ? { session_owners: true } : {}) } }],
    counters: [],
    org_roles: [],
    conversations: [
      { _id: S, short_id: "jxsess1", session_id: "sess1", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "Fix auth", agent_type: "claude_code", message_count: 3, ...convOver },
      { _id: PARENT, short_id: "jxpar01", session_id: "sess0", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "The lead", agent_type: "claude_code", message_count: 3 },
    ],
    session_owners: [],
    managed_sessions: [],
    messages: [],
    user_presence: [],
    pending_messages: [],
    devices: [],
    anchors: [],
    ...extra,
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const people = (db: any) => db._tables.session_owners.filter((r: any) => r.conversation_id === S).sort((a: any, b: any) => a.added_at - b.added_at).map((r: any) => r.user_id);
const conv = (db: any) => db._tables.conversations.find((c: any) => c._id === S);

describe("flag off", () => {
  test("an owners change is refused with the feature's own words", async () => {
    const db = fixtures(false);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: [MATE] })).rejects.toThrow(/Session owners/);
    expect(people(db)).toEqual([]);
  });

  test("cast disown @role and parent are refused", async () => {
    const db = fixtures(false);
    await expect(performRemoveSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "parent" })).rejects.toThrow(/Session owners/);
    await expect(performRemoveSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "@aa" })).rejects.toThrow(/Session owners/);
  });

  test("a person target still clears the role, as today", async () => {
    const db = fixtures(false);
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "aa", team_id: TEAM });
    await performReparentSession(ctxOf(db), ME as any, { session_id: S, target: { kind: "role", role_id: role._id } });
    await performAddSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: MATE });
    expect(conv(db).org_role_id).toBeUndefined();
    expect(conv(db).owners_changed_at).toBeUndefined();
  });

  test("listOwners keeps today's shape", async () => {
    const db = fixtures(false);
    const read: any = await performListOwners(ctxOf(db), ME as any, S);
    expect(read.session_owners).toBeUndefined();
    expect(read.owners.map((o: any) => o.user_id)).toEqual([ME]);
  });
});

describe("applyOwnersChange", () => {
  test("adding a person writes the implicit starter's row first, and stamps owners_changed_at", async () => {
    const db = fixtures(true);
    const res = await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: ["mate@x.ai"] });
    expect(people(db)).toEqual([ME, MATE]);
    expect(res.added).toEqual([MATE]);
    expect(conv(db).owners_changed_at).toBeGreaterThan(0);
  });

  test("adding a person keeps the role; a new role replaces the old one", async () => {
    const db = fixtures(true);
    const a = await performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "aa", team_id: TEAM });
    const b = await performCreateRole(ctxOf(db), ME as any, { name: "B", handle: "bb", team_id: TEAM });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, role: "@aa" });
    expect(conv(db).org_role_id).toBe(a._id);
    expect(people(db)).toEqual([ME]);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: [MATE] });
    expect(conv(db).org_role_id).toBe(a._id);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, role: b._id });
    expect(conv(db).org_role_id).toBe(b._id);
    expect(people(db)).toEqual([ME, MATE]);
  });

  test("removing a person leaves the rest", async () => {
    const db = fixtures(true);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: [MATE, THIRD] });
    const res = await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, remove: [MATE] });
    expect(res.removed).toEqual([MATE]);
    expect(people(db)).toEqual([ME, THIRD]);
  });

  test("taking over a role's start takes every agent owner off, adds the taker and ends the role's start", async () => {
    const db = fixtures(true, { user_id: BOT, role_started: true, parent_conversation_id: PARENT });
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "aa", team_id: TEAM });
    conv(db).org_role_id = role._id;
    // The runner is a bot: MATE can see it and add themselves, then take it over.
    await expect(performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, take_over: true })).rejects.toThrow(/Only its owners/);
    await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, add: [MATE] });
    const res = await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, take_over: true });
    expect(conv(db).org_role_id).toBeUndefined();
    expect(conv(db).parent_released_at).toBeGreaterThan(0);
    expect(conv(db).role_started).toBeUndefined();
    expect(res.org_role_id).toBeNull();
    expect(people(db)).toEqual([MATE]);
  });

  test("cast disown @role takes off only the role and adds nobody", async () => {
    const db = fixtures(true, { parent_conversation_id: PARENT });
    await performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "aa", team_id: TEAM });
    await performAddSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "@aa" });
    expect(conv(db).org_role_id).toBeDefined();
    await expect(performRemoveSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "@zz" })).rejects.toThrow(/does not own/);
    await performRemoveSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "@aa" });
    expect(conv(db).org_role_id).toBeUndefined();
    expect(conv(db).parent_released_at).toBeUndefined();
    expect(people(db)).toEqual([]);
  });

  test("cast disown parent releases only the parent, and the starter owns it again", async () => {
    const db = fixtures(true, { parent_conversation_id: PARENT });
    await performRemoveSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "parent" });
    expect(conv(db).parent_released_at).toBeGreaterThan(0);
    expect(people(db)).toEqual([]);
    const read: any = await performListOwners(ctxOf(db), ME as any, S);
    expect(read.implicit_starter).toMatchObject({ user_id: ME });
    await expect(performRemoveSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "parent" })).rejects.toThrow(/No parent session/);
  });

  test("a deleted or killed parent counts as released: the child falls back to its starter", async () => {
    for (const parent of ["deleted", "killed"]) {
      const db = fixtures(true, { parent_conversation_id: PARENT });
      if (parent === "deleted") db._tables.conversations = db._tables.conversations.filter((c: any) => c._id !== PARENT);
      else db._tables.conversations.find((c: any) => c._id === PARENT).inbox_killed_at = 7;
      const read: any = await performListOwners(ctxOf(db), ME as any, S);
      expect(read.parent_session).toBeNull();
      expect(read.implicit_starter).toMatchObject({ user_id: ME });
    }
  });

  test("a set replaces the implicit starter too (the picker's untick, the park on a person)", async () => {
    const db = fixtures(true, { user_id: BOT, author_user_id: ME });
    await performReparentSession(ctxOf(db), BOT as any, { session_id: S, target: { kind: "user", owners: [MATE], mode: "set" } });
    expect(people(db)).toEqual([MATE]);
    const picker = fixtures(true);
    await performApplyOwnersChange(ctxOf(picker), ME as any, { session_id: S, add: [MATE] });
    await performReparentSession(ctxOf(picker), ME as any, { session_id: S, target: { kind: "user", owners: [MATE], mode: "set" } });
    expect(people(picker)).toEqual([MATE]);
  });

  test("a restore that brings back someone keeps the implicit starter as a row", async () => {
    const db = fixtures(true);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore: [{ user_id: MATE, added_by: ME, added_at: 5 }] });
    expect(people(db)).toEqual([MATE, ME]);
  });

  test("an anchor's own thread never takes a role, by any door", async () => {
    const db = fixtures(true, { anchor_id: "anchors_1" });
    await performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "aa", team_id: TEAM });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, role: "@aa" })).rejects.toThrow(/standing agent's own thread/);
    await expect(performAddSessionOwner(ctxOf(db), ME as any, { session_id: S, owner: "@aa" })).rejects.toThrow(/standing agent's own thread/);
  });

  test("only owners or the runner may edit; anyone who can see it may add themselves", async () => {
    const db = fixtures(true, { user_id: BOT });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: [ME] });
    await expect(performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, add: [THIRD] })).rejects.toThrow(/Only its owners/);
    await expect(performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, remove: [ME] })).rejects.toThrow(/Only its owners/);
    await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, add: ["me"] });
    expect(people(db)).toEqual([ME, MATE]);
    await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, add: [THIRD] });
    expect(people(db)).toEqual([ME, MATE, THIRD]);
  });

  test("never a bot, never outside the team, and a session keeps an owner", async () => {
    const fresh = fixtures(true);
    await expect(performApplyOwnersChange(ctxOf(fresh), ME as any, { session_id: S, add: [BOT] })).rejects.toThrow(/agent account/);
    await expect(performApplyOwnersChange(ctxOf(fresh), ME as any, { session_id: S, add: ["stranger@y.ai"] })).rejects.toThrow(/No team member/);
    await expect(performApplyOwnersChange(ctxOf(fresh), ME as any, { session_id: S, remove: [ME] })).rejects.toThrow(/You started it/);
  });

  test("restore puts a row back as it was, held to the add rules", async () => {
    const db = fixtures(true);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: [MATE] });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, remove: [MATE] });
    const row = { user_id: MATE, added_by: ME, added_at: 5, seen_at: 6, note: "yours" };
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore: [row] });
    expect(people(db)).toEqual([MATE, ME]);
    expect(db._tables.session_owners.find((r: any) => r.user_id === MATE)).toMatchObject({ added_by: ME, added_at: 5, seen_at: 6, note: "yours" });
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore: [{ ...row, user_id: BOT }] })).rejects.toThrow(/agent account/);
    await expect(performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore: [{ ...row, user_id: "stranger@y.ai" }] })).rejects.toThrow(/No team member/);
    // Who added a restored row is the restorer, never the input: a snapshot
    // naming anyone else (an outsider included) cannot put their name on it.
    await performApplyOwnersChange(ctxOf(db), MATE as any, { session_id: S, restore: [{ ...row, user_id: THIRD, added_by: "users_outsider" }] });
    expect(db._tables.session_owners.find((r: any) => r.user_id === THIRD)).toMatchObject({ added_by: MATE });
  });

  test("a restore row names nothing but its own owner fields: a foreign conversation_id or an extra field plants nothing", async () => {
    const db = fixtures(true);
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: [MATE] });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, remove: [MATE] });
    const hostile = { user_id: MATE, added_by: ME, added_at: 5, conversation_id: PARENT, _id: "session_owners_forged", seen_at: 6, team_id: "teams_other" } as any;
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, restore: [hostile] });
    // Nothing lands on the other conversation; the row is this session's, with only the table's fields.
    expect(db._tables.session_owners.filter((r: any) => r.conversation_id === PARENT)).toEqual([]);
    const row = db._tables.session_owners.find((r: any) => r.conversation_id === S && r.user_id === MATE);
    expect(Object.keys(row).filter((k) => !k.startsWith("_")).sort()).toEqual(["added_at", "added_by", "conversation_id", "seen_at", "user_id"]);
    expect(row._id).not.toBe("session_owners_forged");
  });

  test("a chart drop on a role keeps the person who started it", async () => {
    const db = fixtures(true);
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "A", handle: "aa", team_id: TEAM });
    await performReparentSession(ctxOf(db), ME as any, { session_id: S, target: { kind: "role", role_id: role._id } });
    expect(conv(db).org_role_id).toBe(role._id);
    expect(people(db)).toEqual([ME]);
  });
});

describe("listOwners", () => {
  test("names the people in the order added, the role, the parent and whether the viewer may edit", async () => {
    const db = fixtures(true, { parent_conversation_id: PARENT });
    const role = await performCreateRole(ctxOf(db), ME as any, { name: "Eval lead", handle: "aa", team_id: TEAM });
    await performApplyOwnersChange(ctxOf(db), ME as any, { session_id: S, add: [MATE, ME], role: "@aa" });
    const read: any = await performListOwners(ctxOf(db), ME as any, S);
    expect(read.session_owners).toBe(true);
    expect(read.people.map((p: any) => p.user_id)).toEqual([MATE, ME]);
    expect(read.role).toMatchObject({ role_id: String(role._id), handle: "aa", name: "Eval lead" });
    expect(read.parent_session).toEqual({ conversation_id: PARENT, short_id: "jxpar01", title: "The lead" });
    expect(read.implicit_starter).toBeNull();
    expect(read.can_edit).toBe(true);
    expect(read.owners_changed_at).toBeGreaterThan(0);
    const other: any = await performListOwners(ctxOf(db), THIRD as any, S);
    expect(other.can_edit).toBe(false);
  });

  test("the starter is listed as implicit only while nothing else owns it", async () => {
    const db = fixtures(true);
    const read: any = await performListOwners(ctxOf(db), ME as any, S);
    expect(read.people).toEqual([]);
    expect(read.implicit_starter).toMatchObject({ user_id: ME, implicit: true });
    expect(read.starter_id).toBe(ME);
    expect(read.role_started).toBe(false);
    expect(read.owners.map((o: any) => o.user_id)).toEqual([ME]);
    const child: any = await performListOwners(ctxOf(fixtures(true, { parent_conversation_id: PARENT })), ME as any, S);
    expect(child.implicit_starter).toBeNull();
    expect(child.owners).toEqual([]);
    // A plain spawn is its spawner's peer: no parent owns it, so its starter does.
    const peer: any = await performListOwners(ctxOf(fixtures(true, { spawned_by_conversation_id: PARENT })), ME as any, S);
    expect(peer.parent_session).toBeNull();
    expect(peer.implicit_starter).toMatchObject({ user_id: ME, implicit: true });
    await expect(performRemoveSessionOwner(ctxOf(fixtures(true, { spawned_by_conversation_id: PARENT })), ME as any, { session_id: S, owner: "parent" })).rejects.toThrow(/No parent session/);
  });
});
