/**
 * Adversarial review: pure cover properties over many T, lo, budget.
 */
import { describe, expect, test, setDefaultTimeout } from 'bun:test';

import { blockSpan, cover, coverSpan, planCover } from '../src/tree';

// Seeding long histories is slow on a loaded machine; the 5s default is too tight.
setDefaultTimeout(120_000);

/** Fewest aligned power-of-two blocks that tile [lo, hi). */
function minimalTiling(lo: number, hi: number): number {
  let n = 0;
  let a = lo;
  while (a < hi) {
    let size = 1;
    while (a % (size * 2) === 0 && a + size * 2 <= hi) size *= 2;
    a += size;
    n++;
  }
  return n;
}

function checkTiling(lo: number, hi: number, budget: number) {
  const blocks = coverSpan(lo, hi, budget);
  if (hi - lo <= 0) return expect(blocks).toEqual([]);
  let at = lo;
  for (const b of blocks) {
    const [s, e] = blockSpan(b);
    expect(Number.isInteger(b.level) && Number.isInteger(b.index)).toBe(true);
    expect(s).toBe(at);
    at = e;
  }
  expect(at).toBe(hi);
  expect(blocks.length).toBeLessThanOrEqual(Math.max(budget, minimalTiling(lo, hi)));
  // Finest near hi: sizes never shrink going backward from hi... i.e. non-increasing toward hi.
  if (lo === 0) for (let i = 1; i < blocks.length; i++) expect(blocks[i].level).toBeLessThanOrEqual(blocks[i - 1].level);
}

describe('review: coverSpan tiles every range exactly', () => {
  test('cover(T, b) for T 0..300, b 1..40', () => {
    for (let T = 0; T <= 300; T++) for (let b = 1; b <= 40; b++) checkTiling(0, T, b);
  });
  test('coverSpan(lo, hi, b) for lo, hi < 140, b 1..12', () => {
    for (let lo = 0; lo < 140; lo += 3) for (let hi = lo; hi < 140; hi += 5) for (let b = 1; b <= 12; b++) checkTiling(lo, hi, b);
  });
  test('budget equal to the minimal tiling is honoured (no overshoot)', () => {
    for (let lo = 0; lo < 64; lo++) for (let hi = lo + 1; hi <= 128; hi++) {
      const m = minimalTiling(lo, hi);
      expect(coverSpan(lo, hi, m).length).toBe(m);
    }
  });
  test('non-integer and huge budgets', () => {
    expect(cover(10, 1e9).length).toBe(10);
    checkTiling(0, 37, 2.5);
  });
});

describe('review: planCover', () => {
  test('a leaf number with no row is silently dropped from a fully-verbatim cover', () => {
    const rows = [0, 1, 3].map((i) => ({ id: `l${i}`, level: 0, blockIndex: i, endMs: i }));
    const out = planCover(rows, Infinity, 32);
    // Documented: counted and renders as nothing. Recorded for the report.
    expect(out.map((r) => r.id)).toEqual(['l0', 'l1', 'l3']);
  });
});
