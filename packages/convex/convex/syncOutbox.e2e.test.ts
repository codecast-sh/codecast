import { describe, expect, test } from "bun:test";
import { mutation, syncAckReceipts } from "./functions";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { drainSyncOutbox, readDeliveryReceipts, recover } from "./syncOutbox";
import { attachSyncOutbox, enqueueSyncAction } from "./syncOutboxWriter";
import { makeSyncAckCollector } from "./syncLog";
import { readRangePage } from "./syncLog";

function fixture() {
  const db = makeFakeDb({ users: [{ _id: "owner" }] }, {
    strictPatch: true, indexes: schemaIndexes(schema), mintId: (table, n) => `${table}_${n}`,
    creationTime: () => Date.now(),
  });
  // The scheduler as convex keeps it: each job is a row whose state moves from
  // pending to success, failed or canceled.
  const scheduled: any[] = [];
  const jobs = new Map<string, { args: any[]; state: { kind: string } }>();
  const ctx: any = {
    db,
    scheduler: {
      runAfter: async (...args: any[]) => {
        scheduled.push(args);
        const id = `job_${jobs.size + 1}`;
        jobs.set(id, { args, state: { kind: "pending" } });
        return id;
      },
      cancel: async (id: string) => {
        const job = jobs.get(id);
        if (job?.state.kind === "pending") job.state = { kind: "canceled" };
      },
    },
  };
  db.system = { get: async (id: string) => jobs.get(id) ?? null };
  /** Run every due drain the way the scheduler would, oldest first; returns how many ran. */
  const runJobs = async () => {
    let ran = 0;
    for (let i = 0; i < 1000; i++) {
      const next = [...jobs.values()].find((j) => j.state.kind === "pending");
      if (!next) return ran;
      next.state = { kind: "success" };
      await drainSyncOutbox(ctx, next.args[2].id);
      ran++;
    }
    throw new Error("drain jobs did not settle");
  };
  return { db, ctx, scheduled, jobs, runJobs };
}
const save = (mutation({
  args: {},
  handler: async (ctx: any, args: any) => {
    if (args.id) await ctx.db.patch(args.id, args.fields);
    else args.id = await ctx.db.insert("conversations", { user_id: "owner", title: "Initial", ...args.fields });
    return { id: args.id, receipts: syncAckReceipts(ctx) };
  },
}) as any)._handler;

async function deliverAll(ctx: any) {
  for (let i = 0; i < 20; i++) {
    const pending = (ctx.db._tables.sync_outbox ?? []).find((r: any) => r.pending);
    if (!pending) return;
    await drainSyncOutbox(ctx, pending._id);
  }
  throw new Error("outbox did not drain");
}

