import { describe, expect, test } from "bun:test";
import { makeChangeTrackedDb } from "./changeLog";
import {
  appendSyncAction,
  readRangePage,
  buildCargo,
  mergeCargo,
  accessStampFromDoc,
  authorizedFor,
  projectAction,
  CARGO_MAX_BYTES,
  cargoBytes,
  RANGE_PAGE_MAX_BYTES,
  emitSyncActions,
  isChurnOnlyPatch,
  makeSyncAckCollector,
  scopesForChange,
  teamScopeKey,
  userScopeKey,
} from "./syncLog";
import { prunablePrefix } from "./syncLogPrune";
import { canAccessTask, heldKeysFor } from "./lib/access";

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
      if (!cur) return;
      // Mirror Convex: a patch value of undefined UNSETS the key.
      const next: any = { ...cur };
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) delete next[k]; else next[k] = v;
      }
      m.set(String(id), next);
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

describe("scopesForChange (access-derived fan-out)", () => {
  test("tasks land in owner + the WORKSPACE team + the assignee's scope", () => {
    expect(scopesForChange("tasks", { owner_user_id: "users:1", team_id: "teams:9", workspace: "team:teams:9", assignee: "users:2" }))
      .toEqual(["user:users:1", "team:teams:9", "user:users:2"]);
  });
  test("private inside a team (team_id set, workspace user:owner) never enters the team scope", () => {
    expect(scopesForChange("docs", { owner_user_id: "users:1", team_id: "teams:9", workspace: "user:users:1" }))
      .toEqual(["user:users:1"]);
  });
  test("a task assigned to me with no team reaches me through my user scope", () => {
    expect(scopesForChange("tasks", { owner_user_id: "users:1", workspace: "user:users:1", assignee: "users:7" }))
      .toEqual(["user:users:1", "user:users:7"]);
  });
  test("conversations are owner-only even with a team", () => {
    expect(scopesForChange("conversations", { owner_user_id: "users:1", team_id: "teams:9", workspace: "team:teams:9" }))
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
      { owner_user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a" });
    await emitSyncActions(db, null, "tasks", "tasks:1", "upsert",
      { owner_user_id: "users:1", team_id: "teams:b", workspace: "team:teams:b" },
      { owner_user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a" });
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
      { owner_user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a" },
      { owner_user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a" });
    expect(actions(teamScopeKey("teams:a")).map((r) => r.op)).toEqual(["upsert"]);
  });
});

describe("makeChangeTrackedDb — dual emission through the interceptor", () => {
  test("tracked insert dual-writes change_log and the sync log with a collected position", async () => {
    const { db, actions } = makeFakeDb();
    const collector = makeSyncAckCollector();
    const tdb = makeChangeTrackedDb(db, collector);
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:9", workspace: "team:teams:9" });
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
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector()); // fresh txn
    await tdb2.patch(id, { team_id: "teams:b", workspace: "team:teams:b" });
    const departed = actions(teamScopeKey("teams:a"));
    expect(departed).toHaveLength(1);
    expect(departed[0].op).toBe("delete");
    expect(actions(teamScopeKey("teams:b")).map((r) => r.op)).toEqual(["upsert"]);
  });

  test("ordinary semantic patch stays in-scope and just moves the row forward", async () => {
    const { db, actions, head } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("conversations", { user_id: "users:1" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { title: "one" });
    const tdb3 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb3.patch(id, { inbox_dismissed_at: 42 });
    const rows = actions(userScopeKey("users:1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toBe(3);
    expect(head(userScopeKey("users:1"))?.position).toBe(3);
  });

  test("delete emits a delete action in every visible scope", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("docs", { user_id: "users:1", team_id: "teams:9", workspace: "team:teams:9" });
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
    await tdb.insert("conversations", { user_id: "users:1", team_id: "teams:9", workspace: "team:teams:9" });
    expect(actions(teamScopeKey("teams:9"))).toHaveLength(0);
    expect(actions(userScopeKey("users:1"))).toHaveLength(1);
  });
});

describe("churn exemption (design D1)", () => {
  test("counter/liveness-only conversation patches emit no sync action", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("conversations", { user_id: "users:1" });
    const before = actions(userScopeKey("users:1"));
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { message_count: 7, updated_at: 123, last_heartbeat: 456 });
    const after = actions(userScopeKey("users:1"));
    expect(after).toEqual(before); // no move, no append
  });

  test("a mixed patch (churn + semantic field) still emits", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("conversations", { user_id: "users:1" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { message_count: 7, inbox_dismissed_at: 999 });
    expect(actions(userScopeKey("users:1"))[0].position).toBe(2);
  });

  test("isChurnOnlyPatch: only listed tables, only full-churn key sets", () => {
    expect(isChurnOnlyPatch("conversations", { message_count: 1 })).toBe(true);
    expect(isChurnOnlyPatch("conversations", { message_count: 1, title: "x" })).toBe(false);
    expect(isChurnOnlyPatch("conversations", {})).toBe(false);
    expect(isChurnOnlyPatch("tasks", { updated_at: 1 })).toBe(false);
  });
});

describe("kill switch", () => {
  test("SYNC_LOG_DISABLED=1 stops emission without touching change_log", async () => {
    const prev = process.env.SYNC_LOG_DISABLED;
    process.env.SYNC_LOG_DISABLED = "1";
    try {
      const { db, actions } = makeFakeDb();
      const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
      await tdb.insert("tasks", { user_id: "users:1" });
      expect(actions()).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.SYNC_LOG_DISABLED;
      else process.env.SYNC_LOG_DISABLED = prev;
    }
  });
});

describe("scope-move sequences (review majors)", () => {
  test("move + unrelated patch in ONE transaction keeps the revocation", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("docs", { user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { team_id: "teams:b", workspace: "team:teams:b" });
    await tdb2.patch(id, { title: "renamed" });
    expect(actions(teamScopeKey("teams:a")).map((r) => r.op)).toEqual(["delete"]);
    expect(actions(teamScopeKey("teams:b")).map((r) => r.op)).toEqual(["upsert"]);
    expect(actions(userScopeKey("users:1")).map((r) => r.op)).toEqual(["upsert"]);
  });

  test("double move T1→T2→T3 leaves revocations in both departed scopes", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("docs", { user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { team_id: "teams:b", workspace: "team:teams:b" });
    const tdb3 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb3.patch(id, { team_id: "teams:c", workspace: "team:teams:c" });
    expect(actions(teamScopeKey("teams:a")).map((r) => r.op)).toEqual(["delete"]);
    expect(actions(teamScopeKey("teams:b")).map((r) => r.op)).toEqual(["delete"]);
    expect(actions(teamScopeKey("teams:c")).map((r) => r.op)).toEqual(["upsert"]);
  });
});

describe("prunablePrefix (retention prefix walk)", () => {
  test("deletes the old prefix and stops at the first young row", () => {
    const { toDelete, stoppedEarly } = prunablePrefix(
      [{ ts: 1 }, { ts: 2 }, { ts: 100 }, { ts: 3 }],
      50,
    );
    expect(toDelete).toEqual([{ ts: 1 }, { ts: 2 }]);
    expect(stoppedEarly).toBe(true);
  });
  test("consumes the whole page when everything is old", () => {
    const { toDelete, stoppedEarly } = prunablePrefix([{ ts: 1 }, { ts: 2 }], 50);
    expect(toDelete).toHaveLength(2);
    expect(stoppedEarly).toBe(false);
  });
  test("empty page is not an early stop", () => {
    const { toDelete, stoppedEarly } = prunablePrefix([], 50);
    expect(toDelete).toHaveLength(0);
    expect(stoppedEarly).toBe(false);
  });
});

describe("allocatePosition — sub-mutation safety (review C2)", () => {
  test("a second collector's bump between a parent's writes never mints a duplicate position", async () => {
    const { db, actions, head } = makeFakeDb();
    const parent = makeSyncAckCollector();
    // Parent writes (caches head at position 1).
    await appendSyncAction(db, parent, "user:u1", "tasks", "tasks:1", "upsert");
    // Sub-mutation with its OWN collector bumps the same scope (same txn, same db).
    const child = makeSyncAckCollector();
    await appendSyncAction(db, child, "user:u1", "tasks", "tasks:2", "upsert");
    // Parent writes again from its (stale) cache — must re-read, not reuse.
    await appendSyncAction(db, parent, "user:u1", "docs", "docs:1", "upsert");
    const positions = actions("user:u1").map((r) => r.position).sort((a, b) => a - b);
    expect(positions).toEqual([1, 2, 3]); // no duplicates
    expect(head("user:u1")?.position).toBe(3);
  });
});

describe("readRangePage (review C19)", () => {
  const seed = async (db: any, n: number) => {
    for (let i = 1; i <= n; i++) {
      await appendSyncAction(db, null, "user:u1", "tasks", `tasks:${i}`, "upsert");
    }
  };
  test("pages ascending with hasMore and nextFrom", async () => {
    const { db } = makeFakeDb();
    await seed(db, 5);
    const p1 = await readRangePage(db, "user:u1", 0, 2);
    expect(p1.actions.map((a) => a.position)).toEqual([1, 2]);
    expect(p1.hasMore).toBe(true);
    expect(p1.nextFrom).toBe(2);
    const p2 = await readRangePage(db, "user:u1", p1.nextFrom, 100);
    expect(p2.actions.map((a) => a.position)).toEqual([3, 4, 5]);
    expect(p2.hasMore).toBe(false);
    expect(p2.nextFrom).toBe(5);
  });
  test("floor above the cursor returns resync", async () => {
    const { db, head } = makeFakeDb();
    await seed(db, 3);
    const h = head("user:u1");
    h.floor = 2;
    expect((await readRangePage(db, "user:u1", 1, 10)).resync).toBe(true);
    // Cursor exactly at the floor is fine (floor rows are deleted, gt(floor) is the range).
    expect((await readRangePage(db, "user:u1", 2, 10)).resync).toBeUndefined();
  });
  test("empty scope with no head is caught up at 0", async () => {
    const { db } = makeFakeDb();
    const r = await readRangePage(db, "user:u1", 0, 10);
    expect(r).toMatchObject({ actions: [], nextFrom: 0, hasMore: false });
  });
});

// ── Cargo (sync-log-cargo E1–E4) ─────────────────────────────────────────────

describe("buildCargo", () => {
  test("carries top-level fields, turns undefined into unset, drops system fields", () => {
    expect(buildCargo("tasks", { _id: "x", title: "t", status: undefined }, { full: false }))
      .toEqual({ patch: { title: "t" }, unset: ["status"], full: undefined, partial: undefined });
  });
  test("denylisted (OMIT-class) fields are dropped silently with their names recorded — never partial", () => {
    const c = buildCargo("docs", { title: "d", content: "big body", team_id: "teams:1" }, { full: false });
    expect(c.patch).toEqual({ title: "d" });
    expect(c.partial).toBeUndefined();
    expect(c.omitted!.sort()).toEqual(["content", "team_id"]);
  });
  test("churn-exempt fields never ride cargo, even inside a semantic patch", () => {
    const c = buildCargo("conversations", { pending_api_error: true, last_message_preview: "A", model: "x" }, { full: false });
    expect(c.patch).toEqual({ pending_api_error: true });
  });
  test("oversized patch drops cargo to partial", () => {
    const c = buildCargo("tasks", { description: "x".repeat(CARGO_MAX_BYTES + 1) }, { full: false });
    expect(c.patch).toBeUndefined();
    expect(c.partial).toBe(true);
  });
  test("full flag rides through", () => {
    expect(buildCargo("projects", { title: "p" }, { full: true }).full).toBe(true);
  });
  test("kill switch strips cargo but keeps the action honest (partial)", () => {
    const prev = process.env.SYNC_LOG_PAYLOADS_DISABLED;
    process.env.SYNC_LOG_PAYLOADS_DISABLED = "1";
    try { expect(buildCargo("tasks", { title: "t" }, { full: false })).toEqual({ partial: true }); }
    finally { if (prev === undefined) delete process.env.SYNC_LOG_PAYLOADS_DISABLED; else process.env.SYNC_LOG_PAYLOADS_DISABLED = prev; }
  });
});

describe("mergeCargo (coalesce merge, E2)", () => {
  test("later fields overlay, unset removes, re-set clears unset", () => {
    const a = { patch: { title: "a", status: "open" } };
    const b = { patch: { status: "done" }, unset: ["title"] };
    const ab = mergeCargo(a, b);
    expect(ab.patch).toEqual({ status: "done" });
    expect(ab.unset).toEqual(["title"]);
    const c = { patch: { title: "c" } };
    const abc = mergeCargo(ab, c);
    expect(abc.patch).toEqual({ status: "done", title: "c" });
    expect(abc.unset).toBeUndefined();
  });
  test("set → unset → set converges to the same row for every reader (idempotent merge)", () => {
    const steps = [{ patch: { x: 1 } }, { unset: ["x"], patch: {} }, { patch: { x: 3 } }];
    const merged = steps.reduce((acc: any, s) => mergeCargo(acc, s), null);
    // A reader at cursor 0 applies merged; a reader at cursor 2 applies step 3 — same end state.
    const applyTo = (row: any, c: any) => { const r = { ...row, ...(c.patch ?? {}) }; for (const k of c.unset ?? []) delete r[k]; return r; };
    expect(applyTo({}, merged)).toEqual({ x: 3 });
    expect(applyTo(applyTo(applyTo({}, steps[0]), steps[1]), steps[2])).toEqual({ x: 3 });
  });
  test("a full cargo replaces whatever came before (including a prior partial)", () => {
    // The accumulated unset names ride along: a reader whose base still holds
    // `b` must learn it is gone, and a full patch cannot say so by itself.
    expect(mergeCargo({ patch: { a: 1 }, unset: ["b"], partial: true }, { patch: { c: 3 }, full: true }))
      .toEqual({ patch: { c: 3 }, full: true, unset: ["b"] });
  });
  test("a full cargo drops carried unset names its own patch re-sets (review)", () => {
    expect(mergeCargo({ patch: { a: 1 }, unset: ["b", "d"] }, { patch: { b: 2 }, full: true }))
      .toEqual({ patch: { b: 2 }, full: true, unset: ["d"] });
  });
  test("partial is sticky even when the next cargo carries a patch (review blocker)", () => {
    const m = mergeCargo({ partial: true }, { patch: { b: 2 } });
    expect(m.partial).toBe(true);
    expect(m.patch).toEqual({ b: 2 });
  });
  test("an incoming cargo without a patch poisons the row to partial", () => {
    const m = mergeCargo({ patch: { a: 1 } }, { partial: true });
    expect(m.patch).toBeUndefined();
    expect(m.partial).toBe(true);
  });
  test("partial is sticky across merges until a full cargo", () => {
    const m = mergeCargo({ patch: { a: 1 }, partial: true }, { patch: { b: 2 } });
    expect(m.partial).toBe(true);
    expect(mergeCargo(m, { patch: { z: 1 }, full: true }).partial).toBeUndefined();
  });
});

describe("access stamp + projection (E4)", () => {
  test("stamp: owner always, workspace key for scoped tables, assignee grant for tasks, none for conversations", () => {
    expect(accessStampFromDoc("tasks", { user_id: "u1", workspace: "team:T", assignee: "u2" }))
      .toEqual({ access_owner: "u1", access_key: "team:T", access_grants: ["u2"] });
    expect(accessStampFromDoc("conversations", { user_id: "u1", workspace: "team:T" }))
      .toEqual({ access_owner: "u1" });
    expect(accessStampFromDoc("docs", null)).toBeNull();
  });
  test("authorizedFor: owner, grant, held key; pre-cargo rows pass", () => {
    const held = new Set(["user:u9", "team:T"]);
    expect(authorizedFor({ access_owner: "u1", access_key: "team:T" }, "u9", held)).toBe(true);
    expect(authorizedFor({ access_owner: "u1", access_key: "user:u1" }, "u9", held)).toBe(false);
    expect(authorizedFor({ access_owner: "u1", access_key: "user:u1", access_grants: ["u9"] }, "u9", held)).toBe(true);
    expect(authorizedFor({ access_owner: "u9", access_key: "user:u9" }, "u9", new Set())).toBe(true);
    expect(authorizedFor({}, "u9", new Set())).toBe(false); // fail closed
  });
  test("projectAction: a stampless upsert ships no cargo; cargo rides only on opt-in", () => {
    const stampless = { position: 1, entity_type: "tasks", entity_id: "t", op: "upsert", patch: { title: "x" } };
    expect(projectAction(stampless, { userId: "u1", heldKeys: new Set() }).patch).toBeUndefined();
    const stamped = { ...stampless, access_owner: "u1", access_key: "user:u1" };
    expect(projectAction(stamped, { userId: "u1", heldKeys: new Set() }, false).patch).toBeUndefined();
    expect(projectAction(stamped, { userId: "u1", heldKeys: new Set() }, true).patch).toEqual({ title: "x" });
  });
  test("projectAction: unauthorized upsert becomes a bare delete; authorized carries cargo", () => {
    const row = { position: 5, entity_type: "tasks", entity_id: "t1", op: "upsert",
      patch: { title: "secret" }, access_owner: "u1", access_key: "user:u1" };
    expect(projectAction(row, { userId: "u9", heldKeys: new Set(["team:T"]) }))
      .toEqual({ position: 5, entity_type: "tasks", entity_id: "t1", op: "delete" });
    expect(projectAction(row, { userId: "u1", heldKeys: new Set() }).patch).toEqual({ title: "secret" });
  });
});

describe("interceptor cargo end to end", () => {
  test("insert carries a full patch with the access stamp; a later patch merges and keeps the stamp", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:9", workspace: "team:teams:9", title: "a", status: "open" });
    let row = actions(teamScopeKey("teams:9"))[0];
    expect(row.full).toBe(true);
    expect(row.patch).toMatchObject({ title: "a", status: "open" });
    expect(row.access_owner).toBe("users:1");
    expect(row.access_key).toBe("team:teams:9");
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { status: "done" });
    row = actions(teamScopeKey("teams:9"))[0];
    expect(row.patch).toMatchObject({ title: "a", status: "done" });
    expect(row.full).toBe(true);
    expect(row.access_key).toBe("team:teams:9"); // re-read from the post-write doc on every upsert
  });
  test("locking a row private inside a team revokes it from the team scope; the owner keeps it in their own scope", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:9", workspace: "team:teams:9", title: "a" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { workspace: "user:users:1" }); // private inside the team
    const page = await readRangePage(db, teamScopeKey("teams:9"), 0, 10, { userId: "users:7", heldKeys: new Set(["user:users:7", "team:teams:9"]) }, { cargo: true });
    expect(page.actions[0].op).toBe("delete");
    expect((page.actions[0] as any).patch).toBeUndefined();
    const owner = await readRangePage(db, userScopeKey("users:1"), 0, 10, { userId: "users:1", heldKeys: new Set(["user:users:1"]) }, { cargo: true });
    expect(owner.actions[0].op).toBe("upsert");
    expect(owner.actions[0].patch).toMatchObject({ title: "a", workspace: "user:users:1" });
  });
  test("projection guards a STALE stamp too: a team-scope row whose stamp says private reads as delete for members", async () => {
    const row = { position: 1, entity_type: "tasks", entity_id: "t", op: "upsert", patch: { title: "s" },
      access_owner: "users:1", access_key: "user:users:1" };
    expect(projectAction(row, { userId: "users:7", heldKeys: new Set(["team:teams:9"]) }).op).toBe("delete");
  });
  test("delete clears cargo so a later re-insert cannot resurrect stale fields", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("docs", { user_id: "users:1", title: "d", content: "body" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.delete(id);
    const row = actions(userScopeKey("users:1"))[0];
    expect(row.op).toBe("delete");
    expect(row.patch).toBeUndefined();
  });
  test("docs content change ships `omitted: [content]` — no partial, no byIds for life", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("docs", { user_id: "users:1", workspace: "user:users:1", title: "d", content: "v1" });
    const tdb2 = makeChangeTrackedDb(db, makeSyncAckCollector());
    await tdb2.patch(id, { content: "v2" });
    const row = actions(userScopeKey("users:1"))[0];
    expect(row.partial).toBeUndefined();
    expect(row.omitted).toEqual(["content"]);
    expect(row.patch.content).toBeUndefined();
  });
  test("two writes to one entity in one transaction merge cargo without a second position", async () => {
    const { db, actions, head } = makeFakeDb();
    const c = makeSyncAckCollector();
    const tdb = makeChangeTrackedDb(db, c);
    const id = await tdb.insert("tasks", { user_id: "users:1", title: "a" });
    await tdb.patch(id, { status: "done" });
    const rows = actions(userScopeKey("users:1"));
    expect(rows).toHaveLength(1);
    expect(rows[0].patch).toMatchObject({ title: "a", status: "done" });
    expect(head(userScopeKey("users:1"))?.position).toBe(1);
  });
});

// ── Review-driven cases (pl-498 design review) ───────────────────────────────

describe("review: stamps, tombstones, moves", () => {
  test("a delete tombstone clears the stamp; the re-entering upsert is re-stamped from the doc", async () => {
    const { db, actions } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const id = await tdb.insert("tasks", { user_id: "users:1", team_id: "teams:a", workspace: "team:teams:a", title: "x" });
    // Move out of A.
    await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, { team_id: "teams:b", workspace: "team:teams:b" });
    const tomb = actions(teamScopeKey("teams:a"))[0];
    expect(tomb.op).toBe("delete");
    expect(tomb.access_key).toBeUndefined();
    expect(tomb.patch).toBeUndefined();
    // Lock private while in B, then move back to A's routing team — but the
    // workspace stays private, so A's scope never sees an upsert at all.
    await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, { workspace: "user:users:1" });
    await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, { team_id: "teams:a" });
    expect(actions(teamScopeKey("teams:a"))[0].op).toBe("delete");
    // And when it is re-shared to A, the stamp is fresh.
    await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, { workspace: "team:teams:a" });
    const back = actions(teamScopeKey("teams:a"))[0];
    expect(back.op).toBe("upsert");
    expect(back.access_key).toBe("team:teams:a");
  });

  test("assignee change is a scope move: the departed assignee gets a delete, the new one an upsert", async () => {
    const { db, actions } = makeFakeDb();
    const id = await makeChangeTrackedDb(db, makeSyncAckCollector())
      .insert("tasks", { user_id: "users:1", workspace: "user:users:1", assignee: "users:7", title: "t" });
    expect(actions(userScopeKey("users:7")).map((r) => r.op)).toEqual(["upsert"]);
    await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, { assignee: "users:8" });
    expect(actions(userScopeKey("users:7")).map((r) => r.op)).toEqual(["delete"]);
    expect(actions(userScopeKey("users:8")).map((r) => r.op)).toEqual(["upsert"]);
    expect(actions(userScopeKey("users:8"))[0].access_grants).toEqual(["users:8"]);
  });

  test("kill switch window: rows written with cargo off are partial and self-heal to full on the next write", async () => {
    const { db, actions } = makeFakeDb();
    const id = await makeChangeTrackedDb(db, makeSyncAckCollector())
      .insert("tasks", { user_id: "users:1", workspace: "user:users:1", title: "a" });
    process.env.SYNC_LOG_PAYLOADS_DISABLED = "1";
    try {
      await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, { title: "b" });
      const row = actions(userScopeKey("users:1"))[0];
      expect(row.partial).toBe(true);
      expect(row.patch).toBeUndefined();
    } finally { delete process.env.SYNC_LOG_PAYLOADS_DISABLED; }
    await makeChangeTrackedDb(db, makeSyncAckCollector()).patch(id, { status: "done" });
    const healed = actions(userScopeKey("users:1"))[0];
    expect(healed.partial).toBeUndefined();
    expect(healed.full).toBe(true);
    expect(healed.patch).toMatchObject({ title: "b", status: "done" });
  });

  test("oversized merged cargo poisons to partial when the whole doc does not fit either", async () => {
    const { db, actions } = makeFakeDb();
    const big = "x".repeat(CARGO_MAX_BYTES);
    const id = await makeChangeTrackedDb(db, makeSyncAckCollector())
      .insert("tasks", { user_id: "users:1", workspace: "user:users:1", description: big });
    const row = actions(userScopeKey("users:1"))[0];
    expect(row.partial).toBe(true);
    expect(row.patch).toBeUndefined();
  });

  test("readRangePage closes a page at the byte budget and reports hasMore", async () => {
    const { db } = makeFakeDb();
    const tdb = makeChangeTrackedDb(db, makeSyncAckCollector());
    const chunk = "y".repeat(CARGO_MAX_BYTES - 200);
    const n = Math.ceil(RANGE_PAGE_MAX_BYTES / CARGO_MAX_BYTES) + 2;
    for (let i = 0; i < n; i++) {
      await makeChangeTrackedDb(db, makeSyncAckCollector())
        .insert("tasks", { user_id: "users:1", workspace: "user:users:1", description: chunk + i });
    }
    void tdb;
    const page = await readRangePage(db, userScopeKey("users:1"), 0, 1000,
      { userId: "users:1", heldKeys: new Set(["user:users:1"]) }, { cargo: true });
    expect(page.actions.length).toBeLessThan(n);
    expect(page.hasMore).toBe(true);
    expect(cargoBytes({ patch: Object.assign({}, ...page.actions.map((a) => a.patch ?? {})) })).toBeLessThan(RANGE_PAGE_MAX_BYTES + CARGO_MAX_BYTES);
  });

  test("the log's predicate and canAccessTask agree on every generated document and viewer", async () => {
    const { db } = makeFakeDb();
    await db.insert("team_memberships", { user_id: "users:9", team_id: "teams:T" });
    const heldFor = async (u: string) => heldKeysFor({ db } as any, u as any);
    const viewers = ["users:1", "users:9", "users:5"];
    const docs = [
      { user_id: "users:1", workspace: "team:teams:T" },
      { user_id: "users:1", workspace: "user:users:1" },
      { user_id: "users:1", workspace: "user:users:1", assignee: "users:5" },
      { user_id: "users:1", workspace: "restricted:zzz" },
      { user_id: "users:1" },
    ];
    for (const d of docs) for (const v of viewers) {
      const viaLog = authorizedFor(accessStampFromDoc("tasks", d), v, await heldFor(v));
      const viaAccess = await canAccessTask({ db } as any, v as any, d);
      // A doc without a stored key is the one case the pure stamp cannot judge
      // (it needs the lazy compute) — the interceptor resolves it before stamping.
      if (d.workspace !== undefined) expect([d, v, viaLog]).toEqual([d, v, viaAccess]);
    }
  });
});

