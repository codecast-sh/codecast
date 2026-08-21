import { describe, expect, it } from "bun:test";
import { partitionCacheRetention, type CacheRetentionPolicy } from "./cacheRetention";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 100 * DAY;

const policy = (over?: Partial<CacheRetentionPolicy>): CacheRetentionPolicy => ({
  ttlMs: 30 * DAY,
  maxRows: 3,
  alwaysKeep: (row) => !!row.pinned,
  stampedAt: (row) => row.updated_at ?? 0,
  ...over,
});

const row = (id: string, updated_at: number, extra: Record<string, any> = {}) => ({
  _id: id,
  updated_at,
  ...extra,
});

describe("partitionCacheRetention", () => {
  it("keeps rows inside the TTL and drops rows outside it", () => {
    const fresh = row("fresh", NOW - DAY);
    const stale = row("stale", NOW - 40 * DAY);
    const { keep, drop } = partitionCacheRetention([fresh, stale], NOW, policy());
    expect(keep).toEqual([fresh]);
    expect(drop).toEqual(["stale"]);
  });

  it("keeps an always-keep row regardless of age", () => {
    const stalePinned = row("pin", NOW - 90 * DAY, { pinned: true });
    const { keep, drop } = partitionCacheRetention([stalePinned], NOW, policy());
    expect(keep).toEqual([stalePinned]);
    expect(drop).toEqual([]);
  });

  it("caps the windowed survivors at maxRows, newest first, and never the always-keep set", () => {
    const rows = [
      row("a", NOW - 4 * DAY),
      row("b", NOW - DAY),
      row("c", NOW - 3 * DAY),
      row("d", NOW - 2 * DAY),
      row("pin", NOW - 5 * DAY, { pinned: true }),
    ];
    const { keep, drop } = partitionCacheRetention(rows, NOW, policy());
    expect(drop).toEqual(["a"]);
    expect(keep.map((r) => r._id)).toEqual(["pin", "b", "d", "c"]);
  });

  it("orders the cap by sortStamp when it differs from stampedAt", () => {
    const rows = [
      // Freshness rides touched_at (inside TTL for all), the cap orders by
      // updated_at.
      { _id: "a", updated_at: NOW - DAY, touched_at: NOW },
      { _id: "b", updated_at: NOW - 3 * DAY, touched_at: NOW },
      { _id: "c", updated_at: NOW - 2 * DAY, touched_at: NOW },
    ];
    const { keep, drop } = partitionCacheRetention(rows, NOW, policy({
      maxRows: 2,
      stampedAt: (r) => r.touched_at,
      sortStamp: (r) => r.updated_at,
    }));
    expect(drop).toEqual(["b"]);
    expect(keep.map((r) => r._id)).toEqual(["a", "c"]);
  });

  it("treats a missing stamp as epoch (always outside the TTL)", () => {
    const { keep, drop } = partitionCacheRetention([{ _id: "x" }], NOW, policy());
    expect(keep).toEqual([]);
    expect(drop).toEqual(["x"]);
  });
});
