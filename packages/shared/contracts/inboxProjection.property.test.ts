import { describe, expect, it } from "bun:test";
import {
  INBOX_BUCKETS,
  INBOX_WINDOW_CAPS,
  WORKING_SET_RECENCY_MS,
  computeFold,
  digestProjection,
  inWorkingSet,
  inboxEpoch,
  isFoldExempt,
  placeProjectableRow,
  projectInbox,
  selectWorkingSet,
  type InboxBucket,
  type ProjectableInboxRow,
  type WorkingSetWindow,
} from "./inboxProjection";
import {
  GEN_DAY,
  GEN_HOUR,
  GEN_MIN,
  convexIdFor,
  genProjectableRows,
  makeRng,
} from "./__fixtures__/inboxProjectionGen";

// PROPERTY TESTS for the shared inbox projection (sync-convergence,
// "Validation plan"): the identities the convergence proof rests on, checked
// over generated row sets rather than one hand-built fixture. Every run is
// replayable from its seed.

const EPOCH = inboxEpoch(1_800_000_000_000);
const SEEDS = Array.from({ length: 60 }, (_, i) => 1000 + i);

function shuffled<T>(items: T[], seed: number): T[] {
  const rng = makeRng(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sortedEntries(p: ReturnType<typeof projectInbox>): string[] {
  return p.entries.map(([id, b, f]) => `${id}:${b}:${f ? 1 : 0}`).sort();
}

describe("determinism per epoch", () => {
  it("same rows and epoch, any input order: identical membership, placement, fold, tally, digest", () => {
    for (const seed of SEEDS) {
      const rows = genProjectableRows(seed, 80, EPOCH);
      const asking = new Set(rows.filter((_, i) => i % 7 === 0).map((r) => String(r._id)));
      const a = projectInbox(rows, { showOld: false }, EPOCH, { asking: (id) => asking.has(id) });
      const b = projectInbox(shuffled(rows, seed * 3), { showOld: true }, EPOCH, { asking: (id) => asking.has(id) });
      expect(sortedEntries(b)).toEqual(sortedEntries(a));
      expect(b.set_digest).toBe(a.set_digest);
      expect(b.tally).toEqual(a.tally);
      expect(b.truncated).toEqual(a.truncated);
      expect(new Map(b.placements)).toEqual(new Map(a.placements));
      // Rows that are not members never appear; every member appears once.
      expect(a.entries.length).toBe(a.placements.size);
      expect(a.placements.size).toBe(selectWorkingSet(rows, EPOCH).members.size);
    }
  });

  it("copying the rows (fresh object identities) changes nothing — the projection reads values, not refs", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const rows = genProjectableRows(seed, 60, EPOCH);
      const copies = rows.map((r) => JSON.parse(JSON.stringify(r)));
      expect(projectInbox(copies, { showOld: false }, EPOCH).set_digest).toBe(projectInbox(rows, { showOld: false }, EPOCH).set_digest);
    }
  });
});

