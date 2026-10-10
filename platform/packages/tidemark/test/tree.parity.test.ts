/**
 * Parity: the cases of the original activity-tree unit suite, ported
 * unchanged against tree.ts, plus Taelin's rollback push kept here as the
 * oracle of the merge order, so cover(T, budget) is checked to be identical,
 * not merely valid.
 */
import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import { blockChildren, blockKey, blockSpan, cover, coverSpan, pendingMerges, resolveBlocks, type TreeBlock } from '../src/tree';

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

/**
 * Taelin's rollback push (rollback_state_list.js, 2022), verbatim but for
 * `life`, which stays 0 under push alone. Its list, oldest first, holds the
 * first leaf of each line of a view over the leaves pushed so far.
 */
type PushList = { keep: number; state: number; older: PushList } | null;
function push(state: number, list: PushList): PushList {
  if (list === null) return { keep: 0, state, older: null };
  if (list.keep === 0) return { keep: 1, state: list.state, older: list.older };
  return { keep: 0, state, older: push(list.state, list.older) };
}
function starts(list: PushList): number[] {
  const out: number[] = [];
  for (let at = list; at; at = at.older) out.push(at.state);
  return out.reverse();
}

describe('the merge order is Taelin\'s rollback push', () => {
  test('with the budget at push\'s length, cover(T) is push\'s list at every step', () => {
    let list: PushList = null;
    for (let T = 1; T <= 4096; T++) {
      list = push(T - 1, list);
      const want = starts(list);
      expect(cover(T, want.length).map((b) => blockSpan(b)[0])).toEqual(want);
    }
  }, 300_000);

  test('on any sub-range it is the greedy rule itself: merge the most due sibling pair, oldest on ties', () => {
    // The rule simulated literally, pair by pair, as the oracle of coverSpan's per-level computation.
    const greedy = (lo: number, hi: number, budget: number): Array<[number, number]> => {
      const out: Array<[number, number]> = [];
      for (let i = lo; i < hi; i++) out.push([i, i + 1]);
      while (out.length > budget) {
        let best = -1;
        let bestDue = -1;
        for (let k = 0; k + 1 < out.length; k++) {
          const [a, b] = out[k];
          const [c, d] = out[k + 1];
          if (d - c !== b - a || a % (2 * (b - a)) !== 0) continue;
          const due = (hi - (d - 1)) / (b - a);
          if (due > bestDue) {
            bestDue = due;
            best = k;
          }
        }
        if (best < 0) break;
        out.splice(best, 2, [out[best][0], out[best + 1][1]]);
      }
      return out;
    };
    for (let lo = 0; lo < 40; lo += 3) {
      for (let hi = lo + 1; hi < lo + 130; hi += 7) {
        for (const budget of [1, 2, 3, 5, 8, 13, 32]) expect(coverSpan(lo, hi, budget).map(blockSpan)).toEqual(greedy(lo, hi, budget));
      }
    }
  }, 300_000);

  test('old lines stay put as T grows: a line ending before the newest quarter almost never changes', () => {
    for (const budget of [8, 32, 96]) {
      let churned = 0;
      let steps = 0;
      for (let T = 4 * budget; T < 3000; T++) {
        const next = new Set(cover(T + 1, budget).map(blockKey));
        churned += cover(T, budget).filter((b) => blockSpan(b)[1] <= T * 0.75 && !next.has(blockKey(b))).length;
        steps++;
      }
      // Measured: 0.07, 0.20 and 0.33 old lines per step at 8, 32 and 96 lines.
      expect(churned / steps).toBeLessThan(budget / 64 + 0.1);
    }
  }, 300_000);

  test('a growing scope rewrites only its recent end: the first changed line sits past the cover\'s middle on average', () => {
    for (const budget of [8, 32, 96]) {
      let at = 0;
      let steps = 0;
      for (let T = 4 * budget; T < 3000; T++) {
        const a = cover(T, budget).map(blockKey);
        const b = cover(T + 1, budget).map(blockKey);
        let p = 0;
        while (p < a.length && a[p] === b[p]) p++;
        at += p / a.length;
        steps++;
      }
      expect(at / steps).toBeGreaterThan(0.5);
    }
  }, 300_000);
});
