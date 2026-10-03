import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommitRef, SimFailureResult, SimResult } from '@codecast/shared/contracts/evalsApi';

import { SIM_SOURCES } from '../../../web/store/__tests__/sim/history';
import type { AttributionGit } from '../history/attribution';
import type { Tree } from './probe';
import { lastPass, planSimBisect, readingOf, readSimBisect, readSimFailure, runSimBisect, simMaxProbes, type SimFailure, type SimProbeEnv } from './simProbe';
import { bisectPaths, readSteps, requestStop } from './state';

// The sim bisect on a synthetic world: a line of commits C(0)..C(9), a
// failing run recorded at C(9) in a session under a scratch sim home, and a
// fake probe that fails the same way from the breaking commit on. Nothing
// here builds a worktree or runs the sim.

let home: string;
let sim: string;
const saved = { home: process.env.CODECAST_EVALS_HOME, sim: process.env.CODECAST_SIM_HOME };
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'evals-simbisect-'));
  sim = mkdtempSync(join(tmpdir(), 'sim-home-'));
  process.env.CODECAST_EVALS_HOME = home;
  process.env.CODECAST_SIM_HOME = sim;
});
afterAll(() => {
  for (const [k, v] of [['CODECAST_EVALS_HOME', saved.home], ['CODECAST_SIM_HOME', saved.sim]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const C = (i: number): string => String(i).repeat(40);
const idx = (sha: string) => (/^(\d)\1{39}$/.test(sha) ? Number(sha[0]) : -1);
const commit = (i: number): CommitRef => ({ sha: C(i), subject: `change ${i}`, author: 'a', at: `2026-10-0${1 + (i % 9)}T00:00:00Z`, session: i === 6 ? 'jx7abcd' : null, mainSha: C(i), onMain: true });

/** A line of ten commits; `touches` names the ones that change what the sim loads. */
function lineGit(touches: number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9], seen: { paths?: string[] | null } = {}): AttributionGit {
  return {
    resolve: (name) => (idx(name) >= 0 ? name : /^\d$/.test(name) ? C(Number(name)) : null),
    isAncestor: (a, b) => idx(a) <= idx(b),
    path: (good, bad, paths) => {
      seen.paths = paths;
      return Array.from({ length: idx(bad) - idx(good) }, (_, k) => idx(good) + 1 + k).filter((i) => paths === null || touches.includes(i)).map(commit);
    },
    changed: () => [],
    show: () => null,
  };
}

const failure = (o: Partial<SimFailureResult> = {}): SimFailureResult => ({
  scenario: 'memberRemovedMidTurn',
  mode: 'interleave',
  seed: 3,
  gitHead: C(9),
  dirty: false,
  step: 'settle',
  delivery: 7,
  invariant: { id: 'INV-convergence', meaning: 'replicas agree' },
  row: { table: 'sessions', id: 's1', label: 'sess-a', diff: [] },
  order: 'conn:w1 live:w1:inbox repl:w1>w2 conn:w2 sched timer:t1 live:w2:inbox',
  labels: {},
  text: 'failed',
  ...o,
});

let stampN = 0;
/** A session folder under the sim home: session.json, runs.jsonl, and a failure's artifact folder when given one. */
function session(o: { gitHead: string; dirty?: boolean; treePatch?: string | null; runs?: Array<{ passed: boolean; mode?: string; seed?: number; scenario?: string }>; result?: SimFailureResult; known?: boolean }): { dir: string; artifact: string | null } {
  const id = `2026-10-0${++stampN}T00-00-00-000Z-1`;
  const dir = join(sim, 'sessions', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ id, argv: [], gitHead: o.gitHead, dirty: o.dirty ?? false, treePatch: o.treePatch ?? null, startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z', exit: 0 }));
  writeFileSync(join(dir, 'runs.jsonl'), (o.runs ?? []).map((r) => JSON.stringify({ scenario: r.scenario ?? 'memberRemovedMidTurn', mode: r.mode ?? 'interleave', seed: r.seed ?? 3, passed: r.passed, deliveries: 7, ms: 1 })).join('\n') + '\n');
  if (!o.result) return { dir, artifact: null };
  const artifact = join(dir, `${o.result.scenario}-${o.result.mode}-${o.result.seed}${o.known ? '-known' : ''}`);
  mkdirSync(artifact);
  writeFileSync(join(artifact, 'result.json'), JSON.stringify(o.result));
  return { dir, artifact };
}

/** A fake probe: the tree fails the same way from commit `breaks` on (or only with the edits when `breaks` is 'edits'); `skips` do not run. */
function fakeEnv(breaks: number | 'edits', o: { skips?: number[] } = {}): SimProbeEnv & { trees: Tree[] } {
  const trees: Tree[] = [];
  return {
    trees,
    async probe(t) {
      trees.push(t);
      if (o.skips?.includes(idx(t.sha)) && !t.patch) return { verdict: 'skip', detail: 'no result: cannot find module' };
      const bad = breaks === 'edits' ? Boolean(t.patch) : idx(t.sha) >= breaks;
      return bad ? { verdict: 'bad', detail: 'fails the same way: INV-convergence on sessions/sess-a' } : { verdict: 'good', detail: 'passes' };
    },
  };
}

describe('readSimFailure', () => {
  test('the shrunk order when a shrink ran, the row it names, and the session it ran in', () => {
    const { artifact } = session({ gitHead: C(9), result: failure({ minimalOrder: 'scripted conn:w1 repl:w1>w2' }) });
    const f = readSimFailure(artifact!);
    expect(f).toMatchObject({ scenario: 'memberRemovedMidTurn', mode: 'interleave', seed: 3, invariant: 'INV-convergence', row: 'sessions/sess-a', order: 'scripted conn:w1 repl:w1>w2', shrunk: true, deliveries: 2, known: false, sha: C(9), dirty: false, treePatch: null, home: sim });
    const unshrunk = readSimFailure(session({ gitHead: C(9), result: failure(), known: true }).artifact!);
    expect(unshrunk).toMatchObject({ shrunk: false, deliveries: 7, known: true });
  });

  test('a passing run, or a folder with no result, is refused', () => {
    const pass = join(sim, 'pass');
    mkdirSync(pass);
    writeFileSync(join(pass, 'result.json'), JSON.stringify({ scenario: 's', mode: 'scripted', seed: 1, passed: true, deliveries: 3 }));
    expect(() => readSimFailure(pass)).toThrow(/passing run/);
    expect(() => readSimFailure(join(sim, 'nothing'))).toThrow(/no result.json/);
  });
});

describe('readingOf', () => {
  const f = { invariant: 'INV-convergence', row: 'sessions/sess-a' } as SimFailure;
  const got = (o: Partial<SimFailureResult>): SimResult => failure(o);
  test('the same invariant on the same row is bad; a pass is good; any other failure or none is a skip', () => {
    expect(readingOf(f, got({}), '').verdict).toBe('bad');
    expect(readingOf(f, { scenario: 's', mode: 'order', seed: 3, passed: true, deliveries: 7 }, '').verdict).toBe('good');
    expect(readingOf(f, got({ row: { table: 'sessions', id: 's2', label: 'sess-b', diff: [] } }), '')).toEqual({ verdict: 'skip', detail: 'fails another way: INV-convergence on sessions/sess-b' });
    expect(readingOf(f, got({ invariant: { id: 'order-mismatch', meaning: '' }, row: undefined }), '')).toEqual({ verdict: 'skip', detail: 'fails another way: order-mismatch' });
    expect(readingOf(f, null, 'exit 1')).toEqual({ verdict: 'skip', detail: 'no result: exit 1' });
  });
});

describe('planSimBisect', () => {
  test("the good end defaults to the newest clean session that passed the same scenario, mode and seed on an ancestor; candidates touch what the sim loads", () => {
    session({ gitHead: C(1), runs: [{ passed: true }] });
    session({ gitHead: C(2), runs: [{ passed: true }] });
    session({ gitHead: C(3), dirty: true, runs: [{ passed: true }] }); // dirty: not evidence
    session({ gitHead: C(4), runs: [{ passed: true, seed: 4 }] }); // another seed
    session({ gitHead: C(5), runs: [{ passed: false }] });
    const { artifact } = session({ gitHead: C(9), result: failure() });
    const seen: { paths?: string[] | null } = {};
    const p = planSimBisect(artifact!, { git: lineGit([3, 6, 8, 9], seen) });
    expect(p.good).toMatchObject({ sha: C(2), how: 'history' });
    expect(p.bad).toEqual({ sha: C(9), patch: null, dirty: false });
    expect(p.harness).toBe(C(9));
    expect(seen.paths).toEqual(SIM_SOURCES);
    expect(p.candidates.map((c) => (c.kind === 'commit' ? idx(c.commit.sha) : -1))).toEqual([3, 6, 8, 9]);
    expect(p.maxProbes).toBe(2 + 3);
    expect(p.summary).toBe('4 candidates: 2 ends + up to 3 probes, each one deterministic replay of the recorded order of 7 deliveries; free ($0)');
    // --all-commits walks every commit.
    expect(planSimBisect(artifact!, { git: lineGit([3], seen), allCommits: true }).candidates).toHaveLength(7);
    expect(seen.paths).toBeNull();
  });

  test('with no passing session on record it asks for --good; a good end off the line is refused', () => {
    const { artifact } = session({ gitHead: C(9), result: failure() });
    expect(() => planSimBisect(artifact!, { git: lineGit() })).toThrow(/pass --good <sha>/);
    const git = { ...lineGit(), isAncestor: () => false };
    expect(() => planSimBisect(artifact!, { git, good: C(2) })).toThrow(/not an ancestor/);
  });

  test("a dirty failure's kept edits are the last candidate; edits the session did not keep add none", () => {
    const kept = session({ gitHead: C(9), dirty: true, treePatch: 'f'.repeat(64), result: failure({ dirty: true }) });
    const p = planSimBisect(kept.artifact!, { git: lineGit(), good: C(5) });
    expect(p.candidates.at(-1)).toEqual({ kind: 'patch', base: C(9), treePatch: 'f'.repeat(64), renderClass: null });
    expect(p.bad.patch).toBe('f'.repeat(64));
    expect(p.summary).toContain('(the last is the uncommitted edits)');
    const lost = session({ gitHead: C(9), dirty: true, result: failure({ dirty: true }) });
    const q = planSimBisect(lost.artifact!, { git: lineGit(), good: C(5) });
    expect(q.candidates.every((c) => c.kind === 'commit')).toBe(true);
    expect(q.bad).toEqual({ sha: C(9), patch: null, dirty: true });
  });

  test('lastPass skips sessions from after the failure', () => {
    const { artifact } = session({ gitHead: C(9), result: failure() });
    session({ gitHead: C(4), runs: [{ passed: true }] }); // a later session
    expect(lastPass(readSimFailure(artifact!), C(9), lineGit())).toBeNull();
  });
});

describe('runSimBisect', () => {
  const planned = (o: { good?: string; touches?: number[]; result?: Partial<SimFailureResult>; treePatch?: string | null } = {}) => {
    const { artifact } = session({ gitHead: C(9), dirty: Boolean(o.treePatch) || o.result?.dirty, treePatch: o.treePatch ?? null, result: failure(o.result) });
    return planSimBisect(artifact!, { git: lineGit(o.touches), good: o.good ?? C(0) });
  };

  test('names the breaking commit for $0 within the probe bound, and journals every step', async () => {
    const plan = planned();
    const env = fakeEnv(6);
    const r = await runSimBisect('sim-a', plan, env);
    expect(r.status).toBe('done');
    expect(r.answer).toEqual({ kind: 'culprit', commit: commit(6) });
    expect(r.costUsd).toBe(0);
    expect(env.trees.length).toBeLessThanOrEqual(simMaxProbes(9));
    // The ends first: good, then bad.
    expect(env.trees.slice(0, 2).map((t) => idx(t.sha))).toEqual([0, 9]);
    expect(readSimBisect('sim-a')).toEqual(r);
    const steps = readSteps('sim-a');
    expect(steps.at(-1)).toMatchObject({ kind: 'answer', text: `culprit ${C(6).slice(0, 9)} change 6 (jx7abcd), for $0` });
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i + 1));
    expect(readFileSync(bisectPaths('sim-a').log, 'utf8')).toContain('reads bad');
    // A bisect folder with no state.json: the eval list does not read it as an eval bisect.
    expect(existsSync(join(bisectPaths('sim-a').dir, 'state.json'))).toBe(false);
  });

  test('every position of the break is found', async () => {
    for (let k = 1; k <= 9; k++) {
      const r = await runSimBisect(`sim-k${k}`, planned(), fakeEnv(k));
      expect(r.answer).toEqual({ kind: 'culprit', commit: commit(k) });
    }
  });

  test('a commit that does not run is skipped; next to the break it widens the answer to a range', async () => {
    const r = await runSimBisect('sim-skip', planned(), fakeEnv(6, { skips: [5] }));
    expect(r.answer?.kind).toBe('range');
    if (r.answer?.kind !== 'range') return;
    expect(r.answer.candidates.map((c) => (c.kind === 'commit' ? idx(c.commit.sha) : -1))).toEqual([5, 6]);
    expect(r.answer.detail).toContain('do not run under this harness');
    // A skip away from the break costs one probe and still pins it.
    expect((await runSimBisect('sim-skip2', planned(), fakeEnv(6, { skips: [4] }))).answer).toEqual({ kind: 'culprit', commit: commit(6) });
  });

  test('the kept edits are the answer when every commit reads good', async () => {
    const plan = planned({ treePatch: 'e'.repeat(64), result: { dirty: true } });
    const r = await runSimBisect('sim-edits', plan, fakeEnv('edits'));
    expect(r.answer).toEqual({ kind: 'edits', base: C(9), treePatch: 'e'.repeat(64) });
  });

  test('ends that do not read as they should stop it with the reason', async () => {
    expect((await runSimBisect('sim-old', planned(), fakeEnv(0))).answer).toEqual({ kind: 'no-repro', detail: `the good end ${C(0).slice(0, 9)} fails the same way: the break is older than it` });
    expect((await runSimBisect('sim-gone', planned(), fakeEnv(99))).answer?.kind).toBe('no-repro');
    // Edits its session did not keep: the commit alone passes, so nothing can replay the failure.
    const lost = await runSimBisect('sim-lost', planned({ result: { dirty: true } }), fakeEnv(99));
    expect(lost.answer).toMatchObject({ kind: 'no-repro', detail: expect.stringContaining('did not keep') });
  });

  test('a change outside what the sim loads: every candidate reads good, the bad end bad', async () => {
    // Only commits 3 and 5 touch the sim's sources; the break is at 7, which does not.
    const r = await runSimBisect('sim-outside', planned({ touches: [3, 5] }), fakeEnv(7));
    expect(r.answer).toMatchObject({ kind: 'range', candidates: [], detail: expect.stringContaining('--all-commits') });
  });

  test('the stop file stops it between probes; a resume walks the probes on record for free', async () => {
    const plan = planned();
    const env = fakeEnv(6);
    const probe = env.probe.bind(env);
    let calls = 0;
    env.probe = async (t) => {
      if (++calls === 3) requestStop('sim-stop');
      return probe(t);
    };
    const r = await runSimBisect('sim-stop', plan, env);
    expect(r.status).toBe('stopped');
    expect(r.probes).toHaveLength(3);
    const again = fakeEnv(6);
    const done = await runSimBisect('sim-stop', null, again);
    expect(done.answer).toEqual({ kind: 'culprit', commit: commit(6) });
    expect(again.trees.map((t) => idx(t.sha))).not.toContain(0);
    expect(done.probes.length).toBe(3 + again.trees.length);
    // Done is done: a further resume probes nothing.
    const none = fakeEnv(6);
    await runSimBisect('sim-stop', null, none);
    expect(none.trees).toHaveLength(0);
  });

  test('one bisect holds the machine at a time', async () => {
    mkdirSync(join(home, 'bisects'), { recursive: true });
    // A live holder: this test's parent process.
    writeFileSync(join(home, 'bisects', 'running.json'), JSON.stringify({ id: 'settle-1', pid: process.ppid }));
    await expect(runSimBisect('sim-locked', planned(), fakeEnv(6))).rejects.toThrow(/settle-1 is running/);
  });
});
