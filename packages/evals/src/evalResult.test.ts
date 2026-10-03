import { describe, expect, test } from 'bun:test';

import type { EvalRep, EvalRepsFile, EvalRepsFreeze } from '@codecast/shared/contracts/evalResult';

import { buildEvalResult, evalResultLines, majorityOf, provenVerdicts, repsFileProblem } from './evalResult';

// reps.json to eval-result.json (line-profile.md LP4): the one builder every
// project's eval station goes through, `./evals line` included.

const rep = (passed: boolean, over: Partial<EvalRep> = {}): EvalRep => ({ passed, score: passed ? 1 : 0, reply: passed ? 'good reply' : 'bad reply', judge_note: passed ? 'meets the criteria' : 'misses the venue', cost_usd: 0.01, ...over });
const reps = (n: number, passed: boolean, over: Partial<EvalRep> = {}) => Array.from({ length: n }, () => rep(passed, over));
const side = (rs: EvalRep[], batch: string) => ({ batch, sha: batch === 'b' ? 'base-sha' : 'head-sha', reps: rs });
const freeze = (id: string, base: EvalRep[] | null, branch: EvalRep[] | null, over: Partial<EvalRepsFreeze> = {}): EvalRepsFreeze => ({
  freeze: id, name: `moment ${id}`, kind: 'guard', proven: false, input: 'when is the next event?',
  base: base ? side(base, 'b') : null, branch: branch ? side(branch, 'h') : null, ...over,
});
const file = (freezes: EvalRepsFreeze[], over: Partial<EvalRepsFile> = {}): EvalRepsFile => ({
  version: 1, base: { ref: 'main', sha: 'base-sha' }, head: { sha: 'head-sha', dirty: false }, created_at: '2026-10-03T00:00:00Z',
  dry: false, reps: 5, surfaces: [{ surface: 'reply', title: 'Reply', freezes }], gates_failed: [], cost_usd: 0.5, ...over,
});

describe('buildEvalResult', () => {
  test('a proven miss red on the base and green on the branch passes, separates better, and flips with both replies', () => {
    const r = buildEvalResult(file([freeze('miss1aaaa', reps(5, false), reps(5, true), { kind: 'miss', proven: true })]));
    const s = r.surfaces[0]!;
    expect(r.ok).toBe(true);
    expect(s.separation).toBe('better');
    expect(s.proven).toEqual([{ freeze: 'miss1aaaa', basePasses: false, passes: true }]);
    expect(s.flips).toEqual([{ freeze: 'miss1aaaa', name: 'moment miss1aaaa', direction: 'fixed', input: 'moment miss1aaaa: when is the next event?', before: 'bad reply', after: 'good reply', note: 'meets the criteria' }]);
    expect(s.base).toMatchObject({ batch: 'b', reps: 5, passed: 0, median: 0 });
    expect(s.branch).toMatchObject({ batch: 'h', reps: 5, passed: 5, median: 1 });
    expect(r.costUsd).toBe(0.5);
  });

  test('a proven freeze that already passes on the base fails the station: it shows no miss', () => {
    const r = buildEvalResult(file([freeze('miss2bbbb', reps(5, true), reps(5, true), { kind: 'miss', proven: true })]));
    expect(r.ok).toBe(false);
    expect(r.surfaces[0]!.reasons).toEqual(['proven freeze miss2bbb already passes on the base, so it shows no miss; find where the bug is before changing this surface']);
  });

  test('a guard that breaks separates worse and fails, with the flip pointing at the branch reply', () => {
    const r = buildEvalResult(file([freeze('guard1cc', reps(5, true), reps(5, false))]));
    const s = r.surfaces[0]!;
    expect(r.ok).toBe(false);
    expect(s.separation).toBe('worse');
    expect(s.flips[0]).toMatchObject({ direction: 'broke', before: 'good reply', after: 'bad reply', note: 'misses the venue' });
    expect(s.reasons.at(-1)).toMatch(/^separated worse than the base \(p=/);
  });

  test('too few reps cannot separate; per-rep gates and crashes fail the surface; a crash is no verdict', () => {
    const r = buildEvalResult(file([freeze('f1', reps(2, true), [rep(true, { gates_failed: ['no_links'] }), rep(false, { error: 'timeout', score: null })])]));
    const s = r.surfaces[0]!;
    expect(s.separation).toBe('too-few');
    expect(s.gatesFailed).toEqual(['no_links']);
    expect(s.crashes).toBe(1);
    expect(s.reasons).toEqual(['gates failed: no_links', '1 rep(s) crashed']);
    expect(s.branch).toMatchObject({ reps: 2, passed: 1, median: 1 });
  });

  test('no base reps fails closed, with the reason the eval gave', () => {
    const r = buildEvalResult({ ...file([]), surfaces: [{ surface: 'reply', title: 'Reply', freezes: [freeze('f1', null, reps(5, true))], base_failure: 'the base cannot load the reply adapter' }] });
    expect(r.surfaces[0]!.reasons).toEqual(['the base cannot load the reply adapter']);
  });

  test('a skipped surface does not count; a suite gate failure fails the station', () => {
    const skipped = { surface: 'title', title: 'Title', freezes: [], skipped: 'no freeze exercises this prompt yet' };
    const clean = buildEvalResult({ ...file([]), surfaces: [skipped] });
    expect(clean.ok).toBe(true);
    expect(clean.surfaces[0]!.skipped).toBe('no freeze exercises this prompt yet');
    const gated = buildEvalResult({ ...file([]), surfaces: [skipped], gates_failed: ['core/venue-accuracy'] });
    expect(gated.ok).toBe(false);
    expect(gated.gatesFailed).toEqual(['core/venue-accuracy']);
    expect(evalResultLines(gated)).toEqual(['skip title  no freeze exercises this prompt yet', 'FAIL suite gates failed: core/venue-accuracy']);
  });

  test('a verdict-only rep (score null) scores 1 when passed, else 0', () => {
    const r = buildEvalResult(file([freeze('f1', reps(5, false, { score: null }), reps(5, true, { score: null }))]));
    expect(r.surfaces[0]!.separation).toBe('better');
  });
});

describe('the pieces', () => {
  test('majority: more than half of the scored reps; a tie is no pass; nothing scored is no verdict', () => {
    expect(majorityOf([rep(true), rep(true), rep(false)])).toBe(true);
    expect(majorityOf([rep(true), rep(false)])).toBe(false);
    expect(majorityOf([rep(false, { error: 'x' })])).toBeUndefined();
    expect(majorityOf(undefined)).toBeUndefined();
  });

  test('provenVerdicts records each proven freeze and names a still failing one', () => {
    const { proven, reasons } = provenVerdicts([
      freeze('aaaaaaaa1', reps(3, false), reps(3, true), { proven: true }),
      freeze('cccccccc3', null, reps(3, false), { proven: true }),
      freeze('dddddddd4', reps(3, false), reps(3, false)),
    ]);
    expect(proven).toEqual([{ freeze: 'aaaaaaaa1', basePasses: false, passes: true }, { freeze: 'cccccccc3', basePasses: null, passes: false }]);
    expect(reasons).toEqual(['proven freeze cccccccc still fails']);
  });

  test('repsFileProblem names what is missing', () => {
    expect(repsFileProblem(file([]))).toBeNull();
    expect(repsFileProblem({ ...file([]), version: 2 })).toContain('version must be 1');
    expect(repsFileProblem({ ...file([]), gates_failed: undefined })).toContain('gates_failed');
    expect(repsFileProblem(file([freeze('f', [{ passed: 'yes' } as any], null)]))).toContain('each rep needs passed');
  });
});
