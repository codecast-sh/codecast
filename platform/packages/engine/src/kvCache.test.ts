import { describe, expect, test } from "bun:test";
import { createKVCache, type KVStore } from "./kvCache";
import type { OutboxEntry, PlatformConfig } from "./types";

function memoryKV(): KVStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
}

const CONFIG: PlatformConfig = {
  dbName: "test-db",
  dbVersion: 1,
  syncRegistry: {},
  registry: {
    threads: { persistence: { kind: "collection", key: "threads" }, localFirst: true },
    account: { persistence: { kind: "meta", key: "account" } },
    pending: { persistence: { kind: "meta", key: "pending" } },
  },
  detailTables: {
    threadMessages: { keyField: "thread_gmail_id", maxRows: 3 },
  },
};

const patchFor = (key: string) => [{ op: "replace" as const, path: [key], value: null }];

async function settle(ms = 500): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("createKVCache", () => {
  test("collections and meta round-trip through hydrate", async () => {
    const kv = memoryKV();
    const cache = createKVCache(CONFIG, kv);
    const state = {
      threads: { t1: { _id: "t1", subject: "hello" } },
      account: { email: "a@b.c" },
      pending: {},
    };
    cache.writePatchesToIDB(patchFor("threads"), state);
    cache.writePatchesToIDB(patchFor("account"), state);
    cache.flushAll();
    await settle(10);

    const loaded = await cache.loadCache();
    expect(loaded?.threads?.t1?.subject).toBe("hello");
    expect(loaded?.account?.email).toBe("a@b.c");
  });

  test("a row missing from memory survives unless excluded", async () => {
    const kv = memoryKV();
    const cache = createKVCache(CONFIG, kv);
    const full = {
      threads: { t1: { _id: "t1" }, t2: { _id: "t2" } },
      pending: {},
    };
    cache.writePatchesToIDB(patchFor("threads"), full);
    cache.flushAll();

    // t2 vanishes from memory with no exclude → must stay on disk.
    const windowed = { threads: { t1: { _id: "t1" } }, pending: {} };
    cache.writePatchesToIDB(patchFor("threads"), windowed);
    cache.flushAll();
    let loaded = await cache.loadCache();
    expect(Object.keys(loaded!.threads)).toEqual(["t1", "t2"]);

    // Now an explicit removal (exclude tombstone) deletes it.
    const excluded = {
      threads: { t1: { _id: "t1" } },
      pending: { "threads:t2": { type: "exclude", ts: Date.now() } },
    };
    cache.writePatchesToIDB(patchFor("threads"), excluded);
    cache.flushAll();
    loaded = await cache.loadCache();
    expect(Object.keys(loaded!.threads)).toEqual(["t1"]);
  });

  test("writes are ignored while hydrating", async () => {
    const kv = memoryKV();
    const cache = createKVCache(CONFIG, kv);
    cache.setHydrating(true);
    cache.writePatchesToIDB(patchFor("threads"), { threads: { t1: { _id: "t1" } } });
    cache.flushAll();
    expect(await cache.loadCache()).toBeNull();
    cache.setHydrating(false);
  });

  test("detail rows round-trip, buffered reads win, cap prunes oldest", async () => {
    const kv = memoryKV();
    const cache = createKVCache(CONFIG, kv);

    cache.writeDetail("threadMessages", "g1", [{ id: 1 }]);
    // Read-your-writes before the flush timer fires.
    const buffered = await cache.loadDetail("threadMessages", "g1");
    expect(buffered?.value).toEqual([{ id: 1 }]);

    cache.flushDetail();
    await settle(20);
    const persisted = await cache.loadDetail("threadMessages", "g1");
    expect(persisted?.value).toEqual([{ id: 1 }]);

    // maxRows=3: writing four keys prunes the oldest.
    for (const key of ["g2", "g3", "g4"]) {
      cache.writeDetail("threadMessages", key, [{ key }]);
    }
    cache.flushDetail();
    await settle(20);
    const kept = await Promise.all(
      ["g1", "g2", "g3", "g4"].map((k) => cache.loadDetail("threadMessages", k)),
    );
    expect(kept.filter(Boolean).length).toBe(3);
  });

  test("outbox enqueue/remove/load serialize correctly", async () => {
    const kv = memoryKV();
    const cache = createKVCache(CONFIG, kv);
    const entry = (id: string, ts: number): OutboxEntry => ({
      id,
      action: "x",
      args: [],
      patches: [],
      result: null,
      ts,
    });
    // Concurrent writes must not lose entries.
    await Promise.all([
      cache.enqueueDispatch(entry("a", 3)),
      cache.enqueueDispatch(entry("b", 1)),
      cache.enqueueDispatch(entry("c", 2)),
    ]);
    await cache.removeDispatch("c");
    const loaded = await cache.loadOutbox();
    expect(loaded.map((e) => e.id)).toEqual(["b", "a"]);
  });

  test("purge clears everything", async () => {
    const kv = memoryKV();
    const cache = createKVCache(CONFIG, kv);
    cache.writePatchesToIDB(patchFor("threads"), { threads: { t1: { _id: "t1" } }, pending: {} });
    cache.flushAll();
    cache.writeDetail("threadMessages", "g1", [1]);
    cache.flushDetail();
    await cache.enqueueDispatch({ id: "a", action: "x", args: [], patches: [], result: null, ts: 1 });
    await settle(20);

    await cache.purgeLocalCache();
    expect(await cache.loadCache()).toBeNull();
    expect(await cache.loadDetail("threadMessages", "g1")).toBeNull();
    expect(await cache.loadOutbox()).toEqual([]);
    expect(kv.data.size).toBe(0);
  });
});
