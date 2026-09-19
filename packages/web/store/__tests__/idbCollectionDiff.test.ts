import { beforeEach, describe, expect, it } from "bun:test";
import { _resetSnapshotLedger, cacheFloorUnderSnapshot, diffCollection, durableDeletes, keysWithSnapshotDrops, noteSnapshotSync } from "../idbCollectionDiff";

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

// Convex-shaped ids: the rule protects SERVER rows; a stub id always deletes.
const A = "k97aaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const B = "k97bbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

describe("durableDeletes — which store shrinks reach disk", () => {
  beforeEach(() => _resetSnapshotLedger());

  it("keeps a server row that merely went missing from the store", () => {
    const shadow = new Map([[A, { _id: A }], [B, { _id: B }]]);
    const next = new Map([[A, shadow.get(A)]]);
    expect(durableDeletes("sessions", [B], {}, shadow, next)).toEqual([]);
    expect(next.has(B)).toBe(true); // still tracked, so a later change re-diffs it
  });

  it("deletes a row a snapshot sync dropped, once", () => {
    const shadow = new Map([[A, { _id: A }], [B, { _id: B }]]);
    noteSnapshotSync("sessionDecisions", [A], [B]);
    const next = new Map([[A, shadow.get(A)]]);
    expect(durableDeletes("sessionDecisions", [B], {}, shadow, next)).toEqual([B]);
    expect(next.has(B)).toBe(false);
    // The authorization is spent: the same id missing again is an ordinary shrink.
    expect(durableDeletes("sessionDecisions", [B], {}, shadow, new Map())).toEqual([]);
  });

  it("is per collection, and a row the server sends again is no longer dropped", () => {
    noteSnapshotSync("sessionDecisions", [A], [B]);
    expect(durableDeletes("savedViews", [B], {}, new Map([[B, {}]]), new Map())).toEqual([]);
    noteSnapshotSync("sessionDecisions", [A, B], []);
    expect(durableDeletes("sessionDecisions", [B], {}, new Map([[B, {}]]), new Map())).toEqual([]);
  });

  it("still honors an exclude and a client-minted stub id", () => {
    expect(durableDeletes("sessions", [A], { [`sessions:${A}`]: { type: "exclude" } }, undefined, new Map())).toEqual([A]);
    expect(durableDeletes("sessions", ["temp_1"], {}, undefined, new Map())).toEqual(["temp_1"]);
  });
});

describe("cacheFloorUnderSnapshot — hydration under a landed snapshot", () => {
  beforeEach(() => _resetSnapshotLedger());

  it("is the whole cache until a snapshot lands (windowed payloads need the floor)", () => {
    const cached = { [A]: { _id: A }, [B]: { _id: B } };
    expect(cacheFloorUnderSnapshot("tasks", cached, { [A]: { _id: A } })).toBe(cached);
  });

  it("drops cached server rows the landed snapshot omits, keeps stubs, and frees them on disk", () => {
    const cached = { [A]: { _id: A }, [B]: { _id: B }, temp_1: { _id: "temp_1" } };
    noteSnapshotSync("sessionDecisions", [A], []);
    const floor = cacheFloorUnderSnapshot("sessionDecisions", cached, { [A]: { _id: A } });
    expect(Object.keys(floor)).toEqual(["temp_1"]);
    expect(durableDeletes("sessionDecisions", [B], {}, new Map([[B, cached[B]]]), new Map())).toEqual([B]);
  });

  it("an EMPTY landed snapshot still counts: nothing cached comes back", () => {
    noteSnapshotSync("sessionDecisions", [], []);
    expect(cacheFloorUnderSnapshot("sessionDecisions", { [A]: { _id: A } }, {})).toEqual({});
  });

  it("rows hidden by the floor wait as unspent drops until one write settles the collection", () => {
    noteSnapshotSync("sessionDecisions", [A], []);
    cacheFloorUnderSnapshot("sessionDecisions", { [A]: { _id: A }, [B]: { _id: B } }, { [A]: { _id: A } });
    // The post-hydration flush reads this list to clear the disk at once.
    expect(keysWithSnapshotDrops()).toEqual(["sessionDecisions"]);
    durableDeletes("sessionDecisions", [B], {}, new Map([[B, {}]]), new Map());
    expect(keysWithSnapshotDrops()).toEqual([]);
  });

  it("ignores a collection with no disk table, so the ledger cannot grow unspent", () => {
    noteSnapshotSync("pendingMessageStatus", [], [A]);
    expect(keysWithSnapshotDrops()).toEqual([]);
    expect(cacheFloorUnderSnapshot("pendingMessageStatus", { [A]: { _id: A } }, {})).toEqual({ [A]: { _id: A } });
  });
});
