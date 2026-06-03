import { describe, expect, it } from "bun:test";
import { diffCollection } from "../idbCollectionDiff";

describe("diffCollection", () => {
  it("writes every row when there is no prior persisted state", () => {
    const a = { _id: "a" };
    const b = { _id: "b" };
    const { puts, deletes, next } = diffCollection(undefined, { a, b });
    expect(puts).toEqual([a, b]);
    expect(deletes).toEqual([]);
    expect([...next.keys()]).toEqual(["a", "b"]);
  });

  it("writes NOTHING when every row reference is unchanged", () => {
    // applySyncTable reuses the prior row reference when nothing the UI renders
    // changed, so a stable ref must mean a stable row and therefore no disk write.
    // This is the property that kills the constant clear()+re-pour churn.
    const a = { _id: "a", v: 1 };
    const b = { _id: "b", v: 1 };
    const prev = new Map([["a", a], ["b", b]]);
    const { puts, deletes } = diffCollection(prev, { a, b });
    expect(puts).toEqual([]);
    expect(deletes).toEqual([]);
  });

  it("writes only the row whose reference changed", () => {
    const a = { _id: "a", v: 1 };
    const b = { _id: "b", v: 1 };
    const prev = new Map([["a", a], ["b", b]]);
    const bUpdated = { _id: "b", v: 2 };
    const { puts, deletes } = diffCollection(prev, { a, b: bUpdated });
    expect(puts).toEqual([bUpdated]);
    expect(deletes).toEqual([]);
  });

  it("deletes only the row that disappeared — no full-table clear", () => {
    const a = { _id: "a" };
    const b = { _id: "b" };
    const prev = new Map([["a", a], ["b", b]]);
    const { puts, deletes, next } = diffCollection(prev, { a });
    expect(puts).toEqual([]);
    expect(deletes).toEqual(["b"]);
    expect([...next.keys()]).toEqual(["a"]);
  });

  it("handles a simultaneous add, update, and prune in one diff", () => {
    const a = { _id: "a", v: 1 };
    const b = { _id: "b", v: 1 };
    const prev = new Map([["a", a], ["b", b]]);
    const aUpdated = { _id: "a", v: 2 };
    const c = { _id: "c" };
    const { puts, deletes } = diffCollection(prev, { a: aUpdated, c });
    expect(puts).toEqual([aUpdated, c]);
    expect(deletes).toEqual(["b"]);
  });
});
