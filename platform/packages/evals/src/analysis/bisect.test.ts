import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { rowProblems, RUN_ROW_CORE_FIELDS, type Attribution, type CommitRef, type RunRowCore } from '../contract';
import { attribute, type AttributionGit, type AttributionHeads, type AttributionMeta } from './attribution';
import { costBound, costLine, planFrom as planFromWith, planSearchable, renderBatch, renderPlan as renderPlanWith, searchable, treeLabel, readProbe as readProbeWith, crashedFocus, type CheckExit, type PlanArgs, type PlanDeps, type ProbeEnv as CoreProbeEnv, type RenderCheck, type RenderHook, type Tier1, type Tree } from './bisect';
import type { PromptReader } from './epochs';
import { makeVerdict, statusPassRule, type VerdictRun } from './verdict';

// The bisect's pure parts on a synthetic world: a linear main line
// C(0)..C(6), freeze A breaking somewhere inside it, B and D passing
// throughout as the controls, and a fake `check` that writes index rows the
// way the real one resumes a named batch (only the seeds a batch lacks run).
// Moved from codecast's bisect/bisect.test.ts: the plan, Tier 1 and the
// probe reading. The runner, its state and its refusals stay codecast's and
// are tested there; where a case asked the runner whether a plan can start,
// it asks planSearchable, the rule the runner reads. This prelude binds the
// names the cases call to codecast's policy and a product row with
// codecast's own fields. Nothing here makes a worktree or spends anything.

/** A product's row: the core and the fields codecast adds. */
type RunRow = RunRowCore & { sourceHash: string | null; guard: Record<'served' | 'unserved' | 'live' | 'refused' | 'unknown' | 'help', number>; scoreVersions: number };
const isGuard = (v: unknown) => !!v && typeof v === 'object' && ['served', 'unserved', 'live', 'refused', 'unknown', 'help'].every((k) => typeof (v as Record<string, unknown>)[k] === 'number');
const runRowProblems = (value: unknown) => rowProblems(value, { ...RUN_ROW_CORE_FIELDS, sourceHash: 'string?', guard: { name: 'guard', ok: isGuard }, scoreVersions: 'number' });

/** A check as codecast's runner hands it: the render's fields, plus a budget and a stop file. */
type ProbeEnv = CoreProbeEnv<RenderCheck & { budget?: number; stopFile?: string }>;

/** What the plan reads beyond its args: the rows, git, prompts, heads and the recorded spend per rep. */
interface PlanWorld {
  rows: RunRow[];
  git: AttributionGit;
  heads?: AttributionHeads | null;
  reader: PromptReader;
  state?: Record<string, { perRep: Record<string, { usd: number; seconds: number }> }>;
}

const verdict = makeVerdict<VerdictRun>({ passed: statusPassRule(0.7), ruler: (r) => r.ruler ?? null });
/** The surfaces: role-wake is an agent surface, everything else a call surface on m1. No heads map is kept and no freeze is public. */
const meta: AttributionMeta = {
  declaredPaths: () => [],
  surfaceInfo: (surface) => ({ model: 'm1', route: surface === 'role-wake' ? 'agent' : 'call', sources: [] }),
  readHeads: () => null,
  freezeSnapshotPath: () => null,
};
const deps: PlanDeps<PlanWorld> = { verdict, meta, perRepUsd: (surface, model, world) => world.state?.[surface]?.perRep[model]?.usd ?? 0, toolHead: () => 'tool' };
/** The plan from the records alone (Tier 0) and, once Tier 1 has run, its classes. With no attribution given, it is attributed from the world. */
const planFrom = (args: PlanArgs, world: PlanWorld, attribution?: Attribution, tier1: Tier1 | null = null) =>
  planFromWith(args, world, deps, attribution ?? (() => attribute({ surface: args.surface, rows: world.rows, good: args.good, bad: args.bad, freezes: args.freezes, allCommits: args.allCommits, git: world.git, heads: world.heads, reader: world.reader }, meta, verdict)), tier1);
