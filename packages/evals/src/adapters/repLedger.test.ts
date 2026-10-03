import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Freeze } from '@platform/evals';

import { echoImpl, echoMeta } from '../testSurface';
import { laneRepUsd, replayRep, reservedUsd, type PreparedFreeze, type RepLedger } from './replay';

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
    const ledger: RepLedger = { usd: 0.5, lanes: { [`echo ${echoMeta.model}`]: { est: 0.2, running: 2, done: 0, doneUsd: 0 } } };
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
    expect(reservedUsd(ledger)).toBe(0);
    expect(ledger.lanes![`echo ${echoMeta.model}`]!.done).toBe(1);
    const late = await replayRep(prepared(), 2, 2, { reps: 2, model: null, spent: ledger, deadline: Date.now() - 1 });
    expect(late.stopped).toBe(true);
    expect(ledger.stoppedBy).toBe('time');
    expect(folders()).toHaveLength(2);
  });

  test("a lane's reps are reserved at what this check's finished reps cost when that is over the estimate", () => {
    // The 2026-10-02 opus baseline: estimated at sonnet's $1.76 a rep, measured at about $7, four in flight.
    const ledger: RepLedger = { usd: 133, lanes: { 'org-review claude-opus-5-5': { est: 1.76, running: 4, done: 19, doneUsd: 133 } } };
    expect(laneRepUsd(ledger.lanes!['org-review claude-opus-5-5']!)).toBeCloseTo(7);
    expect(reservedUsd(ledger)).toBeCloseTo(28);
    expect(laneRepUsd({ est: 2, running: 0, done: 3, doneUsd: 3 })).toBe(2);
  });

  test("a rep in flight is reserved at its lane's costliest rep, so a budget holds against an agent rep at several times the average", async () => {
    // The opus org-review round: reps from $2.90 to $17.97, averaging about $7. Reserved at the average, --budget 18 started four and spent $22.85.
    const lane = { est: 7, peak: 17.97, running: 0, done: 0, doneUsd: 0 };
    expect(laneRepUsd(lane)).toBeCloseTo(17.97);
    const ledger: RepLedger = { usd: 0, lanes: { [`echo ${echoMeta.model}`]: { ...lane, running: 1 } } };
    const r = await replayRep(prepared(), 1, 2, { reps: 2, model: null, budgetUsd: 18, spent: ledger, estPerRep: 7, peakPerRep: 17.97 });
    expect(r.stopped).toBe(true);
    expect(readFileSync(join(root, folders()[0]!, 'result.json'), 'utf8')).toContain('budget $18 reached');
    // A finished rep dearer than anything seen raises the lane's reservation for the rest of the check.
    const fresh: RepLedger = { usd: 0 };
    await replayRep(prepared(), 1, 1, { reps: 1, model: null, budgetUsd: 100, spent: fresh, estPerRep: 0.2, peakPerRep: 0.5 });
    expect(fresh.lanes![`echo ${echoMeta.model}`]!.peak).toBe(0.5);
  });

  test('a stop counts the reps still running at their measured cost', async () => {
    const ledger: RepLedger = { usd: 100, lanes: { [`echo ${echoMeta.model}`]: { est: 1, running: 4, done: 10, doneUsd: 70 } } };
    // $100 spent + 4 running at $7 + this rep at $7 = $135: over a $130 budget, though the bare estimate ($105) is under it.
    const r = await replayRep(prepared(), 1, 1, { reps: 1, model: null, budgetUsd: 130, spent: ledger, estPerRep: 1 });
    expect(r.stopped).toBe(true);
    expect(ledger.stoppedBy).toBe('budget');
  });
});
