import "fake-indexeddb/auto";
import { stampCacheOwner } from "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "bun:test";
import Dexie from "dexie";
import { _reopenForTests, _resetPersistedShadow, flushLivenessWrites, setHydrating, writePatchesToIDB } from "../idbCache";
import { noteSnapshotSync } from "../idbCollectionDiff";

await _reopenForTests({ indexedDB, IDBKeyRange });
Dexie.dependencies.indexedDB = indexedDB;
Dexie.dependencies.IDBKeyRange = IDBKeyRange;
await stampCacheOwner();
setHydrating(false);

// A write persists the rows its patches name, at a cost of those rows: a
// 400-cell batch into a sheet beside 80k other rows never walks the 80k. The
// pending map goes to disk with every action (its locks guard outbox rows that are already
// on disk); other meta blobs are written once per quiet spell.
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

  it("writes the pending blob with every action, so a page killed right after a write keeps its lock", async () => {
    // The outbox row reaches disk at once; a lock that waited for the 250 ms
    // quiet spell was lost with a page killed in between (no flush), and the
    // reloaded page showed a stale push over its own parked write.
    writePatchesToIDB([{ op: "replace", path: ["pending"], value: {} } as any], { pending: { "liveElements:k:v": { type: "field", value: 1 } } });
    await settle();
    expect((await db().meta.get("pending"))?.value).toEqual({ "liveElements:k:v": { type: "field", value: 1 } });
  });

  it("still writes other meta blobs once for a run of actions, with their last value", async () => {
    let puts = 0;
    const put = db().meta.put.bind(db().meta);
    db().meta.put = (row: any) => { if (row.key === "wallet") puts++; return put(row); };
    for (let i = 0; i < 50; i++) writePatchesToIDB([{ op: "replace", path: ["wallet"], value: {} } as any], { wallet: { n: i } });
    expect(puts).toBe(0);
    await Bun.sleep(400);
    expect(puts).toBe(1);
    expect((await db().meta.get("wallet")).value).toEqual({ n: 49 });
    db().meta.put = put;
  });

  // A working agent's session row changes on every message and model call.
  // Rewriting it each time kept the desktop app's browser process compacting
  // IndexedDB at a core; those ticks now wait for the liveness flush, and the
  // sync cursors wait with them so they never reach disk ahead of the rows.
  it("holds liveness-only session changes and syncMeta for the liveness flush, rows first", async () => {
    _resetPersistedShadow();
    const S = (n: number) => `jx7sess${String(n).padStart(25, "a")}`;
    const base = { _id: S(1), title: "t", agent_status: "working", message_count: 1, updated_at: 1 };
    let sessions: Record<string, any> = { [S(1)]: base, [S(2)]: { ...base, _id: S(2) } };
    writePatchesToIDB([{ op: "replace", path: ["sessions"], value: sessions } as any], { sessions, pending: {} });
    await settle();
    expect((await db().sessions.get(S(1))).message_count).toBe(1);

    const writes: string[] = [];
    const sessionsPut = db().sessions.bulkPut.bind(db().sessions);
    db().sessions.bulkPut = (rows: any[]) => { writes.push(...rows.map((r) => `row:${r._id}:${r.message_count}`)); return sessionsPut(rows); };
    const metaPut = db().meta.put.bind(db().meta);
    db().meta.put = (row: any) => { if (row.key === "syncMeta") writes.push(`syncMeta:${row.value.s.cursor}`); return metaPut(row); };

    for (let i = 2; i <= 20; i++) {
      sessions = { ...sessions, [S(1)]: { ...sessions[S(1)], message_count: i, updated_at: i } };
      const syncMeta = { s: { cursor: i } };
      writePatchesToIDB(
        [
          { op: "replace", path: ["sessions", S(1), "message_count"], value: i } as any,
          { op: "replace", path: ["syncMeta", "s"], value: syncMeta.s } as any,
        ],
        { sessions, syncMeta, pending: {} },
      );
    }
    await Bun.sleep(300);
    expect(writes).toEqual([]);
    expect((await db().sessions.get(S(1))).message_count).toBe(1);

    // Any other field goes to disk at once, liveness fields and all.
    sessions = { ...sessions, [S(2)]: { ...sessions[S(2)], agent_status: "idle", message_count: 9 } };
    writePatchesToIDB([{ op: "replace", path: ["sessions", S(2), "agent_status"], value: "idle" } as any], { sessions, syncMeta: { s: { cursor: 20 } }, pending: {} });
    await settle();
    expect(writes).toEqual([`row:${S(2)}:9`]);

    flushLivenessWrites();
    await settle();
    expect(writes).toEqual([`row:${S(2)}:9`, `row:${S(1)}:20`, "syncMeta:20"]);
    expect((await db().sessions.get(S(1))).message_count).toBe(20);
    expect((await db().meta.get("syncMeta")).value).toEqual({ s: { cursor: 20 } });

    db().sessions.bulkPut = sessionsPut;
    db().meta.put = metaPut;
  });
});
