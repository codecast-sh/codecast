import { describe, expect, test } from 'bun:test';

import type { BisectState, CommitRef } from '@codecast/shared/contracts/evalsApi';

import { bisectSignal, evalSignals, evalsSurfacePath, reportSignals, signalArgv, type SurfaceVerdict } from './signals';

const held: SurfaceVerdict = { surface: 'title', regression: false, gatesFailed: [], failingFreezes: [], summary: ['title  pass 5/5'] };

describe('evalSignals', () => {
  test('a surface that held files nothing', () => {
    expect(evalSignals(held)).toEqual([]);
  });

  test('regression, each gate and each failing freeze get their own stable fingerprint and kind', () => {
    const out = evalSignals({ ...held, regression: true, gatesFailed: ['length', 'json'], failingFreezes: ['abcdef1234567890'] }, 'https://codecast.sh/a/evals');
    expect(out.map((s) => [s.kind, s.fingerprint])).toEqual([
      ['regression', 'evals:title:separated-worse'],
      ['regression', 'evals:title:length'],
      ['regression', 'evals:title:json'],
      ['prompt_miss', 'evals:title:abcdef12'],
    ]);
    for (const s of out) {
      expect(s.subject).toBe('title');
      expect(s.url).toBe('https://codecast.sh/a/evals');
      expect(s.detail).toContain('title  pass 5/5');
    }
    expect(evalSignals({ ...held, regression: true })[0].fingerprint).toBe(out[0].fingerprint);
    // A signal leaves the laptop, so it names a failing freeze by its prefix only, the fingerprint included.
    expect(out[3].detail).toContain('freeze abcdef12 failed');
    expect(signalArgv(out[3]).join(' ')).not.toContain('abcdef1234567890');
  });

  test('no evidence url leaves the flag off', () => {
    const [s] = evalSignals({ ...held, gatesFailed: ['json'] });
    expect(s.url).toBeUndefined();
    expect(signalArgv(s)).not.toContain('--url');
  });
});

describe('reportSignals', () => {
  const signals = evalSignals({ ...held, gatesFailed: ['json'], failingFreezes: ['f1'] }, 'https://x');

  test('files each through cast signal add with source evals', () => {
    const calls: string[][] = [];
    const lines = reportSignals(signals, {
      run: (argv) => {
        calls.push(argv);
        return { status: 0, stdout: JSON.stringify({ short_id: `sg-${calls.length}`, task_short_id: 'ct-9', attach: 'new' }), stderr: '' };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].slice(0, 6)).toEqual(['signal', 'add', '--source', 'evals', '--kind', 'regression']);
    expect(calls[1]).toContain('prompt_miss');
    expect(calls[1]).toContain('--json');
    expect(lines).toEqual(['filed sg-1 evals:title:json -> ct-9 (new)', 'filed sg-2 evals:title:f1 -> ct-9 (new)']);
  });

  test('a failed filing is a line, not a throw', () => {
    const lines = reportSignals(signals.slice(0, 1), { run: () => ({ status: 1, stdout: '', stderr: 'boom\nUnauthorized' }) });
    expect(lines).toEqual(['not filed evals:title:json: Unauthorized']);
  });

  test('dry runs nothing', () => {
    const lines = reportSignals(signals, { dry: true, run: () => { throw new Error('ran'); } });
    expect(lines[0]).toStartWith('would file regression evals:title:json');
  });
});

describe('the in-app path', () => {
  test('a verdict signal names the surface page with its batch pinned', () => {
    const [s] = evalSignals({ ...held, batch: '2026-10-03T00:53:31.614Z', gatesFailed: ['json'] });
    expect(s.detail).toContain('/evals/s/title?batch=2026-10-03T00%3A53%3A31.614Z');
    expect(evalsSurfacePath('settle')).toBe('/evals/s/settle');
  });
});

describe('bisectSignal', () => {
  const reply = 'I looked at the session and the agent is waiting on review';
  const commit = (sha: string): CommitRef => ({ sha, subject: `subject of ${sha}`, author: 'a', at: '2026-10-02T00:00:00Z', session: null, mainSha: sha, onMain: true });
  const state = (answer: BisectState['answer'], status: BisectState['status'] = 'done'): BisectState =>
    ({
      id: 'settle-20261004-004540',
      surface: 'settle',
      status,
      answer,
      range: { good: '2026-10-01T07:00:00.000Z', bad: '2026-10-03T07:33:53.398Z' },
      plan: { freezes: [{ id: 'abcdef1234567890', name: reply, role: 'flipped' }, { id: '99999999aaaa', name: 'stable', role: 'control' }] },
    }) as unknown as BisectState;

  test('a culprit files one regression carrying the in-app paths, the sha and freeze prefixes only', () => {
    const s = bisectSignal(state({ kind: 'culprit', commit: commit('0ae504f0123456789'), separation: { kind: 'worse', p: 0.01 }, tier: 2 } as BisectState['answer']))!;
    expect(s.kind).toBe('regression');
    expect(s.fingerprint).toBe('evals:settle:bisect:0ae504f01');
    expect(s.title).toBe('settle eval regression traced to 0ae504f01');
    expect(s.detail).toContain('/evals/s/settle?batch=2026-10-03T07%3A33%3A53.398Z');
    expect(s.detail).toContain('/evals/bisect/settle-20261004-004540');
    expect(s.detail).toContain('abcdef12');
    expect(s.detail).not.toContain('99999999');
    // No reply, no freeze name, no commit subject: the signal leaves the laptop.
    for (const text of [s.title, s.detail]) {
      expect(text).not.toContain(reply);
      expect(text).not.toContain('subject of');
    }
  });

  test('a range names its ends, the patch candidate included', () => {
    const s = bisectSignal(state({ kind: 'range', candidates: [{ kind: 'commit', commit: commit('1111111aaaa'), renderClass: 0 }, { kind: 'patch', base: '1111111aaaa', treePatch: '87d03bffff', renderClass: 1 }], separation: null, tier: 2 } as BisectState['answer']))!;
    expect(s.fingerprint).toBe('evals:settle:bisect:1111111aa..patch:87d03bff');
    expect(s.detail).toContain('uncommitted edits 87d03bff on 1111111aa');
  });

  test('drift, a non-source answer, or an unfinished bisect files nothing', () => {
    expect(bisectSignal(state({ kind: 'drift', detail: 'does not reproduce' }))).toBeNull();
    expect(bisectSignal(state({ kind: 'attribution', answer: { kind: 'noise', separation: { kind: 'too-few' } } } as BisectState['answer']))).toBeNull();
    expect(bisectSignal(state(null, 'probing'))).toBeNull();
  });

  test('a plan with no flipped freeze files nothing, even when an older state answered source (title-20261005-074131)', () => {
    const s = { ...state({ kind: 'attribution', answer: { kind: 'source', confidence: 'pinned', candidates: [{ kind: 'commit', commit: commit('3333333aaaa'), renderClass: 0 }] } } as BisectState['answer']), plan: { freezes: [] } } as unknown as BisectState;
    expect(bisectSignal(s)).toBeNull();
  });
});
