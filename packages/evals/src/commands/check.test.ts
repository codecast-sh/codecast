import { describe, expect, test } from 'bun:test';

import type { SurfaceMeta } from '../surface';
import { fitBudget } from './check';

describe('a stale run over its budget', () => {
  const plan = (id: string) => ({ meta: { id } as SurfaceMeta });
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(plan) as [ReturnType<typeof plan>, ReturnType<typeof plan>, ReturnType<typeof plan>, ReturnType<typeof plan>];
  const cost: Record<string, number> = { a: 4, b: 6, c: 3, d: 20 };
  const usd = (p: { meta: SurfaceMeta }) => cost[p.meta.id]!;

  test('runs the surfaces stale longest first while they fit, defers the rest, and refuses one over the budget alone', () => {
    // a never ran; c ran before b.
    const state = { b: { lastRunAt: '2026-10-02T10:00:00.000Z' }, c: { lastRunAt: '2026-10-01T10:00:00.000Z' }, d: { lastRunAt: '2026-09-30T10:00:00.000Z' } };
    const fit = fitBudget([b, c, a, d], usd, 10, 10, state);
    expect(fit.refused).toEqual([d]);
    expect(fit.run).toEqual([a, c]);
    expect(fit.deferred).toEqual([b]);
  });

  test('a deferred surface goes first at the next firing, being staler than what ran', () => {
    const state = { a: { lastRunAt: '2026-10-03T08:00:00.000Z' }, c: { lastRunAt: '2026-10-03T08:00:00.000Z' }, b: { lastRunAt: '2026-10-02T10:00:00.000Z' } };
    expect(fitBudget([a, b, c], usd, 10, 10, state).run).toEqual([b, a]);
  });

  test("what the day leaves can defer a surface the budget alone would run, without refusing it", () => {
    const fit = fitBudget([a, b], usd, 10, 5, {});
    expect(fit.run).toEqual([a]);
    expect(fit.deferred).toEqual([b]);
    expect(fit.refused).toEqual([]);
  });
});
