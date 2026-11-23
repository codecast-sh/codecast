import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performReparentSession } from "./orgRoles";
import { ownersChangeFromDispatch, performAddSessionOwner, performApplyOwnersChange, performListOwners, performRemoveSessionOwner, performSetSessionDriver, performSetSessionOwners } from "./sessionOwnership";
import { withLeaveRules } from "./lib/sessionOwnerRules";
import { checkConversationAccess } from "./privacy";

// A role is an owner beside the people, and exactly one owner drives
// (schema.ts conversations.driver_user_id): the filed role while no person
// has taken over, else that person, else the primary owner.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const TEAM = "teams_acme" as any;
const NOW = 1_800_000_000_000;
const CONV = "c".repeat(32);

function fixtures() {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
    ],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], managed_sessions: [], messages: [], user_presence: [], pending_messages: [], devices: [], anchors: [],
    conversations: [{
      _id: CONV, session_id: "sess1", user_id: ME, owner_user_id: ME, team_id: TEAM, status: "active", title: "Fix auth",
      agent_type: "claude_code", message_count: 3, last_message_role: "assistant", updated_at: NOW - 60_000,
    }],
    session_owners: [{ _id: "so1", conversation_id: CONV, user_id: ME, added_by: ME, added_at: 1 }],
  });
}

const ctxOf = (db: any) => ({ db }) as any;
const row = (db: any) => db._tables.conversations[0];
const owners = (db: any) => db._tables.session_owners.map((r: any) => r.user_id).sort();
const driver = async (ctx: any) => (await performListOwners(ctx, ME as any, "sess1"))!.driver;

describe("role owner and driver", () => {
  test("adding a person keeps the role, and the role keeps driving", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: role._id } });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: [MATE], mode: "add" } });
    expect(row(db).org_role_id).toBe(role._id);
    expect(owners(db)).toEqual([ME, MATE].sort());
    expect(await driver(ctx)).toEqual({ kind: "role", role_id: role._id });
  });

  test("adding a person never hands them the wheel", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: ME });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: [MATE], mode: "add" } });
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: ME });
  });

  test("adding a role clears the person driver: the role drives", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: ME } });
    expect(row(db).driver_user_id).toBe(ME);
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: role._id } });
    expect(row(db).driver_user_id).toBeUndefined();
    expect(await driver(ctx)).toEqual({ kind: "role", role_id: role._id });
  });

  test("a person takes the wheel (the role pauses) and hands it back", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: role._id } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: ME } });
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: ME });
    expect(row(db).org_role_id).toBe(role._id);
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "role" } });
    expect(row(db).driver_user_id).toBeUndefined();
    expect(await driver(ctx)).toEqual({ kind: "role", role_id: role._id });
  });

  test("only an owner or the filed role can drive", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await expect(performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: MATE } })).rejects.toThrow(/Only an owner/);
    await expect(performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "role" } })).rejects.toThrow(/not filed under a role/);
  });

  test("removing the person who drives clears the driver", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: [MATE], mode: "add" } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: MATE } });
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: MATE });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: [MATE], mode: "remove" } });
    expect(row(db).driver_user_id).toBeUndefined();
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: ME });
  });

  test("one role at a time: a second role replaces the first; null takes it off", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const growth = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    const evals = await performCreateRole(ctx, ME as any, { name: "Evals", handle: "evals", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: growth._id } });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: evals._id } });
    expect(row(db).org_role_id).toBe(evals._id);
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: null } });
    expect(row(db).org_role_id).toBeUndefined();
    expect(owners(db)).toEqual([ME]);
  });

  test("a chart drop on a person still re-homes under them and takes the role off", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: role._id } });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", user_id: MATE as any } });
    expect(row(db).org_role_id).toBeUndefined();
    expect(row(db).owner_user_id).toBe(MATE);
  });

  test("one Save applies people, role and driver together", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    // Add Mate and the role, and make Mate drive: the role is filed but paused.
    const out = await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { add: [MATE], role: role._id, driver: { kind: "user", user_id: MATE } } });
    expect(out.driver).toEqual({ kind: "user", user_id: MATE });
    expect(row(db).org_role_id).toBe(role._id);
    expect(owners(db)).toEqual([ME, MATE].sort());
    // Take Mate off and give the wheel back to the role.
    const back = await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { remove: [MATE], driver: { kind: "role" } } });
    expect(back.driver).toEqual({ kind: "role", role_id: role._id });
    expect(owners(db)).toEqual([ME]);
  });

  test("the owners read names the role, the driver and the account that runs it", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: role._id } });
    const read = (await performListOwners(ctx, ME as any, "sess1"))!;
    expect(read.owners.map((o) => o.user_id)).toEqual([ME]);
    expect(read.role).toMatchObject({ role_id: role._id, handle: "growth", name: "Growth", hold: "filed" });
    expect(read.driver).toEqual({ kind: "role", role_id: role._id });
    expect(read.runner).toMatchObject({ user_id: ME, name: "Me", is_bot: false });
  });
});

