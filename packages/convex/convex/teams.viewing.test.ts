import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { getTeamMembers } from "./teams";
import { reportPresence } from "./pushRouter";
import { PRESENCE_BUCKET_MS, PRESENCE_FRESH_MS } from "./presenceState";

// Who is viewing what, as the roster tells it. The stored id is a fact about
// the viewed session, so it reaches only callers who could open that session
// themselves, and never off a stale row. Both halves are pinned here against
// the real handlers over the fake db: the write (reportPresence) and the read
// (getTeamMembers).

const NOW = Date.now();
const T1 = "t1";
const ANN = "ua";
const BOB = "ub";
const CY = "uc";
const SHARED = "conv-shared";
const PRIVATE = "conv-private";

function tables() {
  return {
    teams: [{ _id: T1, name: "T" }],
    team_memberships: [
      { _id: "m1", user_id: ANN, team_id: T1, visibility: "full" },
      { _id: "m2", user_id: BOB, team_id: T1, visibility: "full" },
      { _id: "m3", user_id: CY, team_id: T1, visibility: "full" },
    ],
    users: [
      { _id: ANN, name: "Ann" },
      { _id: BOB, name: "Bob" },
      { _id: CY, name: "Cy" },
    ],
    conversations: [
      // Bob's team-visible session.
      { _id: SHARED, user_id: BOB, team_id: T1, is_private: false, updated_at: NOW },
      // Bob's private session: only Bob can open it.
      { _id: PRIVATE, user_id: BOB, team_id: T1, is_private: true, updated_at: NOW },
    ],
    session_owners: [] as any[],
    call_members: [] as any[],
    call_room_state: [] as any[],
    devices: [] as any[],
    user_presence: [] as any[],
  };
}

function ctxFor(rows: ReturnType<typeof tables>, user: string) {
  return {
    db: makeFakeDb(rows as any),
    auth: { getUserIdentity: async () => ({ subject: `${user}|sess`, tokenIdentifier: "x" }) },
  };
}

const handler = (fn: any) => fn._handler ?? fn.handler;

async function rosterRow(rows: ReturnType<typeof tables>, caller: string, member: string) {
  const members = await handler(getTeamMembers)(ctxFor(rows, caller), { team_id: T1 });
  return members.find((m: any) => String(m._id) === member);
}

function presence(user: string, viewing: string | undefined, lastSeenAgo = 0) {
  return {
    _id: `p-${user}`,
    user_id: user,
    surface: "desktop",
    last_seen: NOW - lastSeenAgo,
    last_input_at: NOW - lastSeenAgo,
    focused: true,
    updated_at: NOW - lastSeenAgo,
    viewing_conversation_id: viewing,
    viewing_since: viewing ? NOW - 5 * 60_000 - 1234 : undefined,
  };
}

describe("getTeamMembers viewing_conversation_id", () => {
  test("a team visible session is named to a teammate, with viewing_since bucketed", async () => {
    const rows = tables();
    rows.user_presence.push(presence(ANN, SHARED));
    const ann = await rosterRow(rows, CY, ANN);
    expect(ann.viewing_conversation_id).toBe(SHARED);
    expect(ann.viewing_since).toBe(Math.floor((NOW - 5 * 60_000 - 1234) / PRESENCE_BUCKET_MS) * PRESENCE_BUCKET_MS);
  });

  test("a private session is hidden from a member without access and shown to its owner", async () => {
    const rows = tables();
    // Ann is Bob's co-owner on the private session and has it open.
    rows.session_owners.push({ _id: "so1", conversation_id: PRIVATE, user_id: ANN });
    rows.user_presence.push(presence(ANN, PRIVATE));
    const seenByCy = await rosterRow(rows, CY, ANN);
    expect(seenByCy.viewing_conversation_id).toBeUndefined();
    expect(seenByCy.viewing_since).toBeUndefined();
    // Cy still sees Ann as present; only the id is withheld.
    expect(seenByCy.presence_state).toBe("active");
    const seenByBob = await rosterRow(rows, BOB, ANN);
    expect(seenByBob.viewing_conversation_id).toBe(PRIVATE);
  });

  test("a stale row names nothing even when it still stores an id", async () => {
    const rows = tables();
    rows.user_presence.push(presence(ANN, SHARED, PRESENCE_FRESH_MS + 1000));
    const ann = await rosterRow(rows, CY, ANN);
    expect(ann.viewing_conversation_id).toBeUndefined();
    expect(ann.viewing_since).toBeUndefined();
  });

  test("a deleted conversation names nothing", async () => {
    const rows = tables();
    rows.user_presence.push(presence(ANN, "conv-gone"));
    const ann = await rosterRow(rows, CY, ANN);
    expect(ann.viewing_conversation_id).toBeUndefined();
  });
});

describe("reportPresence viewing fields", () => {
  const report = (rows: ReturnType<typeof tables>, user: string, args: Record<string, unknown>) =>
    handler(reportPresence)(ctxFor(rows, user), { focused: true, idle_ms: 0, ...args });

  test("a first report inserts the row with the id and a start time", async () => {
    const rows = tables();
    await report(rows, ANN, { viewing_conversation_id: SHARED });
    const row = rows.user_presence[0];
    expect(row.viewing_conversation_id).toBe(SHARED);
    expect(typeof row.viewing_since).toBe("number");
  });

  test("an unchanged id leaves viewing_since alone; a new id resets it", async () => {
    const rows = tables();
    rows.user_presence.push({ ...presence(ANN, SHARED), viewing_since: 1000 });
    await report(rows, ANN, { viewing_conversation_id: SHARED });
    expect(rows.user_presence[0].viewing_since).toBe(1000);
    // The heartbeat itself still landed.
    expect(rows.user_presence[0].last_seen).toBeGreaterThanOrEqual(NOW);
    await report(rows, ANN, { viewing_conversation_id: PRIVATE });
    // Ann cannot open Bob's private session, so the claim is dropped.
    expect(rows.user_presence[0].viewing_conversation_id).toBeUndefined();
    rows.session_owners.push({ _id: "so1", conversation_id: PRIVATE, user_id: ANN });
    await report(rows, ANN, { viewing_conversation_id: PRIVATE });
    expect(rows.user_presence[0].viewing_conversation_id).toBe(PRIVATE);
    expect(rows.user_presence[0].viewing_since).toBeGreaterThanOrEqual(NOW);
  });

  test("a report without an id clears the stored one", async () => {
    const rows = tables();
    rows.user_presence.push(presence(ANN, SHARED));
    await report(rows, ANN, {});
    expect(rows.user_presence[0].viewing_conversation_id).toBeUndefined();
    expect(rows.user_presence[0].viewing_since).toBeUndefined();
  });

  test("a report that changes nothing about the view patches only the heartbeat fields", async () => {
    const rows = tables();
    rows.user_presence.push(presence(ANN, undefined));
    const ctx = ctxFor(rows, ANN);
    await handler(reportPresence)(ctx, { focused: true, idle_ms: 0 });
    const [patched] = ctx.db._patched;
    expect(Object.keys(patched.patch).sort()).toEqual(["focused", "last_input_at", "last_seen", "updated_at"]);
  });
});
