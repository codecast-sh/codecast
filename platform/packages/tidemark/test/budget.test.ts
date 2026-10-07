import { describe, expect, test, setDefaultTimeout } from 'bun:test';

const partial = (fields: object) => expect.objectContaining(fields);

import { budgetCover, dedupeOverlappingLeaves, fillBudgetNewestFirst, resolveBudget, splitRecentOlder } from '../src/budget';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

describe('resolveBudget', () => {
  test('defaults: 32 lines, 100k tokens split 50/30/20', () => {
    expect(resolveBudget()).toEqual({ coverLines: 32, maxCoverLines: 96, tokens: 100_000, rawTokens: 50_000, recentTokens: 30_000, olderTokens: 20_000, rawWindow: undefined });
  });

  test('the first layer that defines a field wins, field by field', () => {
    const b = resolveBudget({ coverLines: 8 }, { coverLines: 16, tokens: 1000 }, { tokens: 5000, rawWindow: { kind: 'tokens' } });
    expect(b).toEqual(partial({ coverLines: 8, tokens: 1000, rawTokens: 500, rawWindow: { kind: 'tokens' } }));
    expect(resolveBudget(undefined, { coverLines: 4 }).coverLines).toBe(4);
  });

  test('line budgets are whole numbers from 1 to 1024', () => {
    expect(resolveBudget({ coverLines: 0 }).coverLines).toBe(1);
    expect(resolveBudget({ coverLines: -9 }).coverLines).toBe(1);
    expect(resolveBudget({ coverLines: 7.9 }).coverLines).toBe(7);
    expect(resolveBudget({ coverLines: 1e9 }).coverLines).toBe(96);
    expect(resolveBudget({ coverLines: 1e9, maxCoverLines: 1e9 }).coverLines).toBe(1024);
    expect(resolveBudget({ coverLines: NaN }).coverLines).toBe(32);
    expect(resolveBudget({ coverLines: Infinity }).coverLines).toBe(32);
    expect(resolveBudget({ coverLines: '12' as unknown as number }).coverLines).toBe(32);
    // The default ceiling holds even when a layer asks for more; raising it is explicit.
    expect(resolveBudget({ coverLines: 200 })).toEqual(expect.objectContaining({ coverLines: 96, maxCoverLines: 96 }));
    expect(resolveBudget({ coverLines: 200, maxCoverLines: 300 }).coverLines).toBe(200);
    expect(resolveBudget({ maxCoverLines: 4 })).toEqual(partial({ maxCoverLines: 4, coverLines: 4 }));
    expect(resolveBudget({ coverLines: 500 }, { maxCoverLines: 8 }).coverLines).toBe(8);
    expect(resolveBudget({ maxCoverLines: NaN }).maxCoverLines).toBe(96);
  });

  test('tokens are zero or more; a bad split falls back to the default split', () => {
    expect(resolveBudget({ tokens: 0 })).toEqual(partial({ tokens: 0, rawTokens: 0, recentTokens: 0, olderTokens: 0 }));
    expect(resolveBudget({ tokens: -100 }).tokens).toBe(0);
    expect(resolveBudget({ tokens: NaN }).tokens).toBe(100_000);
    expect(resolveBudget({ tokens: 1000, split: { raw: 10, recent: 20, older: 30 } })).toEqual(partial({ rawTokens: 100, recentTokens: 200, olderTokens: 300 }));
    for (const split of [{ raw: 60, recent: 60, older: 0 }, { raw: -1, recent: 50, older: 50 }, { raw: NaN, recent: 1, older: 1 }, { raw: Infinity, recent: 0, older: 0 }, { raw: 50 } as never]) {
      expect(resolveBudget({ tokens: 1000, split })).toEqual(partial({ rawTokens: 500, recentTokens: 300, olderTokens: 200 }));
    }
    expect(resolveBudget({ rawWindow: { kind: 'age', ms: -1 } }).rawWindow).toBeUndefined();
    expect(resolveBudget({ rawWindow: { kind: 'age', ms: 0 } }).rawWindow).toEqual({ kind: 'age', ms: 0 });
  });
});

describe('fillBudgetNewestFirst', () => {
  test('keeps a contiguous newest suffix and stops at the first line that does not fit', () => {
    expect(fillBudgetNewestFirst([5, 5, 5, 5], 12)).toEqual({ kept: [false, false, true, true], tokensUsed: 10, keptCount: 2 });
    // A small old line behind a line that did not fit is not pulled in: no holes.
    expect(fillBudgetNewestFirst([1, 50, 5, 5], 12).kept).toEqual([false, false, true, true]);
    expect(fillBudgetNewestFirst([5, 5], 10).kept).toEqual([true, true]);
    expect(fillBudgetNewestFirst([5, 5], 0).kept).toEqual([false, false]);
    expect(fillBudgetNewestFirst([5, 50], 10).kept).toEqual([false, false]);
    expect(fillBudgetNewestFirst([], 10)).toEqual({ kept: [], tokensUsed: 0, keptCount: 0 });
  });
});