describe("leaving a session", () => {
  // Me runs it on my Mac and owns it with no row (the starter); Mate shares a
  // Mac mini with the team.
  function leaveFixtures(conv: Record<string, any> = {}, rows: any[] = []) {
    const db = fixtures();
    db._tables.conversations[0] = { ...db._tables.conversations[0], owner_user_id: undefined, owner_device_id: "mymac", ...conv };
    db._tables.session_owners = rows;
    db._tables.devices = [
      { _id: "d1", user_id: ME, device_id: "mymac", label: "My Mac", last_seen: NOW },
      { _id: "d2", user_id: MATE, device_id: "mini", label: "Mate's Mac mini", last_seen: NOW },
    ];
    db._tables.device_shares = [{ _id: "sh1", user_id: MATE, device_id: "mini", team_id: TEAM }];
    db._tables.daemon_commands = [];
    return db;
  }
  const ctxS = (db: any) => ({ db, scheduler: { runAfter: async () => {} } }) as any;

  test("a session on your account cannot be left without moving it", async () => {
    const db = leaveFixtures({}, [{ _id: "so1", conversation_id: CONV, user_id: ME, added_by: ME, added_at: 1 }, { _id: "so2", conversation_id: CONV, user_id: MATE, added_by: ME, added_at: 2 }]);
    await expect(performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { leave: {} } })).rejects.toThrow(/runs on your account/);
  });

  test("the only owner moves it to a teammate's machine and leaves; the new runner owns it, the leaver does not come back", async () => {
    const db = leaveFixtures();
    await performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { leave: { move_to_device_id: "mini" } } });
    expect(row(db).user_id).toBe(MATE);
    // Who started it stays recorded; the new runner owns it by a row, so the
    // starter rule cannot hand it back to me.
    expect(row(db).author_user_id).toBe(ME);
    expect(db._tables.session_owners.map((r: any) => r.user_id)).toEqual([MATE]);
    const read = (await performListOwners(ctxS(db), MATE as any, "sess1"))!;
    expect(read.owner_ids).toEqual([MATE]);
    expect(read.driver).toEqual({ kind: "user", user_id: MATE });
  });

  test("moving to a machine on your own account is not a way out", async () => {
    const db = leaveFixtures();
    db._tables.devices.push({ _id: "d3", user_id: ME, device_id: "myother", label: "My other Mac", last_seen: NOW });
    await expect(performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { leave: { move_to_device_id: "myother" } } })).rejects.toThrow(/runs on your account/);
  });

  test("the only owner of a session someone else runs cannot simply leave", async () => {
    const db = leaveFixtures({ user_id: "users_bot" }, [{ _id: "so1", conversation_id: CONV, user_id: ME, added_by: ME, added_at: 1 }]);
    db._tables.users.push({ _id: "users_bot", name: "Bot", is_bot: true });
    await expect(performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { leave: {} } })).rejects.toThrow(/Nobody would own/);
  });

  test("the only owner of a session a teammate runs leaves it to them", async () => {
    const db = leaveFixtures({ user_id: MATE, author_user_id: ME, owner_device_id: "mini" }, [{ _id: "so1", conversation_id: CONV, user_id: ME, added_by: ME, added_at: 1 }]);
    await performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { remove: [ME] } });
    expect(db._tables.session_owners.map((r: any) => r.user_id)).toEqual([MATE]);
    expect(row(db).author_user_id).toBe(ME);
  });

  // Undo of a leave is a rejoin (an add of yourself, the self-claim). The
  // listOwners read says whether it will succeed (team_access), and the
  // client offers the undo only then.
  test("an owner who leaves a run the team shares can rejoin it, and the read said so", async () => {
    const db = leaveFixtures({ user_id: MATE, owner_device_id: "mini", is_private: false, team_visibility: "full" }, [{ _id: "so1", conversation_id: CONV, user_id: MATE, added_by: MATE, added_at: 1 }, { _id: "so2", conversation_id: CONV, user_id: ME, added_by: MATE, added_at: 2 }]);
    expect((await performListOwners(ctxS(db), ME as any, "sess1"))!.team_access).toBe(true);
    await performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { leave: {} } });
    await performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { add: [ME] } });
    expect(db._tables.session_owners.map((r: any) => r.user_id).sort()).toEqual([MATE, ME].sort());
  });

  test("an owner of a run the team cannot read in full has no way back after leaving, and the read said so", async () => {
    const db = leaveFixtures({ user_id: MATE, owner_device_id: "mini", team_visibility: "summary" }, [{ _id: "so1", conversation_id: CONV, user_id: MATE, added_by: MATE, added_at: 1 }, { _id: "so2", conversation_id: CONV, user_id: ME, added_by: MATE, added_at: 2 }]);
    expect((await performListOwners(ctxS(db), ME as any, "sess1"))!.team_access).toBe(false);
    await performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { leave: {} } });
    await expect(performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { add: [ME] } })).rejects.toThrow(/No session found/);
  });

  test("an owner of a teammate's session leaves and the rest stay", async () => {
    const db = leaveFixtures({ user_id: MATE, owner_device_id: "mini" }, [{ _id: "so1", conversation_id: CONV, user_id: MATE, added_by: MATE, added_at: 1 }, { _id: "so2", conversation_id: CONV, user_id: ME, added_by: MATE, added_at: 2 }]);
    await performApplyOwnersChange(ctxS(db), ME as any, { session_id: "sess1", change: { leave: {} } });
    expect(db._tables.session_owners.map((r: any) => r.user_id)).toEqual([MATE]);
  });
});

