/**
 * Parity: the cases of the original activity-tree unit suite, ported
 * unchanged against tree.ts, plus the original cover implementation kept here
 * as a reference oracle so cover(T, budget) is checked to be identical, not
 * merely valid.
 */
import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import { blockChildren, blockKey, blockSpan, cover, pendingMerges, resolveBlocks, type TreeBlock } from '../src/tree';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

const BUDGET = 32;

/** Every block buildable from T leaves, from the definition (test.py `complete`). */
function complete(T: number): Set<string> {
  const out = new Set<string>();
  for (let level = 1; 2 ** level <= T; level++) {
    for (let k = 0; k < Math.floor(T / 2 ** level); k++) {
      out.add(blockKey({ level, index: k }));
    }
  }
  return out;
}

const SAMPLE_T = [...Array.from({ length: 400 }, (_, i) => i + 1), 1000, 4096, 10000, 65536, 100003];

describe('cover', () => {
  test('tiles [0,T) with aligned power-of-two blocks, within budget, finest near T', () => {
    for (const budget of [BUDGET, 96]) {
      for (const T of SAMPLE_T) {
        const spans = cover(T, budget).map(blockSpan);
        expect(spans.length).toBeLessThanOrEqual(budget);
        expect(spans[0][0]).toBe(0);
        expect(spans[spans.length - 1][1]).toBe(T);
        for (let i = 1; i < spans.length; i++) {
          expect(spans[i][0]).toBe(spans[i - 1][1]);
          expect(spans[i][1] - spans[i][0]).toBeLessThanOrEqual(spans[i - 1][1] - spans[i - 1][0]);
        }
        for (const [lo, hi] of spans) {
          const size = hi - lo;
          expect(size & (size - 1)).toBe(0);
          expect(lo % size).toBe(0);
        }
      }
    }
  }, 120_000);

  test('under budget every leaf renders verbatim', () => {
    expect(cover(300, 320)).toEqual(Array.from({ length: 300 }, (_, i) => ({ level: 0, index: i })));
    expect(cover(32, 32).every((b) => b.level === 0)).toBe(true);
    expect(cover(0, 32)).toEqual([]);
  });

  test('over budget spends the whole budget and keeps the newest leaf verbatim', () => {
    for (const T of [33, 50, 64, 100, 207, 300]) {
      const c = cover(T, BUDGET);
      expect(c.length).toBe(BUDGET);
      expect(c[c.length - 1]).toEqual({ level: 0, index: T - 1 });
    }
  });

  test('every block a cover needs is buildable from its leaves', () => {
    const seen = new Set<string>();
    for (const T of [...Array.from({ length: 299 }, (_, i) => i + 1), 512, 700, 1000, 1023, 1024, 2000, 2999]) {
      for (const b of cover(T, BUDGET)) {
        if (b.level > 0) seen.add(blockKey(b));
        expect(blockSpan(b)[1]).toBeLessThanOrEqual(T);
      }
    }
    const buildable = complete(3000);
    for (const k of seen) expect(buildable.has(k)).toBe(true);
  });
});

describe('resolveBlocks', () => {
  const T = 100;
  const wanted = cover(T, BUDGET);
  const spanOf = (bs: TreeBlock[]) => bs.map(blockSpan);
  const contiguous = (bs: TreeBlock[]) => {
    const s = spanOf(bs);
    expect(s[0][0]).toBe(0);
    expect(s[s.length - 1][1]).toBe(T);
    for (let i = 1; i < s.length; i++) expect(s[i][0]).toBe(s[i - 1][1]);
  };

  test('with every merge built it is the cover itself', () => {
    expect(resolveBlocks(wanted, () => true)).toEqual(wanted);
  });

  test('with no merge built it descends to the leaves and keeps the whole span', () => {
    const r = resolveBlocks(wanted, () => false);
    expect(r).toEqual(Array.from({ length: T }, (_, i) => ({ level: 0, index: i })));
  });

  test('a missing block opens into its halves, nothing else moves', () => {
    const coarse = wanted.find((b) => b.level >= 2)!;
    const r = resolveBlocks(wanted, (b) => blockKey(b) !== blockKey(coarse));
    contiguous(r);
    expect(r.length).toBe(wanted.length + 1);
    expect(r.map(blockKey)).toContain(blockKey(blockChildren(coarse)[0]));
    expect(r.map(blockKey)).toContain(blockKey(blockChildren(coarse)[1]));
  });
});