describe('budgetCover', () => {
  const rows = [{ level: 4, t: 10 }, { level: 2, t: 10 }, { level: 1, t: 10 }, { level: 0, t: 10 }, { level: 0, t: 10 }];
  const tokens = (r: { t: number }) => r.t;

  test('the recent run of leaves and everything older are budgeted apart, each from its newest end', () => {
    expect(budgetCover(rows, tokens, 100, 100)).toEqual({ recent: rows.slice(3), older: rows.slice(0, 3), dropped: 0 });
  });

  test('the first block always survives; what is cut comes from the middle, oldest after the first, first', () => {
    expect(budgetCover(rows, tokens, 100, 20)).toEqual({ recent: rows.slice(3), older: [rows[0], rows[2]], dropped: 1 });
    // No older budget: the first block borrows from the recent one.
    expect(budgetCover(rows, tokens, 100, 0)).toEqual({ recent: rows.slice(3), older: [rows[0]], dropped: 2 });
  });

  test('a recent run cut short leaves nothing between it and the first block, so the kept stretch has no hole', () => {
    expect(budgetCover(rows, tokens, 10, 100)).toEqual({ recent: rows.slice(4), older: [rows[0]], dropped: 3 });
    expect(budgetCover(rows, tokens, 0, 100)).toEqual({ recent: [], older: [rows[0]], dropped: 4 });
  });

  test('a first block larger than the whole budget is kept, with how much of it fits', () => {
    expect(budgetCover(rows, tokens, 5, 3)).toEqual({ recent: [], older: [rows[0]], dropped: 4, clipFirstTo: 8 });
    expect(budgetCover(rows, tokens, 0, 0)).toEqual({ recent: [], older: [rows[0]], dropped: 4, clipFirstTo: 0 });
    expect(budgetCover(rows, tokens, -5, -5)).toEqual({ recent: [], older: [rows[0]], dropped: 4, clipFirstTo: 0 });
  });

  test('a cover with no merged block is all recent; one with no trailing leaf is all older', () => {
    const leaves = [{ level: 0, t: 1 }, { level: 0, t: 1 }, { level: 0, t: 1 }];
    expect(budgetCover(leaves, tokens, 10, 0)).toEqual({ recent: leaves, older: [], dropped: 0 });
    expect(budgetCover(leaves, tokens, 2, 0)).toEqual({ recent: [leaves[0], leaves[2]], older: [], dropped: 1 });
    expect(budgetCover(leaves, tokens, 0, 0)).toEqual({ recent: [leaves[0]], older: [], dropped: 2, clipFirstTo: 0 });
    const merged = [{ level: 2, t: 1 }, { level: 1, t: 1 }];
    expect(budgetCover(merged, tokens, 0, 10)).toEqual({ recent: [], older: merged, dropped: 0 });
    expect(budgetCover([], tokens, 10, 10)).toEqual({ recent: [], older: [], dropped: 0 });
  });

  test('at every budget the first block is kept and the rest is one stretch ending now', () => {
    const cover = [{ level: 5, t: 40 }, { level: 4, t: 7 }, { level: 3, t: 30 }, { level: 2, t: 1 }, { level: 1, t: 12 }, { level: 0, t: 9 }, { level: 0, t: 3 }];
    for (let recent = 0; recent <= 30; recent += 3) {
      for (let older = 0; older <= 100; older += 7) {
        const fit = budgetCover(cover, tokens, recent, older);
        const kept = [...fit.older, ...fit.recent];
        expect(kept[0]).toBe(cover[0]);
        // Kept after the first: a suffix of the cover.
        expect(kept.slice(1)).toEqual(cover.slice(cover.length - (kept.length - 1)));
        expect(fit.dropped).toBe(cover.length - kept.length);
        // The kept blocks never spend more than both budgets, unless the first alone does and is clipped.
        const spent = kept.reduce((n, r) => n + r.t, 0);
        if (fit.clipFirstTo === undefined) expect(spent).toBeLessThanOrEqual(recent + older);
        else expect(kept.length).toBe(1);
      }
    }
  });
});

describe('splitRecentOlder', () => {
  test('recent fills first, then older, and it stops at the first block that fits neither', () => {
    const t = (n: number) => n;
    expect(splitRecentOlder([5, 5, 5, 5, 5], t, 10, 10)).toEqual({ recent: [5, 5], older: [5, 5] });
    expect(splitRecentOlder([5, 20, 1], t, 10, 10)).toEqual({ recent: [5], older: [] });
    expect(splitRecentOlder([20, 5], t, 10, 30)).toEqual({ recent: [], older: [20, 5] });
    expect(splitRecentOlder([], t, 10, 10)).toEqual({ recent: [], older: [] });
  });
});

describe('dedupeOverlappingLeaves', () => {
  const leaf = (scopeKey: string, startMs: number, endMs: number, content: string, createdAtMs = 0, index: number | null = null) => ({ scopeKey, startMs, endMs, content, createdAtMs, index });

  test('of overlapping legacy leaves in one scope the longest wins, then the newest; order is kept', () => {
    const a = leaf('person:ada', 0, 10, 'short');
    const b = leaf('person:ada', 5, 15, 'a longer summary');
    const c = leaf('person:ada', 20, 30, 'apart');
    const d = leaf('person:ada', 20, 30, 'apart', 5);
    expect(dedupeOverlappingLeaves([a, b, c, d])).toEqual([b, d]);
    expect(dedupeOverlappingLeaves([d, c, b, a])).toEqual([d, b]);
  });

  test('the same days in two scopes are not duplicates, and numbered leaves always pass', () => {
    const a = leaf('person:ada', 0, 10, 'x');
    const b = leaf('person:bram', 0, 10, 'x');
    const n1 = leaf('person:ada', 0, 10, 'numbered', 0, 0);
    const n2 = leaf('person:ada', 0, 10, 'also numbered', 0, 1);
    expect(dedupeOverlappingLeaves([a, b, n1, n2])).toEqual([a, b, n1, n2]);
  });
});