// `cast disown`, `cast disown --all`, an owners set and the chart's reparent
// mutation take the caller out by the same leave rules as the menu.
describe("every way out is a leave", () => {
  function doorFixtures(conv: Record<string, any>, rows: string[]) {
    const db = fixtures();
    db._tables.conversations[0] = { ...db._tables.conversations[0], owner_user_id: undefined, ...conv };
    db._tables.session_owners = rows.map((user_id, i) => ({ _id: `so${i}`, conversation_id: CONV, user_id, added_by: ME, added_at: i + 1 }));
    db._tables.users.push({ _id: "users_bot", name: "Bot", is_bot: true });
    return db;
  }
  const ctxS = (db: any) => ({ db, scheduler: { runAfter: async () => {} } }) as any;
  const rowsOf = (db: any) => db._tables.session_owners.map((r: any) => r.user_id);

  test("cast disown on a session that runs on your account is refused", async () => {
    const db = doorFixtures({}, [ME, MATE]);
    await expect(performRemoveSessionOwner(ctxS(db), ME as any, { session_id: "sess1", owner: "me" })).rejects.toThrow(/runs on your account/);
  });

  test("cast disown as the only owner of an agent box's session is refused", async () => {
    const db = doorFixtures({ user_id: "users_bot" }, [ME]);
    await expect(performRemoveSessionOwner(ctxS(db), ME as any, { session_id: "sess1", owner: "me" })).rejects.toThrow(/Nobody would own/);
  });

  test("cast disown by the starter of a session a teammate now runs leaves it to them", async () => {
    // No rows: I own it only as its author, so there is no row to remove.
    const db = doorFixtures({ user_id: MATE, author_user_id: ME, is_private: false }, []);
    await performRemoveSessionOwner(ctxS(db), ME as any, { session_id: "sess1", owner: "me" });
    expect(rowsOf(db)).toEqual([MATE]);
    expect((await performListOwners(ctxS(db), MATE as any, "sess1"))!.owner_ids).toEqual([MATE]);
  });

  test("cast disown of someone else is a plain removal", async () => {
    const db = doorFixtures({}, [ME, MATE]);
    await performRemoveSessionOwner(ctxS(db), ME as any, { session_id: "sess1", owner: "mate@x.ai" });
    expect(rowsOf(db)).toEqual([ME]);
  });

  test("an owners set that leaves you out keeps the leave rules", async () => {
    await expect(performSetSessionOwners(ctxS(doorFixtures({}, [ME, MATE])), ME as any, { session_id: "sess1", owners: ["mate@x.ai"] })).rejects.toThrow(/runs on your account/);
    await expect(performSetSessionOwners(ctxS(doorFixtures({ user_id: "users_bot" }, [ME])), ME as any, { session_id: "sess1", owners: [] })).rejects.toThrow(/Nobody would own/);
    const db = doorFixtures({ user_id: MATE, driver_user_id: ME }, [ME, MATE]);
    await performSetSessionOwners(ctxS(db), ME as any, { session_id: "sess1", owners: ["mate@x.ai"] });
    expect(rowsOf(db)).toEqual([MATE]);
    expect(row(db).driver_user_id).toBeUndefined();
  });

  test("the chart's reparent mutation keeps the leave rules too", async () => {
    const db = doorFixtures({}, [ME, MATE]);
    await expect(withLeaveRules(ctxS(db), ME as any, "sess1", () => performReparentSession(ctxS(db), ME as any, { session_id: "sess1", target: { kind: "user", owners: [ME], mode: "remove" } }))).rejects.toThrow(/runs on your account/);
  });
});

