import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

// The native cache reads a boot snapshot with ONE statement. kv-store's
// multiGet runs a statement per key: ~22,000 native round trips at boot, each
// completion walking React Native's registry of outstanding calls. This pins
// the single statement to the exact key set the per-key path selected.

(globalThis as any).__CODECAST_TEST_KV_STORAGE__ ??= {
  getItem: async () => null, setItem: async () => {}, removeItem: async () => {}, multiGet: async () => [],
  getItemSync: () => null, setItemSync: () => {}, getAllKeysSync: () => [], removeItemSync: () => {},
};
const { readPlan, readPlanSql } = await import("../idbCache.native");

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
