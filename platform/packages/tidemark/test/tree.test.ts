import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import { blockKey, blockParent, blockSibling, blockSpan, cover, coverSpan, isNumberedScope, leafPrefixCount, pendingMerges, planCover, resolveBlocks, type TreeBlock } from '../src/tree';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

const spans = (bs: TreeBlock[]) => bs.map(blockSpan);

/** Aligned power-of-two blocks tiling exactly [lo, hi), oldest first. */
function expectTiling(bs: TreeBlock[], lo: number, hi: number) {
  const s = spans(bs);
  expect(s[0][0]).toBe(lo);
  expect(s[s.length - 1][1]).toBe(hi);
  for (let i = 1; i < s.length; i++) expect(s[i][0]).toBe(s[i - 1][1]);
  for (const [a, b] of s) {
    const size = b - a;
    expect(size & (size - 1)).toBe(0);
    expect(a % size).toBe(0);
  }
}

/** The fewest aligned blocks that tile [lo, hi). */
function minimalTiling(lo: number, hi: number): number {
  let n = 0;
  let at = lo;
  while (at < hi) {
    let size = 1;
    while (at % (size * 2) === 0 && at + size * 2 <= hi) size *= 2;
    at += size;
    n++;
  }
  return n;
}

describe('coverSpan', () => {
  test('cover is coverSpan from zero', () => {
    for (const T of [0, 1, 2, 31, 32, 33, 63, 64, 65, 100, 255, 256, 257, 1000]) {
      for (const budget of [1, 2, 3, 8, 32]) expect(cover(T, budget)).toEqual(coverSpan(0, T, budget));
    }
  });

  test('empty, inverted, negative and zero-budget spans are empty', () => {
    expect(coverSpan(5, 5, 8)).toEqual([]);
    expect(coverSpan(9, 5, 8)).toEqual([]);
    expect(coverSpan(0, 10, 0)).toEqual([]);
    expect(coverSpan(0, 10, -3)).toEqual([]);
    expect(coverSpan(-4, 10, 8)).toEqual([]);
    expect(cover(-1, 8)).toEqual([]);
  });

  test('a span that fits the budget is its leaves', () => {
    expect(coverSpan(10, 14, 8)).toEqual([10, 11, 12, 13].map((index) => ({ level: 0, index })));
    expect(coverSpan(7, 8, 1)).toEqual([{ level: 0, index: 7 }]);
  });

  test('tiles any sub-range exactly, within budget whenever the range can be tiled that coarsely', () => {
    for (let lo = 0; lo < 70; lo += 7) {
      for (let hi = lo + 1; hi <= lo + 140; hi += 13) {
        const least = minimalTiling(lo, hi);
        for (const budget of [1, 2, 4, 8, 16, 32]) {
          const c = coverSpan(lo, hi, budget);
          expectTiling(c, lo, hi);
          expect(c.length).toBeLessThanOrEqual(Math.max(budget, least));
          // The budget is spent whenever there are leaves left to show.
          if (budget >= least) expect(c.length).toBe(Math.min(budget, hi - lo));
        }
      }
    }
  }, 120_000);

  test('at the edges of powers of two', () => {
    for (const k of [1, 2, 5, 6, 7, 10]) {
      for (const T of [2 ** k - 1, 2 ** k, 2 ** k + 1]) {
        for (const budget of [1, 2, 3, 32]) {
          const c = cover(T, budget);
          expectTiling(c, 0, T);
          expect(c.length).toBeLessThanOrEqual(Math.max(budget, minimalTiling(0, T)));
        }
      }
    }
    expect(cover(64, 1)).toEqual([{ level: 6, index: 0 }]);
    expect(cover(64, 2)).toEqual([{ level: 5, index: 0 }, { level: 5, index: 1 }]);
    expect(cover(1, 1)).toEqual([{ level: 0, index: 0 }]);
    expect(cover(2, 1)).toEqual([{ level: 1, index: 0 }]);
    // 65 leaves cannot be one aligned block: the minimal tiling is the 64 and the 1.
    expect(cover(65, 1)).toEqual([{ level: 6, index: 0 }, { level: 0, index: 64 }]);
  }, 60_000);

  test('detail is finest at the end of the span, wherever the span sits', () => {
    for (const [lo, hi] of [[0, 300], [64, 364], [100, 228], [37, 1000]] as const) {
      const sizes = spans(coverSpan(lo, hi, 32)).map(([a, b]) => b - a);
      expect(sizes[sizes.length - 1]).toBe(1);
      expect(Math.max(...sizes)).toBeGreaterThan(1);
      // The newest quarter of the lines never holds the biggest block.
      expect(Math.max(...sizes.slice(24))).toBeLessThan(Math.max(...sizes));
    }
    // From zero, blocks only ever shrink toward the present, at any budget.
    for (const budget of [3, 12, 32]) {
      const sizes = spans(cover(1000, budget)).map(([a, b]) => b - a);
      for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    }
  }, 60_000);

  test('a block opens into its two halves with a budget of two, and a parent is its span at a budget of one', () => {
    for (const b of [{ level: 1, index: 0 }, { level: 3, index: 5 }, { level: 6, index: 1 }]) {
      const [lo, hi] = blockSpan(b);
      expect(coverSpan(lo, hi, 2)).toEqual([{ level: b.level - 1, index: b.index * 2 }, { level: b.level - 1, index: b.index * 2 + 1 }]);
      expect(coverSpan(lo, hi, 1)).toEqual([b]);
      expect(blockParent({ level: b.level - 1, index: b.index * 2 + 1 })).toEqual(b);
      expect(blockSibling({ level: b.level - 1, index: b.index * 2 })).toEqual({ level: b.level - 1, index: b.index * 2 + 1 });
    }
  });
});

