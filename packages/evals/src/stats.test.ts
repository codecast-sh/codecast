import { describe, expect, test } from 'bun:test';

import { EXACT_MAX_STEPS, holdsAcross, mannWhitney, separate, separateNights, separationLine } from './stats';

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

describe('the exact count runs over the smaller sample', () => {
  test('either order gives mirrored tails, and a large first sample costs what a small one does', () => {
    const big = Array.from({ length: 210 }, (_, i) => (i % 7) / 7);
    const small = [0.1, 0.3, 0.5, 0.2, 0.4];
    // Under the old count the first order filled 211 rows of the table and took 17s on a loaded machine; now both fill 6.
    const t = performance.now();
    const ab = mannWhitney(big, small);
    const ba = mannWhitney(small, big);
    expect(performance.now() - t).toBeLessThan(10_000);
    expect(ab.pGreater).toBeCloseTo(ba.pLess, 12);
    expect(ab.pLess).toBeCloseTo(ba.pGreater, 12);
    // And the exact tails still match the hand count when the first sample is the larger.
    expect(mannWhitney([1, 2, 3, 4, 5], [6, 7, 8]).pLess).toBeCloseTo(1 / 56, 12);
  }, 60_000);
});

describe('night by night per freeze', () => {
  const nights = (n: number, v: number) => Array.from({ length: n }, () => v);

  test('the design decides too-few, whatever the scores', () => {
    // One freeze among 7 nights can reach p = 1/8 at best.
    expect(separateNights([{ current: 0, previous: nights(7, 1) }]).kind).toBe('too-few');
    expect(separateNights([{ current: 0, previous: nights(19, 1) }])).toEqual({ kind: 'worse', p: 0.05 });
    expect(separateNights([]).kind).toBe('too-few');
    // A freeze with no earlier night is no stratum.
    expect(separateNights([{ current: 0, previous: [] }, { current: 0, previous: nights(7, 1) }]).kind).toBe('too-few');
  });

  test('a fall on several freezes separates; ties are exact; a steady night does not', () => {
    const fall = [0, 1, 2].map(() => ({ current: 0.4, previous: [0.9, 0.8, 0.95, 0.85, 0.9, 0.9, 0.88] }));
    expect(separateNights(fall)).toEqual({ kind: 'worse', p: 1 / 512 });
    expect(separateNights(fall.map((x) => ({ ...x, current: 1 }))).kind).toBe('better');
    // Every night equal on every freeze: tonight sits at the midrank, nowhere near a tail.
    expect(separateNights([0, 1, 2].map(() => ({ current: 1, previous: nights(7, 1) })))).toEqual({ kind: 'not-separated', p: 1 });
  });
});

describe('a regression across the surfaces one check weighs', () => {
  test("Holm: one surface's p = 0.03 among ten is no regression; p = 0.001 is", () => {
    const quiet = Array.from({ length: 9 }, () => ({ kind: 'not-separated' as const, p: 0.4 }));
    expect(holdsAcross([{ kind: 'worse', p: 0.03 }, ...quiet])[0]).toBe(false);
    expect(holdsAcross([{ kind: 'worse', p: 0.001 }, ...quiet])[0]).toBe(true);
    // Alone, a worse at 0.05 holds; a too-few is no test and does not count.
    expect(holdsAcross([{ kind: 'worse', p: 0.05 }, { kind: 'too-few' }])).toEqual([true, false]);
    // Step-down: the smallest holds against 0.05/3, the next against 0.05/2.
    expect(holdsAcross([{ kind: 'worse', p: 0.016 }, { kind: 'worse', p: 0.024 }, { kind: 'better', p: 0.01 }])).toEqual([true, true, false]);
  });
});