describe('pendingMerges', () => {
  test('nothing is pending while every leaf fits the budget', () => {
    expect(pendingMerges(32, BUDGET, () => false)).toEqual([]);
  });

  test('lists children before parents and only blocks under the cover', () => {
    const T = 207;
    const todo = pendingMerges(T, BUDGET, () => false);
    const pos = new Map(todo.map((b, i) => [blockKey(b), i]));
    for (const b of todo) {
      if (b.level < 2) continue;
      for (const c of blockChildren(b)) {
        expect(pos.get(blockKey(c))!).toBeLessThan(pos.get(blockKey(b))!);
      }
    }
    const coverMerged = cover(T, BUDGET).filter((b) => b.level > 0);
    for (const b of todo) {
      const [lo, hi] = blockSpan(b);
      expect(
        coverMerged.some((c) => {
          const [clo, chi] = blockSpan(c);
          return clo <= lo && hi <= chi;
        }),
      ).toBe(true);
    }
    // Building all of them makes the cover render with no fallback.
    const built = new Set(todo.map(blockKey));
    expect(pendingMerges(T, BUDGET, (b) => built.has(blockKey(b)))).toEqual([]);
    expect(resolveBlocks(cover(T, BUDGET), (b) => built.has(blockKey(b)))).toEqual(cover(T, BUDGET));
  });

  test('a growing scope reuses its blocks: total work stays under one merge per leaf', () => {
    const built = new Set<string>();
    let worst = 0;
    for (let T = 1; T <= 600; T++) {
      const todo = pendingMerges(T, BUDGET, (b) => built.has(blockKey(b)));
      worst = Math.max(worst, todo.length);
      for (const b of todo) built.add(blockKey(b));
    }
    expect(built.size).toBeLessThan(600);
    expect(worst).toBeLessThanOrEqual(64);
  }, 120_000);
});

// The original cover, verbatim, as the oracle.
function refCoverAt(T: number, alpha: number): Array<[number, number]> {
  let root = 1;
  while (root < T) root *= 2;
  const out: Array<[number, number]> = [];
  const stack: Array<[number, number]> = [[0, root]];
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!;
    if (lo >= T) continue;
    const size = hi - lo;
    if (size > 1 && (hi > T || size > alpha * (T - lo))) {
      const mid = (lo + hi) / 2;
      stack.push([mid, hi], [lo, mid]);
    } else {
      out.push([lo, hi]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}
function refCover(T: number, budget: number): TreeBlock[] {
  if (T <= 0 || budget <= 0) return [];
  if (T <= budget) return Array.from({ length: T }, (_, i) => ({ level: 0, index: i }));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (refCoverAt(T, mid).length > budget) lo = mid;
    else hi = mid;
  }
  const out = refCoverAt(T, hi);
  while (out.length < budget) {
    let at = -1;
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i][1] - out[i][0] > 1) {
        at = i;
        break;
      }
    }
    if (at < 0) break;
    const [a, b] = out[at];
    const mid = (a + b) / 2;
    out.splice(at, 1, [a, mid], [mid, b]);
  }
  return out.map(([a, b]) => ({ level: Math.log2(b - a), index: a / (b - a) }));
}

describe('identical to the original cover', () => {
  test('cover(T, budget) equals the reference wherever the reference fits its budget', () => {
    let compared = 0;
    for (const budget of [8, 16, 32, 96]) {
      for (const T of [...Array.from({ length: 400 }, (_, i) => i), 1023, 1024, 1025, 4095, 4096, 4097, 65537]) {
        const ref = refCover(T, budget);
        if (ref.length > budget) continue; // the reference overflowed; see the next test
        expect(cover(T, budget)).toEqual(ref);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(1500);
  }, 300_000);

  test('at the default budget of 32 the reference fits its budget at every sampled size', () => {
    for (const T of [1000, 10000, 100003, 262143]) {
      expect(refCover(T, 32).length).toBeLessThanOrEqual(32);
      expect(cover(T, 32)).toEqual(refCover(T, 32));
    }
  }, 300_000);
});
