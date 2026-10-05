import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRowProblems, type BisectState, type CommitRef, type RunRow } from '@codecast/shared/contracts/evalsApi';

import type { AttributionGit } from '../history/attribution';
import type { PromptReader } from '../history/epochs';
import { costBound, costLine, planFrom, renderPlan, searchable, type PlanArgs, type PlanWorld } from './plan';
import { renderBatch, renderClasses, treeLabel, type CheckExit, type ProbeEnv, type Tree } from './probe';
import { crashedFocus, readProbe } from './reading';
import { runBisect, startRefusal } from './runner';
import { bisectPaths, readBisectState, readSteps, requestStop } from './state';

// The bisect engine on a synthetic world: a linear main line C(0)..C(6),
// freeze A breaking somewhere inside it, B and D passing throughout as the
// controls, and a fake `check` that writes index rows the way the real one
// resumes a named batch (only the seeds a batch lacks run). Nothing here
// makes a worktree or spends anything.

let home: string;
const saved = { home: process.env.CODECAST_EVALS_HOME, test: process.env.CODECAST_EVALS_TEST };
beforeAll(() => {
  process.env.CODECAST_EVALS_TEST = '1';
});
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evals-bisect-'));
  process.env.CODECAST_EVALS_HOME = home;
});
afterAll(() => {
  for (const [k, v] of [['CODECAST_EVALS_HOME', saved.home], ['CODECAST_EVALS_TEST', saved.test]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const S = 'echo';
const C = (i: number): string => String(i).repeat(40);
const idx = (sha: string) => (/^(\d)\1{39}$/.test(sha) ? Number(sha[0]) : -1);
const A = 'a1a1a1a1-0000-4000-8000-00000000000a';
const E = 'e5e5e5e5-0000-4000-8000-00000000000e';
const B = 'b2b2b2b2-0000-4000-8000-00000000000b';
const D = 'd4d4d4d4-0000-4000-8000-00000000000d';
const day = (n: number) => `2026-09-${String(n).padStart(2, '0')}T00:00:00.000Z`;

let clock = 0;
/** One index row: passing on m1 under ruler r1 at C(0), unless told otherwise. */
function row(batch: string, freezeId: string, seed: number, o: Partial<RunRow> = {}): RunRow {
  const score = o.score === undefined ? 0.9 : o.score;
  const at = new Date(Date.UTC(2026, 8, 1) + clock++ * 1000).toISOString();
  return {
    id: `${S}-${freezeId.slice(0, 8)}-seed${seed}-${batch}`, surface: S, freezeId, freezeName: `freeze ${freezeId.slice(0, 2)}`, visibility: 'private', seed, stamp: at, batch, batchAt: o.batchAt ?? at, cadence: null,
    status: score !== null && score >= 0.7 ? 'pass' : 'fail', score, passMark: 0.7, gatesFailed: [], checks: {}, missedFloors: [], model: 'm1', judgeModel: 'j1', ruler: 'r1',
    gitHead: C(0), mainSha: C(0), dirty: false, offBranch: false, treePatch: null, sourceHash: null, sourceHashDisk: null, promptSha: 'p0', freezeSha: null, liveReads: 0,
    costUsd: 0.1, judgeCostUsd: 0.01, realMs: 1, guard: { served: 0, unserved: 0, live: 0, refused: 0, unknown: 0, help: 0 }, scoreVersions: 1, ...o,
  };
}
const batchOf = (batch: string, at: string, by: Record<string, Partial<RunRow>>, reps = 3): RunRow[] => Object.entries(by).flatMap(([f, o]) => Array.from({ length: reps }, (_, i) => row(batch, f, i + 1, { batchAt: at, ...o })));

/** The good batch at C(0) passes everything; the bad batch at C(6) fails A (and E when `two`). */
function world(o: { two?: boolean; bad?: Partial<RunRow>; good?: Partial<RunRow> } = {}): RunRow[] {
  const at6 = { gitHead: C(6), mainSha: C(6), ...o.bad };
  return [
    ...batchOf('good', day(1), { [A]: { ...o.good }, [B]: { ...o.good }, [D]: { ...o.good }, ...(o.two ? { [E]: { ...o.good } } : {}) }),
    ...batchOf('bad', day(5), { [A]: { ...at6, score: 0.2 }, [B]: at6, [D]: at6, ...(o.two ? { [E]: { ...at6, score: 0.2 } } : {}) }),
  ];
}

/** A linear main line; every commit after C(0) touches the declared sources unless `touching` says otherwise. */
function fakeGit(touching = [1, 2, 3, 4, 5, 6]): AttributionGit {
  const line = [0, 1, 2, 3, 4, 5, 6].map(C);
  const ref = (sha: string): CommitRef => ({ sha, subject: `commit ${sha[0]}`, author: 'dev', at: day(1), session: null, mainSha: sha, onMain: true });
  return {
    resolve: (name) => line.find((s) => s.startsWith(name)) ?? null,
    isAncestor: (a, b) => idx(a) <= idx(b),
    path: (g, b, paths) => line.slice(idx(g) + 1, idx(b) + 1).filter((s) => paths === null || touching.includes(idx(s))).map(ref),
    changed: () => [],
    show: () => null,
  };
}
const reader: PromptReader = { files: () => [], text: () => null, size: () => null };
/** The plan's world: fake git and prompts, and a recorded $0.10 a rep on m1, what the fake check charges (plus the judge's cent). */
const W = (_rows?: RunRow[]): Omit<PlanWorld, 'rows'> => ({ git: fakeGit(), heads: null, reader, state: { [S]: { perRep: { m1: { usd: 0.1, seconds: 1 } } } } });

interface Fake extends ProbeEnv {
  calls: Array<{ tree: string; batch: string; reps: number; dry: boolean; budget: number | undefined }>;
  world: RunRow[];
}

/**
 * A fake `check`: for each freeze it runs the seeds the batch lacks, up to
 * --reps, scoring each with `score` (or as `render` says for a dry render).
 * It honours the stop file and refuses an estimate over --budget, as check
 * does. `hang` never answers that call: a kill mid-probe.
 */
function fakeEnv(rows: RunRow[], o: { score?: (t: Tree, f: string, seed: number) => number; render?: (t: Tree, f: string) => string; loadError?: (t: Tree, dry: boolean) => string | null; hang?: (n: number) => boolean; onCall?: (n: number) => void; params?: (id: string) => string; crash?: (t: Tree, f: string) => boolean } = {}): Fake {
  const calls: Fake['calls'] = [];
  const badAt = (t: Tree) => idx(t.sha) >= 3 || !!t.patch;
  const score = o.score ?? ((t: Tree, f: string) => (f === A && badAt(t) ? 0.2 : 0.9));
  return {
    surface: S,
    world: rows,
    calls,
    rows: async () => [...rows].reverse(),
    params: o.params ?? (() => 'haiku'),
    async check(tree, args): Promise<CheckExit> {
      const n = calls.length;
      calls.push({ tree: treeLabel(tree), batch: args.batch, reps: args.reps ?? 0, dry: !!args.dry, budget: args.budget });
      const err = o.loadError?.(tree, !!args.dry);
      if (err) return { kind: 'load-error', error: err };
      if (o.hang?.(n)) return new Promise(() => {});
      if (args.stopFile && existsSync(args.stopFile)) return { kind: 'exit', code: 3 };
      const have = new Set(rows.filter((r) => r.batch === args.batch && r.status !== 'crash').map((r) => `${r.freezeId}:${r.seed}`));
      const todo = (args.freeze ?? []).flatMap((f) => Array.from({ length: args.reps ?? 1 }, (_, i) => ({ f, seed: i + 1 }))).filter((x) => !have.has(`${x.f}:${x.seed}`));
      if (!args.dry && args.budget != null && todo.length * 0.11 > args.budget + 1e-9) return { kind: 'exit', code: 1 };
      for (const { f, seed } of todo) {
        const base = { gitHead: tree.sha, mainSha: tree.sha, dirty: !!tree.patch, cadence: 'bisect' };
        rows.push(args.dry ? row(args.batch, f, seed, { ...base, status: 'dry', score: null, costUsd: 0, judgeCostUsd: 0, promptSha: o.render?.(tree, f) ?? 'p0' }) : o.crash?.(tree, f) ? row(args.batch, f, seed, { ...base, status: 'crash', score: null }) : row(args.batch, f, seed, { ...base, score: score(tree, f, seed) }));
      }
      o.onCall?.(n);
      return { kind: 'exit', code: 0 };
    },
  };
}

/** Renders: C1-C2 render as the good side, C3-C4 alike, C5-C6 alike: three classes. */
const threeClasses = (t: Tree) => (idx(t.sha) <= 2 ? 'r0' : idx(t.sha) <= 4 ? 'r1' : 'r2');
const args = (o: Partial<PlanArgs> = {}): PlanArgs => ({ surface: S, good: 'good', bad: 'bad', ...o });
const run = (id: string, env: Fake, o: Partial<PlanArgs> = {}, ro: Parameters<typeof runBisect>[3] = {}) => runBisect(id, args(o), env, { world: W(env.world), toolHead: 'tool', ...ro });
const probeKinds = (s: BisectState) => s.probes.filter((p) => !p.recorded).map((p) => `${p.kind}@${p.sha[0]}${p.renderClass != null ? `c${p.renderClass}` : ''}:${p.verdict}`);

describe('the plan: Tier 0 answers and the cost bound', () => {
  test('every fixture row is a valid index row', () => {
    for (const r of world({ two: true })) expect(runRowProblems(r)).toEqual([]);
  });

  test('the bound follows the spec formula, and its line reads in plain words', () => {
    const b = costBound({ classes: 3, freezes: 3, reps: 3, perRepUsd: 0.02, judgePerRepUsd: 0 });
    expect(b).toMatchObject({ classes: 3, probes: 2, freezes: 3, reps: 3, maxReps: 110 });
    expect(b.maxUsd).toBeCloseTo(2.2);
    expect(costLine(b, 2.6)).toBe('2 controls + up to 2 probes + confirmation, 3 freezes, 3 to 5 reps: at most 110 reps, about $2.20, budget $2.60');
    expect(costBound({ classes: 0, freezes: 3, reps: 3, perRepUsd: 1, judgePerRepUsd: 0 }).maxReps).toBe(0);
  });

  test('a source range: the flipped freeze plus two stable controls, every candidate a class until rendered', () => {
    const rows = world();
    const p = planFrom(args(), { rows, ...W(rows) });
    expect(p.freezes.map((f) => [f.id[0], f.role])).toEqual([['a', 'flipped'], ['b', 'control'], ['d', 'control']]);
    expect(p.candidates.map((c) => (c.kind === 'commit' ? c.commit.sha[0] : '?'))).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(p.classes).toBeNull();
    expect(p.bound).toMatchObject({ classes: 6, probes: 3, freezes: 3, reps: 3, maxReps: (2 + 3) * 3 * 5 + 2 * 5 * 5 });
    expect(p.budgetUsd).toBeCloseTo(p.bound.maxUsd * 1.2, 2);
    expect(searchable(p.attribution)).toBe(true);
    expect(startRefusal(p)).toBeNull();
    expect(p.summary).toMatch(/^2 controls \+ up to 3 probes \+ confirmation, 3 freezes, 3 to 5 reps: at most 125 reps, about \$/);
  });

  test('a chosen freeze list holds for the controls too, so unticking one prices the smaller set', () => {
    const rows = world();
    const p = planFrom({ ...args(), freezes: ['a', 'b'] }, { rows, ...W(rows) });
    expect(p.freezes.map((f) => [f.id[0], f.role])).toEqual([['a', 'flipped'], ['b', 'control']]);
    expect(p.bound).toMatchObject({ freezes: 2, maxReps: (2 + 3) * 2 * 5 + 2 * 4 * 5 });
  });

  test('each non-source Tier 0 answer has nothing to search, and says why', () => {
    const cases: Array<[string, RunRow[], RegExp]> = [
      ['footing', world({ bad: { model: 'm2' } }), /^the model moved \(m1 to m2\): not a source change, nothing to search$/],
      ['freeze', world({ good: { freezeSha: 'f1' }, bad: { freezeSha: 'f2' } }), /^the frozen moment changed on a1a1a1a1: not a source change/],
      ['live-reads', world({ bad: { liveReads: 2 } }), /^3 bad rep\(s\) read the live workspace: not reproducible/],
      ['noise', [...batchOf('good', day(1), { [A]: {} }, 5), ...batchOf('bad', day(2), { [A]: { score: 0.2 } }, 5)], /^nothing differs between the two sides \(worse, p=0\.\d+\): noise, nothing to search$/],
    ];
    for (const [kind, rows, words] of cases) {
      const p = planFrom(args(), { rows, ...W(rows) });
      expect(p.attribution.answer.kind).toBe(kind as never);
      expect(searchable(p.attribution)).toBe(false);
      expect(p.bound.maxReps).toBe(0);
      expect(p.summary).toMatch(words);
      expect(startRefusal(p)).toBe(`nothing to search: ${p.summary}`);
    }
  });

  test('a source answer the records pin needs no search: no spend, no start', () => {
    const rows = world();
    const p = planFrom(args(), { rows, ...W(rows), git: fakeGit([4]) });
    expect(p.attribution.answer).toMatchObject({ kind: 'source', confidence: 'pinned' });
    expect(p.summary).toBe('pinned by the records to 444444444 commit 4: nothing to spend');
    expect(p.bound.maxReps).toBe(0);
    expect(startRefusal(p)).not.toBeNull();
  });

  test('an empty range cannot start and names --all-commits, which prices every commit in it', () => {
    const rows = world();
    const p = planFrom(args(), { rows, ...W(rows), git: fakeGit([]) });
    expect(p.attribution.answer).toMatchObject({ kind: 'source', confidence: 'empty', candidates: [], rangeCommits: 6 });
    expect(p.summary).toBe('no declared source moved in the range; --all-commits searches every commit');
    expect(p.bound.maxReps).toBe(0);
    expect(startRefusal(p)).toBe(`nothing to search: ${p.summary}`);
    const wide = planFrom(args({ allCommits: true }), { rows, ...W(rows), git: fakeGit([]) });
    expect(wide.allCommits).toBe(true);
    expect(wide.candidates).toHaveLength(6);
    expect(wide.bound).toMatchObject({ classes: 6, probes: 3 });
    expect(startRefusal(wide)).toBeNull();
  });

  test('an unattributable range still lists its candidates and can be searched', () => {
    const rows = world({ bad: { dirty: true } });
    const p = planFrom(args(), { rows, ...W(rows) });
    expect(p.attribution.answer).toMatchObject({ kind: 'source', confidence: 'unattributable', reason: expect.stringMatching(/^bad bad ran on uncommitted edits to 666666666 that nothing recorded can replay$/) });
    expect(p.candidates).toHaveLength(6);
    expect(searchable(p.attribution)).toBe(true);
    expect(p.bound.classes).toBe(6);
    expect(startRefusal(p)).toBeNull();
  });

  test('an agent surface needs the confirm', () => {
    const rows = world().map((r) => ({ ...r, surface: 'role-wake' }));
    const p = planFrom({ ...args(), surface: 'role-wake' }, { rows, ...W(rows) });
    expect(p.needsConfirm).toBe(true);
    expect(startRefusal(p)).toMatch(/^role-wake is an agent surface: .*pass --yes to start/);
    expect(startRefusal(p, true)).toBeNull();
  });
});

describe('Tier 1: dry renders fold candidates into classes', () => {
  test('neighbours that render alike fold; a load error is a skip of its own; renders on record are not run again', async () => {
    const rows = world();
    const p = planFrom(args(), { rows, ...W(rows) });
    const env = fakeEnv(rows, { render: threeClasses, loadError: (t) => (idx(t.sha) === 5 ? 'Cannot find module ./seam' : null) });
    const done = await renderPlan(p, args(), { rows, ...W(rows) }, env, { toolHead: 'tool' });
    expect(done.plan.classes!.map((c) => [c.n, c.shas.map((s) => s[0]), c.representative[0], c.skip])).toEqual([
      [0, ['1', '2'], '2', null],
      [1, ['3', '4'], '4', null],
      [2, ['5'], '5', 'Cannot find module ./seam'],
      [3, ['6'], '6', null],
    ]);
    expect(done.plan.candidates.map((c) => c.renderClass)).toEqual([0, 0, 1, 1, 2, 3]);
    expect(env.calls.map((c) => [c.batch, c.dry, c.reps])).toEqual([1, 2, 3, 4, 5, 6].map((i) => [renderBatch({ sha: C(i), patch: null }, 'tool'), true, 1]));
    // Live classes are the ones that load: 3, so P = 2.
    expect(done.plan.bound).toMatchObject({ classes: 3, probes: 2 });
    const again = fakeEnv(rows, { render: threeClasses, loadError: (t) => (idx(t.sha) === 5 ? 'Cannot find module ./seam' : null) });
    await renderPlan(p, args(), { rows, ...W(rows) }, again, { toolHead: 'tool' });
    expect(again.calls.map((c) => c.tree)).toEqual(['555555555']);
  });

  test("the legacy mapping: a dirty bad batch with no patch whose render matches a class is that class's run", async () => {
    const rows = world({ bad: { dirty: true, promptSha: 'r1' } });
    const p = planFrom(args(), { rows, ...W(rows) });
    expect(p.attribution.answer).toMatchObject({ kind: 'source', confidence: 'unattributable' });
    const mapped = await renderPlan(p, args(), { rows, ...W(rows) }, fakeEnv(rows, { render: threeClasses }), { toolHead: 'tool' });
    expect(mapped.legacy).toEqual({ good: null, bad: 1 });
    expect(mapped.plan.attribution.answer).toMatchObject({ kind: 'source', confidence: 'narrowed', reason: null });
    expect(mapped.plan.attribution.answer.kind === 'source' && mapped.plan.attribution.answer.candidates.map((c) => (c.kind === 'commit' ? c.commit.sha[0] : '?'))).toEqual(['1', '2', '3', '4']);
    // A render nothing matches stays unattributable; the search brackets to the last commit.
    const lost = world({ bad: { dirty: true, promptSha: 'zz' } });
    const un = await renderPlan(planFrom(args(), { rows: lost, ...W(lost) }), args(), { rows: lost, ...W(lost) }, fakeEnv(lost, { render: threeClasses }), { toolHead: 'tool' });
    expect(un.legacy).toEqual({ good: null, bad: null });
    expect(un.plan.attribution.answer).toMatchObject({ kind: 'source', confidence: 'unattributable' });
    expect(searchable(un.plan.attribution)).toBe(true);
  });

  test('when every candidate renders as the dirty good side did, nothing in the range reaches the prompt: noise', async () => {
    const rows = world({ good: { dirty: true, promptSha: 'r0' } });
    const out = await renderPlan(planFrom(args(), { rows, ...W() }), args(), { rows, ...W() }, fakeEnv(rows, { render: () => 'r0' }), { toolHead: 'tool' });
    expect(out.plan.classes!.map((c) => c.shas.length)).toEqual([6]);
    expect(out.legacy).toEqual({ good: 0, bad: null });
    expect(out.plan.attribution.answer).toEqual({ kind: 'noise', separation: { kind: 'too-few' } });
    expect(out.plan.attribution.checklist.map((c) => [c.class, c.differs])).toEqual([['footing', false], ['freeze', false], ['live-reads', false], ['source', false], ['noise', true]]);
    expect(out.plan.attribution.checklist[3]!.detail).toMatch(/; but every candidate renders as the good side does \(Tier 1\)$/);
    expect(startRefusal(out.plan)).toMatch(/^nothing to search: nothing differs/);
    // When the bad side also ran on edits nothing matches, only those edits remain.
    const both = world({ good: { dirty: true, promptSha: 'r0' }, bad: { dirty: true, promptSha: 'zz' } });
    const un = await renderPlan(planFrom(args(), { rows: both, ...W() }), args(), { rows: both, ...W() }, fakeEnv(both, { render: () => 'r0' }), { toolHead: 'tool' });
    expect(un.plan.attribution.answer).toMatchObject({ kind: 'source', confidence: 'unattributable', candidates: [] });
    expect(un.plan.summary).toMatch(/so only those edits remain: nothing to search$/);
  });

  test('a start the renders answer finishes at once, at tier 1, for $0', async () => {
    const rows = world({ good: { dirty: true, promptSha: 'r0' } });
    const env = fakeEnv(rows, { render: () => 'r0' });
    const s = await run('echo-r', env);
    expect(s).toMatchObject({ status: 'done', tier: 1, spentUsd: 0, answer: { kind: 'attribution', answer: { kind: 'noise' } } });
    expect(env.calls.every((c) => c.dry)).toBe(true);
  });

  test('a range whose every class fails to load cannot start: no replay can probe it', async () => {
    const rows = world({ good: { dirty: true, promptSha: 'r0' } });
    const env = fakeEnv(rows, { render: threeClasses, loadError: (t) => (idx(t.sha) >= 3 ? 'Export named moveIn not found' : null) });
    const out = await renderPlan(planFrom(args(), { rows, ...W() }), args(), { rows, ...W() }, env, { toolHead: 'tool' });
    expect(out.legacy).toEqual({ good: 0, bad: null });
    expect(out.plan.bound.classes).toBe(0);
    expect(out.plan.summary).toBe("4 class(es) left and none loads under today's tool (Export named moveIn not found): no replay can probe them");
    expect(startRefusal(out.plan)).toBe(`nothing to search: ${out.plan.summary}`);
  });

  test("a dirty bad batch's patch is the last candidate, rendered on its base", async () => {
    const rows = world({ bad: { dirty: true, treePatch: 'feedface' } });
    const env = fakeEnv(rows, { render: (t) => (t.patch ? 'rp' : threeClasses(t)) });
    const out = await renderPlan(planFrom(args(), { rows, ...W(rows) }), args(), { rows, ...W(rows) }, env, { toolHead: 'tool' });
    expect(out.plan.classes!.at(-1)).toMatchObject({ shas: ['patch:feedface'], representative: 'patch:feedface' });
    expect(env.calls.at(-1)!.tree).toBe('666666666+feedface');
  });
});

describe('the search, with a fake check', () => {
  test('controls, two probes over three classes, and a confirmed culprit', async () => {
    const env = fakeEnv(world(), { render: threeClasses });
    const s = await run('echo-a', env);
    expect(s.status).toBe('done');
    expect(s.answer).toMatchObject({ kind: 'culprit', commit: { sha: C(3) }, separation: { kind: 'worse' }, tier: 2 });
    expect(s.classes!.map((c) => c.shas.map((x) => x[0]).join(''))).toEqual(['12', '34', '56']);
    // The budget was left to default, so it follows the bound the renders narrowed (3 classes, not 6 candidates).
    expect(s.plan.bound).toMatchObject({ classes: 3, probes: 2 });
    expect(s.budgetUsd).toBeCloseTo(Math.round(s.plan.bound.maxUsd * 120) / 100, 5);
    expect(probeKinds(s)).toEqual(['control-good@0:good', 'control-bad@6:bad', 'probe@2c0:good', 'probe@4c1:bad', 'confirm-culprit@4c1:pending', 'confirm-parent@2c0:pending']);
    // Confirmation tops the probes up to 5 in their own batches.
    expect(env.calls.filter((c) => !c.dry).map((c) => `${c.tree}:${c.reps}`)).toEqual(['000000000:3', '666666666:3', '222222222:3', '444444444:3', '444444444:5', '222222222:5']);
    expect(s.spentUsd).toBeCloseTo((3 * 4 + 2 * 2) * 3 * 0.11, 5);
    const steps = readSteps('echo-a');
    expect(steps.map((x) => x.seq)).toEqual(steps.map((_, i) => i + 1));
    expect(steps.filter((x) => x.kind === 'rep').length).toBe(48);
    expect(steps.at(-1)).toMatchObject({ kind: 'answer', text: expect.stringMatching(/^culprit 333333333 commit 3 \(confirmed: worse, p=0\.\d+\)$/) });
    expect(readBisectState('echo-a')!.finishedAt).not.toBeNull();
  });

  test('a probe whose surface does not load is a skip, and the answer widens to a range', async () => {
    const env = fakeEnv(world(), { render: threeClasses, loadError: (t, dry) => (idx(t.sha) === 4 && !dry ? 'no seam' : null) });
    const s = await run('echo-b', env);
    expect(probeKinds(s)).toContain('probe@4c1:skip');
    expect(s.answer).toMatchObject({ kind: 'range', separation: null, tier: 2 });
    expect(s.answer!.kind === 'range' && s.answer!.candidates.map((c) => (c.kind === 'commit' ? c.commit.sha[0] : '?'))).toEqual(['3', '4', '5', '6']);
  });

  test('a split vote gets 2 more reps per freeze once, then is unsure and sides with the nearer control', async () => {
    // Two flipped freezes: at C3-C4, A fails while E still passes (lower), so the probe at class 1 splits 1 to 1; its median sits nearer the bad control.
    const env = fakeEnv(world({ two: true }), {
      render: threeClasses,
      score: (t, f) => (idx(t.sha) >= 5 ? (f === A || f === E ? 0.2 : 0.9) : idx(t.sha) >= 3 ? (f === A ? 0.2 : f === E ? 0.75 : 0.9) : 0.9),
    });
    const s = await run('echo-c', env);
    expect(probeKinds(s)).toContain('probe@4c1:unsure');
    expect(env.calls.filter((c) => c.tree === '444444444' && !c.dry).map((c) => c.reps)).toEqual([3, 5]);
    expect(readSteps('echo-c').find((x) => x.kind === 'narrow' && x.text.startsWith('class 1'))!.text).toBe('class 1 reads unsure (siding bad): 0 class(es) left between class 0 and class 1');
    expect(s.answer).toMatchObject({ kind: 'culprit', commit: { sha: C(3) } });
  });

  test('controls that do not reproduce: drift, not source', async () => {
    const env = fakeEnv(world(), { render: threeClasses, score: () => 0.9 });
    const s = await run('echo-d', env);
    expect(s.answer).toEqual({ kind: 'drift', detail: "The good control read good and the bad control read good on today's tool and judge." });
    expect(env.calls.filter((c) => !c.dry).length).toBe(2);
  });

  test('a stable control failing at either end is drift, even when the flipped freeze reproduces', async () => {
    const env = fakeEnv(world(), { render: threeClasses, score: (t, f) => (f === A && idx(t.sha) >= 3 ? 0.2 : f === D && idx(t.sha) === 6 ? 0.3 : 0.9) });
    const s = await run('echo-control-drift', env);
    expect(s.answer).toEqual({ kind: 'drift', detail: "The good control read good and the bad control read bad; the control freeze d4d4d4d4 failed at the bad end on today's tool and judge." });
    expect(env.calls.filter((c) => !c.dry).length).toBe(2);
  });

  test('a probe where a stable control fails is a skip, so it never moves a bound', async () => {
    const env = fakeEnv(world(), { render: threeClasses, score: (t, f) => (f === A && idx(t.sha) >= 3 ? 0.2 : f === B && idx(t.sha) === 4 ? 0.3 : 0.9) });
    const s = await run('echo-control-probe', env);
    expect(probeKinds(s)).toContain('probe@4c1:skip');
    expect(s.probes.find((p) => p.kind === 'probe' && p.sha === C(4))!.skipReason).toBe('the control freeze b2b2b2b2 failed here');
    expect(s.answer).toMatchObject({ kind: 'range', tier: 2 });
  });

  // 2026-10-04: every rep of title-20261004-120047 crashed (the probe tree ran its own, older harness, which
  // could not find a login) and the search still answered drift. A crash is no reading at all.
  test('controls whose reps all crash answer crashed, never drift', async () => {
    const env = fakeEnv(world(), { render: threeClasses, crash: () => true });
    const s = await run('echo-crash', env);
    expect(s.answer).toMatchObject({ kind: 'crashed' });
    expect(s.answer!.kind === 'crashed' && s.answer!.runIds.length).toBeGreaterThan(0);
    expect(readSteps('echo-crash').at(-1)).toMatchObject({ kind: 'answer', text: 'crashed: the good control could not run a rep' });
  });

  test('a probe whose reps all crash is a skip, so the answer widens to a range instead of guessing a side', async () => {
    const env = fakeEnv(world(), { render: threeClasses, crash: (t) => idx(t.sha) === 4 });
    const s = await run('echo-crash-probe', env);
    expect(probeKinds(s)).toContain('probe@4c1:skip');
    expect(s.answer).toMatchObject({ kind: 'range', tier: 2 });
  });

  test('readProbe leaves crashed reps out of the vote', () => {
    const set = [1, 2, 3].map((seed) => row('b', A, seed, { status: 'crash', score: null })).concat([row('b', A, 4, { score: 0.9 })]);
    expect(readProbe(set, [A], 'flip', set)).toBe('good');
    expect(crashedFocus(set.slice(0, 3), [A])).toEqual([A]);
  });

  test('a bound over the budget is refused before any paid rep', async () => {
    const env = fakeEnv(world(), { render: threeClasses });
    const s = await run('echo-e', env, { budgetUsd: 0.5 });
    expect(s.status).toBe('budget');
    expect(readSteps('echo-e').at(-1)).toMatchObject({ kind: 'stop', text: expect.stringMatching(/^refused: the bound \$[\d.]+ is over the budget \$0\.50/) });
    expect(env.calls.filter((c) => !c.dry)).toEqual([]);
  });

  test('a budget spent mid-search stops it there; each check is handed only what is left', async () => {
    // The plan expects a cent a rep, so its budget is small; the reps cost eleven.
    const env = fakeEnv(world(), { render: threeClasses });
    const s = await runBisect('echo-i', args(), env, { world: { ...W(), state: { [S]: { perRep: { m1: { usd: 0.0001, seconds: 1 } } } } }, toolHead: 'tool' });
    expect(s.status).toBe('budget');
    expect(s.answer).toBeNull();
    expect(readSteps('echo-i').at(-1)!.text).toMatch(/^stopped: the \$[\d.]+ budget is spent/);
    const paid = env.calls.filter((c) => !c.dry);
    expect(paid[0]!.budget).toBeCloseTo(s.budgetUsd, 5);
    expect(paid.every((c, i) => i === 0 || c.budget! < paid[i - 1]!.budget!)).toBe(true);
  });

  test('the stop file halts it between probes, and resume goes on without running a finished batch again', async () => {
    // Calls 0-5 are the dry renders, 6 and 7 the controls: the stop lands after the bad control.
    const env = fakeEnv(world(), { render: threeClasses, onCall: (n) => n === 7 && requestStop('echo-f') });
    const s = await run('echo-f', env);
    expect(s.status).toBe('stopped');
    expect(s.answer).toBeNull();
    expect(readSteps('echo-f').at(-1)).toMatchObject({ kind: 'stop', text: 'stopped: the stop file was written' });
    const before = env.calls.filter((c) => !c.dry).map((c) => c.batch);
    expect(before.length).toBe(2);
    const again = fakeEnv(env.world, { render: threeClasses });
    const done = await run('echo-f', again, {}, { resume: true });
    expect(existsSync(bisectPaths('echo-f').stop)).toBe(false);
    expect(done.answer).toMatchObject({ kind: 'culprit', commit: { sha: C(3) } });
    expect(again.calls.map((c) => c.batch).filter((b) => before.includes(b))).toEqual([]);
    expect(again.calls.filter((c) => c.dry)).toEqual([]);
  });

  test('resume after a kill mid-probe: the same path for free up to the kill, then on to the answer', async () => {
    let hung!: () => void;
    const reached = new Promise<void>((r) => (hung = r));
    // Call 8 is the first probe, after six renders and two controls.
    const env = fakeEnv(world(), { render: threeClasses, hang: (n) => n === 8 && (hung(), true) });
    void run('echo-g', env);
    await reached;
    const mid = readBisectState('echo-g')!;
    expect(mid.status).toBe('probing');
    expect(mid.finishedAt).toBeNull();
    const again = fakeEnv(env.world, { render: threeClasses });
    const s = await run('echo-g', again, {}, { resume: true });
    expect(s.answer).toMatchObject({ kind: 'culprit', commit: { sha: C(3) } });
    // The controls landed before the kill; the probe the kill interrupted runs again, and nothing else is repeated.
    expect(again.calls.map((c) => `${c.tree}:${c.reps}`)).toEqual(['222222222:3', '444444444:3', '444444444:5', '222222222:5']);
    expect(probeKinds(s).filter((k) => k.startsWith('control'))).toEqual(['control-good@0:good', 'control-bad@6:bad']);
    expect(readSteps('echo-g').some((x) => x.kind === 'plan' && x.text.startsWith('resumed at probing'))).toBe(true);
  });

  test('a second bisect waits for the running one', async () => {
    const env = fakeEnv(world(), { render: threeClasses });
    const held = Bun.spawn(['sleep', '30']);
    mkdirSync(join(home, 'bisects'), { recursive: true });
    writeFileSync(join(home, 'bisects', 'running.json'), JSON.stringify({ id: 'other', pid: held.pid }));
    await expect(run('echo-h', env)).rejects.toThrow('bisect other is running; one bisect runs at a time');
    expect(readBisectState('echo-h')).toBeNull();
    held.kill();
  });
});