describe("the fold", () => {
  it("never changes membership or buckets: shown + folded per bucket equals the placed count", () => {
    for (const seed of SEEDS) {
      const rows = genProjectableRows(seed, 100, EPOCH);
      const p = projectInbox(rows, { showOld: false }, EPOCH);
      const counted: Record<string, number> = {};
      for (const [, b] of p.entries) counted[b] = (counted[b] ?? 0) + 1;
      for (const b of INBOX_BUCKETS) {
        const expected = b === "hidden" ? 0 : (counted[b] ?? 0);
        expect(p.tally.shown[b] + p.tally.folded[b]).toBe(expected);
      }
      // The fold flag on every entry agrees with computeFold over the selection.
      const { members } = selectWorkingSet(rows, EPOCH);
      const { belowFold } = computeFold(members, EPOCH);
      for (const [id, , fold] of p.entries) expect(fold).toBe(belowFold.has(id));
    }
  });

  it("only recent-only members fold; a deliberate seat or queued work is always above the fold", () => {
    for (const seed of SEEDS) {
      const rows = genProjectableRows(seed, 100, EPOCH);
      const p = projectInbox(rows, { showOld: false }, EPOCH);
      for (const [id, , fold] of p.entries) {
        if (!fold) continue;
        const row = rows.find((r) => String(r._id) === id)!;
        expect(isFoldExempt(row, p.windows.get(id))).toBe(false);
        expect(!!row.has_pending_messages).toBe(false);
      }
    }
  });

  it("a fold flip on any single entry changes the digest; unchanged buckets are not enough to hide it", () => {
    for (const seed of SEEDS.slice(0, 30)) {
      const rows = genProjectableRows(seed, 40, EPOCH);
      const p = projectInbox(rows, { showOld: false }, EPOCH);
      const base = digestProjection(p.entries);
      expect(base).toBe(p.set_digest);
      for (let i = 0; i < p.entries.length; i++) {
        const flipped = p.entries.map(([id, b, f], j) => [id, b, j === i ? !f : f] as const);
        expect(digestProjection(flipped)).not.toBe(base);
      }
    }
  });

  it("the cut sits at a gap wider than 12h and nothing at or above the cut folds", () => {
    for (const seed of SEEDS) {
      const rows = genProjectableRows(seed, 100, EPOCH);
      const { members } = selectWorkingSet(rows, EPOCH);
      const { belowFold, cutoff } = computeFold(members, EPOCH);
      if (cutoff === 0) {
        expect(belowFold.size).toBe(0);
        continue;
      }
      const recentOnly = [...members.values()].filter((m) => !isFoldExempt(m.row, m.windows));
      // The cutoff is the activity time of the row AT the gap (it never folds
      // itself); the nearest recent-only activity strictly above it is more
      // than 12h away.
      expect(recentOnly.some((m) => m.row.updated_at === cutoff)).toBe(true);
      const above = recentOnly.filter((m) => m.row.updated_at > cutoff).map((m) => m.row.updated_at).sort((a, b) => a - b);
      expect(above[0] - cutoff).toBeGreaterThan(12 * GEN_HOUR);
      for (const id of belowFold) expect(members.get(id)!.row.updated_at).toBeLessThan(cutoff);
    }
  });
});

describe("truncation flags", () => {
  const WINDOWS = Object.keys(INBOX_WINDOW_CAPS) as WorkingSetWindow[];

  function rowsIn(window: WorkingSetWindow, n: number): ProjectableInboxRow[] {
    return Array.from({ length: n }, (_, i) => {
      const base: ProjectableInboxRow = { _id: convexIdFor(`${window}${i}`), status: "active", updated_at: EPOCH - 40 * GEN_DAY, message_count: 3, is_idle: true };
      switch (window) {
        case "recent": return { ...base, updated_at: EPOCH - GEN_MIN - i * 1000 };
        case "pinned": return { ...base, inbox_pinned_at: EPOCH - GEN_HOUR - i * 1000 };
        case "dismissed": return { ...base, inbox_dismissed_at: EPOCH - GEN_HOUR - i * 1000 };
        case "stashed": return { ...base, inbox_stashed_at: EPOCH - GEN_HOUR - i * 1000 };
        case "owned": return { ...base, updated_at: EPOCH - GEN_MIN - i * 1000, owned_by_me: true };
      }
    });
  }

  it("every window is silent AT its cap and fires at cap + 1, and only that window fires", () => {
    for (const w of WINDOWS) {
      const cap = INBOX_WINDOW_CAPS[w];
      const atCap = selectWorkingSet(rowsIn(w, cap), EPOCH);
      // owned rows are recent-eligible too; the recent cap is the same size, so
      // it stays silent at the owned cap as well.
      expect(atCap.truncated).toEqual([]);
      expect(atCap.members.size).toBe(cap);
      const over = selectWorkingSet(rowsIn(w, cap + 1), EPOCH);
      const expected = w === "owned" ? ["recent", "owned"] : [w];
      expect(over.truncated).toEqual(expected);
      expect(over.members.size).toBe(cap);
      for (const id of over.members.keys()) expect(inWorkingSet(over.members.get(id)!.row, EPOCH)).toContain(w);
    }
  });

  it("an overflowing ordered window keeps its newest K by the window's own sort key", () => {
    for (const w of WINDOWS.filter((x) => x !== "owned")) {
      const cap = INBOX_WINDOW_CAPS[w];
      const rows = shuffled(rowsIn(w, cap + 25), 7);
      const { members } = selectWorkingSet(rows, EPOCH);
      const key = (r: ProjectableInboxRow) =>
        w === "recent" ? r.updated_at : w === "pinned" ? r.inbox_pinned_at! : w === "dismissed" ? r.inbox_dismissed_at! : r.inbox_stashed_at!;
      const kept = [...members.values()].map((m) => key(m.row)).sort((a, b) => b - a);
      const all = rows.map(key).sort((a, b) => b - a);
      expect(kept).toEqual(all.slice(0, cap));
    }
  });

  it("projectInbox reports the same flags as the selection it ran", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const rows = [...genProjectableRows(seed, 30, EPOCH), ...rowsIn("stashed", INBOX_WINDOW_CAPS.stashed + 1)];
      expect(projectInbox(rows, { showOld: false }, EPOCH).truncated).toEqual(selectWorkingSet(rows, EPOCH).truncated);
    }
  });
});

