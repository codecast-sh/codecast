import { describe, expect, test } from "bun:test";
import { narrowSessionScan, rankSessions, sessionMatchTier, sessionRankScore, sessionStanding, dropWeakHits, type SessionScan } from "../instantSessionSearch";
import { matchEntities, matchRoutines } from "../universalSearch";
import { paletteSessionPool } from "../paletteRecents";

// The palette's search shortcuts (an early stop on recency, narrowing a query
// that extends the last one, cached scopes) must answer exactly what a full
// scan answers. Each test checks them against the plain definition over
// random rows.

const WORDS = ["sync", "inbox", "sink", "review", "rev", "palette", "pal", "deploy", "store", "syncing", "asdf", "fix"];
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = () => WORDS[Math.floor(rand() * WORDS.length)];
const phrase = (n: number) => Array.from({ length: n }, pick).join(" ");
const NOW = 1_800_000_000_000;

function sessions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    _id: `s${i}`,
    title: phrase(1 + Math.floor(rand() * 4)),
    idle_summary: rand() < 0.5 ? phrase(6) : undefined,
    project_path: `/src/${pick()}`,
    updated_at: NOW - Math.floor(rand() * 90 * 86_400_000),
    inbox_stashed_at: rand() < 0.1 ? 1 : undefined,
    is_subagent: rand() < 0.1,
  })).sort((a, b) => b.updated_at - a.updated_at);
}

// The ranking as the palette defined it before its shortcuts: score every
// match, drop weak hits when enough strong ones answer, sort, cap.
function fullRank(rows: any[], q: string, cap: number) {
  const ranked: Array<{ row: any; score: number; tier: number }> = [];
  for (const row of rows) {
    const match = sessionMatchTier(row, q);
    if (!match) continue;
    ranked.push({ row, tier: match.tier, score: sessionRankScore(match, sessionStanding(row, "me", null), row.updated_at, NOW) });
  }
  const kept = dropWeakHits(ranked);
  kept.sort((a, b) => a.score - b.score || b.row.updated_at - a.row.updated_at);
  return kept.slice(0, cap).map((r) => r.row._id);
}

describe("rankSessions shortcuts", () => {
  const pool = sessions(3000);
  const standingOf = (row: any) => sessionStanding(row, "me", null);

  test("stopping early on recency ranks what a full scan ranks", () => {
    for (const q of ["", "s", "sy", "sync", "rev", "pal", "sync rev", "fix asdf", "x", "inbox store"]) {
      for (const cap of [8, 25]) {
        const fast = rankSessions(pool, q, standingOf, cap, NOW, { newestFirst: true }).map((r) => r._id);
        expect(fast).toEqual(fullRank(pool, q, cap));
      }
    }
  });

  test("a query that extends the last one ranks what a full scan ranks", () => {
    for (const word of ["sync review", "palette store", "asdf", "inbox  fix", "re"]) {
      let last: (SessionScan<any> & { pool: readonly any[] }) | null = null;
      for (let i = 1; i <= word.length; i++) {
        const q = word.slice(0, i).toLowerCase();
        const out: SessionScan<any> = { q: "", matched: [], complete: false };
        const fast = rankSessions(narrowSessionScan(pool, q, last), q, standingOf, 25, NOW, { newestFirst: true, out }).map((r) => r._id);
        last = { ...out, pool };
        expect(fast).toEqual(fullRank(pool, q, 25));
      }
    }
  });

  test("a scan that stopped early is never narrowed from", () => {
    const out: SessionScan<any> = { q: "", matched: [], complete: false };
    rankSessions(pool, "s", standingOf, 8, NOW, { newestFirst: true, out });
    expect(out.complete).toBe(false);
    expect(narrowSessionScan(pool, "sy", { ...out, pool })).toBe(pool);
  });
});

describe("entity matchers narrow without changing answers", () => {
  const records = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`t${i}`, { _id: `t${i}`, title: phrase(1 + (i % 4)), short_id: `ct-${i}`, status: i % 7 ? "open" : "dropped", updated_at: NOW - i * 1000 }]));
  const fresh = () => JSON.parse(JSON.stringify(records));

  test("matchEntities over a typed query equals a cold search at each key", () => {
    for (const word of ["sync review", "ct-12", "pal st"]) {
      for (let i = 1; i <= word.length; i++) {
        const q = word.slice(0, i);
        expect(matchEntities(records, q, undefined, 8).map((r) => r._id)).toEqual(matchEntities(fresh(), q, undefined, 8).map((r) => r._id));
      }
    }
  });

  test("matchRoutines narrows, and a query naming the kind still lists every routine", () => {
    const rows = Object.values(records).map((r: any) => ({ ...r, prompt: phrase(5), status: "active" }));
    for (const word of ["sync rev", "routines", "ro", "rou"]) {
      for (let i = 1; i <= word.length; i++) {
        const q = word.slice(0, i);
        expect(matchRoutines(rows, q, 6).map((r) => r._id)).toEqual(matchRoutines([...rows], q, 6).map((r) => r._id));
      }
    }
  });
});

