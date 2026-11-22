import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole, performReparentSession } from "./orgRoles";
import { performApplyOwnersChange, performListOwners, performSetSessionDriver } from "./sessionOwnership";

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
    // Leave, and give the wheel back to the role.
    const left = await performApplyOwnersChange(ctx, ME as any, { session_id: "sess1", change: { remove: [ME], driver: { kind: "role" } } });
    expect(left.driver).toEqual({ kind: "role", role_id: role._id });
    expect(owners(db)).toEqual([MATE]);
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