const renderPlan = (plan: ReturnType<typeof planFrom>, args: PlanArgs, world: PlanWorld, env: ProbeEnv, o: { toolHead?: string; onRender?: RenderHook } = {}) => renderPlanWith(plan, args, world, env, deps, o);
const readProbe = (set: RunRow[], focus: string[], mode: 'flip' | 'score', goodControl: RunRow[]) => readProbeWith(verdict, set, focus, mode, goodControl);

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
  // The bad side rendered another prompt (a source change): with the same prompt on both sides a call surface's fall is noise.
  const at6 = { gitHead: C(6), mainSha: C(6), promptSha: 'p6', ...o.bad };
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
    expect(planSearchable(p)).toBe(true);
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
      expect(planSearchable(p)).toBe(false);
    }
  });

  test('a source answer the records pin needs no search: no spend, no start', () => {
    const rows = world();
    const p = planFrom(args(), { rows, ...W(rows), git: fakeGit([4]) });
    expect(p.attribution.answer).toMatchObject({ kind: 'source', confidence: 'pinned' });
    expect(p.summary).toBe('pinned by the records to 444444444 commit 4: nothing to spend');
    expect(p.bound.maxReps).toBe(0);
    expect(planSearchable(p)).toBe(false);
  });

  test('an empty range cannot start and names --all-commits, which prices every commit in it', () => {
    const rows = world();
    const p = planFrom(args(), { rows, ...W(rows), git: fakeGit([]) });
    expect(p.attribution.answer).toMatchObject({ kind: 'source', confidence: 'empty', candidates: [], rangeCommits: 6 });
    expect(p.summary).toBe('no declared source moved in the range; --all-commits searches every commit');
    expect(p.bound.maxReps).toBe(0);
    expect(planSearchable(p)).toBe(false);
    const wide = planFrom(args({ allCommits: true }), { rows, ...W(rows), git: fakeGit([]) });
    expect(wide.allCommits).toBe(true);
    expect(wide.candidates).toHaveLength(6);
    expect(wide.bound).toMatchObject({ classes: 6, probes: 3 });
    expect(planSearchable(wide)).toBe(true);
  });

  test('an unattributable range still lists its candidates and can be searched', () => {
    const rows = world({ bad: { dirty: true } });
    const p = planFrom(args(), { rows, ...W(rows) });
    expect(p.attribution.answer).toMatchObject({ kind: 'source', confidence: 'unattributable', reason: expect.stringMatching(/^bad bad ran on uncommitted edits to 666666666 that nothing recorded can replay$/) });
    expect(p.candidates).toHaveLength(6);
    expect(searchable(p.attribution)).toBe(true);
    expect(p.bound.classes).toBe(6);
    expect(planSearchable(p)).toBe(true);
  });

  test('an agent surface needs the confirm', () => {
    const rows = world().map((r) => ({ ...r, surface: 'role-wake' }));
    const p = planFrom({ ...args(), surface: 'role-wake' }, { rows, ...W(rows) });
    expect(p.needsConfirm).toBe(true);
    expect(planSearchable(p)).toBe(true);
  });
});

describe('a call surface whose flipped freezes rendered one prompt on both sides', () => {
  test('the moved commit is not a source change: the source line says so, nothing is offered to search, and the answer is noise', () => {
    const rows = world({ bad: { promptSha: 'p0' } });
    const plan = planFrom(args(), { ...W(), rows });
    const source = plan.attribution.checklist.find((c) => c.class === 'source')!;
    expect(source.differs).toBe(false);
    expect(source.detail).toContain('same rendered prompts on every flipped freeze');
    expect(plan.attribution.answer.kind).toBe('noise');
    expect(plan.attribution.checklist.find((c) => c.class === 'noise')!.detail).toContain('on the 1 flipped freeze only');
    expect(searchable(plan.attribution)).toBe(false);
  });
});

