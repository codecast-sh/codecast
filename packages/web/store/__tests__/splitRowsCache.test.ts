import Dexie from "dexie";
import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, it, expect } from "bun:test";
import { loadSplitRows, persistSplitRows, _reopenForTests } from "../idbCache";
import { cacheRows, rebuildRows, splitRows, type SplitCache } from "@codecast/shared/contracts/inboxSplit";

await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();

// A web launch held no split rows, so the first split inbox value could never
// be rebuilt and the feeder downloaded the whole list (3MB against 213KB
// split) on every boot. The rows a launch held now outlive it on disk.

const settle = () => new Promise((r) => setTimeout(r, 20));

describe("held split rows", () => {
  it("rebuild the next launch's split value from disk", async () => {
    const now = Date.now();
    const rows: Array<[string, any]> = [["a", { _id: "a", updated_at: now }], ["b", { _id: "b", updated_at: now - 86_400_000 }]];
    const held: SplitCache<any> = new Map();
    cacheRows(held, rows);
    persistSplitRows("conversations:listInboxSessions", [...held].map(([id, { row, hash }]) => ({ id, hash, row })), []);
    await settle();

    const restored: SplitCache<any> = new Map();
    for (const { id, hash, row } of await loadSplitRows("conversations:listInboxSessions")) restored.set(id, { row, hash });
    expect(rebuildRows(splitRows(rows, now), restored)?.map(([id]) => id)).toEqual(["a", "b"]);
  });

  it("keeps each query's rows apart and drops removed ones", async () => {
    persistSplitRows("q:one", [{ id: "x", hash: "h1", row: { v: 1 } }, { id: "y", hash: "h2", row: { v: 2 } }], []);
    persistSplitRows("q:two", [{ id: "x", hash: "h9", row: { v: 9 } }], []);
    await settle();
    persistSplitRows("q:one", [], ["y"]);
    await settle();
    expect(await loadSplitRows("q:one")).toEqual([{ id: "x", hash: "h1", row: { v: 1 } }]);
    expect(await loadSplitRows("q:two")).toEqual([{ id: "x", hash: "h9", row: { v: 9 } }]);
  });
});
