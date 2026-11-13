import { describe, expect, it } from "bun:test";
import { createCoalescedWriter, diffCollection, diffPatchedRows, patchedIds } from "./idbCollectionDiff";

describe("persisting an action's rows", () => {
  const big = () => {
    const data: Record<string, any> = {};
    for (let i = 0; i < 50_000; i++) data[`r${i}`] = { _id: `r${i}`, v: i };
    return data;
  };

  it("names the rows a write patched, or none when it replaced the collection", () => {
    expect(patchedIds([{ path: ["rows", "a", "x"] }, { path: ["rows", "b"] }, { path: ["other", "c"] }], "rows")).toEqual(new Set(["a", "b"]));
    expect(patchedIds([{ path: ["rows", "a"] }, { path: ["rows"] }], "rows")).toBeNull();
  });

  it("finds the same puts and deletes a full diff finds among the patched rows", () => {
    const data = big();
    const shadow = new Map(Object.entries(data));
    const next = { ...data, r1: { _id: "r1", v: -1 }, added: { _id: "added" } };
    delete (next as any).r2;
    delete (next as any).r3;
    const removed = (id: string) => id === "r2";
    const { puts, deletes } = diffPatchedRows(shadow, next, ["r1", "added", "r2", "r3", "r4"], removed);
    expect(puts.map((r) => r._id)).toEqual(["r1", "added"]);
    // r2 was removed on purpose; r3 is merely missing and stays on disk.
    expect(deletes).toEqual(["r2"]);
    expect(shadow.get("r1")).toBe(next.r1);
    expect(shadow.has("r2")).toBe(false);
    expect(shadow.has("r3")).toBe(true);
    const full = diffCollection(new Map(Object.entries(data)), next);
    expect(full.puts.map((r) => r._id).sort()).toEqual(["added", "r1"]);
  });

  it("costs the patched rows, not the collection", () => {
    const data = big();
    const shadow = new Map(Object.entries(data));
    let walked = 0;
    const watched = new Proxy({ ...data, r7: { _id: "r7", v: 0 } }, {
      ownKeys(t) { walked++; return Reflect.ownKeys(t); },
      getOwnPropertyDescriptor(t, k) { walked++; return Reflect.getOwnPropertyDescriptor(t, k); },
    });
    const { puts } = diffPatchedRows(shadow, watched, ["r7"], () => false);
    expect(puts).toHaveLength(1);
    // One own-property check for the one id: never an enumeration of 50k keys.
    expect(walked).toBeLessThanOrEqual(2);
  });
});

describe("coalesced meta writes", () => {
  it("writes each key's latest value once per quiet spell, and on flush", () => {
    const written: Array<[string, any]> = [];
    let fire: (() => void) | null = null;
    const w = createCoalescedWriter((k, v) => written.push([k, v]), 250, (fn) => { fire = fn; return 1; });
    for (let i = 0; i < 150; i++) w.write("pending", { n: i });
    expect(written).toEqual([]);
    fire!();
    expect(written).toEqual([["pending", { n: 149 }]]);
    w.write("pending", { n: 150 });
    w.flush();
    expect(written.at(-1)).toEqual(["pending", { n: 150 }]);
    w.write("pending", { n: 151 });
    w.drop();
    w.flush();
    expect(written).toHaveLength(2);
  });
});