describe("epoch monotonicity", () => {
  it("advancing the epoch never adds a member: recency only expires, pins and hides hold their seats", () => {
    for (const seed of SEEDS) {
      const rows = genProjectableRows(seed, 80, EPOCH);
      const now = selectWorkingSet(rows, EPOCH).members;
      for (const step of [GEN_MIN, GEN_HOUR, GEN_DAY, 10 * GEN_DAY, WORKING_SET_RECENCY_MS]) {
        const later = selectWorkingSet(rows, EPOCH + step).members;
        for (const id of later.keys()) expect(now.has(id)).toBe(true);
      }
    }
  });

  it("a row's placement depends on the epoch only through the loop wake and the park/verdict clocks", () => {
    // With no loop state, moving the epoch inside the same minute-grid never
    // changes a bucket (the trust decay is the caller's, applied before the
    // shared module sees the row).
    for (const seed of SEEDS.slice(0, 20)) {
      const rows = genProjectableRows(seed, 50, EPOCH).filter((r) => !r.loop_state);
      for (const r of rows) {
        const a = placeProjectableRow(r, false, EPOCH);
        const b = placeProjectableRow(r, false, EPOCH + 5 * GEN_MIN);
        expect(b).toEqual(a);
      }
    }
  });
});

describe("the digest", () => {
  it("is order independent and 16 lowercase hex characters over any generated set", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const p = projectInbox(genProjectableRows(seed, 70, EPOCH), { showOld: false }, EPOCH);
      expect(p.set_digest).toMatch(/^[0-9a-f]{16}$/);
      expect(digestProjection(shuffled(p.entries, seed))).toBe(p.set_digest);
    }
  });

  it("hidden rows are in the digest but never in a tally", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const p = projectInbox(genProjectableRows(seed, 70, EPOCH), { showOld: false }, EPOCH);
      const hidden = p.entries.filter(([, b]) => b === "hidden");
      if (hidden.length === 0) continue;
      const without = p.entries.filter(([, b]) => b !== "hidden");
      expect(digestProjection(without)).not.toBe(p.set_digest);
      expect(p.tally.shown.hidden + p.tally.folded.hidden).toBe(0);
    }
  });

  it("a bucket change on any single member changes the digest", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const p = projectInbox(genProjectableRows(seed, 30, EPOCH), { showOld: false }, EPOCH);
      for (let i = 0; i < p.entries.length; i++) {
        const [, bucket] = p.entries[i];
        const other: InboxBucket = bucket === "working" ? "done" : "working";
        const changed = p.entries.map(([id, b, f], j) => [id, j === i ? other : b, f] as const);
        expect(digestProjection(changed)).not.toBe(p.set_digest);
      }
    }
  });
});
