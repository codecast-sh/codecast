// The calibration scorer (priorities-measure.ts) on synthetic data with a
// scripted judge and task statuses: recall over active golden priorities,
// precision over active produced ones in the golden set's scope (mostly-standing
// ones count against it, unlabeled ones are set apart), a golden priority
// matched once per workspace, session mapping over the labeled sessions the
// window read, and false "done" split into real, stale-golden and a done part
// of an open golden step.
import { describe, expect, test } from 'bun:test';
import type { ClassifierChoice } from '../../convex/convex/lib/priorityClassifier';

import { SEED_BASE, classifierSeed, heldOut, keptReads, replayReads, score, scoreClassifier, scoreReads, seedState, type Golden, type Judge, type Match, type Produced, type StepPair, type TaskStatus } from './priorities-measure';

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

/** Task statuses as `cast task show` would report them now. */
const tasksNow = (statuses: Record<string, string> = {}): TaskStatus => async (ids) => new Map(ids.flatMap((id) => (statuses[id] ? [[id, statuses[id]!] as [string, string]] : [])));

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
        'a:1~g1': [{ produced: 0, golden: 0, scope: 'same', reason: '' }, { produced: 1, golden: 1, scope: 'same', reason: '' }, { produced: 1, golden: 0, scope: 'same', reason: 'repeat' }],
        'a:2~g2': [{ produced: 0, golden: 0, scope: 'same', reason: '' }],
      },
    );
    const s = await score(golden, produced, read, judge, tasksNow());

    expect(s.standing_like).toEqual(['a:3']);
    // a:4 and p:1 hold no sessions at all: still in scope, offered and scored.
    expect(offered).toEqual([['a:1', 'a:2', 'a:4', 'p:1']]);
    expect(s.matches.map((m) => `${m.produced}=${m.golden}`)).toEqual(['a:1=g1', 'a:2=g2', 'p:1=g3']);
    expect(s.recall).toEqual({ matched: 3, of: 3, missed: [] });
    // Active produced in scope: a:1, a:2 matched; a:3 (mostly standing) and a:4 (sessionless, g1's slot taken) not.
    expect(s.precision).toEqual({ matched: 2, of: 4, unmatched: ['a:3', 'a:4'] });
    expect(s.unlabeled).toEqual([]);
    // s1, s2, s3 right; s4 sits under g2's match; s5 under an unmatched one; st1 and st2 should be unassigned. s9 was not read.
    expect(Object.fromEntries(s.sessions.results.map((r) => [r.session, r.correct]))).toEqual({ s1: true, s2: true, s3: true, s4: false, s5: false, st1: false, st2: false });
    expect(s.sessions.not_read).toEqual(['s9']);
    // No critical steps on p:1: no alignment asked.
    expect(aligned.sort()).toEqual(['a:1~g1', 'a:2~g2']);
    expect(s.steps.false_done.map((f) => `${f.produced_step}~${f.golden_step}`)).toEqual(['Faults under 10%~Grader faults']);
    expect(s.metrics).toEqual({ recall: 1, precision: 2 / 4, sessions: 3 / 7, step_done: 2 / 3, false_done: 1 });
    expect(s.pass).toBe(false);
  });

  test('meets the bar when every metric clears it and nothing is falsely done', async () => {
    const clean = produced.slice(0, 2).map((p) => ({ ...p, steps: p.steps.map((x) => ({ ...x, done: x.title === 'Every case' })), sessions: p.key === 'a:2' ? ['s3'] : p.sessions }));
    const all = [...clean, { ...produced[4]!, sessions: ['s4'] }];
    const { judge } = scripted(
      [{ produced: 'a:1', golden: 'g1', reason: '' }, { produced: 'a:2', golden: 'g2', reason: '' }, { produced: 'p:1', golden: 'g3', reason: '' }],
      { 'a:1~g1': [{ produced: 0, golden: 0, scope: 'same', reason: '' }, { produced: 1, golden: 1, scope: 'same', reason: '' }] },
    );
    const s = await score(golden, all, read, judge, tasksNow());
    // s5 (golden g4, held by nobody) is the one miss: 6 of 7.
    expect(s.metrics).toEqual({ recall: 1, precision: 1, sessions: 6 / 7, step_done: 1, false_done: 0 });
    expect(s.pass).toBe(true);
  });

  test('a golden priority spanning workspaces matches one produced priority in each: recall counts it once, precision each match', async () => {
    const spread: Produced[] = [
      { key: 'acme:1', workspace: 'acme', title: 'Evals at work', summary: '', status: 'active', steps: [], sessions: ['s1'] },
      { key: 'acme:2', workspace: 'acme', title: 'Evals again', summary: '', status: 'active', steps: [], sessions: ['s3'] },
      { key: 'me:1', workspace: 'personal', title: 'Evals at home', summary: '', status: 'active', steps: [], sessions: ['s2'] },
    ];
    const { judge } = scripted(
      [{ produced: 'acme:1', golden: 'g1', reason: '' }, { produced: 'me:1', golden: 'g1', reason: '' }, { produced: 'acme:2', golden: 'g1', reason: 'second in acme' }],
      {},
    );
    const s = await score(golden, spread, new Map([['s1', ''], ['s2', ''], ['s3', '']]), judge, tasksNow());
    expect(s.matches.map((m) => `${m.produced}=${m.golden}`)).toEqual(['acme:1=g1', 'me:1=g1']);
    expect(s.recall).toMatchObject({ matched: 1, of: 3 });
    expect(s.precision).toEqual({ matched: 2, of: 3, unmatched: ['acme:2'] });
    // s2 sits under the personal match of g1: right. s3 (golden g2) sits under an unmatched one.
    expect(Object.fromEntries(s.sessions.results.map((r) => [r.session, r.correct]))).toEqual({ s1: true, s2: true, s3: false });
  });

  test('a produced priority with no labeled session is unlabeled, outside precision', async () => {
    const extra: Produced[] = [
      { key: 'a:1', workspace: 'acme', title: 'Evals', summary: '', status: 'active', steps: [], sessions: ['s1'] },
      { key: 'p:9', workspace: 'personal', title: 'Wardrobe', summary: '', status: 'active', steps: [], sessions: ['x1', 'x2'] },
    ];
    const { judge } = scripted([{ produced: 'a:1', golden: 'g1', reason: '' }], {});
    const s = await score(golden, extra, new Map([['s1', ''], ['x1', ''], ['x2', '']]), judge, tasksNow());
    expect(s.unlabeled).toEqual(['p:9']);
    expect(s.precision).toEqual({ matched: 1, of: 1, unmatched: [] });
    expect(s.metrics.precision).toBe(1);
  });

  test('an unlabeled priority is never offered to the judge, so it cannot take a labeled one\'s slot', async () => {
    const extra: Produced[] = [
      { key: 'p:9', workspace: 'acme', title: 'Evals too', summary: '', status: 'active', steps: [], sessions: ['x1'] },
      { key: 'a:1', workspace: 'acme', title: 'Evals', summary: '', status: 'active', steps: [], sessions: ['s1'] },
    ];
    // The judge would hand the acme slot to the unlabeled one first; it is never offered it.
    const { judge, offered } = scripted([{ produced: 'p:9', golden: 'g1', reason: '' }, { produced: 'a:1', golden: 'g1', reason: '' }], {});
    const s = await score(golden, extra, new Map([['s1', ''], ['x1', '']]), judge, tasksNow());
    expect(offered[0]).toEqual(['a:1']);
    expect(s.unlabeled).toEqual(['p:9']);
    expect(s.precision).toEqual({ matched: 1, of: 1, unmatched: [] });
  });

  test('a step falsely done is stale when its golden task is done now, real when it has no task or the task is open', async () => {
    const tasked: Golden = {
      ...golden,
      priorities: [{ ...golden.priorities[0]!, critical: [{ title: 'Cases', done: false, task: 'ct-1' }, { title: 'Grader faults', done: false, task: 'ct-2' }, { title: 'Requests path', done: false, task: null }] }, ...golden.priorities.slice(1)],
    };
    const p: Produced[] = [{ key: 'a:1', workspace: 'acme', title: 'Evals', summary: '', status: 'active', steps: [step('Cases', true), step('Faults', true), step('Requests', true)], sessions: ['s1'] }];
    const { judge } = scripted([{ produced: 'a:1', golden: 'g1', reason: '' }], { 'a:1~g1': [0, 1, 2].map((i) => ({ produced: i, golden: i, scope: 'same', reason: '' })) });
    const s = await score(tasked, p, new Map([['s1', '']]), judge, tasksNow({ 'ct-1': 'done', 'ct-2': 'in_progress' }));
    expect(s.steps.stale_done.map((f) => [f.golden_step, f.golden_task, f.task_status, f.verdict])).toEqual([['Cases', 'ct-1', 'done', 'task done now (golden stale)']]);
    expect(s.steps.false_done.map((f) => [f.golden_step, f.golden_task, f.task_status, f.verdict])).toEqual([
      ['Grader faults', 'ct-2', 'in_progress', 'no task / task open (real)'],
      ['Requests path', null, null, 'no task / task open (real)'],
    ]);
    expect(s.metrics.false_done).toBe(2);
  });

  test('a done step that is only part of an open golden step is not a false done; a wider one is', async () => {
    const g: Golden = { ...golden, priorities: [{ ...golden.priorities[0]!, critical: [{ title: 'Every service moved', done: false, task: null }, { title: 'Grader faults', done: false, task: null }, { title: 'Cases', done: true, task: null }] }, ...golden.priorities.slice(1)] };
    const p: Produced[] = [{ key: 'a:1', workspace: 'acme', title: 'Evals', summary: '', status: 'active', steps: [step('Move the iMessage bridge', true), step('Faults and the rest', true), step('One case', false)], sessions: ['s1'] }];
    const { judge } = scripted([{ produced: 'a:1', golden: 'g1', reason: '' }], {
      'a:1~g1': [
        { produced: 0, golden: 0, scope: 'narrower', reason: '' },
        { produced: 1, golden: 1, scope: 'wider', reason: '' },
        // A part still open while the whole is done: wrong.
        { produced: 2, golden: 2, scope: 'narrower', reason: '' },
      ],
    });
    const s = await score(g, p, new Map([['s1', '']]), judge, tasksNow());
    expect(s.steps.part_done.map((f) => f.produced_step)).toEqual(['Move the iMessage bridge']);
    expect(s.steps.false_done.map((f) => f.produced_step)).toEqual(['Faults and the rest']);
    expect(s.metrics.false_done).toBe(1);
    expect(s.metrics.step_done).toBe(1 / 3);
  });
});

