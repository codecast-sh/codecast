import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "bun:test";
import Dexie from "dexie";
import { _reopenForTests, _resetPersistedShadow, setHydrating, writePatchesToIDB } from "../idbCache";
import { noteSnapshotSync } from "../idbCollectionDiff";

await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();
setHydrating(false);

// A write persists the rows its patches name, at a cost of those rows: a
// 400-cell batch into a sheet beside 80k other rows never walks the 80k. The
// pending map is one blob, written once per quiet spell rather than per action.
const db = () => Dexie.connections.find((d) => d.name === "codecast-store") as any;
const ID = (n: number) => `k17row${String(n).padStart(26, "a")}`;
const settle = () => Bun.sleep(30);

describe("incremental persistence", () => {
  it("writes the patched rows, keeps unpatched ones, and still honors a whole-collection replace and snapshot drops", async () => {
    _resetPersistedShadow();
    const rows: Record<string, any> = {};
    for (let i = 0; i < 2000; i++) rows[ID(i)] = { _id: ID(i), doc_id: "d", layer: "main", key: `k${i}`, v: i };
    writePatchesToIDB([{ op: "replace", path: ["liveElements"], value: rows } as any], { liveElements: rows, pending: {} });
    await settle();
    expect(await db().liveElements.count()).toBe(2000);

    // One row changed, read through a collection that would throw if it were enumerated.
    const changed = { ...rows[ID(7)], v: -7 };
    const next = new Proxy({ ...rows, [ID(7)]: changed }, { ownKeys: () => { throw new Error("walked the collection"); } });
    writePatchesToIDB([{ op: "replace", path: ["liveElements", ID(7), "v"], value: -7 } as any], { liveElements: next, pending: {} });
    await settle();
    expect((await db().liveElements.get(ID(7))).v).toBe(-7);

    // A snapshot prune is found by the full diff even though no patch names the row.
    const pruned = { ...rows, [ID(7)]: changed };
    delete pruned[ID(9)];
    noteSnapshotSync("liveElements", Object.keys(pruned), [ID(9)]);
    writePatchesToIDB([{ op: "replace", path: ["liveElements", ID(8), "v"], value: 8 } as any], { liveElements: pruned, pending: {} });
    await settle();
    expect(await db().liveElements.get(ID(9))).toBeUndefined();
    expect(await db().liveElements.count()).toBe(1999);
  });

  it("writes the pending blob once for a run of actions, with its last value", async () => {
    let puts = 0;
    const put = db().meta.put.bind(db().meta);
    db().meta.put = (row: any) => { if (row.key === "pending") puts++; return put(row); };
    for (let i = 0; i < 50; i++) writePatchesToIDB([{ op: "replace", path: ["pending"], value: {} } as any], { pending: { [`liveElements:${i}`]: { type: "field" } } });
    expect(puts).toBe(0);
    await Bun.sleep(400);
    expect(puts).toBe(1);
    expect(Object.keys((await db().meta.get("pending")).value)).toEqual(["liveElements:49"]);
    db().meta.put = put;
  });
});
