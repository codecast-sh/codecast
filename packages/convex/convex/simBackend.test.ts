import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import { convexIdFor, makeRng } from "@codecast/shared/contracts/__fixtures__/inboxProjectionGen";
import { api } from "./_generated/api";
import { dispatch } from "./dispatch";
import { internalMutation, mutation, query } from "./functions";
import { makeSimBackend, type ScheduledJob, type SimBackendOptions } from "./simBackend.testing";
import { makeFakeDb } from "./testDb";

// The sim backend (docs/architecture/multiplayer-sim-harness.md, unit U1): real
// handlers reached by name through the router, with the Convex runtime parts
// they need (validation, transactions, scheduler, memo) and named errors for
// the parts the sim leaves out.

const ME = "users_me";
const MATE = "users_mate";
const TEAM = "teams_1";
const OTHER_TEAM = "teams_2";
const CONV = "conversations_mate";
const NOW = 1_800_000_000_000;

// The same world as conversations.viewerHides.test.ts, so case 1 can compare
// against that file's direct `_handler` call.
function seed(): Record<string, any[]> {
  return {
    users: [
      { _id: ME, name: "Me", email: "me@example.com", team_id: TEAM },
      { _id: MATE, name: "Mate", email: "mate@example.com", team_id: TEAM },
    ],
    teams: [{ _id: TEAM, name: "Team" }, { _id: OTHER_TEAM, name: "Elsewhere" }],
    team_memberships: [
      { _id: "tm_me", team_id: TEAM, user_id: ME },
      { _id: "tm_mate", team_id: TEAM, user_id: MATE },
    ],
    conversations: [
      { _id: CONV, short_id: "convers", user_id: MATE, status: "completed", updated_at: NOW, message_count: 5, team_id: TEAM, is_private: false, title: "Mate's work" },
      { _id: "conversations_mine", user_id: ME, status: "active", updated_at: NOW, message_count: 5, team_id: TEAM, is_private: false, title: "Mine" },
    ],
    session_owners: [],
    inbox_hides: [],
    managed_sessions: [],
    messages: [],
  };
}

// Test-only functions, reached by the name `simFixtures:<export>`.
const recordIdentityRef = makeFunctionReference<"mutation">("simFixtures:recordIdentity");
const simFixtures = {
  writesThenThrows: mutation({
    args: {},
    handler: async (ctx) => {
      await (ctx.db as any).insert("tasks", { user_id: ME, team_id: TEAM, title: "doomed", status: "open", short_id: "ct-1" });
      throw new Error("boom after the write");
    },
  }),
  usesStorage: mutation({
    args: {},
    handler: async (ctx) => (ctx.storage as any).getUrl("kg2abc"),
  }),
  readsUnknownCtx: query({
    args: {},
    handler: async (ctx) => (ctx as any).vectorSearch,
  }),
  schedulesProbe: mutation({
    args: { note: v.string() },
    handler: async (ctx, { note }) => {
      await ctx.scheduler.runAfter(5_000, recordIdentityRef as any, { note });
    },
  }),
  recordIdentity: internalMutation({
    args: { note: v.string() },
    handler: async (ctx, { note }) => {
      await (ctx.db as any).insert("sim_probes", { note, identity: await ctx.auth.getUserIdentity() });
    },
  }),
};

function backend(extra: Partial<SimBackendOptions> = {}) {
  return makeSimBackend({
    tables: seed(),
    now: () => Date.now(),
    rngFor: (seq) => makeRng(seq),
    mintId: (table, n) => convexIdFor(`${table}:${n}`),
    modules: { simFixtures: async () => simFixtures },
    ...extra,
  });
}

// Rows with their system fields dropped, so two dbs that minted ids
// differently compare on content.
function content(tables: Record<string, any[]>) {
  return Object.fromEntries(
    Object.entries(tables)
      .filter(([, rows]) => rows.length > 0)
      .map(([table, rows]) => [table, rows.map(({ _id, _creationTime, ...rest }) => rest)]),
  );
}

const me = { kind: "user", userId: ME } as const;

