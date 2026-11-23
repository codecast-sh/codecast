import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performCreateRole } from "./orgRoles";
import { performApplyOwnersChange, performListOwners } from "./sessionOwnership";
import { ownersFactsOf } from "./lib/sessionOwnerRules";
import { ownerRowsOf } from "./sessionOwners";
import { collectInboxSessionsByIds } from "./conversations";
import { applyOwnersChangeTo, driverOf, listedOwnerIds, ownersFactsFromRead, type OwnersChangeInput } from "@codecast/shared/contracts/sessionOwners";

// The web store paints a Save with shared/contracts/sessionOwners before the
// server answers, and holds those fields until the answer matches. These run
// the shared rule and the real mutation side by side and require the same
// answer: owners in order, role, the person who took the wheel, who drives.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";
const SAM = "u".repeat(31) + "s";
const BOT = "u".repeat(31) + "b";
const TEAM = "teams_acme" as any;
const CONV = "c".repeat(32);

function fixtures(conv: Record<string, any>, rows: Array<[string, number]>) {
  return makeFakeDb({
    users: [
      { _id: ME, name: "Me", email: "me@x.ai" },
      { _id: MATE, name: "Mate", email: "mate@x.ai" },
      { _id: SAM, name: "Sam", email: "sam@x.ai" },
      { _id: BOT, name: "Agent box", is_bot: true },
    ],
    team_memberships: [ME, MATE, SAM].map((user_id, i) => ({ _id: `m${i}`, user_id, team_id: TEAM, role: i === 0 ? "admin" : "member", joined_at: 1 })),
    teams: [{ _id: TEAM, name: "Acme", features: { org: true } }],
    counters: [], org_roles: [], managed_sessions: [], messages: [], user_presence: [], pending_messages: [], devices: [], anchors: [],
    conversations: [{ _id: CONV, session_id: "sess1", user_id: ME, team_id: TEAM, is_private: false, status: "active", title: "Fix auth", agent_type: "claude_code", message_count: 3, ...conv }],
    session_owners: rows.map(([user_id, added_at], i) => ({ _id: `so${i}`, conversation_id: CONV, user_id, added_by: ME, added_at })),
  });
}

const ctxOf = (db: any) => ({ db, scheduler: { runAfter: async () => {} } }) as any;
const conv = (db: any) => db._tables.conversations[0];

/** Apply `change` both ways and require the same answer. */
async function parity(db: any, actor: string, change: OwnersChangeInput & Record<string, any>) {
  const ctx = ctxOf(db);
  // What the store holds before the Save: the owners read and the session row.
  const storeFacts = ownersFactsFromRead(await performListOwners(ctx, actor as any, "sess1"), { ...conv(db) });
  const facts = await ownersFactsOf(ctx, conv(db));
  expect(storeFacts).toEqual({ ...facts, rows: facts.rows });
  const expected = applyOwnersChangeTo(storeFacts, change, { actor, now: Date.now() });
  await performApplyOwnersChange(ctx, actor as any, { session_id: "sess1", change: change as any });
  const read = (await performListOwners(ctx, ME as any, "sess1"))!;
  expect(read.owner_ids).toEqual(listedOwnerIds(expected));
  expect(String(conv(db).org_role_id ?? "") || null).toBe(expected.role_id);
  expect(String(conv(db).driver_user_id ?? "") || null).toBe(expected.driver_user_id);
  expect(read.driver).toEqual(driverOf(expected, listedOwnerIds(expected)) as any);
  // The inbox card reads the same owners off its row.
  const { sessions } = await collectInboxSessionsByIds(ctx, conv(db).user_id, [CONV]);
  expect(sessions.find((r: any) => String(r._id) === CONV)?.owner_ids).toEqual(read.owner_ids);
  return read;
}

describe("the store's guess is the server's answer", () => {
  test("undo of removing a middle owner puts the order back", async () => {
    const db = fixtures({}, [[ME, 1], [MATE, 2], [SAM, 3]]);
    const mate = (await ownerRowsOf(ctxOf(db), CONV as any)).find((r) => r.user_id === MATE)!;
    await parity(db, ME, { remove: [MATE] });
    const read = await parity(db, ME, { restore: [mate] });
    expect(read.owner_ids).toEqual([ME, MATE, SAM]);
  });

  test("removing the last row hands the session back to the person who started it", async () => {
    // I started it and handed it to Mate; now I take Mate off.
    const db = fixtures({}, [[MATE, 2]]);
    const read = await parity(db, ME, { remove: [MATE] });
    expect(read.owner_ids).toEqual([ME]);
  });

  test("the phone's clear takes everyone else off", async () => {
    const db = fixtures({}, [[ME, 1], [MATE, 2], [SAM, 3]]);
    await parity(db, ME, { remove: [MATE, SAM] });
  });

  test("unticking yourself on a teammate's session is a leave, and they own it", async () => {
    const db = fixtures({ user_id: MATE }, [[ME, 1]]);
    const read = await parity(db, ME, { remove: [ME] });
    expect(read.owner_ids).toEqual([MATE]);
  });

  test("taking ownership of a session an agent box runs makes you its driver", async () => {
    const db = fixtures({ user_id: BOT }, []);
    const read = await parity(db, MATE, { add: [MATE] });
    expect(read.driver).toEqual({ kind: "user", user_id: MATE });
  });

  test("adding a teammate to a starter-owned session keeps the starter and the wheel", async () => {
    const db = fixtures({}, []);
    await parity(db, ME, { add: [MATE] });
    expect(conv(db).driver_user_id).toBe(ME);
  });

  test("a run a role started gives nobody a starter row, and has no starter until the role comes off", async () => {
    const db = fixtures({ role_started: true }, []);
    const growth = await performCreateRole(ctxOf(db), ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    conv(db).org_role_id = growth._id;
    const before = (await performListOwners(ctxOf(db), ME as any, "sess1"))!;
    expect(before.owners).toEqual([]);
    expect(before.owner_ids).toEqual([]);
    expect(before.driver).toEqual({ kind: "role", role_id: growth._id });
    // The account it runs on adds a teammate: the runner gets no row.
    const read = await parity(db, ME, { add: [MATE] });
    expect(read.owner_ids).toEqual([MATE]);
    expect(read.driver).toEqual({ kind: "role", role_id: growth._id });
    await parity(db, ME, { remove: [MATE] });
    expect((await ownerRowsOf(ctxOf(db), CONV as any)).length).toBe(0);
    // Released from the role, it is the runner's again.
    const released = await parity(db, ME, { role: null });
    expect(released.owner_ids).toEqual([ME]);
  });

  test("taking ownership of a run a role started makes you its only person owner", async () => {
    const db = fixtures({ role_started: true }, []);
    const growth = await performCreateRole(ctxOf(db), ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    conv(db).org_role_id = growth._id;
    const read = await parity(db, MATE, { add: [MATE] });
    expect(read.owner_ids).toEqual([MATE]);
  });

  test("a role, a person who takes the wheel, and the role again", async () => {
    const db = fixtures({}, [[ME, 1]]);
    const growth = await performCreateRole(ctxOf(db), ME as any, { name: "Growth", handle: "growth", team_id: TEAM });
    const evals = await performCreateRole(ctxOf(db), ME as any, { name: "Evals", handle: "evals", team_id: TEAM });
    await parity(db, ME, { add: [MATE], role: growth._id, driver: { kind: "user", user_id: MATE } });
    await parity(db, ME, { role: evals._id });
    await parity(db, ME, { driver: { kind: "user", user_id: ME } });
    await parity(db, ME, { role: null, driver: { kind: "none" } });
  });
});
