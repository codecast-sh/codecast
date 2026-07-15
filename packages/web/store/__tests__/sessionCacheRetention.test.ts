import { describe, it, expect } from "bun:test";
import { partitionSessionRetention } from "../idbCache";

// Hydration-time retention for the persisted sessions collection. The
// in-memory map is never-prune by design, so boot is the only moment the
// months-long on-disk accumulation can be shed — these tests pin down exactly
// what survives it (see partitionSessionRetention in idbCache.ts).

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const cid = (n: number) => `k${String(n).padStart(31, "0")}`; // 32-char convex-shaped id

function row(over: Record<string, any> = {}) {
  return { _id: cid(1), updated_at: NOW - DAY, ...over };
}

describe("partitionSessionRetention", () => {
  it("keeps rows inside the TTL window and drops older ones", () => {
    const fresh = row({ _id: cid(1), updated_at: NOW - 5 * DAY });
    const stale = row({ _id: cid(2), updated_at: NOW - 45 * DAY });
    const { keep, drop } = partitionSessionRetention([fresh, stale], [], null, NOW);
    expect(keep.map((r) => r._id)).toEqual([cid(1)]);
    expect(drop).toEqual([cid(2)]);
  });

  it("always keeps live-inbox rows, the focused row, pinned rows, and optimistic stubs regardless of age", () => {
    const ancient = NOW - 400 * DAY;
    const live = row({ _id: cid(1), updated_at: ancient });
    const focused = row({ _id: cid(2), updated_at: ancient });
    const pinned = row({ _id: cid(3), updated_at: ancient, is_pinned: true });
    const stub = row({ _id: "optimistic-stub-1", updated_at: ancient });
    const gone = row({ _id: cid(4), updated_at: ancient });
    const { keep, drop } = partitionSessionRetention(
      [live, focused, pinned, stub, gone],
      [cid(1)],
      cid(2),
      NOW,
    );
    expect(keep.map((r) => r._id).sort()).toEqual([cid(1), cid(2), cid(3), "optimistic-stub-1"].sort());
    expect(drop).toEqual([cid(4)]);
  });

  it("keeps stashed/dismissed rows while their stamp is inside the window (Stashed/Killed browse views)", () => {
    const stashed = row({ _id: cid(1), updated_at: NOW - 90 * DAY, inbox_stashed_at: NOW - 3 * DAY });
    const dismissed = row({ _id: cid(2), updated_at: NOW - 90 * DAY, inbox_dismissed_at: NOW - 3 * DAY });
    const agedOut = row({ _id: cid(3), updated_at: NOW - 90 * DAY, inbox_dismissed_at: NOW - 60 * DAY });
    const { keep, drop } = partitionSessionRetention([stashed, dismissed, agedOut], [], null, NOW);
    expect(keep.map((r) => r._id).sort()).toEqual([cid(1), cid(2)].sort());
    expect(drop).toEqual([cid(3)]);
  });

  it("caps windowed survivors newest-first but never evicts the always-keep set", () => {
    const rows = [];
    for (let i = 0; i < 1500; i++) rows.push(row({ _id: cid(i), updated_at: NOW - i * 1000 }));
    // An ancient pinned row would lose a pure recency contest — it must survive.
    rows.push(row({ _id: cid(9000), updated_at: NOW - 29 * DAY, is_pinned: true }));
    const { keep, drop } = partitionSessionRetention(rows, [], null, NOW);
    expect(keep.length).toBe(1201); // MAX_CACHED_SESSIONS + the pinned row
    expect(drop.length).toBe(300);
    expect(keep.some((r) => r._id === cid(9000))).toBe(true);
    // The dropped ones are the OLDEST of the windowed set.
    expect(drop).toContain(cid(1499));
    expect(drop).not.toContain(cid(0));
  });

  it("falls back to _creationTime when updated_at is missing", () => {
    const fresh = { _id: cid(1), _creationTime: NOW - 2 * DAY };
    const stale = { _id: cid(2), _creationTime: NOW - 60 * DAY };
    const { keep, drop } = partitionSessionRetention([fresh, stale], [], null, NOW);
    expect(keep.map((r) => r._id)).toEqual([cid(1)]);
    expect(drop).toEqual([cid(2)]);
  });
});