describe("who may change the owners and the driver", () => {
  test("a teammate who only sees the session may claim it, but not reshape it or take the wheel", async () => {
    const db = fixtures();
    db._tables.conversations[0].is_private = false;
    const ctx = ctxOf(db);
    await expect(performSetSessionDriver(ctx, MATE as any, { session_id: "sess1", driver: { kind: "user", user_id: ME } })).rejects.toThrow(/Only an owner/);
    await expect(performApplyOwnersChange(ctx, MATE as any, { session_id: "sess1", change: { remove: [ME] } })).rejects.toThrow(/Only an owner/);
    await performApplyOwnersChange(ctx, MATE as any, { session_id: "sess1", change: { add: [MATE] } });
    expect(owners(db)).toEqual([ME, MATE].sort());
    expect((await performListOwners(ctx, MATE as any, "sess1"))!.can_edit).toBe(true);
  });

  test("cast own and cast disown refuse a teammate who only sees the session, except claiming it", async () => {
    const db = fixtures();
    db._tables.conversations[0].is_private = false;
    db._tables.users.push({ _id: "u".repeat(31) + "o", name: "Other", email: "other@x.ai" });
    db._tables.team_memberships.push({ _id: "m3", user_id: "u".repeat(31) + "o", team_id: TEAM, role: "member", joined_at: 1 });
    const ctx = ctxOf(db);
    await expect(performAddSessionOwner(ctx, MATE as any, { session_id: "sess1", owner: "other@x.ai" })).rejects.toThrow(/Only an owner/);
    await expect(performRemoveSessionOwner(ctx, MATE as any, { session_id: "sess1", owner: "me@x.ai" })).rejects.toThrow(/Only an owner/);
    await expect(performSetSessionOwners(ctx, MATE as any, { session_id: "sess1", owners: [] })).rejects.toThrow(/Only an owner/);
    await expect(performSetSessionOwners(ctx, MATE as any, { session_id: "sess1", owners: ["me"] })).rejects.toThrow(/Only an owner/);
    expect(owners(db)).toEqual([ME]);
    await performAddSessionOwner(ctx, MATE as any, { session_id: "sess1", owner: "me" });
    expect(owners(db)).toEqual([ME, MATE].sort());
    // Now an owner, they may hand it on and leave it.
    await performAddSessionOwner(ctx, MATE as any, { session_id: "sess1", owner: "other@x.ai" });
    await performRemoveSessionOwner(ctx, MATE as any, { session_id: "sess1", owner: "me" });
    expect(owners(db)).toEqual([ME, "u".repeat(31) + "o"].sort());
  });

  test("adding a teammate to a session with no owner rows keeps its starter", async () => {
    const db = fixtures();
    db._tables.session_owners = [];
    const ctx = ctxOf(db);
    await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { add: [MATE] } });
    expect((await performListOwners(ctx, ME as any, "sess1"))!.owner_ids).toEqual([ME, MATE]);
  });

  test("none hands the wheel back to the default", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: [MATE], mode: "add" } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: MATE } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "none" } });
    expect(row(db).driver_user_id).toBeUndefined();
  });

  // `cast own` passes owners as a person types them.
  test("cast own @handle files the role, which drives; the same role again changes nothing", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { role: "@growth" } });
    expect(row(db).org_role_id).toBe(role._id);
    expect(await driver(ctx)).toEqual({ kind: "role", role_id: role._id });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: "me" } });
    await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { role: role.short_id } });
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: ME });
    await expect(performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { role: "@nobody" } })).rejects.toThrow(/No role @nobody/);
  });

  test("cast own --drive matches a name among the owners before the team", async () => {
    const db = fixtures();
    const SAM2 = "u".repeat(31) + "2";
    db._tables.users.push({ _id: "u".repeat(31) + "1", name: "Sam Lee", email: "sam1@x.ai" }, { _id: SAM2, name: "Sam Lee", email: "sam2@x.ai" });
    db._tables.team_memberships.push({ _id: "m4", user_id: "u".repeat(31) + "1", team_id: TEAM, role: "member", joined_at: 1 }, { _id: "m5", user_id: SAM2, team_id: TEAM, role: "member", joined_at: 1 });
    const ctx = ctxOf(db);
    await performAddSessionOwner(ctx, ME as any, { session_id: "sess1", owner: "sam2@x.ai" });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: "Sam Lee" } });
    expect(row(db).driver_user_id).toBe(SAM2);
  });

  test("cast own --drive takes a teammate by email once they own it", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await expect(performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: "mate@x.ai" } })).rejects.toThrow(/add them as an owner first/);
    await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { add: ["mate@x.ai"] } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: "mate@x.ai" } });
    expect(row(db).driver_user_id).toBe(MATE);
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: MATE });
  });
});