describe("sim backend", () => {
  let clock: ReturnType<typeof spyOn>;
  beforeEach(() => {
    clock = spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => clock.mockRestore());

  test("1. dispatch killSession through clientFor writes what the direct _handler call writes", async () => {
    const direct = makeFakeDb(seed());
    await (dispatch as any)._handler(
      { auth: { getUserIdentity: async () => ({ subject: `${ME}|session` }) }, db: direct },
      { action: "killSession", args: [CONV] },
    );
    const sim = backend();
    await sim.clientFor(me).mutation(api.dispatch.dispatch, { action: "killSession", args: [CONV] });
    expect(sim.db._tables.inbox_hides).toHaveLength(1);
    expect(sim.db._tables.inbox_hides[0]).toMatchObject({ user_id: ME, conversation_id: CONV, kind: "dismiss" });
    expect(content(sim.db._tables)).toEqual(content(direct._tables));
    expect(sim.calls.at(-1)).toMatchObject({ name: "dispatch:dispatch", kind: "mutation", ok: true });
  });

  test("2. a mutation that throws after writing leaves rows, sync_actions and writes() unchanged", async () => {
    const sim = backend();
    const before = structuredClone(sim.db._tables);
    const writes = sim.writes();
    await expect(sim.clientFor(me).mutation("simFixtures:writesThenThrows", {})).rejects.toThrow("boom after the write");
    expect(sim.db._tables).toEqual(before);
    expect(sim.db._tables.sync_actions ?? []).toEqual([]);
    expect(sim.writes()).toBe(writes);
    expect(sim.calls.at(-1)).toMatchObject({ name: "simFixtures:writesThenThrows", ok: false, writes: 0 });
    // The same write without the throw does reach the sync log: the rollback is
    // what removed it.
    await sim.clientFor(me).mutation(api.dispatch.dispatch, { action: "killSession", args: [CONV] });
    expect(sim.writes()).toBeGreaterThan(writes);
  });

  test("3. syncLog:getRange for a scope the caller does not hold answers authorized: false", async () => {
    const sim = backend();
    const page = await sim.clientFor(me).query(api.syncLog.getRange, { scope_key: `team:${OTHER_TEAM}`, from: 0 });
    expect(page).toEqual({ actions: [], nextFrom: 0, hasMore: false, authorized: false });
    const mine = await sim.clientFor(me).query(api.syncLog.getRange, { scope_key: `team:${TEAM}`, from: 0 });
    expect(mine.authorized).not.toBe(false);
  });

  test("4. bad arguments throw an ArgumentValidationError worded like prod", async () => {
    const client = backend().clientFor(me);
    await expect(client.mutation(api.dispatch.dispatch, { action: 5, args: [] }))
      .rejects.toThrow(/^ArgumentValidationError: Value does not match validator\.\nPath: \.action\nValue: 5\nValidator: v\.string\(\)/);
    await expect(client.mutation(api.dispatch.dispatch, { action: "killSession", args: [], ack_positions: true, extra: 1 }))
      .rejects.toThrow(/ArgumentValidationError: Object contains extra field `extra` that is not in the validator/);
    await expect(client.mutation(api.dispatch.dispatch, { args: [] }))
      .rejects.toThrow(/ArgumentValidationError: Object is missing the required field `action`/);
    // A local stub id is not an id of the table the validator names.
    await expect(client.query(api.conversations.listTeamInboxSessions, { activeTeamId: "k7x2m9p4q8r1s5t3v6w0yz" }))
      .rejects.toThrow(/ArgumentValidationError: .*\n.*Path: \.activeTeamId/s);
  });

  test("5. an unknown function names the closest real one", async () => {
    const client = backend().clientFor(me);
    await expect(client.mutation("chat:sendMesage", {})).rejects.toThrow(
      'sim client: no handler for "chat:sendMesage"; did you mean chat:sendMessage? Add the module to MODULES in convex/simBackend.testing.ts',
    );
    await expect(client.mutation("chats:sendMessage", {})).rejects.toThrow("did you mean chat:sendMessage?");
    await expect(client.query("nowhere:atAll", {})).rejects.toThrow('sim client: no handler for "nowhere:atAll". Add the module');
  });

  test("6. ctx.storage and fields the sim does not provide fail with a named error", async () => {
    const sim = backend();
    await expect(sim.clientFor(me).mutation("simFixtures:usesStorage", {})).rejects.toThrow(
      "sim ctx: simFixtures:usesStorage read ctx.storage.getUrl, which the sim does not provide. Add it in makeCtx.",
    );
    await expect(sim.clientFor(me).query("simFixtures:readsUnknownCtx", {})).rejects.toThrow(
      "sim ctx: simFixtures:readsUnknownCtx read ctx.vectorSearch, which the sim does not provide. Add it in makeCtx.",
    );
  });

  test("7. a memo hit returns byte-identical JSON; a write between calls misses", async () => {
    const sim = backend();
    const client = sim.clientFor(me);
    const args = { show_all: false, include_liveness: false, fast_fields_in_overlay: true };
    const first = await client.query(api.conversations.listInboxSessions, args);
    const second = await client.query(api.conversations.listInboxSessions, args);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).not.toBe(first);
    expect(sim.calls.slice(-2).map((c) => c.memo)).toEqual(["miss", "hit"]);
    // Hiding the teammate's session writes an inbox_hides row.
    await client.mutation(api.dispatch.dispatch, { action: "killSession", args: [CONV] });
    expect(sim.calls.at(-1)?.writes).toBeGreaterThan(0);
    await client.query(api.conversations.listInboxSessions, args);
    expect(sim.calls.at(-1)?.memo).toBe("miss");
  });

  test("8. runAfter hands a job to onSchedule, and runScheduled runs it with a null identity", async () => {
    const jobs: ScheduledJob[] = [];
    const sim = backend({ onSchedule: (job) => jobs.push(job) });
    await sim.clientFor(me).mutation("simFixtures:schedulesProbe", { note: "later" });
    expect(jobs).toEqual([{ id: expect.any(String), due: NOW + 5_000, name: "simFixtures:recordIdentity", args: { note: "later" } }]);
    expect(sim.db._tables.sim_probes ?? []).toEqual([]);
    await sim.runScheduled(jobs[0]!);
    expect(sim.db._tables.sim_probes).toMatchObject([{ note: "later", identity: null }]);
    expect(sim.calls.at(-1)).toMatchObject({ name: "simFixtures:recordIdentity", principal: { kind: "system" }, ok: true });
    // A job runs once.
    await sim.runScheduled(jobs[0]!);
    expect(sim.db._tables.sim_probes).toHaveLength(1);
  });

  test("a canceled job never runs", async () => {
    const jobs: ScheduledJob[] = [];
    const sim = backend({ onSchedule: (job) => jobs.push(job) });
    await sim.clientFor(me).mutation("simFixtures:schedulesProbe", { note: "canceled" });
    sim.cancelScheduled(jobs[0]!.id);
    await sim.runScheduled(jobs[0]!);
    expect(sim.db._tables.sim_probes ?? []).toEqual([]);
  });

  test("internal functions are out of a client's reach and in runInternal's", async () => {
    const sim = backend();
    await expect(sim.clientFor(me).mutation("simFixtures:recordIdentity", { note: "x" })).rejects.toThrow(/is internal/);
    await sim.runInternal("simFixtures:recordIdentity", { note: "x" });
    expect(sim.db._tables.sim_probes).toHaveLength(1);
  });

  test("a rolled-back mutation schedules nothing", async () => {
    const jobs: ScheduledJob[] = [];
    const fixtures = {
      ...simFixtures,
      schedulesThenThrows: mutation({
        args: {},
        handler: async (ctx) => {
          await ctx.scheduler.runAfter(0, recordIdentityRef as any, { note: "never" });
          throw new Error("no");
        },
      }),
    };
    const sim = backend({ onSchedule: (job) => jobs.push(job), modules: { simFixtures: async () => fixtures } });
    await expect(sim.clientFor(me).mutation("simFixtures:schedulesThenThrows", {})).rejects.toThrow("no");
    expect(jobs).toEqual([]);
  });

  test("top-level calls run one at a time; debug mode refuses overlap", async () => {
    const sim = backend();
    const client = sim.clientFor(me);
    const args = { show_all: false };
    await Promise.all([client.query(api.conversations.listInboxSessions, args), client.query(api.syncLog.getHeads, {})]);
    expect(sim.calls.map((c) => c.ok)).toEqual([true, true]);
    const strict = backend({ debug: true }).clientFor(me);
    const first = strict.query(api.conversations.listInboxSessions, args);
    const second = strict.query(api.syncLog.getHeads, {});
    await first;
    await expect(second).rejects.toThrow(/sim server: syncLog:getHeads started while conversations:listInboxSessions was running/);
  });
});

