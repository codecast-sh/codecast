import { describe, expect, test } from "bun:test";
import { makeChangeTrackedDb } from "./changeLog";
import {
  appendSyncAction,
  emitSyncActions,
  makeSyncAckCollector,
  scopesForChange,
  teamScopeKey,
  userScopeKey,
} from "./syncLog";
import { floorAdvances } from "./syncLogPrune";

// Same fake-DatabaseWriter convention as changeLog.test.ts: ids are
// "<table>:<n>" so normalizeId is a prefix check. Extended with the index
// operators the sync log uses (gt/lt, unique, position ordering).
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
          const preds: Array<[string, (v: any) => boolean]> = [];
          const q: any = {
            eq: (f: string, v: any) => { preds.push([f, (x) => x === v]); return q; },
            gt: (f: string, v: any) => { preds.push([f, (x) => x > v]); return q; },
            lt: (f: string, v: any) => { preds.push([f, (x) => x < v]); return q; },
          };
          fn(q);
          rows = rows.filter((r) => preds.every(([f, ok]) => ok(r[f])));
          return api;
        },
        order(dir?: string) {
          rows = [...rows].sort((a, b) =>
            dir === "desc" ? b.position - a.position : a.position - b.position);
          return api;
        },
        async first() { return rows[0] ?? null; },
        async unique() {
          if (rows.length > 1) throw new Error("unique() found more than one row");
          return rows[0] ?? null;
        },
        async take(n: number) { return rows.slice(0, n); },
        async collect() { return rows; },
      };
      return api;
    },
  };
  const actions = (scope?: string) => {
    const all = [...ensure("sync_actions").values()].sort((a, b) => a.position - b.position);
    return scope ? all.filter((r) => r.scope_key === scope) : all;
  };
  const head = (scope: string) =>
    [...ensure("sync_heads").values()].find((h) => h.scope_key === scope) ?? null;
  return { db, actions, head };
}

describe("scopesForChange", () => {
  test("tasks land in owner and team scopes", () => {
    expect(scopesForChange("tasks", { owner_user_id: "users:1", team_id: "teams:9" }))
      .toEqual(["user:users:1", "team:teams:9"]);
  });
  test("conversations are owner-only even with a team", () => {
    expect(scopesForChange("conversations", { owner_user_id: "users:1", team_id: "teams:9" }))
      .toEqual(["user:users:1"]);
  });
  test("no owner means no scopes (already-gone row)", () => {
    expect(scopesForChange("tasks", { owner_user_id: undefined, team_id: "teams:9" })).toEqual([]);
  });
});

describe("appendSyncAction — ordering and coalescing", () => {
  test("positions are strictly increasing per scope in append order", async () => {
    const { db, actions, head } = makeFakeDb();
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:2", "upsert");
    await appendSyncAction(db, null, "user:u1", "docs", "docs:1", "upsert");
    expect(actions("user:u1").map((r) => r.position)).toEqual([1, 2, 3]);
    expect(head("user:u1")?.position).toBe(3);
  });

  test("scopes have independent counters", async () => {
    const { db, head } = makeFakeDb();
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
    await appendSyncAction(db, null, "team:t1", "tasks", "tasks:1", "upsert");
    expect(head("user:u1")?.position).toBe(1);
    expect(head("team:t1")?.position).toBe(1);
  });

  test("a re-written entity MOVES its row to the new head instead of appending", async () => {
    const { db, actions, head } = makeFakeDb();
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:2", "upsert");
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert"); // separate txn
    const rows = actions("user:u1");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.entity_id, r.position])).toEqual([
      ["tasks:2", 2],
      ["tasks:1", 3],
    ]);
    expect(head("user:u1")?.position).toBe(3);
  });

  test("a reader whose cursor already passed the entity sees it again after the move", async () => {
    const { db, actions } = makeFakeDb();
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert"); // pos 1
    const cursorAfterFirstApply = 1;
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert"); // moves to 2
    const unseen = actions("user:u1").filter((r) => r.position > cursorAfterFirstApply);
    expect(unseen.map((r) => r.entity_id)).toEqual(["tasks:1"]);
  });

  test("delete flips the entity's active row in place at the new head", async () => {
    const { db, actions } = makeFakeDb();
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "upsert");
    await appendSyncAction(db, null, "user:u1", "tasks", "tasks:1", "delete");
    const rows = actions("user:u1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_id: "tasks:1", op: "delete", position: 2 });
  });

  test("scope lifecycle actions always insert (never coalesce with entity rows)", async () => {
    const { db, actions } = makeFakeDb();
    await appendSyncAction(db, null, "user:u1", "scope", "teams:9", "scope_added");
    await appendSyncAction(db, null, "user:u1", "scope", "teams:9", "scope_removed");
    expect(actions("user:u1").map((r) => r.op)).toEqual(["scope_added", "scope_removed"]);
  });

  test("collector dedupes repeated identical appends within one transaction", async () => {
    const { db, actions } = makeFakeDb();
    const collector = makeSyncAckCollector();
    await appendSyncAction(db, collector, "user:u1", "tasks", "tasks:1", "upsert");
    await appendSyncAction(db, collector, "user:u1", "tasks", "tasks:1", "upsert");
    expect(actions("user:u1")).toHaveLength(1);
    expect(collector.positions).toEqual([{ scope_key: "user:u1", position: 1 }]);
  });
});

