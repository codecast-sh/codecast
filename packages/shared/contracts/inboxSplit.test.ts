import { describe, expect, it } from "bun:test";
import { INBOX_SPLIT_HOT_MS, isHotRow, rebuildRows, rowHash, splitRows, stableStringify, type SplitCache } from "./inboxSplit";

const NOW = 1_800_000_000_000;
const old = (id: string, extra: Record<string, unknown> = {}) => [id, { _id: id, updated_at: NOW - 3 * INBOX_SPLIT_HOT_MS, n: 1, ...extra }] as [string, any];
const recent = (id: string) => [id, { _id: id, updated_at: NOW - 1000 }] as [string, any];

describe("stableStringify", () => {
  it("preserves canonical bytes for nested values, escapes and sparse arrays", () => {
    expect(stableStringify({ z: undefined, b: [undefined, 12n, NaN, "a\n\""], a: {} }))
      .toBe('{"a":{},"b":[null,"12",null,"a\\n\\\""]}');
    const sparse = new Array(3);
    sparse[1] = undefined;
    expect(stableStringify(sparse)).toBe("[,null,]");
    expect(stableStringify([])).toBe("[]");
  });
  it("ignores key order and undefined fields, as the wire does", () => {
    expect(stableStringify({ b: 1, a: [{ y: 2, x: undefined, z: null }] })).toBe(stableStringify({ a: [{ z: null, y: 2 }], b: 1 }));
    expect(rowHash({ a: 1 })).not.toBe(rowHash({ a: 2 }));
  });
});

describe("isHotRow", () => {
  it("is hot for a recent stamp or a deadline ahead, cold otherwise; counts are not stamps", () => {
    expect(isHotRow({ updated_at: NOW - 1000 }, NOW)).toBe(true);
    expect(isHotRow({ updated_at: NOW - 3 * INBOX_SPLIT_HOT_MS, daemon_alive_until: NOW + 60_000 }, NOW)).toBe(true);
    expect(isHotRow({ updated_at: NOW - 3 * INBOX_SPLIT_HOT_MS, message_count: 4_000 }, NOW)).toBe(false);
  });
});

describe("splitRows / rebuildRows", () => {
  it("ships hot rows only and rebuilds the whole ordered set from a cache that holds the rest", () => {
    const rows = [old("a"), recent("b"), old("c")];
    const split = splitRows(rows, NOW);
    expect(split.ids).toEqual(["a", "b", "c"]);
    expect(split.hot.map(([id]) => id)).toEqual(["b"]);
    const cache: SplitCache<any> = new Map();
    expect(rebuildRows(split, cache)).toBeNull(); // nothing held yet
    for (const [id, row] of rows) cache.set(id, { row, hash: rowHash(row) });
    expect(rebuildRows(split, cache)).toEqual(rows);
  });

  it("refuses a cache holding an older version of a cold row", () => {
    const cache: SplitCache<any> = new Map();
    for (const [id, row] of [old("a"), old("c")]) cache.set(id, { row, hash: rowHash(row) });
    expect(rebuildRows(splitRows([old("a", { n: 2 }), old("c")], NOW), cache)).toBeNull();
  });

  it("keeps a row that cooled off from its last hot push, and drops rows the result no longer lists", () => {
    const cache: SplitCache<any> = new Map();
    const a = old("a");
    cache.set("a", { row: a[1], hash: rowHash(a[1]) });
    const b = recent("b");
    expect(rebuildRows(splitRows([a, b], NOW), cache)).toEqual([a, b]);
    // b is unchanged but now outside the window: rebuilt from the cache.
    const later = NOW + 2 * INBOX_SPLIT_HOT_MS;
    expect(rebuildRows(splitRows([a, b], later), cache)).toEqual([a, b]);
    expect(rebuildRows(splitRows([b], later), cache)).toEqual([b]);
    expect(cache.has("a")).toBe(false);
  });
});