describe("paletteSessionPool", () => {
  const row = (id: string, at: number, extra = {}) => ({ _id: id, user_id: "me", updated_at: at, ...extra });
  const state = (sessions: any[], index: any[]) => ({
    sessions: Object.fromEntries(sessions.map((s) => [s._id, s])),
    sessionIndex: Object.fromEntries(index.map((s) => [s._id, s])),
    clientState: { ui: { inbox_scope: "mine" as const } },
    currentUser: { _id: "me" },
    teamInboxIds: new Set<string>(),
    currentSessionId: null,
  }) as any;

  test("newest first, live rows learn their origin, and the same sources give the same rows", () => {
    const live = [row("a", 30), row("b", 10)];
    const index = [{ _id: "b", updated_at: 10, first_prompt: "began" }, { _id: "c", updated_at: 20, first_prompt: "old" }];
    const first = paletteSessionPool(state(live, index), undefined);
    expect(first.map((r) => r._id)).toEqual(["a", "c", "b"]);
    expect(first.find((r) => r._id === "b")!.first_prompt).toBe("began");
    expect(first.find((r) => r._id === "c")!.user_id).toBe("me");
    // Rebuilt state objects holding the same rows: the same pool, same objects.
    const again = paletteSessionPool(state(live, index), undefined);
    expect(again).toBe(first);
    // One row moves: the others keep their objects, so their search entries hold.
    const moved = paletteSessionPool(state([row("a", 30), { ...live[1], updated_at: 40 }], index), undefined);
    expect(moved.map((r) => r._id)).toEqual(["b", "a", "c"]);
    expect(moved.find((r) => r._id === "c")).toBe(first.find((r) => r._id === "c"));
  });
});

describe("withFavorites", () => {
  test("adds only the favorites the pool lacks, less exclusions, after the pool", async () => {
    const { withFavorites } = await import("../paletteQuery");
    const pool = [{ _id: "a" }, { _id: "b" }];
    expect(withFavorites(pool, [{ _id: "b" }])).toBe(pool);
    expect(withFavorites(pool, [{ _id: "c" }, { _id: "a" }, { _id: "d" }], ["d"]).map((r) => r._id)).toEqual(["a", "b", "c"]);
  });
});

describe("paletteSessionPool patching", () => {
  const st = (sessions: any[], index: any, server?: any) => ({
    sessions: Object.fromEntries(sessions.map((s) => [s._id, s])),
    sessionIndex: index,
    clientState: { ui: { inbox_scope: "mine" as const } },
    currentUser: { _id: "me" },
    teamInboxIds: new Set<string>(),
    currentSessionId: null,
  }) as any;

  test("a pool patched for moved live rows equals one merged from scratch", () => {
    let index: Record<string, any> = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`x${i}`, { _id: `x${i}`, updated_at: 1000 - i, first_prompt: `p${i}` }]));
    let server: any[] = [];
    let live = Array.from({ length: 50 }, (_, i) => ({ _id: i % 3 ? `l${i}` : `x${i}`, user_id: "me", updated_at: 2000 - i * 7 }));
    paletteSessionPool(st(live, index), undefined);
    for (let round = 0; round < 6; round++) {
      // Some rows beat, one leaves the cache, one is new.
      live = live.filter((_, i) => i !== round).map((r, i) => (i % 4 === round % 4 ? { ...r, updated_at: r.updated_at + 500 + i } : r));
      live.push({ _id: `n${round}`, user_id: "me", updated_at: 1500 + round });
      // The index syncs (one row edited, one gone) and the server's recents land.
      index = { ...index, [`x${round + 100}`]: { _id: `x${round + 100}`, updated_at: 3000 + round, first_prompt: "edited" } };
      delete index[`x${round + 200}`];
      server = [{ _id: `x${round}`, updated_at: 2500, title: `server ${round}` }, { _id: `s${round}`, updated_at: 900 }];
      const patched = paletteSessionPool(st(live, index), server).map((r) => [r._id, r.updated_at, r.first_prompt ?? null, r.user_id, r.title ?? null]);
      // A fresh merge: a different viewer makes the pool merge everything;
      // switching back merges again from scratch.
      paletteSessionPool({ ...st(live, index), currentUser: { _id: "other" } }, server);
      const fresh = paletteSessionPool(st(live, { ...index }), [...server]).map((r) => [r._id, r.updated_at, r.first_prompt ?? null, r.user_id, r.title ?? null]);
      expect(patched).toEqual(fresh);
    }
  });
});
