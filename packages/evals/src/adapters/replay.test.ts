import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSnapshot } from '../commands/snapshot';
import { surfaceMeta } from '../registry';
import { servedReadKey } from '../served';
import type { AgentResult, CallResult } from '../surface';
import { assertAnswered, harnessFailure } from './dryRun';
import { dominantModel, routeGates, scoreOf } from './replay';

const call = (over: Partial<CallResult> = {}): CallResult => ({
  request: { model: 'pin', prompt: 'p', max_tokens: 100 },
  text: 't',
  outputTokens: 10,
  stopReason: 'end_turn',
  modelUsage: { pin: { outputTokens: 10 }, 'side-model': { outputTokens: 2 } },
  costUsd: 0.001,
  isError: false,
  exitCode: 0,
  dir: '/tmp/x',
  realMs: 1,
  ...over,
});
const agent = (calls: string[]): AgentResult => ({ runSubdir: '/tmp/a', said: ['hi'], turns: [['hi']], calls, costUsd: 0.1, modelUsage: { pin: { outputTokens: 50 } }, isError: false, exitCode: 0, model: 'pin', realMs: 1 });
const byId = (gates: Array<{ id: string; pass: boolean; evidence: { summary: string } }>) => Object.fromEntries(gates.map((g) => [g.id, g]));

describe('route gates', () => {
  const callMeta = { ...surfaceMeta('title')!, model: 'pin' };
  const agentMeta = { ...surfaceMeta('role-wake')!, model: 'pin' };

  test('a clean call passes model-as-pinned, ok and prod-budget', () => {
    expect(routeGates(callMeta, { calls: [call()], agents: [] }).map((g) => `${g.id}:${g.pass}`)).toEqual(['model-as-pinned:true', 'ok:true', 'prod-budget:true']);
  });

  test('another model doing most of the work fails model-as-pinned', () => {
    const g = byId(routeGates(callMeta, { calls: [call({ modelUsage: { pin: { outputTokens: 1 }, other: { outputTokens: 90 } } })], agents: [] }));
    expect(g['model-as-pinned']!.pass).toBe(false);
    expect(g['model-as-pinned']!.evidence.summary).toContain('answered on other');
    expect(dominantModel({ a: { outputTokens: 1 }, b: { outputTokens: 3 } })).toBe('b');
  });

  test('a reply prod would have truncated fails prod-budget', () => {
    expect(byId(routeGates(callMeta, { calls: [call({ stopReason: 'max_tokens' })], agents: [] }))['prod-budget']!.pass).toBe(false);
    expect(byId(routeGates(callMeta, { calls: [call({ outputTokens: 101 })], agents: [] }))['prod-budget']!.pass).toBe(false);
  });

  test('an agent read that went live fails frozen-reads and names the argv and the fix', () => {
    const g = byId(routeGates(agentMeta, { calls: [], agents: [agent(['brief', 'SERVED brief', 'UNSERVED org inputs --team T --json'])] }));
    expect(g['frozen-reads']!.pass).toBe(false);
    expect(g['frozen-reads']!.evidence.summary).toContain('cast org inputs --team T --json was not captured, so it was refused: add it to meta.frozenReads');
    expect(g['no-unexpected-writes']!.pass).toBe(true);
    expect(byId(routeGates(agentMeta, { calls: [], agents: [agent(['REFUSED task create x'])] }))['no-unexpected-writes']!.pass).toBe(false);
  });

  test('score: any failed gate zeroes it; a missed floor fails it', () => {
    const ok = { id: 'g', pass: true, evidence: { summary: '' } };
    expect(scoreOf([ok], [{ id: 'c', weight: 1, score: 0.8 }]).pass).toBe(true);
    expect(scoreOf([{ ...ok, pass: false }], [{ id: 'c', weight: 1, score: 0.8 }]).score).toBe(0);
    const floored = scoreOf([ok], [{ id: 'criteria', weight: 1, score: 0.6, must: 0.7 }, { id: 'x', weight: 3, score: 1 }]);
    expect(floored.score).toBeCloseTo(0.9);
    expect(floored.pass).toBe(false);
    expect(floored.missedFloors).toEqual([{ id: 'criteria', score: 0.6, must: 0.7 }]);
  });
});

describe('a run the model never answered', () => {
  // The out.json the harness wrote on 2026-10-01 when the copied login was revoked mid-check.
  const revoked = { is_error: true, terminal_reason: 'api_error', api_error_status: 401, result: 'Failed to authenticate: OAuth token revoked.', modelUsage: {} };

  test('an API error the prompt did not cause, or no out.json, is a harness failure; a 400 and a clean reply are not', () => {
    expect(harnessFailure(revoked, 1)).toBe('API error 401: Failed to authenticate: OAuth token revoked.');
    expect(harnessFailure(null, 2)).toBe('the harness wrote no out.json (exit 2)');
    expect(harnessFailure({ ...revoked, api_error_status: 400, result: 'prompt is too long' }, 1)).toBeUndefined();
    expect(harnessFailure({ is_error: false, terminal_reason: 'completed', result: '{}' }, 0)).toBeUndefined();
  });

  test('the rep crashes instead of failing model-as-pinned, ok and the surface gates', () => {
    expect(() => assertAnswered(call({ harnessFailure: harnessFailure(revoked, 1), dir: '/tmp/x/run' }), 'call1')).toThrow('call1 never reached the model: API error 401');
    expect(() => assertAnswered(call(), 'call1')).not.toThrow();
  });
});

describe('snapshot', () => {
  test('captures every frozen read by its served key, the legacy org files, the frozen verbs, read-only', () => {
    process.env.CODECAST_EVALS_HOME = mkdtempSync(join(tmpdir(), 'evals-snap-'));
    try {
      const seen: string[][] = [];
      const dir = runSnapshot('role-wake', ['--team', 'T', '--role', 'R', '--name', 'scratch'], (argv) => {
        seen.push(argv);
        return { out: `served ${argv.join(' ')}`, code: argv[0] === 'sessions' ? 3 : 0 };
      });
      expect(seen).toEqual(surfaceMeta('role-wake')!.frozenReads!.map((t) => t.map((p) => p.replace('{team}', 'T').replace('{role}', 'R'))));
      expect(readFileSync(join(dir, 'reads', `${servedReadKey(['brief'])}.out`), 'utf8')).toBe('served brief @R');
      expect(readFileSync(join(dir, 'reads', `${servedReadKey(['sessions', '--json'])}.exit`), 'utf8').trim()).toBe('3');
      expect(readFileSync(join(dir, 'org-inputs.json'), 'utf8')).toBe('served org inputs --team T --json');
      expect(readFileSync(join(dir, 'frozen'), 'utf8').trim().split('\n')).toEqual(['brief', 'org', 'sessions']);
      expect(statSync(join(dir, 'captured.json')).mode & 0o777).toBe(0o444);
      expect(() => runSnapshot('role-wake', ['--team', 'T', '--role', 'R', '--name', 'scratch'], () => ({ out: '', code: 0 }))).toThrow('immutable');
      expect(() => runSnapshot('role-wake', ['--role', 'R', '--name', 'other'], () => ({ out: '', code: 0 }))).toThrow('--team is required');
      expect(() => runSnapshot('title', [], () => ({ out: '', code: 0 }))).toThrow('snapshot is for the agent surfaces');
    } finally {
      delete process.env.CODECAST_EVALS_HOME;
    }
  });
});
