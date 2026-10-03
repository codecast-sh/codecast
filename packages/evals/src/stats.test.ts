import { describe, expect, test } from 'bun:test';

import { EXACT_MAX_STEPS, mannWhitney, separate, separationLine } from './stats';

describe('exact Mann-Whitney', () => {
  test('5 vs 5, every value greater: p = 1/252', () => {
    const r = mannWhitney([6, 7, 8, 9, 10], [1, 2, 3, 4, 5]);
    expect(r.pGreater).toBeCloseTo(1 / 252, 12);
    expect(r.u).toBe(25);
    expect(r.pLess).toBe(1);
  });

  test('3 vs 3 all greater: p = 1/20', () => {
    expect(mannWhitney([4, 5, 6], [1, 2, 3]).pGreater).toBeCloseTo(1 / 20, 12);
  });

  test('identical samples are never separated', () => {
    const r = mannWhitney([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]);
    expect(r.pGreater).toBe(1);
    expect(r.pLess).toBe(1);
    expect(separate([1, 1, 1, 1, 1], [1, 1, 1, 1, 1]).kind).toBe('not-separated');
  });

  test('ties take midranks: one shared value, 4 vs 4', () => {
    // a = [2,3,4,5], b = [0,1,2,2]: the exact tail over all C(8,4) = 70 splits, by enumeration.
    const a = [2, 3, 4, 5];
    const b = [0, 1, 2, 2];
    const pooled = [...a, ...b];
    const rank = (v: number) => {
      const less = pooled.filter((x) => x < v).length;
      const eq = pooled.filter((x) => x === v).length;
      return less + (eq + 1) / 2;
    };
    const ranks = pooled.map(rank);
    const obs = a.reduce((s, v) => s + rank(v), 0);
    let ge = 0;
    let all = 0;
    const pick = (start: number, left: number, sum: number) => {
      if (left === 0) {
        all++;
        if (sum >= obs - 1e-9) ge++;
        return;
      }
      for (let i = start; i <= ranks.length - left; i++) pick(i + 1, left - 1, sum + ranks[i]!);
    };
    pick(0, 4, 0);
    expect(mannWhitney(a, b).pGreater).toBeCloseTo(ge / all, 12);
  });

  test('the separation rule', () => {
    expect(separate([1, 1, 1, 1, 1], [0, 0, 0, 0, 0]).kind).toBe('better');
    expect(separate([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]).kind).toBe('worse');
    expect(separate([1, 1, 1, 1], [0, 0, 0, 0, 0]).kind).toBe('too-few');
    expect(separationLine([1, 1, 1], [0, 0, 0])).toBe('too few samples to separate (need 5+ per side)');
    expect(separationLine([1, 0, 1, 0, 1], [0, 1, 0, 1, 1])).toMatch(/^not separated: medians 1\.00 vs 1\.00, ranges 0\.00-1\.00 vs 0\.00-1\.00$/);
  });
});

describe('Mann-Whitney past the exact count', () => {
  test('the sampled tails agree with the exact count, ties and all', () => {
    // 24 against 168 is past the exact count; 23 passes and one 0 against 168 passes is its worst tie case, exactly 24/192 for the fall.
    const tonight = [...Array.from({ length: 23 }, () => 1), 0];
    const pool = Array.from({ length: 168 }, () => 1);
    expect(192 * 24 * (192 * 193)).toBeGreaterThan(EXACT_MAX_STEPS);
    expect(Math.abs(mannWhitney(tonight, pool).pLess - 24 / 192)).toBeLessThan(0.005);
    expect(mannWhitney(tonight, pool).pGreater).toBeCloseTo(1, 3);
    // Two 0s, both tonight: the fall's exact tail is C(24,2)/C(192,2), past the exact count all the same.
    const two = mannWhitney([...Array.from({ length: 22 }, () => 1), 0, 0], pool);
    expect(Math.abs(two.pLess - 276 / 18336)).toBeLessThan(0.005);
    // Seeded: the same samples give the same p every time.
    expect(mannWhitney(tonight, pool)).toEqual(mannWhitney(tonight, pool));
  }, 60_000);

  test('against a pooled baseline of hundreds of reps, one failed rep in 24 against 168 passes is no drift', () => {
    const pool = Array.from({ length: 168 }, () => 1);
    const tonight = [...Array.from({ length: 23 }, () => 1), 0];
    expect(separate(tonight, pool).kind).toBe('not-separated');
    // A real fall still separates.
    expect(separate([...Array.from({ length: 16 }, () => 1), ...Array.from({ length: 8 }, () => 0)], pool).kind).toBe('worse');
    // A rise is reported as better, never as a regression.
    expect(separate(Array.from({ length: 24 }, () => 1), [...Array.from({ length: 120 }, () => 1), ...Array.from({ length: 48 }, () => 0)]).kind).toBe('better');
  }, 60_000);
});