describe("durable sync delivery through wrapped application saves", () => {
  test("64 concurrent semantic saves touch no shared head; bounded delivery converges", async () => {
    const { ctx, db } = fixture();
    const query = db.query.bind(db);
    db.query = ((table: string) => {
      if (table === "sync_heads") throw new Error("application save read shared counter");
      return query(table);
    }) as any;
    const saved = await Promise.all(Array.from({ length: 64 }, (_, i) => save(ctx, { fields: { title: `Session ${i}` } })));
    expect(db._tables.conversations).toHaveLength(64);
    expect(db._tables.sync_outbox).toHaveLength(64);
    expect(db._tables.sync_heads ?? []).toHaveLength(0);
    expect(saved.every((r: any) => r.receipts.length === 1)).toBe(true);
    db.query = query;
    await deliverAll(ctx);
    expect(db._tables.sync_actions).toHaveLength(64);
    expect(db._tables.sync_heads[0].position).toBe(64);
    expect(new Set(db._tables.sync_actions.map((r: any) => r.position)).size).toBe(64);
  });

  test("superseded writes and unsets coalesce, receipts settle only after delivery", async () => {
    const { ctx, db } = fixture();
    const a = await save(ctx, { fields: { title: "Old", subtitle: "Remove" } });
    const b = await save(ctx, { id: a.id, fields: { title: "New", subtitle: undefined } });
    expect(b.receipts[0].revision).toBe(2);
    expect(await readDeliveryReceipts(db, [a.receipts[0]], new Set(["user:owner"])))
      .toMatchObject([{ revision: 0, position: 0 }]);
    await deliverAll(ctx);
    expect(db._tables.sync_actions[0]).toMatchObject({ patch: { title: "New" }, unset: ["subtitle"] });
    expect(db._tables.sync_actions[0].patch.subtitle).toBeUndefined();
    expect(await readDeliveryReceipts(db, [a.receipts[0]], new Set(["user:owner"])))
      .toMatchObject([{ revision: 2, position: 1 }]);
    await drainSyncOutbox(ctx, a.receipts[0].id);
    expect(db._tables.sync_heads[0].position).toBe(1);
  });

  test("worker rollback leaves saved data and pending delivery recoverable", async () => {
    const { ctx, db, scheduled, jobs } = fixture();
    const a = await save(ctx, { fields: { title: "Saved" } });
    const patch = db.patch.bind(db);
    db.__beginJournal();
    db.patch = (async (id: any, fields: any) => {
      if (fields.delivered_revision) throw new Error("worker crashed before commit");
      return patch(id, fields);
    }) as any;
    await expect(drainSyncOutbox(ctx, a.receipts[0].id)).rejects.toThrow("worker crashed");
    db.__rollback();
    db.patch = patch;
    expect((await db.get(a.id))?.title).toBe("Saved");
    expect(db._tables.sync_actions ?? []).toHaveLength(0);
    expect((await db.get(a.receipts[0].id))?.pending).toBe(true);
    jobs.get("job_1")!.state = { kind: "failed" };
    scheduled.length = 0;
    await (recover as any)._handler(ctx, {});
    expect(scheduled).toHaveLength(1);
    await deliverAll(ctx);
    expect(db._tables.sync_actions).toHaveLength(1);
  });

  test("failed application transaction rolls back its outbox too", async () => {
    const { ctx, db } = fixture();
    db.__beginJournal();
    await save(ctx, { fields: { title: "Aborted" } });
    db.__rollback();
    expect(db._tables.conversations ?? []).toHaveLength(0);
    expect(db._tables.sync_outbox ?? []).toHaveLength(0);
  });

  test("deletion before delivery emits only a tombstone and cannot resurrect cargo", async () => {
    const { ctx, db } = fixture();
    const a = await save(ctx, { fields: { title: "Delete me" } });
    const remove = mutation({ args: {}, handler: async (wrapped: any) => wrapped.db.delete(a.id) });
    await (remove as any)._handler(ctx, {});
    await deliverAll(ctx);
    expect(await db.get(a.id)).toBeNull();
    expect(db._tables.sync_actions).toHaveLength(1);
    expect(db._tables.sync_actions[0].op).toBe("delete");
    expect(db._tables.sync_actions[0].patch).toBeUndefined();
  });

  test("a later write survives an earlier delivery and duplicate worker invocations", async () => {
    const { ctx, db } = fixture();
    const a = await save(ctx, { fields: { title: "First" } });
    await deliverAll(ctx);
    await save(ctx, { id: a.id, fields: { title: "Second" } });
    await drainSyncOutbox(ctx, a.receipts[0].id);
    await drainSyncOutbox(ctx, a.receipts[0].id);
    expect(db._tables.sync_actions[0]).toMatchObject({ position: 2, patch: { title: "Second" } });
    expect((await db.get(a.receipts[0].id))?.delivered_revision).toBe(2);
  });

  test("pending revoke fences old cargo immediately; revoke then regrant cannot replay a stale delete", async () => {
    const { ctx, db } = fixture();
    const extra = { cargo: { patch: { title: "Secret" }, full: true }, access: async () => ({ access_owner: "owner", access_key: "team:team" }) };
    const a = await enqueueSyncAction(ctx, "team:team", "tasks", "task", "upsert", extra);
    await deliverAll(ctx);
    await enqueueSyncAction(ctx, "team:team", "tasks", "task", "delete");
    const viewer = { userId: "member", heldKeys: new Set(["team:team"]) };
    expect((await readRangePage(db, "team:team", 0, 10, viewer, { cargo: true })).actions)
      .toEqual([{ position: 1, entity_type: "tasks", entity_id: "task", op: "delete" }]);
    await enqueueSyncAction(ctx, "team:team", "tasks", "task", "upsert", extra);
    await drainSyncOutbox(ctx, a.id);
    expect(db._tables.sync_actions).toHaveLength(1);
    expect(db._tables.sync_actions[0].op).toBe("upsert");
    expect((await db.get(a.id))?.delivered_revision).toBe(3);
  });

  test("bootstrap never replays stale cargo while a newer save awaits delivery", async () => {
    const { ctx, db } = fixture();
    const a = await save(ctx, { fields: { title: "Before snapshot" } });
    await deliverAll(ctx);
    await save(ctx, { id: a.id, fields: { title: "Snapshot value" } });
    const page = await readRangePage(db, "user:owner", 0, 10, undefined, { cargo: true });
    expect(page.actions[0]).not.toHaveProperty("patch");
    expect((await db.get(a.id))?.title).toBe("Snapshot value");
    await deliverAll(ctx);
    expect((await readRangePage(db, "user:owner", 1, 10, undefined, { cargo: true })).actions[0])
      .toMatchObject({ patch: { title: "Snapshot value" } });
  });

  test("membership events preserve remove/add/remove order and are not deduplicated", async () => {
    const { ctx, db } = fixture();
    for (const op of ["scope_removed", "scope_added", "scope_removed"] as const)
      await enqueueSyncAction(ctx, "user:owner", "scope", "team", op);
    await deliverAll(ctx);
    expect(db._tables.sync_actions.map((r: any) => r.op)).toEqual(["scope_removed", "scope_added", "scope_removed"]);
    expect(db._tables.sync_actions.map((r: any) => r.position)).toEqual([1, 2, 3]);
  });

  // Every drain job costs the scheduler a slot whether or not it finds work,
  // and in prod most of them found none (2026-10-14: 10.6k of 13.6k an hour).
  test("one transaction touching many entities in a scope schedules one drain", async () => {
    const { ctx, db, scheduled } = fixture();
    const collector = makeSyncAckCollector();
    attachSyncOutbox(ctx, collector);
    for (let i = 0; i < 10; i++) await collector.enqueue!("user:owner", "conversations" as any, `c${i}`, "upsert", { cargo: { partial: true } } as any);
    await collector.enqueue!("team:t1", "conversations" as any, "c0", "upsert", { cargo: { partial: true } } as any);
    expect(db._tables.sync_outbox.filter((r: any) => r.pending)).toHaveLength(11);
    expect(scheduled.map((args) => args[2].id)).toHaveLength(2);
    await deliverAll(ctx);
    expect(db._tables.sync_actions).toHaveLength(11);
  });

  // Saves in separate transactions each schedule a drain, and the first one
  // to run delivers the whole scope. On 2026-10-23 86% of prod drains found
  // nothing to do; the delivered slots' drains are now canceled instead.
  test("saves in separate transactions run one drain for the scope", async () => {
    const { ctx, db, scheduled, jobs, runJobs } = fixture();
    for (let i = 0; i < 10; i++) await save(ctx, { fields: { title: `Session ${i}` } });
    expect(scheduled).toHaveLength(10);
    expect(await runJobs()).toBe(1);
    expect(db._tables.sync_actions).toHaveLength(10);
    expect([...jobs.values()].filter((j) => j.state.kind === "canceled")).toHaveLength(9);
    expect(db._tables.sync_outbox.every((r: any) => !r.pending && r.drain_job === undefined)).toBe(true);
  });

  test("recover leaves a scope whose drain is still waiting alone", async () => {
    const { ctx, db, scheduled, jobs, runJobs } = fixture();
    await save(ctx, { fields: { title: "Waiting" } });
    await enqueueSyncAction(ctx, "team:t1", "tasks", "task", "upsert", { cargo: { partial: true } } as any);
    scheduled.length = 0;
    for (let minute = 0; minute < 5; minute++) await (recover as any)._handler(ctx, {});
    expect(scheduled).toHaveLength(0);
    // A drain that died without delivering leaves its scope to recover.
    jobs.get("job_1")!.state = { kind: "failed" };
    await (recover as any)._handler(ctx, {});
    expect(scheduled.map((args) => args[2].id)).toEqual([db._tables.sync_outbox[0]._id]);
    expect(await runJobs()).toBe(2);
    expect(db._tables.sync_actions).toHaveLength(2);
  });

  test("a lifecycle slot past one pass's event cap gets exactly one follow-up drain", async () => {
    const { ctx, db, scheduled } = fixture();
    for (let i = 0; i < 40; i++) await enqueueSyncAction(ctx, "user:owner", "member", "m1", i % 2 ? "scope_added" : "scope_removed");
    scheduled.length = 0;
    await drainSyncOutbox(ctx, db._tables.sync_outbox[0]._id);
    expect(db._tables.sync_actions).toHaveLength(32);
    expect(scheduled).toHaveLength(1);
    await drainSyncOutbox(ctx, scheduled[0][2].id);
    expect(db._tables.sync_actions).toHaveLength(40);
  });

  test("receipts never reveal another scope's position", async () => {
    const { ctx, db } = fixture();
    const a = await save(ctx, { fields: {} });
    await deliverAll(ctx);
    expect(await readDeliveryReceipts(db, [a.receipts[0]], new Set(["user:intruder"])))
      .toEqual([{ id: a.receipts[0].id, revision: 1, revoked: true }]);
  });
});

