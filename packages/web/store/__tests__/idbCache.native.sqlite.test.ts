import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The phone's cache on a real SQLite file, as expo-sqlite's kv-store lays it
// out ("storage": key, value). A flush goes to disk as one statement
// (idbCacheWriteBehind.native batchStatements); this suite writes through
// that path and reads back the way a relaunch does: the module's own boot
// read (loadCache, one SELECT over the table) with nothing left in memory,
// and a second connection that never saw the writes.
const dir = mkdtempSync(join(tmpdir(), "codecast-kv-"));
const file = join(dir, "kv.db");
const db = new Database(file);
db.run("CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY NOT NULL, value TEXT);");

const statements: string[] = [];
const perKeyWrites: string[] = [];
const reads: string[] = [];
// A write landing between a sliced read's key listing and its value batches.
let afterListing: (() => void) | null = null;
const get = db.query("SELECT value FROM storage WHERE key = ?");
const value = (key: string): string | null => (get.get(key) as { value: string } | null)?.value ?? null;
const allKeys = (): string[] => (db.query("SELECT key FROM storage").all() as Array<{ key: string }>).map((r) => r.key);
const upsert = "INSERT INTO storage (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;";

const shimBefore = (globalThis as any).__CODECAST_TEST_KV_STORAGE__;
(globalThis as any).__CODECAST_TEST_KV_STORAGE__ = {
  // What expo-sqlite's SQLiteDatabase offers and the cache calls.
  cacheDb: {
    async runAsync(sql: string, params: string[]) { statements.push(sql); db.run(sql, params); },
    async getAllAsync(sql: string, params: string[]) {
      reads.push(sql);
      const rows = db.query(sql).all(...params);
      if (sql.includes("octet_length")) afterListing?.();
      return rows;
    },
    getAllSync(sql: string, params: string[]) { reads.push(sql); return db.query(sql).all(...params); },
    getFirstSync(sql: string, params: string[]) { return db.query(sql).get(...params); },
  },
  async getItem(key: string) { return value(key); },
  getItemSync(key: string) { return value(key); },
  async setItem(key: string, v: string) { perKeyWrites.push(key); db.run(upsert, [key, v]); },
  setItemSync(key: string, v: string) { db.run(upsert, [key, v]); },
  async removeItem(key: string) { perKeyWrites.push(key); db.run("DELETE FROM storage WHERE key = ?", [key]); },
  removeItemSync(key: string) { db.run("DELETE FROM storage WHERE key = ?", [key]); },
  async multiGet(keys: string[]) { return keys.map((k) => [k, value(k)] as [string, string | null]); },
  async getAllKeys() { return allKeys(); },
  getAllKeysSync() { return allKeys(); },
};

// Its own copy of the module: another suite in the same process may have
// loaded it over a plain map.
const { writePatchesToIDB, loadCache, loadCacheSync, flushPersistence, setHydrating, _resetPersistedShadow, _setReadSliceBytes, persistSplitRows, loadSplitRows } =
  await import("../idbCache.native?sqlite" as string) as typeof import("../idbCache.native");

const sessions = (n: number, title = "row"): Record<string, any> =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { _id: `s${i}`, title: `${title} ${i}`, note: `it's "quoted"\n${i}` }]));
const touch = (key: string) => [{ op: "replace", path: [key], value: {} } as any];

