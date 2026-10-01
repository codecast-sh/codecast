import { describe, expect, test } from 'bun:test';

import { evalSignals, reportSignals, signalArgv, type SurfaceVerdict } from './signals';

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
      ['prompt_miss', 'evals:title:abcdef1234567890'],
    ]);
    for (const s of out) {
      expect(s.subject).toBe('title');
      expect(s.url).toBe('https://codecast.sh/a/evals');
      expect(s.detail).toContain('title  pass 5/5');
    }
    expect(evalSignals({ ...held, regression: true })[0].fingerprint).toBe(out[0].fingerprint);
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
