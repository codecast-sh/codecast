import { describe, expect, it } from "bun:test";
import { makeCollectionSig, rowSigExcluding, stableRefId } from "./wakeSig";

// Wake signatures decide whether a component re-renders. A signature that flips
// on churn costs frames; a signature that fails to flip on a real change renders
// stale data. These tests pin both directions.

describe("rowSigExcluding", () => {
  const deny = new Set(["last_heartbeat"]);

  it("ignores a denied churn field", () => {
    const before = rowSigExcluding({ _id: "a", title: "x", last_heartbeat: 1 }, deny);
    const after = rowSigExcluding({ _id: "a", title: "x", last_heartbeat: 2 }, deny);
    expect(after).toBe(before);
  });

  it("flips on any watched field", () => {
    const before = rowSigExcluding({ _id: "a", title: "x" }, deny);
    const after = rowSigExcluding({ _id: "a", title: "y" }, deny);
    expect(after).not.toBe(before);
  });

  it("folds an object-valued field in by reference identity", () => {
    const nested = { flags: 1 };
    const stable = rowSigExcluding({ _id: "a", meta: nested }, deny);
    expect(rowSigExcluding({ _id: "a", meta: nested }, deny)).toBe(stable);
    expect(rowSigExcluding({ _id: "a", meta: { flags: 1 } }, deny)).not.toBe(stable);
  });

  it("has a signature for an absent row", () => {
    expect(rowSigExcluding(null, deny)).toBe("none");
    expect(rowSigExcluding(undefined, deny)).toBe("none");
  });
});

describe("makeCollectionSig", () => {
  it("recomputes only when the collection reference changes", () => {
    let projections = 0;
    const sig = makeCollectionSig<{ _id: string; group: string }>((row) => {
      projections++;
      return `${row._id}:${row.group}`;
    });
    const collection = { a: { _id: "a", group: "inboxish" } };

    const first = sig(collection);
    const second = sig(collection);

    expect(second).toBe(first);
    expect(projections).toBe(1);
  });

  it("reuses projections for unchanged row references", () => {
    let projections = 0;
    const sig = makeCollectionSig<{ _id: string; group: string; beats: number }>((row) => {
      projections++;
      return `${row._id}:${row.group}`;
    });
    const a = { _id: "a", group: "one", beats: 1 };
    const b = { _id: "b", group: "two", beats: 1 };
    const first = sig({ a, b });

    const second = sig({ a, b: { ...b, beats: 2 } });

    expect(second).toBe(first);
    expect(projections).toBe(3);
  });

  it("flips when a projected field changes and holds when a churn field does", () => {
    const sig = makeCollectionSig<any>((row) => `${row._id}:${row.group}`);
    const base = sig({ a: { _id: "a", group: "one", beats: 1 } });

    expect(sig({ a: { _id: "a", group: "one", beats: 2 } })).toBe(base);
    expect(sig({ a: { _id: "a", group: "two", beats: 2 } })).not.toBe(base);
  });

  it("separates row projections so two rows cannot read as one", () => {
    const sig = makeCollectionSig<any>((row) => row.label);
    expect(sig({ a: { label: "x" }, b: { label: "y" } })).toBe("x\ny");
    expect(sig({ a: { label: "xy" } })).toBe("xy");
  });
});

describe("stableRefId", () => {
  it("gives one id per object reference", () => {
    const o = {};
    expect(stableRefId(o)).toBe(stableRefId(o));
    expect(stableRefId({})).not.toBe(stableRefId(o));
  });
});