describe("emitSyncActions — scope moves", () => {
  test("moving a task between teams revokes in the departed scope", async () => {
    const { db, actions } = makeFakeDb();
    await emitSyncActions(db, null, "tasks", "tasks:1", "upsert",
      { owner_user_id: "users:1", team_id: "teams:a" });
    await emitSyncActions(db, null, "tasks", "tasks:1", "upsert",
      { owner_user_id: "users:1", team_id: "teams:b" },
      { owner_user_id: "users:1", team_id: "teams:a" });
    const departed = actions(teamScopeKey("teams:a"));
    expect(departed).toHaveLength(1);
    expect(departed[0].op).toBe("delete");
    const entered = actions(teamScopeKey("teams:b"));
    expect(entered).toHaveLength(1);
    expect(entered[0].op).toBe("upsert");
    // Owner scope keeps one moved upsert row.
    const owner = actions(userScopeKey("users:1"));
    expect(owner).toHaveLength(1);
    expect(owner[0].op).toBe("upsert");
  });

  test("unchanged scope emits no revocation", async () => {
    const { db, actions } = makeFakeDb();
    await emitSyncActions(db, null, "tasks", "tasks:1", "upsert",
      { owner_user_id: "users:1", team_id: "teams:a" },
      { owner_user_id: "users:1", team_id: "teams:a" });
    expect(actions(teamScopeKey("teams:a")).map((r) => r.op)).toEqual(["upsert"]);
  });
});

describe("makeChangeTrackedDb — dual emission through the interceptor", () => {
  test("tracked insert dual-writes change_log and the sync log with a collected position", async () => {
    const { db, actions } = makeFakeDb();
    const collector = makeSyncAckCollector();
    const tdb = makeChangeTrackedDb(db, collector);
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:9" });
    expect(actions(userScopeKey("users:1")).map((r) => r.entity_id)).toEqual([String(id)]);
    expect(actions(teamScopeKey("teams:9")).map((r) => r.entity_id)).toEqual([String(id)]);
    expect(collector.positions).toEqual([
      { scope_key: "user:users:1", position: 1 },
      { scope_key: "team:teams:9", position: 1 },
    ]);
  });

  test("patch that moves team emits revocation in the departed team scope", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:a" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector()); // fresh txn
    await tdb2.patch(id, { team_id: "teams:b" });
    const departed = actions(teamScopeKey("teams:a"));
    expect(departed).toHaveLength(1);
    expect(departed[0].op).toBe("delete");
    expect(actions(teamScopeKey("teams:b")).map((r) => r.op)).toEqual(["upsert"]);
  });

  test("ordinary field patch stays in-scope and just moves the row forward", async () => {
    const { db, actions, head } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("conversations", { user_id: "users:1" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { message_count: 5 });
    const tdb3 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb3.patch(id, { message_count: 6 });
    const rows = actions(userScopeKey("users:1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe(3);
    expect(head(userScopeKey("users:1"))?.position).toBe(3);
  });

  test("delete emits a delete action in every visible scope", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("docs", { user_id: "users:1", team_id: "teams:9" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.delete(id);
    expect(actions(userScopeKey("users:1")).map((r) => r.op)).toEqual(["delete"]);
    expect(actions(teamScopeKey("teams:9")).map((r) => r.op)).toEqual(["delete"]);
  });

  test("membership insert/delete emits scope lifecycle actions in the member's scope", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const mid = await tdb.insert("team_memberships", { user_id: "users:7", team_id: "teams:9", role: "member" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.delete(mid);
    expect(actions(userScopeKey("users:7")).map((r) => [r.entity_type, r.op])).toEqual([
      ["scope", "scope_added"],
      ["scope", "scope_removed"],
    ]);
  });

  test("conversations never emit into the team scope", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb.insert("conversations", { user_id: "users:1", team_id: "teams:9" });
    expect(actions(teamScopeKey("teams:9"))).toHaveLength(0);
    expect(actions(userScopeKey("users:1"))).toHaveLength(1);
  });
});

describe("floorAdvances", () => {
  test("keeps the max pruned position per scope", () => {
    const advances = floorAdvances([
      { scope_key: "user:u1", position: 3 },
      { scope_key: "user:u1", position: 7 },
      { scope_key: "team:t1", position: 2 },
    ]);
    expect(advances.get("user:u1")).toBe(7);
    expect(advances.get("team:t1")).toBe(2);
  });
});
