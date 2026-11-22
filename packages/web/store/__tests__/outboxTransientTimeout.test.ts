import "./fixtures/signedInPrincipal";
import { indexedDB, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { describe, it, expect } from "bun:test";
import { enqueueDispatch, loadOutbox, removeDispatch, _reopenForTests } from "../idbCache";

await _reopenForTests({ indexedDB, IDBKeyRange });

// ct-75824: Chrome aborts an IndexedDB write with "TimeoutError: Transaction
// timed out due to inactivity" when the page stalls (seen beside 85-126s
// /vault/file requests). That is transient: the same put succeeds a moment
// later. A durable outbox write must survive one such abort instead of
// rejecting, which the middleware reports as lasting failure ("durable enqueue
// ... failed after Nms — durability is degraded") and never retries.

const entry = (id: string) => ({ id, action: "stageExpandLeaf", args: {}, patches: {}, result: null, ts: 1 }) as any;

function failPutsOnce(store: string, times = 1) {
  const proto = IDBObjectStore.prototype as any;
  const realPut = proto.put;
  let left = times;
  proto.put = function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === store && left > 0) {
      left--;
      throw new DOMException("Transaction timed out due to inactivity", "TimeoutError");
    }
    return realPut.apply(this, args);
  };
  return () => { proto.put = realPut; };
}

describe("dispatch outbox under a transient IndexedDB timeout", () => {
  it("persists the entry when the first write times out and the next succeeds", async () => {
    const restore = failPutsOnce("dispatchOutbox");
    let error: unknown = null;
    try {
      await enqueueDispatch(entry("t1"));
    } catch (e) {
      error = e;
    } finally {
      restore();
    }
    expect(error).toBeNull();
    expect((await loadOutbox()).map((e) => e.id)).toContain("t1");
    await removeDispatch("t1");
  });
});
