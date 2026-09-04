// The cache sweep used to take 500 rows in table order and then filter by age.
// Table order is creation order, and a row created months ago but refreshed
// every day sits at the head of it forever: every sweep re-read the same live
// rows, and the genuinely stale ones further in were never reached. Ordering by
// fetched_at and bounding at the cutoff means the sweep reads only rows it is
// about to delete.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { pruneRepoCache } from "./repos";

const DAY = 24 * 60 * 60 * 1000;
const TEAM = "team_1" as any;

function row(id: string, ageDays: number) {
  return {
    _id: id,
    team_id: TEAM,
    repository: "codecast-sh/codecast",
    kind: "blob",
    ref: "main",
    path: `src/${id}.ts`,
    content: "{}",
    fetched_at: Date.now() - ageDays * DAY,
  };
}

const run = (ctx: any, args: any = {}) => (pruneRepoCache as any)._handler(ctx, args);

describe("pruneRepoCache", () => {
  test("deletes only what has gone a week without a read", async () => {
    const db = makeFakeDb({ repo_cache: [row("stale_a", 9), row("fresh", 1), row("stale_b", 30)] });
    const out = await run({ db });

    expect(out.deleted).toBe(2);
    expect(db._tables.repo_cache.map((r: any) => r._id)).toEqual(["fresh"]);
  });

  test("reads only the rows it deletes", async () => {
    // The point of the change: a cache that is mostly warm costs the sweep
    // nothing, instead of 500 reads to find nothing to do.
    const warm = Array.from({ length: 50 }, (_, i) => row(`warm_${i}`, 1));
    const db = makeFakeDb({ repo_cache: [...warm, row("stale", 40)] });
    const out = await run({ db });

    expect(out.scanned).toBe(1);
    expect(out.deleted).toBe(1);
  });

  test("takes the oldest first when there is more than one batch", async () => {
    const db = makeFakeDb({
      repo_cache: [row("newer_stale", 8), row("oldest", 400), row("middle", 60)],
    });
    const out = await run({ db }, { limit: 2 });

    expect(out.deleted).toBe(2);
    // The two oldest went; the least stale one waits for the next sweep.
    expect(db._tables.repo_cache.map((r: any) => r._id)).toEqual(["newer_stale"]);
  });

  test("an entirely warm cache is a no-op", async () => {
    const db = makeFakeDb({ repo_cache: [row("a", 0), row("b", 2)] });
    const out = await run({ db });

    expect(out).toEqual({ deleted: 0, scanned: 0 });
    expect(db._tables.repo_cache).toHaveLength(2);
  });
});
