import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

// The native cache reads a boot snapshot with ONE statement (a few on
// Android, sliced by size; see the second suite). kv-store's
// multiGet runs a statement per key: ~22,000 native round trips at boot, each
// completion walking React Native's registry of outstanding calls. This pins
// the single statement to the exact key set the per-key path selected.

(globalThis as any).__CODECAST_TEST_KV_STORAGE__ ??= {
  getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiGet: async () => [],
  getItemSync: () => null, setItemSync: () => {}, getAllKeysSync: () => [], removeItemSync: () => {},
};
const { readPlan, readPlanSql } = await import("../idbCache.native");
const { readPlanSizesSql, sliceKeys, readKeysSql } = await import("../idbCacheKeys.native");

const KEYS = [
  "col:sessions", // a legacy blob
  "col:sessions:jx1", "col:sessions:jx2",
  "col:sessionsX:nope", // shares a prefix with sessions, is not sessions
  "col:sessionReads:r1",
  "col:tasks:t1",
  "meta:liveInboxIdList", "meta:clientState", "meta:conversations", "meta:conversations:jx1",
  "meta:conversationsX", "convmsg:jx1", "convusermsg:jx1",
];

function select(wanted: string[] | null): string[] {
  const db = new Database(":memory:");
  db.run("CREATE TABLE storage (key TEXT PRIMARY KEY NOT NULL, value TEXT)");
  for (const key of KEYS) db.run("INSERT INTO storage (key, value) VALUES (?, ?)", [key, "{}"]);
  const { sql, params } = readPlanSql(readPlan(wanted ? new Set(wanted) : null));
  return (db.query(sql).all(...params) as { key: string }[]).map((row) => row.key).sort();
}

describe("native cache read plan", () => {
  it("reads a collection's rows and blob, and nothing that only shares its prefix", () => {
    expect(select(["sessions"])).toEqual(["col:sessions", "col:sessions:jx1", "col:sessions:jx2"]);
  });

  it("reads exact meta keys and the rows under a per-row meta key", () => {
    expect(select(["liveInboxIdList", "conversations"])).toEqual(
      ["meta:conversations", "meta:conversations:jx1", "meta:liveInboxIdList"],
    );
  });

  it("never reads message rows, which hydrate per conversation", () => {
    const all = select(null);
    expect(all.filter((key) => key.startsWith("conv"))).toEqual([]);
    expect(all).toContain("col:tasks:t1");
    expect(all).toContain("col:sessionReads:r1");
  });

  it("an empty plan selects nothing", () => {
    expect(select(["noSuchKey"])).toEqual([]);
  });
});

// Android's getAll holds a statement's whole result on a Java heap capped at
// 256 MB, so a read there lists its keys with octet_length, then reads the
// values in batches under a byte budget.
describe("native cache read in slices", () => {
  const table = (rows: Array<[string, string | null]>) => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE storage (key TEXT PRIMARY KEY NOT NULL, value TEXT)");
    for (const row of rows) db.run("INSERT INTO storage (key, value) VALUES (?, ?)", row);
    return db;
  };
  const sliced = (db: Database, plan: ReturnType<typeof readPlan>, budget: number) => {
    const sizes = readPlanSizesSql(plan);
    return sliceKeys(db.query(sizes.sql).all(...sizes.params) as any[], budget).map((keys) => {
      const { sql, params } = readKeysSql(keys);
      return db.query(sql).all(...params) as Array<{ key: string; value: string | null }>;
    });
  };
  const bytes = (rows: Array<{ value: string | null }>) =>
    rows.reduce((n, row) => n + Buffer.byteLength(row.value ?? ""), 0);

  it("returns exactly the rows the one statement does, no slice over budget", () => {
    const rows: Array<[string, string | null]> = KEYS.map((key, i) => [key, "é".repeat(5 + i * 7)]);
    rows.push(["col:sessions:jx3", null]);
    const db = table(rows);
    const plan = readPlan(null);
    const one = readPlanSql(plan);
    const whole = (db.query(one.sql).all(...one.params) as Array<{ key: string; value: string | null }>)
      .sort((a, b) => a.key.localeCompare(b.key));
    const slices = sliced(db, plan, 60);
    expect(slices.length).toBeGreaterThan(2);
    for (const slice of slices) {
      if (slice.length > 1) expect(bytes(slice)).toBeLessThanOrEqual(60);
    }
    expect(slices.flat().sort((a, b) => a.key.localeCompare(b.key))).toEqual(whole);
  });

  it("a row bigger than the budget is read on its own", () => {
    const db = table([["col:sessions:a", "x".repeat(10)], ["col:sessions:b", "x".repeat(500)], ["col:sessions:c", "x".repeat(10)]]);
    expect(sliced(db, readPlan(new Set(["sessions"])), 100).map((s) => s.map((r) => r.key))).toEqual(
      [["col:sessions:a"], ["col:sessions:b"], ["col:sessions:c"]],
    );
  });

  it("lists keys in the one statement's order, and caps a batch's key count", () => {
    const db = table(Array.from({ length: 1_200 }, (_, i) => [`col:sessions:k${i}`, "{}"] as [string, string]));
    const plan = readPlan(new Set(["sessions"]));
    const one = readPlanSql(plan);
    const sizes = readPlanSizesSql(plan);
    const listed = db.query(sizes.sql).all(...sizes.params) as Array<{ key: string; bytes: number }>;
    expect(listed.map((r) => r.key)).toEqual((db.query(one.sql).all(...one.params) as Array<{ key: string }>).map((r) => r.key));
    expect(sliceKeys(listed, 1e9).map((keys) => keys.length)).toEqual([500, 500, 200]);
  });

  it("an empty read reads nothing", () => {
    expect(sliceKeys([], 100)).toEqual([]);
  });
});