describe('seedState', () => {
  test('holds every golden priority with its critical steps open, their tasks linked, and no sessions, numbered clear of real pri-N and on from them', () => {
    const state = seedState(golden, 1000);
    expect(state.cursor_at).toBe(1000);
    expect(state.next_id).toBe(SEED_BASE + 4);
    expect(state.priorities.map((p) => [p.short_id, p.title, p.status, p.sessions.length])).toEqual([
      ['pri-100001', 'Trusted evals', 'active', 0],
      ['pri-100002', 'Simple deploys', 'active', 0],
      ['pri-100003', 'Laptop stops crashing', 'active', 0],
      ['pri-100004', 'Broker changes', 'done', 0],
    ]);
    expect(state.priorities[0]!.steps.map((s) => [s.key, s.title, s.done])).toEqual([['s1', 'Cases', false], ['s2', 'Grader faults', false]]);
    const withTask = seedState({ ...golden, priorities: [{ ...golden.priorities[0]!, critical: [{ title: 'Cases', done: true, task: 'ct-7' }] }] }, 0);
    expect(withTask.priorities[0]!.steps[0]!.refs).toEqual([{ kind: 'task', id: 'ct-7' }]);
  });
});

describe('the classifier replay', () => {
  test('holds out every Nth golden priority and seeds the rest open, done ones included, keeping their numbers', () => {
    expect([...heldOut(golden, 2)]).toEqual(['g2', 'g4']);
    expect([...heldOut(golden, 0)]).toEqual([]);
    expect(classifierSeed(golden, 0, heldOut(golden, 2)).map((p) => [p.short_id, p.status])).toEqual([['pri-100001', 'active'], ['pri-100003', 'active']]);
    expect(classifierSeed(golden, 0, new Set()).map((p) => p.status)).toEqual(['active', 'active', 'active', 'active']);
  });

  test('scores placement into seeded goals, new detection on held-out ones, and standing apart; the verdict is the two together', () => {
    const seeded = (key: string, sessions: string[]): Produced => ({ key, workspace: key.split(':')[0]!, title: '', summary: '', status: 'active', steps: [], sessions });
    // g2 and g4 held out. s1 right; s2 left out; s3 (g2, held out) wrongly placed; s4 right; s5 (g4, held out) rightly left out.
    const placed = [seeded('acme:pri-100001', ['s1', 's3']), seeded('personal:pri-100003', ['s4'])];
    const s = scoreClassifier(golden, placed, read, heldOut(golden, 2));
    expect(s.metrics.placement).toEqual({ correct: 2, of: 3, score: 2 / 3 });
    expect(s.metrics.new).toEqual({ correct: 1, of: 2, score: 1 / 2 });
    expect(s.metrics.combined).toEqual({ correct: 3, of: 5, score: 3 / 5 });
    expect(s.metrics.standing).toEqual({ correct: 2, of: 2, score: 1 });
    expect(s.metrics.as_pass).toEqual({ correct: 4, of: 5, score: 4 / 5 });
    expect(s.not_read).toEqual(['s9']);
    expect(s.pass).toBe(false);
    expect(s.results.filter((r) => !r.correct).map((r) => [r.session, r.kind])).toEqual([['s2', 'placement'], ['s3', 'new']]);
  });

  test('words:N keeps the first read, then each once N more words were typed since the last kept', () => {
    const at = (n: number, chars: number) => ({ trigger: 'message' as const, at: n, chars, session: {} as any });
    const asks = [at(1, 30), at(2, 300), at(3, 600), at(4, 6), at(5, 300)];
    expect(keptReads(asks, null).map((a) => a.at)).toEqual([1, 2, 3, 4, 5]);
    // 100 words is 600 characters: 2 (300) is short of it, 3 (900 since 1) passes, 4 and 5 (306 since 3) do not.
    expect(keptReads(asks, 100).map((a) => a.at)).toEqual([1, 3]);
  });

  test('a cadence replay reads sessions in time order across them, the latest read standing, and children inherit at their first activity', async () => {
    const seed = classifierSeed(golden, 0, new Set());
    const read = (at: number) => ({ trigger: 'message' as const, at, chars: 10, session: { title: `at ${at}` } as any });
    const sessions = [
      { id: 'a', title: 'A', last_active: 1, parent: null, asks: [read(1), read(4)] },
      { id: 'b', title: 'B', last_active: 2, parent: null, asks: [read(2)] },
      { id: 'kid', title: 'Kid', last_active: 3, parent: 'a', asks: [] },
    ];
    const answers: Record<string, ClassifierChoice> = { 'at 1': { priority: `pri-${SEED_BASE + 1}`, step: null }, 'at 2': 'new', 'at 4': { priority: `pri-${SEED_BASE + 2}`, step: null } };
    const seen: string[] = [];
    const rows = await replayReads(sessions, seed, null, async (held, session) => {
      // What each read sees: where the other sessions sit at that moment.
      seen.push(`${session.title}: ${held.flatMap((p) => p.sessions.map((x) => `${x.id}@${p.short_id}`)).join(',')}`);
      return { choice: answers[session.title], reason: '' };
    });
    expect(seen).toEqual([`at 1: `, `at 2: a@pri-${SEED_BASE + 1}`, `at 4: kid@pri-${SEED_BASE + 1},a@pri-${SEED_BASE + 1}`]);
    expect(rows.map((r) => [r.session, r.choice, r.asks.length, r.inherited_from ?? null])).toEqual([
      ['a', { priority: `pri-${SEED_BASE + 2}`, step: null }, 2, null],
      ['b', 'new', 1, null],
      ['kid', { priority: `pri-${SEED_BASE + 1}`, step: null }, 0, 'a'],
    ]);
    // A moved session leaves its old priority; one read as "new" sits nowhere.
    expect(seed.map((p) => p.sessions.map((x) => x.id))).toEqual([['kid'], ['a'], [], []]);
  });

  test('reads: a session is right at its first read, and over its life by the share of its reads that filed it right', () => {
    const pri = (n: number) => ({ priority: `pri-${SEED_BASE + n}`, step: null });
    // g2 and g4 held out. s1 (g1) wrong then right twice; s3 (g2, held out) right at once ("new"); st1 is no label.
    const r = scoreReads(golden, [
      { session: 's1', asks: [{ choice: pri(3) }, { choice: pri(1) }, { choice: pri(1) }] },
      { session: 's3', asks: [{ choice: 'new' }, { choice: pri(1) }] },
      { session: 'st1', asks: [{ choice: pri(1) }] },
      { session: 's4', asks: [] },
    ], heldOut(golden, 2));
    expect(r.first).toEqual({ correct: 1, of: 2, score: 0.5 });
    expect(r.life).toBeCloseTo((2 / 3 + 1 / 2) / 2);
    expect(r.reads).toBe(5);
  });

  test('a run names a session whose short id collides by a longer prefix of its id; the golden label still finds it', () => {
    const g: Golden = { ...golden, priorities: [golden.priorities[0]!], session_labels: { jx7137j: 'g1' }, standing_sessions: [] };
    const placed: Produced[] = [{ key: 'acme:pri-100001', workspace: 'acme', title: '', summary: '', status: 'active', steps: [], sessions: ['jx7137jn'] }];
    const s = scoreClassifier(g, placed, new Map([['jx7137jn', 'Ship flow unification']]), new Set());
    expect(s.results).toMatchObject([{ session: 'jx7137j', title: 'Ship flow unification', correct: true }]);
  });
});