test("Convex transactions validate the schema and deliver actual title mutations", async () => {
  const { convexTest } = await import("convex-test");
  const { makeFunctionReference } = await import("convex/server");
  const t = convexTest(schema, {
    "./_generated/server.ts": () => import("./_generated/server"),
    "./titleGeneration.ts": () => import("./titleGeneration"),
    "./syncOutbox.ts": () => import("./syncOutbox"),
  });
  const ids = await t.run(async (ctx) => {
    const user = await ctx.db.insert("users", { name: "Sync fixture" });
    const conversations = [];
    for (let i = 0; i < 12; i++) conversations.push(await ctx.db.insert("conversations", {
      user_id: user, agent_type: "claude_code", session_id: `outbox-${i}`, started_at: 1, updated_at: 1,
      is_private: true, status: "active", title: "Before",
    } as any));
    return conversations;
  });
  const title = makeFunctionReference<"mutation">("titleGeneration:setTitleAndSubtitle");
  await Promise.all(ids.map((conversation_id, i) => t.mutation(title, { conversation_id, title: `After ${i}` })));
  await new Promise((resolve) => setTimeout(resolve, 100));
  await t.finishInProgressScheduledFunctions();
  await t.run(async (ctx) => {
    const pending = await ctx.db.query("sync_outbox").collect();
    expect(pending).toHaveLength(12);
    expect(pending.every((r) => !r.pending && r.delivered_revision === 1)).toBe(true);
    const actions = await ctx.db.query("sync_actions").collect();
    expect(actions).toHaveLength(12);
    expect(new Set(actions.map((r) => r.position)).size).toBe(12);
    for (let i = 0; i < ids.length; i++) expect((await ctx.db.get(ids[i]))?.title).toBe(`After ${i}`);
  });
}, 120_000);
