// The calibration scorer (priorities-measure.ts) on synthetic data with a
// scripted judge: recall over active golden priorities, precision over active
// produced ones (mostly-standing ones count against it), session mapping over
// the labeled sessions the window read, and false "done" over aligned steps.
import { describe, expect, test } from 'bun:test';

import { score, type Golden, type Judge, type Match, type Produced, type StepPair } from './priorities-measure';

const golden: Golden = {
  person: 'Ana',
  window: ['2026-11-10', '2026-11-24'],
  priorities: [
    { id: 'g1', title: 'Trusted evals', workspace: 'acme', status: 'active', critical: [{ title: 'Cases', done: true, task: null }, { title: 'Grader faults', done: false, task: null }], sessions: ['s1', 's2', 's9'] },
    { id: 'g2', title: 'Simple deploys', workspace: 'acme', status: 'active', critical: [{ title: 'One button', done: false, task: null }], sessions: ['s3'] },
    { id: 'g3', title: 'Laptop stops crashing', workspace: 'personal', status: 'active', sessions: ['s4'] },
    { id: 'g4', title: 'Broker changes', workspace: null, status: 'done', sessions: ['s5'] },
  ],
  session_labels: { s1: 'g1', s2: 'g1', s9: 'g1', s3: 'g2', s4: 'g3', s5: 'g4' },
  standing_sessions: ['st1', 'st2'],
};

const step = (title: string, done: boolean, tier = 'critical') => ({ title, tier, done });
const produced: Produced[] = [
  { key: 'a:1', workspace: 'acme', title: 'Evals', summary: '', status: 'active', steps: [step('Every case', true), step('Faults under 10%', true), step('Docs', true, 'polish')], sessions: ['s1', 's2'] },
  { key: 'a:2', workspace: 'acme', title: 'Deploys', summary: '', status: 'active', steps: [step('Deploy button', false)], sessions: ['s3', 's4'] },
  { key: 'a:3', workspace: 'acme', title: 'People lead', summary: '', status: 'active', steps: [], sessions: ['st1', 'st2', 's5'] },
  { key: 'a:4', workspace: 'acme', title: 'Ghost', summary: '', status: 'active', steps: [], sessions: [] },
  { key: 'p:1', workspace: 'personal', title: 'Crashes', summary: '', status: 'quiet', steps: [], sessions: [] },
];
const read = new Map(['s1', 's2', 's3', 's4', 's5', 'st1', 'st2'].map((s) => [s, `Session ${s}`]));

function scripted(matches: Match[], steps: Record<string, StepPair[]>) {
  const offered: string[][] = [];
  const aligned: string[] = [];
  const judge: Judge = {
    async match(p) {
      offered.push(p.map((x) => x.key));
      return matches;
    },
    async alignSteps(p, g) {
      aligned.push(`${p.key}~${g.id}`);
      return steps[`${p.key}~${g.id}`] ?? [];
    },
  };
  return { judge, offered, aligned };
}

describe('score', () => {
  test('recall, precision, session mapping, step-done and false done', async () => {
    const { judge, offered, aligned } = scripted(
      [
        { produced: 'a:1', golden: 'g1', reason: '' },
        { produced: 'a:2', golden: 'g2', reason: '' },
        { produced: 'a:3', golden: 'g4', reason: 'not offered: mostly standing' },
        { produced: 'p:1', golden: 'g3', reason: '' },
        { produced: 'a:4', golden: 'g1', reason: 'g1 already taken' },
      ],
      {
        'a:1~g1': [{ produced: 0, golden: 0, reason: '' }, { produced: 1, golden: 1, reason: '' }, { produced: 1, golden: 0, reason: 'repeat' }],
        'a:2~g2': [{ produced: 0, golden: 0, reason: '' }],
      },
    );
    const s = await score(golden, produced, read, judge);

    expect(s.standing_like).toEqual(['a:3']);
    expect(offered).toEqual([['a:1', 'a:2', 'a:4', 'p:1']]);
    expect(s.matches.map((m) => `${m.produced}=${m.golden}`)).toEqual(['a:1=g1', 'a:2=g2', 'p:1=g3']);
    // Every active golden priority is matched; a quiet produced one counts for recall.
    expect(s.recall).toEqual({ matched: 3, of: 3, missed: [] });
    // Active produced: a:1, a:2 matched; a:3 (mostly standing) and a:4 not.
    expect(s.precision).toEqual({ matched: 2, of: 4, unmatched: ['a:3', 'a:4'] });
    // s1, s2, s3 right; s4 sits under g2's match; s5 under an unmatched one; st1 and st2 should be unassigned. s9 was not read.
    expect(Object.fromEntries(s.sessions.results.map((r) => [r.session, r.correct]))).toEqual({ s1: true, s2: true, s3: true, s4: false, s5: false, st1: false, st2: false });
    expect(s.sessions.not_read).toEqual(['s9']);
    // No critical steps on p:1: no alignment asked.
    expect(aligned.sort()).toEqual(['a:1~g1', 'a:2~g2']);
    expect(s.steps.false_done.map((f) => `${f.produced_step}~${f.golden_step}`)).toEqual(['Faults under 10%~Grader faults']);
    expect(s.metrics).toEqual({ recall: 1, precision: 0.5, sessions: 3 / 7, step_done: 2 / 3, false_done: 1 });
    expect(s.pass).toBe(false);
  });

  test('meets the bar when every metric clears it and nothing is falsely done', async () => {
    const clean = produced.slice(0, 2).map((p) => ({ ...p, steps: p.steps.map((x) => ({ ...x, done: x.title === 'Every case' })), sessions: p.key === 'a:2' ? ['s3'] : p.sessions }));
    const all = [...clean, { ...produced[4]!, sessions: ['s4'] }];
    const { judge } = scripted(
      [{ produced: 'a:1', golden: 'g1', reason: '' }, { produced: 'a:2', golden: 'g2', reason: '' }, { produced: 'p:1', golden: 'g3', reason: '' }],
      { 'a:1~g1': [{ produced: 0, golden: 0, reason: '' }, { produced: 1, golden: 1, reason: '' }] },
    );
    const s = await score(golden, all, read, judge);
    // s5 (golden g4, held by nobody) is the one miss: 6 of 7.
    expect(s.metrics).toEqual({ recall: 1, precision: 1, sessions: 6 / 7, step_done: 1, false_done: 0 });
    expect(s.pass).toBe(true);
  });
});
