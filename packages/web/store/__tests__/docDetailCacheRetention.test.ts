import { describe, it, expect } from "bun:test";
import {
  partitionDocDetailRetention,
  MAX_CACHED_DOC_DETAILS,
  DOC_DETAIL_CACHE_TTL_MS,
} from "../cacheRetention";

// Hydration-time retention for the persisted docDetails collection (doc
// bodies). Rows enter only when a doc is opened or body-prefetched, and this
// pass is what keeps the cache an LRU of what the user reads instead of an
// append-only body archive (the exact balloon the thin docs list was split to
// avoid). See partitionDocDetailRetention in cacheRetention.ts.

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const cid = (n: number) => `d${String(n).padStart(31, "0")}`; // 32-char convex-shaped id

function row(over: Record<string, any> = {}) {
  return { _id: cid(1), updated_at: NOW - DAY, content: "body", ...over };
}

describe("partitionDocDetailRetention", () => {
  it("keeps rows opened inside the TTL and drops ones idle past it", () => {
    const fresh = row({ _id: cid(1), _cachedAt: NOW - 5 * DAY });
    const stale = row({ _id: cid(2), _cachedAt: NOW - 45 * DAY, updated_at: NOW - 45 * DAY });
    const { keep, drop } = partitionDocDetailRetention([fresh, stale], NOW);
    expect(keep.map((r) => r._id)).toEqual([cid(1)]);
    expect(drop).toEqual([cid(2)]);
  });

  it("a recent open (_cachedAt) rescues a doc whose own updated_at is ancient", () => {
    const oldDocReadYesterday = row({ _id: cid(1), updated_at: NOW - 200 * DAY, _cachedAt: NOW - DAY });
    const { keep, drop } = partitionDocDetailRetention([oldDocReadYesterday], NOW);
    expect(keep.map((r) => r._id)).toEqual([cid(1)]);
    expect(drop).toEqual([]);
  });

  it("rows from older builds without _cachedAt fall back to updated_at", () => {
    const legacyFresh = row({ _id: cid(1), updated_at: NOW - 2 * DAY });
    const legacyStale = row({ _id: cid(2), updated_at: NOW - DOC_DETAIL_CACHE_TTL_MS - DAY });
    const { keep, drop } = partitionDocDetailRetention([legacyFresh, legacyStale], NOW);
    expect(keep.map((r) => r._id)).toEqual([cid(1)]);
    expect(drop).toEqual([cid(2)]);
  });

  it("always keeps pinned docs and optimistic stubs regardless of age", () => {
    const ancient = NOW - 400 * DAY;
    const pinned = row({ _id: cid(1), updated_at: ancient, pinned: true });
    const stub = row({ _id: "temp_123", updated_at: ancient });
    const { keep, drop } = partitionDocDetailRetention([pinned, stub], NOW);
    expect(keep.map((r) => r._id).sort()).toEqual(["temp_123", cid(1)].sort());
    expect(drop).toEqual([]);
  });

  it("caps the cache at the most recently opened MAX rows", () => {
    const rows = Array.from({ length: MAX_CACHED_DOC_DETAILS + 50 }, (_, i) =>
      row({ _id: cid(i), _cachedAt: NOW - i * 60_000 })
    );
    const { keep, drop } = partitionDocDetailRetention(rows, NOW);
    expect(keep.length).toBe(MAX_CACHED_DOC_DETAILS);
    expect(drop.length).toBe(50);
    // The newest-opened survive; the oldest 50 are the ones shed.
    expect(keep.some((r) => r._id === cid(0))).toBe(true);
    expect(drop).toContain(cid(MAX_CACHED_DOC_DETAILS + 49));
  });
});