// The agent reports to whoever drives (lib/reportsTo), never to the primary
// owner the chart files it by, which follows the person last added.
describe("the reports-to line follows the driver", () => {
  const told = (db: any) => db._tables.pending_messages.map((m: any) => String(m.content)).filter((c: string) => c.includes("You now report to"));

  test("adding a teammate tells nothing new; making them driver tells the agent it reports to them", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "user", owners: [MATE], mode: "add" } });
    expect(row(db).owner_user_id).toBe(MATE);
    expect(await driver(ctx)).toEqual({ kind: "user", user_id: ME });
    expect(told(db)).toEqual([]);
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: MATE } });
    expect(told(db)).toHaveLength(1);
    expect(told(db)[0]).toContain("You now report to Mate: your questions and decisions go to them.");
  });

  test("filing a role tells the role; a person taking the wheel back tells them, and handing it to the role tells the role again", async () => {
    const db = fixtures();
    const ctx = ctxOf(db);
    const role = await performCreateRole(ctx, ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    await performReparentSession(ctx, ME as any, { session_id: "sess1", target: { kind: "role", role_id: role._id } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "user", user_id: ME } });
    await performSetSessionDriver(ctx, ME as any, { session_id: "sess1", driver: { kind: "role" } });
    expect(told(db).map((c: string) => c.match(/You now report to [^:(]+/)![0].trim())).toEqual(["You now report to Growth", "You now report to Me", "You now report to Growth"]);
  });
});

// An undo's restore is an add by another name: the team rule and the human
// rule hold, and the dispatch's check holds each field to its type. An owner
// row is owner access (privacy.checkConversationAccess), so a stranger's row
// would open the whole transcript to them.
describe("restoring owner rows", () => {
  const STRANGER = "u".repeat(31) + "x";
  const BOT = "u".repeat(31) + "b";
  const world = () => {
    const db = fixtures();
    db._tables.users.push({ _id: STRANGER, name: "Stranger", email: "s@x.ai" }, { _id: BOT, name: "Box", is_bot: true });
    // The team's agent box is a member; it still may never own.
    db._tables.team_memberships.push({ _id: "m3", user_id: BOT, team_id: TEAM, role: "member", joined_at: 1 });
    return db;
  };
  const restore = (user_id: string, over: Record<string, any> = {}) => ({ user_id, added_by: ME, added_at: 2, ...over });

  test("someone outside the team, or an agent account, is refused, and gains no access", async () => {
    const db = world();
    const ctx = ctxOf(db);
    await expect(performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { restore: [restore(STRANGER)] } })).rejects.toThrow(/isn't a member of this session's team/);
    await expect(performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { restore: [restore(BOT)] } })).rejects.toThrow(/agent account/);
    expect(owners(db)).toEqual([ME]);
    expect(await checkConversationAccess(ctx, STRANGER as any, row(db))).toBe("denied");
  });

  test("a teammate's row comes back as it was", async () => {
    const db = world();
    const ctx = ctxOf(db);
    await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { restore: [restore(MATE, { seen_at: 5, note: "yours" })] } });
    expect(db._tables.session_owners.find((r: any) => r.user_id === MATE)).toMatchObject({ added_by: ME, added_at: 2, seen_at: 5, note: "yours" });
  });

  test("the dispatch's check refuses a note or seen_at of the wrong type, and keeps only the row's own fields", () => {
    expect(() => ownersChangeFromDispatch({ restore: [restore(MATE, { note: { not: "a string" } })] })).toThrow("Invalid owners change");
    expect(() => ownersChangeFromDispatch({ restore: [restore(MATE, { seen_at: "yesterday" })] })).toThrow("Invalid owners change");
    expect(ownersChangeFromDispatch({ restore: [restore(MATE, { extra: 1 })] }).restore).toEqual([restore(MATE)]);
  });
});
