// The forward replay's pure parts (priorities-forward.ts): which grid points a
// replay runs the pass at, what a step's plans changed, and when each
// authoritative priority first had a match.
import { describe, expect, test } from 'bun:test';

import type { EvalChunk } from '../../convex/convex/priorityPassEval';
import type { PassPriority } from '../../convex/convex/lib/priorityPass';
import { firstMatched, passTimes, stepCounts } from './priorities-forward';

const H = 3_600_000;

describe('passTimes', () => {
  test('runs at each grid point closing an interval with activity, an activity on a grid point belonging to the interval it closes', () => {
    // Grid every 90 min from 0: 1.5h, 3h, 4.5h, 6h.
    const times = passTimes([0.5 * H, 1.5 * H, 4 * H], 0, 6 * H, 1.5 * H, []);
    expect(times).toEqual([{ at: 1.5 * H, active: true }, { at: 4.5 * H, active: true }]);
  });

  test('adds each snapshot time in the window as an idle step, and keeps an active one active', () => {
    const times = passTimes([1 * H], 0, 6 * H, 1.5 * H, [1.5 * H, 3 * H, 9 * H]);
    expect(times).toEqual([{ at: 1.5 * H, active: true }, { at: 3 * H, active: false }]);
  });

  test('ignores activity before the window', () => {
    expect(passTimes([-1 * H], 0, 3 * H, 1.5 * H, [])).toEqual([]);
  });
});

describe('stepCounts', () => {
  const before = [{ short_id: 'pri-1', title: 'Ship the thing', status: 'active' }] as PassPriority[];
  const chunk = (plan: Partial<EvalChunk['plan']>, sessions: string[]) =>
    ({ sessions, plan: { creates: [], merges: [], sessions: [], unmap: [], updates: [], ...plan } }) as unknown as EvalChunk;

  test('counts creates, merges, filings and only real retitles and status changes', () => {
    const c = stepCounts([
      chunk({ creates: [{}, {}], sessions: [{}, {}, {}], updates: [{ short_id: 'pri-1', patch: { title: 'Ship the thing' } }] } as never, ['a', 'b']),
      chunk({ merges: [{}], updates: [{ short_id: 'pri-1', patch: { title: 'Ship it everywhere', status: 'done' } }] } as never, ['c']),
    ], before);
    expect(c).toEqual({ sessions: ['a', 'b', 'c'], creates: 2, merges: 1, retitles: 1, status_changes: 1, filed: 3, unmapped: 0 });
  });
});

describe('firstMatched', () => {
  test('keeps the first time each authoritative priority was matched', () => {
    expect(firstMatched([
      { at: 'T1', matches: [{ golden: 'a' }] },
      { at: 'T2', matches: [{ golden: 'a' }, { golden: 'b' }] },
    ])).toEqual({ a: 'T1', b: 'T2' });
  });
});
