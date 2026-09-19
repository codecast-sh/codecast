import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { describe, it, expect } from "bun:test";
import { enqueueDispatch, removeDispatch, loadOutbox, _reopenForTests } from "../idbCache";

// bun has no IndexedDB, and the Dexie singleton may already have failed to
// open in another test file: bind it to fake-indexeddb and reopen.
await _reopenForTests({ indexedDB, IDBKeyRange });

// The outbox is a queue: every dispatch puts a row and deletes it on ack.
// Chromium keeps the index entry of a deleted row until every connection to
// the database closes, and a read through the index steps over all of them.
// With a `ts` index, loading the EMPTY outbox cost 476ms in a day-old tab
// against 3ms by primary key, once per dispatch, and it pinned the desktop
// app's browser process for a day. fake-indexeddb has no dead entries to time,
// so these tests pin the shape that keeps the cost away.

const entry = (id: string, ts: number) => ({ id, action: "x", args: {}, patches: {}, result: null, ts }) as any;

describe("dispatch outbox", () => {
  it("has no secondary index", async () => {
    const raw = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("codecast-store");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const names = [...raw.transaction("dispatchOutbox").objectStore("dispatchOutbox").indexNames];
    raw.close();
    expect(names).toEqual([]);
  });

  it("still loads in ts order, and skips acknowledged rows", async () => {
    await enqueueDispatch(entry("c", 300));
    await enqueueDispatch(entry("a", 100));
    await enqueueDispatch(entry("b", 200));
    await removeDispatch("b");
    expect((await loadOutbox()).map((e) => e.id)).toEqual(["a", "c"]);
  });
});