// ── Source guards (sync-log-cargo E4/E7) ────────────────────────────────────
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("source guards", () => {
  const DIR = import.meta.dir;
  const sources = () => readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  test("access_key is read only by the stamp builder, the projection, the interceptor and the schema", () => {
    const allowed = new Set(["syncLog.ts", "schema.ts", "changeLog.ts"]);
    const offenders = sources().filter((f) => !allowed.has(f) && readFileSync(join(DIR, f), "utf8").includes("access_key"));
    expect(offenders).toEqual([]);
    expect(readFileSync(join(DIR, "lib", "access.ts"), "utf8")).toContain("access_key"); // the builder
  });
  test("scope_key is never an access input (lib/access.ts does not know the log's scopes)", () => {
    const access = readFileSync(join(DIR, "lib", "access.ts"), "utf8");
    expect(access).not.toContain("scope_key");
    expect(access).not.toContain("sync_actions");
  });
  test("every task_comments insert goes through insertTaskComment (the last_comment_at stamp)", () => {
    const offenders = sources().filter((f) => f !== "tasks.ts" && /\.insert\(\s*"task_comments"/.test(readFileSync(join(DIR, f), "utf8")));
    expect(offenders).toEqual([]);
    expect((readFileSync(join(DIR, "tasks.ts"), "utf8").match(/\.insert\(\s*"task_comments"/g) ?? []).length).toBe(1);
  });
  test("visibleInTeamList agrees with the stamp predicate", async () => {
    const { visibleInTeamList } = await import("./lib/access");
    const { db } = makeFakeDb();
    const docs = [
      { user_id: "users:1", workspace: "team:teams:T" },
      { user_id: "users:1", workspace: "user:users:1" },
      { user_id: "users:1", workspace: "user:users:1", assignee: "users:9" },
      { user_id: "users:1", workspace: "user:users:1", assignee: "agent:claude" },
    ];
    for (const d of docs) for (const v of ["users:1", "users:9", "users:5"]) {
      const viaList = await visibleInTeamList({ db } as any, v as any, "tasks", d, "teams:T");
      const viaStamp = authorizedFor(accessStampFromDoc("tasks", d), v, new Set([`user:${v}`, "team:teams:T"]));
      expect([d, v, viaList]).toEqual([d, v, viaStamp]);
    }
  });
  test("agent:* assignees are neither grants nor scopes", () => {
    const stamp = accessStampFromDoc("tasks", { user_id: "u1", workspace: "user:u1", assignee: "agent:claude" });
    expect(stamp).not.toBeNull();
    expect(stamp?.access_grants).toBeUndefined();
    expect(scopesForChange("tasks", { owner_user_id: "u1", workspace: "user:u1", assignee: "agent:claude" })).toEqual(["user:u1"]);
  });
  test("coalescing onto a cargo-less existing row cannot emit a thin patch (review blocker)", () => {
    const m = mergeCargo({ op: "upsert" } as any, { patch: { title: "t" } });
    expect(m.partial).toBe(true); // the self-heal then rebuilds a full cargo
  });
});
