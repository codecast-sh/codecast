import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Freeze } from '@platform/evals';

import { echoImpl, echoMeta } from '../testSurface';
import { replayRep, type PreparedFreeze, type RepLedger } from './replay';

// The ledger every rep of one check shares: a rep starts only while the
// spend, the estimates of the reps still running and its own estimate fit the
// budget, and only the first rep to find no room leaves a stop folder.

let root = '';
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evals-ledger-'));
});
afterEach(() => {
  root = '';
});

const prepared = (): PreparedFreeze => {
  const f = { id: 'ffffffff-0000-0000-0000-000000000000', name: 'ledger', asOf: '2026-01-01T00:00:00.000Z', tags: [], meta: { surface: 'echo' } } as unknown as Freeze;
  return {
    f,
    meta: echoMeta,
    impl: echoImpl,
    root,
    model: echoMeta.model,
    scenario: 'echo-ffffffff',
    // No snapshot: the rep grades the snapshot gate and spawns nothing.
    loaded: null,
    mismatch: 'no snapshot in this test',
    run: { freezeId: f.id, notes: null, model: echoMeta.model, route: 'call', sourceHash: 'h', budgetUsd: 1, gitHead: 'x', dirty: false, dry: true, temperatureReplay: 'cli-default', batch: 'b', title: 'ledger' },
  };
};
const folders = () => (existsSync(root) ? readdirSync(root) : []);

describe('the rep ledger', () => {
  test('reps still in flight count against the budget, and the first stop is the only trace', async () => {
    const ledger: RepLedger = { usd: 0.5, inFlightUsd: 0.4 };
    const first = await replayRep(prepared(), 1, 3, { reps: 3, model: null, budgetUsd: 1, spent: ledger, estPerRep: 0.2 });
    expect(first.stopped).toBe(true);
    expect(ledger.stoppedBy).toBe('budget');
    expect(folders()).toHaveLength(1);
    const later = await replayRep(prepared(), 2, 3, { reps: 3, model: null, budgetUsd: 1, spent: ledger, estPerRep: 0.2 });
    expect(later).toEqual({ summary: null, crashed: false, stopped: true });
    expect(folders()).toHaveLength(1);
  });

  test('a rep with room runs, releases its reservation, and a passed deadline stops the next', async () => {
    const ledger: RepLedger = { usd: 0 };
    const ran = await replayRep(prepared(), 1, 2, { reps: 2, model: null, budgetUsd: 1, spent: ledger, estPerRep: 0.2 });
    expect(ran.stopped).toBe(false);
    expect(ledger.inFlightUsd).toBe(0);
    const late = await replayRep(prepared(), 2, 2, { reps: 2, model: null, spent: ledger, deadline: Date.now() - 1 });
    expect(late.stopped).toBe(true);
    expect(ledger.stoppedBy).toBe('time');
    expect(folders()).toHaveLength(2);
  });
});
