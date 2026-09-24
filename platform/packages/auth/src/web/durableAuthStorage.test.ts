import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createDurableAuthStorage } from "./durableAuthStorage";

// A Map-backed localStorage; IndexedDB stays absent, which the wrapper
// tolerates (its durable tier is best effort).
function fakeLocalStorage() {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    clear: () => { m.clear(); },
  } as Storage;
}

const g = globalThis as any;
let saved: unknown;
beforeEach(() => { saved = g.localStorage; g.localStorage = fakeLocalStorage(); });
afterEach(() => { g.localStorage = saved; });

describe("durable auth storage write hook", () => {
  test("reports this window's own set, remove, clear and purge", async () => {
    const durable = createDurableAuthStorage({ dbName: "test-auth" });
    const seen: Array<[string | null, string | null]> = [];
    const stop = durable.subscribeWrites((k, v) => seen.push([k, v]));
    durable.storage.setItem("jwt", "t1");
    durable.storage.removeItem("jwt");
    durable.storage.clear();
    await durable.purgeDurableAuthValues(["jwt"]).catch(() => {});
    expect(seen).toEqual([["jwt", "t1"], ["jwt", null], [null, null], ["jwt", null]]);
    stop();
    durable.storage.setItem("jwt", "t2");
    expect(seen.length).toBe(4);
  });

  test("a reading listener's failure never breaks the write", () => {
    const durable = createDurableAuthStorage({ dbName: "test-auth" });
    durable.subscribeWrites(() => { throw new Error("boom"); });
    const error = console.error;
    console.error = () => {};
    try {
      expect(() => durable.storage.setItem("jwt", "t1")).not.toThrow();
    } finally {
      console.error = error;
    }
    expect(localStorage.getItem("jwt")).toBe("t1");
  });
});
