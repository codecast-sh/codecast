import { describe, it, expect } from "bun:test";
import { partitionSessionRetention, expireExcludeTombstones } from "../idbCache";
import { admitUnheldSessions, MAX_CACHED_SESSIONS } from "../cacheRetention";

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

describe("expireExcludeTombstones", () => {
  it("drops excludes past the window, keeps recent ones", () => {
    const pending = {
      "sessions:a": { type: "exclude", ts: NOW - 45 * DAY },
      "sessions:b": { type: "exclude", ts: NOW - 5 * DAY },
    };
    const cleaned = expireExcludeTombstones(pending, NOW);
    expect(Object.keys(cleaned)).toEqual(["sessions:b"]);
  });

  it("stamps legacy excludes without a timestamp instead of dropping them", () => {
    const pending = { "tasks:a": { type: "exclude" } };
    const cleaned = expireExcludeTombstones(pending, NOW);
    expect(cleaned["tasks:a"]).toEqual({ type: "exclude", ts: NOW });
  });

  it("never expires include/field entries, however old", () => {
    const pending = {
      "sessions:a": { type: "include", ts: NOW - 400 * DAY },
      "sessions:b:title": { type: "field", value: "x", ts: NOW - 400 * DAY },
    };
    const cleaned = expireExcludeTombstones(pending, NOW);
    expect(Object.keys(cleaned).sort()).toEqual(["sessions:a", "sessions:b:title"]);
  });
});

// What a change stream may add in-session. The map never prunes, so the rule
// is the hydration policy asked ahead of time (admitUnheldSessions).
describe("admitUnheldSessions", () => {
  const stale = row({ _id: cid(9001), updated_at: NOW - 60 * DAY, inbox_dismissed_at: NOW - 40 * DAY });
  const fresh = row({ _id: cid(9002), updated_at: NOW - 2 * DAY });

  it("leaves out a session hydration would drop for age", () => {
    expect(admitUnheldSessions([stale, fresh], [], [], null, NOW)).toEqual([fresh]);
  });

  it("admits an old session the server lists in the live inbox, or that is pinned", () => {
    const pinned = { ...stale, _id: cid(9003), is_pinned: true };
    expect(admitUnheldSessions([stale, pinned], [], [stale._id], null, NOW)).toEqual([stale, pinned]);
  });

  it("leaves out a session inside the TTL once the replica already holds the cap of newer ones", () => {
    const held = Array.from({ length: MAX_CACHED_SESSIONS }, (_, i) => row({ _id: cid(i + 1), updated_at: NOW - DAY }));
    const weekOld = row({ _id: cid(9004), updated_at: NOW - 7 * DAY });
    const brandNew = row({ _id: cid(9005), updated_at: NOW });
    expect(admitUnheldSessions([weekOld, brandNew], held, [], null, NOW)).toEqual([brandNew]);
  });

  it("admits a row with no stamps: it cannot be judged old", () => {
    const bare = { _id: cid(9006) };
    expect(admitUnheldSessions([bare], [], [], null, NOW)).toEqual([bare]);
  });
});