describe('two bare commits with no batch on either', () => {
  // Regression: title-20261005-074131 (good and bad two commits nobody graded) weighed no freeze, every candidate rendered
  // alike on the empty set, renderPlan pinned all 31 as one class and bisectSignal filed a regression nobody observed.
  test('nothing fell, so the source does not light, the answer is noise, a render does not pin, and nothing is filed', async () => {
    const rows = world();
    const bare = args({ good: C(2).slice(0, 9), bad: C(5).slice(0, 9) });
    const p = planFrom(bare, { rows, ...W(rows) });
    expect(p.attribution.good.batch).toBeNull();
    expect(p.attribution.bad.batch).toBeNull();
    expect(p.freezes).toEqual([]);
    const source = p.attribution.checklist.find((c) => c.class === 'source')!;
    expect(source.differs).toBe(false);
    expect(source.detail).toBe('no freeze graded on both sides fell (the commit moved, 222222222 to 555555555): nothing for a commit to explain');
    expect(p.attribution.answer.kind).toBe('noise');
    expect(p.attribution.checklist.find((c) => c.class === 'noise')!.detail).toBe('nothing else differs: no freeze graded on both sides, so no fall to weigh');
    expect(searchable(p.attribution)).toBe(false);
    expect(planSearchable(p)).toBe(false);
    expect(p.summary).toBe('no freeze graded on both ends fell, so every commit renders alike; pick a good and a bad batch that both graded the freeze that broke');
    expect(p.bound.classes).toBe(0);
    const env = fakeEnv(rows, { render: () => 'same' });
    const done = await renderPlan(p, bare, { rows, ...W(rows) }, env, { toolHead: 'tool' });
    expect(done.plan.attribution.answer.kind).toBe('noise');
    expect(env.calls).toEqual([]);
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
    expect(planSearchable(out.plan)).toBe(false);
    expect(out.plan.summary).toMatch(/^nothing differs/);
    // When the bad side also ran on edits nothing matches, only those edits remain.
    const both = world({ good: { dirty: true, promptSha: 'r0' }, bad: { dirty: true, promptSha: 'zz' } });
    const un = await renderPlan(planFrom(args(), { rows: both, ...W() }), args(), { rows: both, ...W() }, fakeEnv(both, { render: () => 'r0' }), { toolHead: 'tool' });
    expect(un.plan.attribution.answer).toMatchObject({ kind: 'source', confidence: 'unattributable', candidates: [] });
    expect(un.plan.summary).toMatch(/so only those edits remain: nothing to search$/);
  });

  test('a range whose every class fails to load cannot start: no replay can probe it', async () => {
    const rows = world({ good: { dirty: true, promptSha: 'r0' } });
    const env = fakeEnv(rows, { render: threeClasses, loadError: (t) => (idx(t.sha) >= 3 ? 'Export named moveIn not found' : null) });
    const out = await renderPlan(planFrom(args(), { rows, ...W() }), args(), { rows, ...W() }, env, { toolHead: 'tool' });
    expect(out.legacy).toEqual({ good: 0, bad: null });
    expect(out.plan.bound.classes).toBe(0);
    expect(out.plan.summary).toBe("4 class(es) left and none loads under today's tool (Export named moveIn not found): no replay can probe them");
    expect(planSearchable(out.plan)).toBe(false);
  });

  test("a dirty bad batch's patch is the last candidate, rendered on its base", async () => {
    const rows = world({ bad: { dirty: true, treePatch: 'feedface' } });
    const env = fakeEnv(rows, { render: (t) => (t.patch ? 'rp' : threeClasses(t)) });
    const out = await renderPlan(planFrom(args(), { rows, ...W(rows) }), args(), { rows, ...W(rows) }, env, { toolHead: 'tool' });
    expect(out.plan.classes!.at(-1)).toMatchObject({ shas: ['patch:feedface'], representative: 'patch:feedface' });
    expect(env.calls.at(-1)!.tree).toBe('666666666+feedface');
  });
});

describe('reading a probe', () => {
  test('readProbe leaves crashed reps out of the vote', () => {
    const set = [1, 2, 3].map((seed) => row('b', A, seed, { status: 'crash', score: null })).concat([row('b', A, 4, { score: 0.9 })]);
    expect(readProbe(set, [A], 'flip', set)).toBe('good');
    expect(crashedFocus(set.slice(0, 3), [A])).toEqual([A]);
  });

});
