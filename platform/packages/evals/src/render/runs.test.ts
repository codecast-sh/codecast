import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureScore, writeFixtureRun } from '../fixture';
import { fsRunSource } from '../fs';
import type { RunDetail, Score } from '../model';
import { CHECK_MOVE, diffRuns, renderRunDiff, type DiffableRun } from './runs';

const run = (gates: Array<[string, boolean]>, checks: Array<[string, number]>): DiffableRun => ({
  verdict: { gates: gates.map(([id, pass]) => ({ id, pass })), checks: checks.map(([id, score]) => ({ id, score })) },
});

describe('diffRuns', () => {
  test('lists gate flips, then checks that moved by CHECK_MOVE or more, in b order', () => {
    const a = run([['no-leak', true], ['addressed', false], ['steady', true]], [['tone', 0.9], ['criteria', 0.8], ['brief', 0.5]]);
    const b = run([['steady', true], ['addressed', true], ['no-leak', false]], [['brief', 0.69], ['criteria', 0.6], ['tone', 0.3]]);
    expect(diffRuns(a, b)).toEqual([
      { kind: 'gate', id: 'addressed', before: false, after: true },
      { kind: 'gate', id: 'no-leak', before: true, after: false },
      { kind: 'check', id: 'criteria', before: 0.8, after: 0.6 },
      { kind: 'check', id: 'tone', before: 0.9, after: 0.3 },
    ]);
  });
  test('a move just under the threshold is not a move, and one exactly at it is', () => {
    expect(CHECK_MOVE).toBe(0.2);
    expect(diffRuns(run([], [['c', 0.5]]), run([], [['c', 0.69]]))).toEqual([]);
    expect(diffRuns(run([], [['c', 0.5]]), run([], [['c', 0.25]]))).toEqual([{ kind: 'check', id: 'c', before: 0.5, after: 0.25 }]);
  });
  test('ids on only one side, unscored runs and identical runs yield nothing', () => {
    expect(diffRuns(run([['only-a', true]], [['only-a', 0]]), run([['only-b', false]], [['only-b', 1]]))).toEqual([]);
    expect(diffRuns({ verdict: null }, run([['g', false]], [['c', 1]]))).toEqual([]);
    expect(diffRuns(run([['g', false]], [['c', 1]]), {})).toEqual([]);
    const same = run([['g', true]], [['c', 0.4]]);
    expect(diffRuns(same, same)).toEqual([]);
  });
  test('takes a bare score.json as the verdict', () => {
    const before: Score = fixtureScore;
    const after: Score = { ...fixtureScore, gates: fixtureScore.gates.map((g, i) => (i === 0 ? { ...g, pass: !g.pass } : g)) };
    const first = fixtureScore.gates[0]!;
    expect(diffRuns({ verdict: before }, { verdict: after })).toEqual([{ kind: 'gate', id: first.id, before: first.pass, after: !first.pass }]);
  });
});

describe('renderRunDiff', () => {
  let root: string;
  let a: RunDetail;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'evals-diff-'));
    writeFixtureRun(root);
    a = (await fsRunSource({ root }).get('weekend-seed42'))!;
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const opts = { color: false, width: 100, cli: 'xrun' };

  test('prints what diffRuns found under "what moved"', () => {
    const v = a.verdict!;
    const b: RunDetail = {
      ...a,
      id: 'weekend-seed43',
      verdict: { ...v, gates: v.gates.map((g, i) => (i === 0 ? { ...g, pass: !g.pass } : g)), checks: v.checks.map((c, i) => (i === 0 ? { ...c, score: c.score >= 0.5 ? c.score - 0.4 : c.score + 0.4 } : c)) },
    };
    const moved = diffRuns(a, b);
    expect(moved.map((d) => d.kind)).toEqual(['gate', 'check']);
    const text = renderRunDiff(a, b, opts);
    const tail = text.slice(text.indexOf('what moved'));
    const g = moved[0]!;
    const c = moved[1]!;
    if (g.kind !== 'gate' || c.kind !== 'check') throw new Error('unexpected order');
    expect(tail).toContain(`  ${g.id}: ${g.before ? 'held' : 'failed'} → ${g.after ? 'held' : 'failed'}`);
    expect(tail).toContain(`  ${c.id}: ${c.before.toFixed(2)} → ${c.after.toFixed(2)}`);
    expect(renderRunDiff(a, a, opts)).toContain('nothing by 0.2 or a gate');
  });
});
