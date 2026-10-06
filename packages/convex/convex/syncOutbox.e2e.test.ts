import { describe, expect, test } from "bun:test";
import { mutation, syncAckReceipts } from "./functions";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { drainSyncOutbox, readDeliveryReceipts, recover } from "./syncOutbox";
import { enqueueSyncAction } from "./syncOutboxWriter";
import { readRangePage } from "./syncLog";

function fixture() {
  const db = makeFakeDb({ users: [{ _id: "owner" }] }, {
    strictPatch: true, indexes: schemaIndexes(schema), mintId: (table, n) => `${table}_${n}`,
    creationTime: () => Date.now(),
  });
  const scheduled: any[] = [];
  const ctx: any = { db, scheduler: { runAfter: async (...args: any[]) => { scheduled.push(args); return "scheduled"; } } };
  return { db, ctx, scheduled };
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
    expect(await readDeliveryReceipts(db, [a.receipts[0].id], new Set(["user:owner"])))
      .toMatchObject([{ revision: 0, position: 0 }]);
    await deliverAll(ctx);
    expect(db._tables.sync_actions[0]).toMatchObject({ patch: { title: "New" }, unset: ["subtitle"] });
    expect(db._tables.sync_actions[0].patch.subtitle).toBeUndefined();
    expect(await readDeliveryReceipts(db, [a.receipts[0].id], new Set(["user:owner"])))
      .toMatchObject([{ revision: 2, position: 1 }]);
    await drainSyncOutbox(ctx, a.receipts[0].id);
    expect(db._tables.sync_heads[0].position).toBe(1);
  });

  test("worker rollback leaves saved data and pending delivery recoverable", async () => {
    const { ctx, db, scheduled } = fixture();
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

  test("receipts never reveal another scope's position", async () => {
    const { ctx, db } = fixture();
    const a = await save(ctx, { fields: {} });
    await deliverAll(ctx);
    expect(await readDeliveryReceipts(db, [a.receipts[0].id], new Set(["user:intruder"])))
      .toEqual([{ id: a.receipts[0].id, revoked: true }]);
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
