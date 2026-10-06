import { describe, expect, test } from 'bun:test';

import type { RunRowCore } from '../contract';
import { makeVerdict, unfootedReps, type VerdictRun } from './verdict';

// What the verdict adds for a product that records no footing (union's eval
// rows carry no model or judge model yet): the batch verdict says so, rather
// than reading every comparison as on one footing. A product that records
// its footing, or a run summary that leaves the judge out, never reads as
// unfooted.

const verdict = makeVerdict<VerdictRun>({ passed: (r) => r.status === 'pass', ruler: () => null });
const meta = { id: 'agent', model: '' };

const row = (batch: string, freezeId: string, seed: number, o: Partial<RunRowCore> = {}): RunRowCore => ({
  id: `${batch}-${freezeId}-${seed}`, surface: 'agent', freezeId, freezeName: freezeId, visibility: 'private', seed, stamp: batch, batch, batchAt: batch, cadence: null,
  status: 'pass', score: 0.9, passMark: null, gatesFailed: [], checks: {}, missedFloors: [], model: null, judgeModel: null, ruler: null,
  gitHead: null, mainSha: null, dirty: false, offBranch: false, treePatch: null, sourceHashDisk: null, promptSha: null, freezeSha: null, liveReads: 0,
  costUsd: 0.01, judgeCostUsd: 0, realMs: 1, ...o,
});
const batch = (at: string, o: Partial<RunRowCore> = {}) => ['f1', 'f2'].flatMap((f) => [1, 2, 3].map((s) => row(at, f, s, o)));

describe('unfooted', () => {
  test('every graded rep on both sides with no model and no judge model: the verdict says the footing is unknown', () => {
    const rows = [...batch('2026-10-02T00:00:00.000Z'), ...batch('2026-10-01T00:00:00.000Z')];
    const v = verdict.batchVerdict(meta, '2026-10-02T00:00:00.000Z', rows);
    expect(v.baseline).toMatchObject({ kind: 'previous', batches: ['2026-10-01T00:00:00.000Z'] });
    expect(v.unfooted).toBe(true);
  });

  test('a side that names its model or its judge is not unfooted; a set with no baseline yet is, on its own reps', () => {
    const footed = [...batch('2026-10-02T00:00:00.000Z', { judgeModel: 'j1' }), ...batch('2026-10-01T00:00:00.000Z')];
    expect('unfooted' in verdict.batchVerdict(meta, '2026-10-02T00:00:00.000Z', footed)).toBe(false);
    const modelled = [...batch('2026-10-02T00:00:00.000Z', { model: 'm1' }), ...batch('2026-10-01T00:00:00.000Z', { model: 'm1' })];
    expect('unfooted' in verdict.batchVerdict(meta, '2026-10-02T00:00:00.000Z', modelled)).toBe(false);
    expect(verdict.batchVerdict(meta, '2026-10-01T00:00:00.000Z', batch('2026-10-01T00:00:00.000Z')).unfooted).toBe(true);
  });

  test('only graded reps count, and a rep that leaves the judge out says nothing', () => {
    expect(unfootedReps([{ status: 'crash', model: null, judgeModel: null }])).toBe(false);
    expect(unfootedReps([{ status: 'fail', model: null, judgeModel: null }, { status: 'dry', model: 'm1', judgeModel: null }])).toBe(true);
    expect(unfootedReps([{ status: 'pass', model: null }])).toBe(false);
    expect(unfootedReps([])).toBe(false);
  });
});