// Leave the process as it was found: the shim another suite may have set, no
// open database, no temp file.
afterAll(async () => {
  await flushPersistence();
  (globalThis as any).__CODECAST_TEST_KV_STORAGE__ = shimBefore;
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("the phone cache on a real SQLite table", () => {
  beforeEach(() => {
    db.run("DELETE FROM storage;");
    statements.length = 0;
    perKeyWrites.length = 0;
    _resetPersistedShadow();
    setHydrating(false);
  });

  it("a flush of many rows is a few statements, and a relaunch reads every row back", async () => {
    const state = { sessions: sessions(150) };
    writePatchesToIDB(touch("sessions"), state);
    await flushPersistence();

    // 150 rows at 64 a batch; no row went out on its own.
    const upserts = statements.filter((s) => s.startsWith("INSERT INTO storage"));
    expect(upserts).toHaveLength(3);
    expect(perKeyWrites).toEqual([]);

    // A relaunch: nothing in memory, the boot read's one SELECT over the table.
    _resetPersistedShadow();
    statements.length = 0;
    const cached = await loadCache(["sessions"]);
    expect(cached!.sessions).toEqual(state.sessions);
    expect(loadCacheSync(["sessions"])!.sessions).toEqual(state.sessions);

    // And a connection that never saw the writes finds the same bytes in the file.
    const other = new Database(file, { readonly: true });
    const onDisk = other.query("SELECT key, value FROM storage WHERE key LIKE '%s149'").all() as Array<{ key: string; value: string }>;
    other.close();
    expect(onDisk).toHaveLength(1);
    expect(JSON.parse(onDisk[0].value)).toEqual(state.sessions.s149);
  });

  it("changed rows overwrite, removed rows leave, untouched rows are not rewritten", async () => {
    const first = { sessions: sessions(10) };
    writePatchesToIDB(touch("sessions"), first);
    await flushPersistence();
    statements.length = 0;

    // A minted stub leaves disk when it leaves the store (a server row's
    // absence from a delta is not a delete; see durableDeletes).
    const next: Record<string, any> = { ...first.sessions, s3: { ...first.sessions.s3, title: "renamed" }, temp_1: { _id: "temp_1", title: "stub" } };
    writePatchesToIDB(touch("sessions"), { sessions: next });
    await flushPersistence();
    const withStub = statements.filter((s) => s.startsWith("INSERT INTO storage"));
    expect(withStub).toHaveLength(1);
    // Two rows changed, so two value pairs in the one statement.
    expect(withStub[0].match(/\(\?, \?\)/g)).toHaveLength(2);

    statements.length = 0;
    const { temp_1: _gone, ...without } = next;
    writePatchesToIDB(touch("sessions"), { sessions: without });
    await flushPersistence();

    _resetPersistedShadow();
    const cached = await loadCache(["sessions"]);
    expect(cached!.sessions.s3.title).toBe("renamed");
    expect(cached!.sessions.s4).toEqual(first.sessions.s4);
    // The stub's removal reached disk as one DELETE statement.
    expect(statements.filter((s) => s.startsWith("DELETE FROM storage"))).toHaveLength(1);
    expect(Object.keys(cached!.sessions).sort()).toEqual(Object.keys(without).sort());
    expect(perKeyWrites).toEqual([]);
  });

  it("a meta value written beside rows comes back with them", async () => {
    const state = { sessions: sessions(3), liveInboxIdList: ["s0", "s2"] };
    writePatchesToIDB([...touch("sessions"), ...touch("liveInboxIdList")], state);
    await flushPersistence();
    _resetPersistedShadow();
    const cached = await loadCache(["sessions", "liveInboxIdList"]);
    expect(cached!.liveInboxIdList).toEqual(["s0", "s2"]);
    expect(Object.keys(cached!.sessions)).toEqual(["s0", "s1", "s2"]);
  });

  // Android: a statement's whole result sits on the Java heap before JS sees
  // it, so the boot and split reads go in slices under a byte budget.
  it("a sliced read returns every row the one statement does", async () => {
    const state = { sessions: sessions(150), liveInboxIdList: ["s0", "s149"] };
    writePatchesToIDB([...touch("sessions"), ...touch("liveInboxIdList")], state);
    persistSplitRows("conversations:listInboxSessions", [
      { id: "a", hash: "h1", row: { _id: "a" } },
      { id: "b", hash: "h2", row: { _id: "b", title: "x".repeat(300) } },
    ], []);
    await flushPersistence();
    _resetPersistedShadow();
    reads.length = 0;
    _setReadSliceBytes(1_000);
    try {
      const cached = await loadCache(["sessions", "liveInboxIdList"]);
      expect(cached!.sessions).toEqual(state.sessions);
      expect(cached!.liveInboxIdList).toEqual(["s0", "s149"]);
      // One sizing pass, then many value reads.
      expect(reads.filter((sql) => sql.includes("octet_length"))).toHaveLength(1);
      expect(reads.filter((sql) => sql.startsWith("SELECT key, value")).length).toBeGreaterThan(5);
      // The paint fallback's synchronous read, sliced the same way.
      _resetPersistedShadow();
      reads.length = 0;
      expect(loadCacheSync(["sessions"])!.sessions).toEqual(state.sessions);
      expect(reads.filter((sql) => sql.includes("octet_length"))).toHaveLength(1);
      expect(reads.length).toBeGreaterThan(5);
      expect(await loadSplitRows("conversations:listInboxSessions")).toEqual([
        { id: "a", hash: "h1", row: { _id: "a" } },
        { id: "b", hash: "h2", row: { _id: "b", title: "x".repeat(300) } },
      ]);
    } finally {
      _setReadSliceBytes(null);
    }
    // Off the phone the read stays one statement.
    reads.length = 0;
    _resetPersistedShadow();
    expect((await loadCache(["sessions"]))!.sessions).toEqual(state.sessions);
    expect(reads).toHaveLength(1);
  });

  it("a write between the listing and the batches reads fresh and drops deleted rows", async () => {
    const state = { sessions: sessions(20) };
    writePatchesToIDB(touch("sessions"), state);
    await flushPersistence();
    _resetPersistedShadow();
    _setReadSliceBytes(200);
    afterListing = () => {
      afterListing = null;
      db.run(upsert, ["col:sessions:s7", JSON.stringify({ _id: "s7", title: "fresh" })]);
      db.run("DELETE FROM storage WHERE key = ?", ["col:sessions:s3"]);
    };
    try {
      const cached = (await loadCache(["sessions"]))!.sessions;
      expect(cached.s7.title).toBe("fresh");
      expect(cached.s3).toBeUndefined();
      expect(Object.keys(cached)).toHaveLength(19);
    } finally {
      afterListing = null;
      _setReadSliceBytes(null);
    }
  });
});
