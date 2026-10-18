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

  it("reads each row once per denylist and recomputes for a new row ref", () => {
    let reads = 0;
    const row = { _id: "a", get title() { reads++; return "x"; } };
    const first = rowSigExcluding(row, deny);
    expect(rowSigExcluding(row, deny)).toBe(first);
    expect(reads).toBe(1);
    rowSigExcluding(row, new Set(["_id"]));
    expect(reads).toBe(2);
    expect(rowSigExcluding({ ...row }, deny)).toBe(first);
    expect(reads).toBe(3);
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
    expect(sig({ a: { label: "x" }, b: { label: "y" } })).not.toBe(sig({ a: { label: "xy" } }));
    expect(sig({ a: { label: "x" }, b: { label: "y" } })).not.toBe(sig({ a: { label: "y" }, b: { label: "x" } }));
  });

  it("projects a set's members once, not on every rebuild", () => {
    let projections = 0;
    const sig = makeCollectionSig<boolean>(() => { projections++; return ""; });
    const set = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, true]));
    const first = sig(set);
    expect(projections).toBe(100);
    expect(sig({ ...set })).toBe(first);
    expect(projections).toBe(100);
    expect(sig({ ...set, k100: true })).not.toBe(first);
    expect(projections).toBe(101);
  });

  it("leaves out a row whose projection is null", () => {
    const sig = makeCollectionSig<any>((row) => (row.keep ? row.label : null));
    const base = sig({ a: { keep: true, label: "x" } });
    expect(sig({ a: { keep: true, label: "x" }, b: { keep: false, label: "y" } })).toBe(base);
    expect(sig({ a: { keep: true, label: "x" }, b: { keep: true, label: "y" } })).not.toBe(base);
  });

  it("is a short digest that ignores key order", () => {
    const sig = makeCollectionSig<any>((row) => row.label);
    const rows = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, { label: `row ${i} with a longish projection` }]));
    const reversed = Object.fromEntries(Object.entries(rows).reverse());
    expect(sig(rows).length).toBeLessThan(32);
    expect(sig(reversed)).toBe(sig(rows));
    expect(sig({ ...rows, k7: { label: "moved" } })).not.toBe(sig(rows));
    const { k9: _gone, ...fewer } = rows;
    expect(sig(fewer)).not.toBe(sig(rows));
  });
});

describe("stableRefId", () => {
  it("gives one id per object reference", () => {
    const o = {};
    expect(stableRefId(o)).toBe(stableRefId(o));
    expect(stableRefId({})).not.toBe(stableRefId(o));
  });
});

describe("collection snapshot reuse", () => {
  it("does not enumerate a prior snapshot when React revisits it", () => {
    let enumerations = 0;
    const before = new Proxy({ a: { label: "Before" } }, {
      ownKeys(target) { enumerations++; return Reflect.ownKeys(target); },
    });
    const after = { a: { label: "After" } };
    const sig = makeCollectionSig((row: { label: string }) => row.label);
    const beforeSig = sig(before);
    const afterSig = sig(after);
    expect(afterSig).not.toBe(beforeSig);
    enumerations = 0;
    expect(sig(before)).toBe(beforeSig);
    expect(sig(after)).toBe(afterSig);
    expect(enumerations).toBe(0);
  });

  it("reuses an empty signature and notices added and removed rows", () => {
    const sig = makeCollectionSig((row: { label: string }) => row.label);
    const empty = {};
    const one = { a: { label: "A" } };
    const two = { ...one, b: { label: "B" } };
    const [e, o, t] = [sig(empty), sig(one), sig(two)];
    expect(new Set([e, o, t]).size).toBe(3);
    expect(sig({ a: { label: "A" } })).toBe(o);
    expect(sig({})).toBe(e);
  });
});
