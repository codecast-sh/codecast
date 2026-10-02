import { expect, test } from "bun:test";
import schema from "./schema";
import { makeFakeDb, schemaIndexes } from "./testDb";

test("normalizeId recognizes late fixture rows and retains table identity after deletion", async () => {
  const db = makeFakeDb({ conversations: [{ _id: "initial" }] });
  db._tables.conversations.push({ _id: "late" });
  for (const id of ["initial", "late", await db.insert("conversations", {})]) {
    expect(db.normalizeId("conversations", id)).toBe(id);
    expect(db.normalizeId("users", id)).toBeNull();
    await db.delete(id);
    expect(await db.get(id)).toBeNull();
    expect(db.normalizeId("conversations", id)).toBe(id);
    expect(db.normalizeId("users", id)).toBeNull();
  }
  expect(db.normalizeId("conversations", "unknown")).toBeNull();
});

// With the schema's indexes (the multiplayer sim's db), reads follow the named
// index the way prod does, not a heuristic time key.
const INDEXES = schemaIndexes(schema);
const indexedDb = (tables: Record<string, any[]>) => {
  let t = 1000;
  let n = 0;
  return makeFakeDb(tables, { indexes: INDEXES, creationTime: () => t++, mintId: (table) => `${table}_${++n}` });
};

test("order follows the named index: by_user_updated is newest updated, not newest created", async () => {
  const db = indexedDb({ tasks: [] });
  const old = await db.insert("tasks", { user_id: "u", created_at: 1, updated_at: 30 });
  const mid = await db.insert("tasks", { user_id: "u", created_at: 2, updated_at: 10 });
  const fresh = await db.insert("tasks", { user_id: "u", created_at: 3, updated_at: 20 });
  const desc = await db.query("tasks").withIndex("by_user_updated", (q: any) => q.eq("user_id", "u")).order("desc").take(3);
  expect(desc.map((r: any) => r._id)).toEqual([old, fresh, mid]);
  // No order() is ascending index order, not insertion order.
  const asc = await db.query("tasks").withIndex("by_user_updated", (q: any) => q.eq("user_id", "u")).collect();
  expect(asc.map((r: any) => r._id)).toEqual([mid, fresh, old]);
  // No index reads by_creation_time.
  expect((await db.query("tasks").order("desc").collect()).map((r: any) => r._id)).toEqual([fresh, mid, old]);
});

test("an unknown index, or an eq or range out of field order, throws as in prod", () => {
  const db = indexedDb({ tasks: [] });
  expect(() => db.query("tasks").withIndex("by_nothing", (q: any) => q.eq("user_id", "u"))).toThrow(/no index by_nothing/);
  expect(() => db.query("tasks").withIndex("by_user_updated", (q: any) => q.eq("updated_at", 1))).toThrow(/cannot take eq/);
  expect(() => db.query("tasks").withIndex("by_user_updated", (q: any) => q.gt("user_id", "a").eq("updated_at", 1))).toThrow(/cannot take eq/);
  expect(() => db.query("tasks").withIndex("by_user_updated", (q: any) => q.gt("updated_at", 1))).toThrow(/cannot take a range/);
  expect(() => db.query("tasks").withIndex("by_user_updated", (q: any) => q.eq("user_id", "u").gt("updated_at", 1).lt("updated_at", 9))).not.toThrow();
});

test("paginate cursors carry the last key, so a row written between pages neither repeats nor skips one", async () => {
  const db = indexedDb({ tasks: [] });
  for (const updated_at of [10, 20, 30, 40]) await db.insert("tasks", { user_id: "u", updated_at });
  const page = (cursor: string | null) =>
    db.query("tasks").withIndex("by_user_updated", (q: any) => q.eq("user_id", "u")).order("desc").paginate({ numItems: 2, cursor });
  const first = await page(null);
  expect(first.page.map((r: any) => r.updated_at)).toEqual([40, 30]);
  expect(first.isDone).toBe(false);
  // Lands ahead of the cursor: an offset cursor would hand 30 back again.
  await db.insert("tasks", { user_id: "u", updated_at: 50 });
  const second = await page(first.continueCursor);
  expect(second.page.map((r: any) => r.updated_at)).toEqual([20, 10]);
  expect(second.isDone).toBe(true);
  // Lands behind it: the next page reaches it.
  await db.insert("tasks", { user_id: "u", updated_at: 5 });
  const third = await page(second.continueCursor);
  expect(third.page.map((r: any) => r.updated_at)).toEqual([5]);
});