describe('planCover', () => {
  const leaves = (n: number, endOf = (i: number) => i * 10) => Array.from({ length: n }, (_, i) => ({ id: `l${i}`, level: 0, blockIndex: i, endMs: endOf(i) }));

  test('zero, one and two leaves', () => {
    expect(planCover([], 1000)).toEqual([]);
    expect(planCover(leaves(1), 1000).map((r) => r.id)).toEqual(['l0']);
    expect(planCover(leaves(2), 1000).map((r) => r.id)).toEqual(['l0', 'l1']);
  });

  test('only leaves that ended before the boundary are read', () => {
    expect(leafPrefixCount(leaves(10), 45)).toBe(5);
    expect(leafPrefixCount(leaves(10), 40)).toBe(4); // a leaf ending at the boundary is not before it
    expect(leafPrefixCount(leaves(10), 0)).toBe(0);
    expect(leafPrefixCount(leaves(10), Infinity)).toBe(10);
    expect(planCover(leaves(10), 45).map((r) => r.id)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4']);
  });

  test('with no merge built the plan is every leaf: the span is never narrowed to fit', () => {
    const plan = planCover(leaves(100), Infinity, 8);
    expect(plan.map((r) => r.blockIndex)).toEqual(Array.from({ length: 100 }, (_, i) => i));
  });

  test('with every merge built the plan is the cover, and it starts at the first leaf', () => {
    const T = 100;
    const rows: Array<{ id: string; level: number; blockIndex: number; endMs: number }> = leaves(T);
    for (const m of pendingMerges(T, 8, () => false)) rows.push({ id: blockKey(m), level: m.level, blockIndex: m.index, endMs: 0 });
    const plan = planCover(rows, Infinity, 8);
    expect(plan.length).toBe(8);
    expect(plan.map((r) => ({ level: r.level, index: r.blockIndex }))).toEqual(cover(T, 8));
    expect(blockSpan({ level: plan[0].level, index: plan[0].blockIndex })[0]).toBe(0);
  });

  test('a leaf number with no row is counted and renders as nothing', () => {
    const rows = leaves(6).filter((r) => r.blockIndex !== 2);
    expect(leafPrefixCount(rows, Infinity)).toBe(6);
    expect(planCover(rows, Infinity).map((r) => r.blockIndex)).toEqual([0, 1, 3, 4, 5]);
  });

  test('unnumbered leaves are outside the tree', () => {
    const rows = [...leaves(3), { id: 'legacy', level: 0, blockIndex: null, endMs: 5 }];
    expect(isNumberedScope(rows)).toBe(false);
    expect(isNumberedScope(leaves(3))).toBe(true);
    expect(isNumberedScope([])).toBe(true);
    expect(planCover(rows, Infinity).map((r) => r.id)).toEqual(['l0', 'l1', 'l2']);
  });
});

describe('resolveBlocks', () => {
  test('missing merges at every level open down to what exists', () => {
    const wanted = cover(128, 4);
    const built = new Set(pendingMerges(128, 4, () => false).map(blockKey));
    for (const drop of built) {
      const r = resolveBlocks(wanted, (b) => built.has(blockKey(b)) && blockKey(b) !== drop);
      expectTiling(r, 0, 128);
    }
  }, 60_000);
});
