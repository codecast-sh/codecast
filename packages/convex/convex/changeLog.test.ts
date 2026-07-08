import { describe, expect, test } from "bun:test";
import {
  scopeFromDoc,
  patchNeedsDocRead,
  trackedTableOf,
  makeChangeTrackedDb,
} from "./changeLog";

// Minimal in-memory stand-in for the Convex DatabaseWriter surface the
// interceptor touches. Ids are "<table>:<n>" so normalizeId is a prefix check and
// get/patch/delete can find the owning table without a registry.
function makeFakeDb() {
  const tables = new Map<string, Map<string, any>>();
  let counter = 0;
  const tableOf = (id: any) => String(id).split(":")[0];
  const ensure = (t: string) => {
    if (!tables.has(t)) tables.set(t, new Map());
    return tables.get(t)!;
  };
  const db: any = {
    async insert(table: string, doc: any) {
      const id = `${table}:${++counter}`;
      ensure(table).set(id, { _id: id, ...doc });
      return id;
    },
    async get(id: any) {
      if (id == null) return null;
      return ensure(tableOf(id)).get(String(id)) ?? null;
    },
    async patch(id: any, fields: any) {
      const m = ensure(tableOf(id));
      const cur = m.get(String(id));
      if (cur) m.set(String(id), { ...cur, ...fields });
    },
    async replace(id: any, doc: any) {
      ensure(tableOf(id)).set(String(id), { _id: id, ...doc });
    },
    async delete(id: any) {
      ensure(tableOf(id)).delete(String(id));
    },
    normalizeId(table: string, id: any) {
      return tableOf(id) === table ? id : null;
    },
    query(table: string) {
      let rows = [...ensure(table).values()];
      const api: any = {
        withIndex(_name: string, fn: (q: any) => any) {
          const preds: Array<[string, any]> = [];
          const q: any = { eq: (f: string, v: any) => { preds.push([f, v]); return q; } };
          fn(q);
          rows = rows.filter((r) => preds.every(([f, v]) => r[f] === v));
          return api;
        },
        order() { return api; },
        async first() { return rows[0] ?? null; },
        async take(n: number) { return rows.slice(0, n); },
        async collect() { return rows; },
      };
      return api;
    },
  };
  return { db, changeRows: () => [...ensure("change_log").values()] };
}

describe("scopeFromDoc", () => {
  test("extracts owner + team, stringified", () => {
    expect(scopeFromDoc({ user_id: "users:1", team_id: "teams:9" })).toEqual({
      owner_user_id: "users:1",
      team_id: "teams:9",
    });
  });
  test("team is undefined when absent", () => {
    expect(scopeFromDoc({ user_id: "users:1" })).toEqual({ owner_user_id: "users:1", team_id: undefined });
  });
  test("null doc yields no owner (delete of an already-gone row)", () => {
    expect(scopeFromDoc(null)).toEqual({ owner_user_id: undefined, team_id: undefined });
  });
});

describe("patchNeedsDocRead", () => {
  test("needs a read when no prior row exists (first sight)", () => {
    expect(patchNeedsDocRead({ title: "x" }, false)).toBe(true);
  });
  test("needs a read when the patch could move scope", () => {
    expect(patchNeedsDocRead({ team_id: "teams:2" }, true)).toBe(true);
    expect(patchNeedsDocRead({ user_id: "users:2" }, true)).toBe(true);
  });
  test("reuses the existing row's scope for an ordinary field change (hot path)", () => {
    expect(patchNeedsDocRead({ inbox_dismissed_at: 123 }, true)).toBe(false);
    expect(patchNeedsDocRead({ message_count: 5 }, true)).toBe(false);
  });
});

describe("trackedTableOf", () => {
  const db = makeFakeDb().db;
  test("identifies each tracked table from an id", () => {
    expect(trackedTableOf(db, "conversations:1")).toBe("conversations");
    expect(trackedTableOf(db, "tasks:1")).toBe("tasks");
    expect(trackedTableOf(db, "docs:1")).toBe("docs");
    expect(trackedTableOf(db, "plans:1")).toBe("plans");
  });
  test("returns null for untracked ids", () => {
    expect(trackedTableOf(db, "messages:1")).toBeNull();
    expect(trackedTableOf(db, "users:1")).toBeNull();
  });
});

describe("makeChangeTrackedDb — emission", () => {
  test("insert into a tracked table emits one upsert row with scope", async () => {
    const { db, changeRows } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db);
    const id = await tdb.insert("conversations", { user_id: "users:1", team_id: "teams:9", status: "active" });
    const rows = changeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entity_type: "conversations",
      entity_id: String(id),
      op: "upsert",
      owner_user_id: "users:1",
      team_id: "teams:9",
    });
    expect(typeof rows[0].seq).toBe("number");
  });

  test("insert into an UNtracked table emits nothing", async () => {
    const { db, changeRows } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db);
    await tdb.insert("messages", { user_id: "users:1", content: "hi" });
    expect(changeRows()).toHaveLength(0);
  });

  test("repeated writes to one entity upsert a SINGLE row (bounded by entity count)", async () => {
    const { db, changeRows } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db);
    const id = await tdb.insert("tasks", { user_id: "users:1", status: "open" });
    await tdb.patch(id, { status: "in_progress" });
    await tdb.patch(id, { status: "done" });
    const rows = changeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe("upsert");
    expect(rows[0].entity_id).toBe(String(id));
  });

  test("a dismiss-style patch (no scope fields) still emits — the gap the feed closes", async () => {
    const { db, changeRows } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db);
    const id = await tdb.insert("conversations", { user_id: "users:1", status: "active" });
    // The kind of write that does NOT bump updated_at and so an updated_at delta
    // would miss — the original bug.
    await tdb.patch(id, { inbox_dismissed_at: 123456 });
    const rows = changeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: "upsert", owner_user_id: "users:1" });
  });

  test("delete emits an op:delete tombstone with the pre-delete scope", async () => {
    const { db, changeRows } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db);
    const id = await tdb.insert("docs", { user_id: "users:1", team_id: "teams:3" });
    await tdb.delete(id);
    const rows = changeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: "docs", op: "delete", owner_user_id: "users:1", team_id: "teams:3" });
    // And the entity itself is gone.
    expect(await db.get(id)).toBeNull();
  });

  test("a team reassignment patch refreshes the recorded team scope", async () => {
    const { db, changeRows } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db);
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:1", status: "open" });
    await tdb.patch(id, { team_id: "teams:2" });
    const rows = changeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].team_id).toBe("teams:2");
  });

  test("untracked patch/delete never touch the change log", async () => {
    const { db, changeRows } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db);
    const id = await tdb.insert("messages", { user_id: "users:1" });
    await tdb.patch(id, { content: "x" });
    await tdb.delete(id);
    expect(changeRows()).toHaveLength(0);
  });
});
