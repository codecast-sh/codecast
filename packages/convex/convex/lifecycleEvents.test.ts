import { test, expect } from "bun:test";
import { makeLifecycleEventDb, noteWriteCause } from "./lifecycleEvents";

function fakeDb(rows: Record<string, any>) {
  const inserted: any[] = [];
  const tableOfId = (id: string) => id.split(":")[0];
  const db = {
    normalizeId: (table: string, id: string) => (tableOfId(id) === table ? id : null),
    get: async (id: string) => rows[id] ?? null,
    patch: async (id: string, fields: any) => { rows[id] = { ...rows[id], ...fields }; },
    replace: async (id: string, doc: any) => { rows[id] = doc; },
    delete: async (id: string) => { delete rows[id]; },
    insert: async (table: string, doc: any) => { inserted.push({ table, ...doc }); return "x"; },
    query: () => null,
    system: {},
  };
  return { db, inserted, rows };
}

test("a dismiss records the change and the cause the mutation named", async () => {
  const { db, inserted } = fakeDb({ "conversations:c1": { status: "active" } });
  const ctx = { db: makeLifecycleEventDb(db, db) };
  noteWriteCause(ctx, "web:killSession");
  await ctx.db.patch("conversations:c1", { inbox_dismissed_at: 5, title: "x" });
  expect(inserted).toHaveLength(1);
  expect(inserted[0]).toMatchObject({
    table: "conversation_events",
    conversation_id: "conversations:c1",
    kind: "lifecycle",
    cause: "web:killSession",
    changes: { inbox_dismissed_at: [null, "5"] },
  });
});

test("re-asserting a value that is already set records nothing", async () => {
  const { db, inserted } = fakeDb({ "conversations:c1": { status: "completed" } });
  const ctx = { db: makeLifecycleEventDb(db, db) };
  await ctx.db.patch("conversations:c1", { status: "completed" });
  await ctx.db.patch("conversations:c1", { title: "only a title" });
  expect(inserted).toHaveLength(0);
});

test("without a cause the writer's stack is kept", async () => {
  const { db, inserted } = fakeDb({ "conversations:c1": { status: "active" } });
  const ctx = { db: makeLifecycleEventDb(db, db) };
  await ctx.db.patch("conversations:c1", { status: "completed" });
  expect(inserted[0].cause).toBeUndefined();
  expect(inserted[0].stack).toContain("lifecycleEvents.test");
});

test("a pending message ending cancelled is recorded under its conversation", async () => {
  const { db, inserted } = fakeDb({ "pending_messages:m1": { status: "pending", conversation_id: "conversations:c1" } });
  const ctx = { db: makeLifecycleEventDb(db, db) };
  noteWriteCause(ctx, "killSession");
  await ctx.db.patch("pending_messages:m1", { status: "cancelled" });
  expect(inserted[0]).toMatchObject({ conversation_id: "conversations:c1", kind: "message_cancelled", cause: "killSession" });
});

test("deleting a conversation or its managed session is recorded", async () => {
  const { db, inserted } = fakeDb({
    "conversations:c1": { status: "active" },
    "managed_sessions:s1": { conversation_id: "conversations:c1", session_id: "sid" },
  });
  const ctx = { db: makeLifecycleEventDb(db, db) };
  await ctx.db.delete("managed_sessions:s1");
  await ctx.db.delete("conversations:c1");
  expect(inserted.map((e) => e.kind)).toEqual(["managed_session_deleted", "deleted"]);
});
