import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { batchStatements, createWriteBehind } from "../idbCacheWriteBehind.native";

// kv-store's own table, as expo-sqlite creates it.
function kvTable() {
  const db = new Database(":memory:");
  db.run("CREATE TABLE IF NOT EXISTS storage (key TEXT PRIMARY KEY NOT NULL, value TEXT);");
  const all = () => Object.fromEntries((db.query("SELECT key, value FROM storage ORDER BY key").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
  const run = (puts: Array<[string, string]>, removes: string[]) => {
    for (const { sql, params } of batchStatements(puts, removes)) db.run(sql, params);
  };
  return { db, all, run };
}

/** A storage that records each call, and a batch writer over the same map. */
function recorder() {
  const disk = new Map<string, string>();
  const perKey: string[] = [];
  const batches: Array<{ puts: Array<[string, string]>; removes: string[] }> = [];
  let gate: Promise<void> = Promise.resolve();
  let failBatches = false;
  const storage = {
    async setItem(key: string, value: string) { perKey.push(`set ${key}`); disk.set(key, value); },
    async removeItem(key: string) { perKey.push(`remove ${key}`); disk.delete(key); },
  };
  const writeBatch = async (puts: Array<[string, string]>, removes: string[]) => {
    batches.push({ puts, removes });
    await gate;
    if (failBatches) throw new Error("database is locked");
    for (const [k, v] of puts) disk.set(k, v);
    for (const k of removes) disk.delete(k);
  };
  return {
    disk, perKey, batches, storage, writeBatch,
    hold() { let open!: () => void; gate = new Promise<void>((r) => { open = r; }); return open; },
    failBatches(on: boolean) { failBatches = on; },
  };
}

describe("batchStatements", () => {
  test("nothing to write is no statement", () => {
    expect(batchStatements([], [])).toEqual([]);
  });

  test("puts insert new keys and overwrite held ones in one statement", () => {
    const t = kvTable();
    t.run([["a", "1"], ["b", "2"]], []);
    t.run([["b", "two"], ["c", "3"]], []);
    expect(t.all()).toEqual({ a: "1", b: "two", c: "3" });
    expect(batchStatements([["b", "two"], ["c", "3"]], [])).toHaveLength(1);
  });

  test("removes delete their keys and leave the rest", () => {
    const t = kvTable();
    t.run([["a", "1"], ["b", "2"], ["c", "3"]], []);
    t.run([["d", "4"]], ["a", "c", "never-there"]);
    expect(t.all()).toEqual({ b: "2", d: "4" });
  });

  test("a full batch of rows with quotes and newlines round-trips", () => {
    const t = kvTable();
    const puts = Array.from({ length: 64 }, (_, i): [string, string] => [`col:sessions:${i}`, JSON.stringify({ _id: i, title: `it's "row" ${i}\n?` })]);
    t.run(puts, []);
    expect(Object.keys(t.all())).toHaveLength(64);
    expect(JSON.parse(t.all()["col:sessions:7"])).toEqual({ _id: 7, title: `it's "row" 7\n?` });
  });
});

describe("write-behind with a batch writer", () => {
  test("a burst of rows reaches disk as one batch, never one write per row", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    for (let i = 0; i < 20; i++) w.scheduleWrite(`k${i}`, () => `v${i}`);
    w.scheduleRemove("gone");
    await w.flush();
    expect(r.batches).toHaveLength(1);
    expect(r.batches[0].puts).toHaveLength(20);
    expect(r.batches[0].removes).toEqual(["gone"]);
    expect(r.perKey).toEqual([]);
    expect(r.disk.get("k19")).toBe("v19");
  });

  test("the latest producer for a key wins, and a key is in a batch once", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    w.scheduleWrite("k", () => "first");
    w.scheduleWrite("k", () => "second");
    w.scheduleRemove("k");
    w.scheduleWrite("k", () => "third");
    await w.flush();
    expect(r.batches).toEqual([{ puts: [["k", "third"]], removes: [] }]);
  });

  test("one batch is in flight at a time; what arrives meanwhile goes in the next", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    const open = r.hold();
    w.scheduleWrite("a", () => "1");
    const draining = w.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.batches).toHaveLength(1);
    w.scheduleWrite("a", () => "2");
    w.scheduleWrite("b", () => "3");
    // Still one batch: the second waits for the first to land.
    expect(r.batches).toHaveLength(1);
    open();
    await draining;
    expect(r.batches).toHaveLength(2);
    expect(r.batches[1].puts).toEqual([["a", "2"], ["b", "3"]]);
    expect(r.disk.get("a")).toBe("2");
  });

  test("a read sees the value a batch in flight is writing", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    const open = r.hold();
    w.scheduleWrite("a", () => "new");
    expect(w.scheduledValue("a")).toBe("new");
    const draining = w.flush();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.disk.has("a")).toBe(false);
    expect(w.scheduledValue("a")).toBe("new");
    open();
    await draining;
    // On disk now; the scheduler no longer answers for it.
    expect(w.scheduledValue("a")).toBeUndefined();
    expect(r.disk.get("a")).toBe("new");
  });

  test("a backlog goes out in capped batches, in order", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    for (let i = 0; i < 200; i++) w.scheduleWrite(`k${i}`, () => `v${i}`);
    await w.flush();
    expect(r.batches.map((b) => b.puts.length)).toEqual([64, 64, 64, 8]);
    expect(r.batches[0].puts[0][0]).toBe("k0");
    expect(r.batches[3].puts[7][0]).toBe("k199");
    expect(r.disk.size).toBe(200);
  });

  test("large rows end a batch early, so one task never stringifies megabytes", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    const big = "x".repeat(300_000);
    for (let i = 0; i < 5; i++) w.scheduleWrite(`k${i}`, () => big);
    await w.flush();
    expect(r.batches.map((b) => b.puts.length)).toEqual([2, 2, 1]);
  });

  test("a batch that fails is written one key at a time, so nothing is lost", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    r.disk.set("old", "x");
    r.failBatches(true);
    w.scheduleWrite("a", () => "1");
    w.scheduleWrite("b", () => "2");
    w.scheduleRemove("old");
    await w.flush();
    expect(r.perKey).toEqual(["set a", "set b", "remove old"]);
    expect(Object.fromEntries(r.disk)).toEqual({ a: "1", b: "2" });
    // The next flush tries a batch again.
    r.failBatches(false);
    w.scheduleWrite("c", () => "3");
    await w.flush();
    expect(r.batches).toHaveLength(2);
    expect(r.perKey).toHaveLength(3);
  });

  test("a producer that throws loses only its own row", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    w.scheduleWrite("a", () => "1");
    w.scheduleWrite("bad", () => { throw new Error("cyclic"); });
    w.scheduleWrite("c", () => "3");
    await w.flush();
    expect(r.batches[0].puts).toEqual([["a", "1"], ["c", "3"]]);
  });

  test("clearScheduled forgets what has not started and settleInflight waits out what has", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage, r.writeBatch);
    const open = r.hold();
    w.scheduleWrite("a", () => "1");
    const draining = w.flush();
    await Promise.resolve();
    await Promise.resolve();
    w.scheduleWrite("b", () => "2");
    w.clearScheduled();
    open();
    await w.settleInflight();
    await draining;
    expect(Object.fromEntries(r.disk)).toEqual({ a: "1" });
  });
});

describe("write-behind without a batch writer", () => {
  test("writes one key at a time, as before", async () => {
    const r = recorder();
    const w = createWriteBehind(r.storage);
    w.scheduleWrite("a", () => "1");
    w.scheduleRemove("b");
    await w.flush();
    expect(r.batches).toEqual([]);
    expect(r.perKey).toEqual(["set a", "remove b"]);
  });
});