describe("fake db sim options", () => {
  test("with no options the db mints, patches and deletes as before", async () => {
    const db = makeFakeDb({ tasks: [{ _id: "tasks_1", title: "a" }] });
    const id = await db.insert("tasks", { title: "b" });
    expect(id).toBe("tasks_2");
    await db.patch(id, { title: undefined });
    expect(Object.keys(db._tables.tasks[1])).toEqual(["_id", "title"]);
    expect(db._tables.tasks[1]._creationTime).toBeUndefined();
    expect(db.__writeCount).toBe(2);
  });

  test("minted ids, _creationTime, strict patch and rollback", async () => {
    let t = 100;
    const db = makeFakeDb({ tasks: [] }, { mintId: (table, n) => `${table}-${n}`, creationTime: () => t, strictPatch: true });
    const a = await db.insert("tasks", { title: "a", note: "x" });
    const b = await db.insert("tasks", { title: "b" });
    expect([a, b]).toEqual(["tasks-1", "tasks-2"]);
    expect(db._tables.tasks[0]._creationTime).toBe(100);
    expect(db._tables.tasks[1]._creationTime).toBeGreaterThan(100);
    await db.patch(a, { note: undefined });
    expect("note" in db._tables.tasks[0]).toBe(false);
    expect(await db.get(b)).toMatchObject({ _id: b, title: "b" });

    const snapshot = structuredClone(db._tables);
    const writes = db.__writeCount;
    db.__beginJournal();
    await db.insert("tasks", { title: "c" });
    await db.patch(a, { title: "changed", extra: 1 });
    await db.replace(b, { title: "replaced" });
    await db.delete(a);
    db.__rollback();
    expect(db._tables).toEqual(snapshot);
    expect(db.__writeCount).toBe(writes);
    // Ids are never reused after a rollback.
    t = 200;
    expect(await db.insert("tasks", { title: "d" })).toBe("tasks-4");
  });
});
