import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

import type { BisectStep, Candidate, CommitRef, SimFailureResult, SimMode, SimResult } from '@codecast/shared/contracts/evalsApi';

import { readRuns, readSession, sessionsDir, SIM_SOURCES, simHome, treePatchPath } from '../../../web/store/__tests__/sim/history';
import { dropBaseTree, prepareTreeAt } from '../commands/line';
import { repoGit, type AttributionGit } from '../history/attribution';
import { homePaths, writeJsonAtomic } from '../paths';
import { treeLabel, type Tree } from './probe';
import { acquireRunLock, bisectPaths, bisectsDir, BISECT_ID_RE } from './state';

// The multiplayer sim's bisect (docs/architecture/evals-ui.md section 5,
// "Sim bisect"): take a failing sim run to the commit that broke it, for
// nothing. A sim replay is deterministic, so a probe is one run of the
// failure's own delivery order (the shrunk one when a shrink ran) at a
// commit: it fails the same way (the same invariant on the same row, the
// shrink's rule) or it does not. No controls, no reps, no budget.
//
// It shares the eval bisect's machinery: the candidate commits come from the
// same ancestry walk (repoGit().path, limited to what the sim loads,
// SIM_SOURCES), each probe is a prepareTreeAt tree, one bisect holds the
// machine at a time (acquireRunLock), and its folder is a bisect folder
// (EVALS_HOME/bisects/<id>/: steps.jsonl, log.txt, the stop file), with
// sim.json in place of state.json, since BisectState describes an eval plan.
//
// Every probe tree runs the harness of the failing run's commit
// (store/__tests__/sim and scripts/sim.ts as they were there): the order is
// that harness's recording, and the checkout's own copy can hold other
// sessions' unsaved edits. The store, convex and shared code are the
// probed commit's.

/** The harness a probe tree runs: the failing commit's, whatever the probed commit had. */
export const SIM_HARNESS = ['packages/web/store/__tests__/sim', 'packages/web/scripts/sim.ts'];

/** A probe that has not finished in this long is killed and reads as a skip. */
export const SIM_PROBE_MAX_MS = 10 * 60_000;

/** A failing sim run, as its artifact folder records it. */
export interface SimFailure {
  /** The artifact folder, absolute. */
  artifact: string;
  scenario: string;
  mode: SimMode;
  seed: number;
  invariant: string;
  /** `<table>/<label>` of the row the check named, or null. */
  row: string | null;
  /** The --order value a probe replays: the shrunk one when a shrink ran, else the recorded one. */
  order: string;
  shrunk: boolean;
  /** Deliveries in that order (a scripted run's leading mark is not one). */
  deliveries: number;
  /** The known check's folder (`-known`): the scenario's first run again with nothing left out. */
  known: boolean;
  sha: string | null;
  dirty: boolean;
  /** The session's kept edits (`<sim home>/trees/<sha>.patch.gz`), when it ran dirty and kept them. */
  treePatch: string | null;
  /** The sim home the patch lives in. */
  home: string;
  session: string | null;
}

const readJson = <T>(path: string): T | null => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const rowKey = (r: SimResult | null): string | null => (r && !r.passed && r.row ? `${r.row.table}/${r.row.label}` : null);

/** Read a failing run's artifact folder; throws with the reason when it is not one. */
export function readSimFailure(dirArg: string): SimFailure {
  const artifact = resolve(dirArg);
  const result = readJson<SimResult>(join(artifact, 'result.json'));
  if (!result) throw new Error(`no result.json in ${artifact}; --sim takes a failing Multiplayer sim run's artifact folder`);
  if (result.passed) throw new Error(`${artifact} holds a passing run; --sim takes a failure's artifact folder`);
  const f = result as SimFailureResult;
  const sessionDir = dirname(artifact);
  const session = readSession(sessionDir);
  // A session sits at <home>/sessions/<stamp>; an artifact sent elsewhere (--out) reads the default home.
  const home = basename(dirname(sessionDir)) === 'sessions' ? dirname(dirname(sessionDir)) : simHome();
  const order = f.minimalOrder ?? f.order;
  const dirty = f.dirty ?? session?.dirty ?? false;
  return {
    artifact,
    scenario: f.scenario,
    mode: f.mode,
    seed: f.seed,
    invariant: f.invariant.id,
    row: rowKey(f),
    order,
    shrunk: f.minimalOrder !== undefined,
    deliveries: order.split(/[\s,]+/).filter((t) => t && t !== 'scripted').length,
    known: basename(artifact).endsWith('-known'),
    sha: f.gitHead ?? session?.gitHead ?? null,
    dirty,
    treePatch: dirty ? (session?.treePatch ?? null) : null,
    home,
    session: session?.id ?? null,
  };
}

export type SimVerdict = 'good' | 'bad' | 'skip';

/** How a probe's result.json reads against the failure: the same invariant on the same row is bad, a pass is good, anything else is a skip. */
export function readingOf(f: SimFailure, got: SimResult | null, why: string): { verdict: SimVerdict; detail: string } {
  if (!got) return { verdict: 'skip', detail: `no result: ${why}` };
  if (got.passed) return { verdict: 'good', detail: 'passes' };
  const saw = `${got.invariant.id}${rowKey(got) ? ` on ${rowKey(got)}` : ''}`;
  if (got.invariant.id === f.invariant && rowKey(got) === f.row) return { verdict: 'bad', detail: `fails the same way: ${saw}` };
  return { verdict: 'skip', detail: `fails another way: ${saw}` };
}

/** The world a sim bisect acts on: the real one builds trees and runs the sim, tests hand in a fake. */
export interface SimProbeEnv {
  probe(tree: Tree): Promise<{ verdict: SimVerdict; detail: string }>;
}

const withoutSimEnv = (env: NodeJS.ProcessEnv) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith('SIM_') && k !== 'CODECAST_SIM_HOME'));

/**
 * The real env: each probe is a prepareTreeAt tree at the commit (the kept
 * edits applied for the patch candidate), the failing commit's harness
 * checked in, and one `scripts/sim.ts <scenario> --seed N --order=<order>`
 * run whose artifacts and session go to a scratch folder, so probes never
 * enter the sim history. The tree is dropped after.
 */
export function simTreeEnv(f: SimFailure, harness: string, o: { log?: (line: string) => void } = {}): SimProbeEnv {
  return {
    async probe(tree) {
      mkdirSync(homePaths().scratch, { recursive: true });
      const work = mkdtempSync(join(homePaths().scratch, 'sim-probe-'));
      let wt: string | null = null;
      try {
        let patch: string | undefined;
        if (tree.patch) {
          const kept = treePatchPath(tree.patch, f.home);
          if (!existsSync(kept)) return { verdict: 'skip', detail: `the edits ${tree.patch.slice(0, 8)} are not in ${dirname(kept)}` };
          patch = join(work, 'edits.patch');
          writeFileSync(patch, gunzipSync(readFileSync(kept)));
        }
        // prepareTreeAt's notes are about the eval tool it copies in, not the sim: they go to the log only.
        const say = console.log;
        console.log = (...a: unknown[]) => o.log?.(a.join(' '));
        try {
          wt = prepareTreeAt(tree.sha, { patch, prefix: 'sim-bisect-' }).wt;
          if (tree.sha !== harness) {
            const r = spawnSync('git', ['checkout', harness, '--', ...SIM_HARNESS], { cwd: wt, encoding: 'utf8' });
            if (r.status !== 0) throw new Error(`the harness at ${harness.slice(0, 9)} could not be checked in: ${r.stderr.trim().split('\n')[0]}`);
          }
        } catch (e) {
          return { verdict: 'skip', detail: `the tree at ${treeLabel(tree)} could not be built: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}` };
        } finally {
          console.log = say;
        }
        const out = join(work, 'out');
        const argv = [process.execPath, join(wt, 'packages/web/scripts/sim.ts'), f.scenario, '--seed', String(f.seed), `--order=${f.order}`, '--out', out];
        const child = Bun.spawn(argv, { cwd: join(wt, 'packages/web'), env: { ...withoutSimEnv(process.env), CODECAST_SIM_HOME: join(work, 'home') }, stdout: 'pipe', stderr: 'pipe' });
        const timer = setTimeout(() => child.kill(), SIM_PROBE_MAX_MS);
        let last = '';
        const pump = async (stream: ReadableStream<Uint8Array>) => {
          const text = await new Response(stream).text();
          for (const l of text.split('\n')) {
            const line = l.split(`${wt}/`).join('');
            if (line.trim()) {
              o.log?.(line);
              if (/error|cannot find|not found/i.test(line)) last = line.trim();
            }
          }
        };
        await Promise.all([pump(child.stdout), pump(child.stderr)]);
        const code = await child.exited;
        clearTimeout(timer);
        const got = readJson<SimResult>(join(out, `${f.scenario}-order-${f.seed}${f.known ? '-known' : ''}`, 'result.json'));
        return readingOf(f, got, code === null || child.signalCode ? `killed after ${SIM_PROBE_MAX_MS / 60_000} minutes` : last || `exit ${code}`);
      } finally {
        if (wt) dropBaseTree(wt);
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}

// ── Plan ────────────────────────────────────────────────────────────────────

export interface SimBisectPlan {
  failure: SimFailure;
  good: { sha: string; how: 'flag' | 'history'; session: string | null };
  bad: { sha: string; patch: string | null; dirty: boolean };
  /** The commit whose harness every probe runs. */
  harness: string;
  /** Oldest first: the commits after good up to bad touching what the sim loads (every commit with allCommits), then the kept edits. */
  candidates: Candidate[];
  allCommits: boolean;
  /** The most probes it can take: the two ends and a binary search. */
  maxProbes: number;
  summary: string;
}

/**
 * The newest clean session before the failure, on an ancestor of its commit,
 * in which the same scenario, mode and seed passed: the default good end.
 */
export function lastPass(f: SimFailure, bad: string, git: AttributionGit): { sha: string; session: string } | null {
  const root = sessionsDir(f.home);
  if (!existsSync(root)) return null;
  const tried = new Map<string, boolean>();
  for (const id of readdirSync(root).sort().reverse()) {
    if (f.session && id >= f.session) continue;
    const s = readSession(join(root, id));
    if (!s?.gitHead || s.dirty || s.gitHead === bad) continue;
    if (!readRuns(join(root, id)).some((r) => r.scenario === f.scenario && r.mode === f.mode && r.seed === f.seed && r.passed)) continue;
    if (!tried.has(s.gitHead)) tried.set(s.gitHead, git.isAncestor(s.gitHead, bad));
    if (tried.get(s.gitHead)) return { sha: s.gitHead, session: id };
  }
  return null;
}

/** The most probes a search over `c` candidates takes, both ends included. */
export const simMaxProbes = (c: number): number => 2 + Math.ceil(Math.log2(c + 1));

/** The plan: the ends, the candidates and the probe bound. Reads git and the sim history; runs nothing. */
export function planSimBisect(artifact: string, o: { good?: string; bad?: string; allCommits?: boolean; git?: AttributionGit } = {}): SimBisectPlan {
  const f = readSimFailure(artifact);
  const git = o.git ?? repoGit();
  const badName = o.bad ?? f.sha;
  if (!badName) throw new Error(`${f.artifact} names no commit (a run from before the sim recorded one); pass --bad <sha>`);
  const bad = git.resolve(badName);
  if (!bad) throw new Error(`--bad ${badName} is not a commit in this repo`);
  // The kept edits stand only for the commit they were taken on.
  const patch = bad === f.sha && f.dirty ? f.treePatch : null;
  let good: SimBisectPlan['good'];
  if (o.good) {
    const sha = git.resolve(o.good);
    if (!sha) throw new Error(`--good ${o.good} is not a commit in this repo`);
    good = { sha, how: 'flag', session: null };
  } else {
    const found = lastPass(f, bad, git);
    if (!found) throw new Error(`no earlier clean session passed ${f.scenario} ${f.mode} seed ${f.seed} on an ancestor of ${bad.slice(0, 9)}; pass --good <sha>`);
    good = { ...found, how: 'history' };
  }
  if (good.sha === bad && !patch) throw new Error(`the good and bad ends are the same commit, ${bad.slice(0, 9)}`);
  if (good.sha !== bad && !git.isAncestor(good.sha, bad)) throw new Error(`${good.sha.slice(0, 9)} is not an ancestor of ${bad.slice(0, 9)}: no single line of commits joins them`);
  const commits: Candidate[] = good.sha === bad ? [] : git.path(good.sha, bad, o.allCommits ? null : SIM_SOURCES).map((commit) => ({ kind: 'commit', commit, renderClass: null }));
  const candidates: Candidate[] = [...commits, ...(patch ? [{ kind: 'patch' as const, base: bad, treePatch: patch, renderClass: null }] : [])];
  const maxProbes = simMaxProbes(candidates.length);
  const what = `${f.shrunk ? 'the shrunk' : 'the recorded'} order of ${f.deliveries} deliver${f.deliveries === 1 ? 'y' : 'ies'}`;
  const summary = candidates.length
    ? `${candidates.length} candidate${candidates.length === 1 ? '' : 's'}${patch ? ' (the last is the uncommitted edits)' : ''}: 2 ends + up to ${maxProbes - 2} probe${maxProbes - 2 === 1 ? '' : 's'}, each one deterministic replay of ${what}; free ($0)`
    : `no commit between ${good.sha.slice(0, 9)} and ${bad.slice(0, 9)} touched what the sim loads${o.allCommits ? '' : '; --all-commits searches every commit'}`;
  return { failure: f, good, bad: { sha: bad, patch, dirty: f.dirty }, harness: f.sha ?? bad, candidates, allCommits: Boolean(o.allCommits), maxProbes, summary };
}

// ── Run ─────────────────────────────────────────────────────────────────────

export interface SimBisectProbe {
  sha: string;
  patch: string | null;
  role: 'good' | 'bad' | 'probe';
  /** The candidate's index, or null for an end that is not a candidate. */
  index: number | null;
  verdict: SimVerdict;
  detail: string;
  ms: number;
  at: string;
}

export type SimBisectAnswer =
  | { kind: 'culprit'; commit: CommitRef }
  /** The session's uncommitted edits broke it: every commit reads good. */
  | { kind: 'edits'; base: string; treePatch: string }
  /** Commits that did not run under the harness keep the answer to a range. */
  | { kind: 'range'; candidates: Candidate[]; detail: string }
  /** The ends do not read as they should: the failure is not inside this range. */
  | { kind: 'no-repro'; detail: string };

/** EVALS_HOME/bisects/<id>/sim.json, rewritten after each probe. */
export interface SimBisectRecord {
  kind: 'sim';
  id: string;
  seq: number;
  plan: SimBisectPlan;
  probes: SimBisectProbe[];
  status: 'probing' | 'done' | 'stopped' | 'failed';
  answer: SimBisectAnswer | null;
  /** Always 0: a sim probe calls no model. */
  costUsd: 0;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  tmux: string | null;
}

export const simRecordPath = (id: string, home?: string): string => join(bisectPaths(id, home).dir, 'sim.json');
export const readSimBisect = (id: string, home?: string): SimBisectRecord | null => (BISECT_ID_RE.test(id) ? readJson<SimBisectRecord>(simRecordPath(id, home)) : null);

/** `sim-<scenario>-<yyyymmdd>-<hhmmss>`, lowercased, with a counter when that second is taken. */
export function newSimBisectId(scenario: string, now = new Date(), home?: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const base = `sim-${scenario.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)}-${stamp}`;
  let id = base;
  for (let n = 2; existsSync(join(bisectsDir(home), id)); n++) id = `${base}-${n}`;
  return id;
}

/** Every sim bisect, newest first. */
export function listSimBisects(home?: string): SimBisectRecord[] {
  const dir = bisectsDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((n) => {
      const r = readSimBisect(n, home);
      return r ? [r] : [];
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

const short = (s: string) => s.slice(0, 9);
const candidateWords = (c: Candidate) => (c.kind === 'commit' ? `${short(c.commit.sha)} ${c.commit.subject}` : `the uncommitted edits ${c.treePatch.slice(0, 8)} on top of ${short(c.base)}`);

/** A sim bisect's answer in one line. */
export function simAnswerWords(a: SimBisectAnswer | null): string {
  if (!a) return 'no answer yet';
  switch (a.kind) {
    case 'culprit':
      return `culprit ${short(a.commit.sha)} ${a.commit.subject}${a.commit.session ? ` (${a.commit.session})` : ''}, for $0`;
    case 'edits':
      return `the uncommitted edits ${a.treePatch.slice(0, 8)} on top of ${short(a.base)}: every commit reads good, for $0`;
    case 'range':
      return `a range of ${a.candidates.length}: ${a.candidates.map(candidateWords).join('; ')} (${a.detail})`;
    case 'no-repro':
      return a.detail;
  }
}

export interface SimRunOptions {
  home?: string;
  tmux?: string | null;
  /** The terminal, when there is one. */
  echo?: (line: string) => void;
}

/**
 * Run a sim bisect to its answer, or go on with one: a bisect whose sim.json
 * is on disk keeps its plan and its probes, and a tree it already probed is
 * never run again, so a resume walks the same path for free up to where it
 * stopped. The stop file is read before every probe.
 */
export async function runSimBisect(id: string, plan: SimBisectPlan | null, env: SimProbeEnv, o: SimRunOptions = {}): Promise<SimBisectRecord> {
  const paths = bisectPaths(id, o.home);
  const prior = readSimBisect(id, o.home);
  if (prior?.status === 'done') return prior;
  const p = prior?.plan ?? plan;
  if (!p) throw new Error(`no sim bisect ${id}`);
  const lock = acquireRunLock(id, o.home);
  if (!lock.ok) throw new Error(`bisect ${lock.holder} is running; one bisect runs at a time (./evals bisect stop ${lock.holder})`);
  mkdirSync(paths.dir, { recursive: true });
  const now = () => new Date().toISOString();
  const rec: SimBisectRecord = prior ?? { kind: 'sim', id, seq: 0, plan: p, probes: [], status: 'probing', answer: null, costUsd: 0, startedAt: now(), updatedAt: now(), finishedAt: null, tmux: o.tmux ?? null };
  if (prior && o.tmux) rec.tmux = o.tmux;
  const save = () => {
    rec.updatedAt = now();
    writeJsonAtomic(simRecordPath(id, o.home), rec);
  };
  const log = (line: string) => {
    appendFileSync(paths.log, `${line}\n`);
    o.echo?.(line);
  };
  const step = (kind: BisectStep['kind'], sha: string | null, text: string) => {
    const s: BisectStep = { seq: rec.seq + 1, at: now(), kind, sha, text };
    appendFileSync(paths.steps, `${JSON.stringify(s)}\n`);
    log(`[${s.seq}] ${kind}${sha ? ` ${short(sha)}` : ''}: ${text}`);
    rec.seq = s.seq;
    save();
  };
  const finish = (status: SimBisectRecord['status'], answer: SimBisectAnswer | null, text: string) => {
    rec.status = status;
    rec.answer = answer;
    rec.finishedAt = now();
    step(answer ? 'answer' : 'stop', null, text);
    return rec;
  };

  try {
    rec.status = 'probing';
    rec.finishedAt = null;
    if (prior) {
      rmSync(paths.stop, { force: true });
      step('plan', null, `resumed; trees already probed are not run again`);
    } else step('plan', null, `${p.failure.scenario} [${p.failure.mode} seed ${p.failure.seed}] ${p.failure.invariant}${p.failure.row ? ` on ${p.failure.row}` : ''}, good ${short(p.good.sha)} to bad ${short(p.bad.sha)}${p.bad.patch ? '+edits' : ''}: ${p.summary}`);

    const n = p.candidates.length;
    const treeAt = (i: number): Tree => {
      const c = p.candidates[i]!;
      return c.kind === 'commit' ? { sha: c.commit.sha, patch: null } : { sha: c.base, patch: c.treePatch };
    };
    const goodTree: Tree = { sha: p.good.sha, patch: null };
    const badTree: Tree = { sha: p.bad.sha, patch: p.bad.patch };
    // The bad end is the newest candidate when it is one; else it stands past them (index n).
    const badIndex = n && treeLabel(treeAt(n - 1)) === treeLabel(badTree) ? n - 1 : n;

    type Read = { verdict: SimVerdict; detail: string } | 'stopped';
    const probe = async (role: SimBisectProbe['role'], index: number | null, t: Tree): Promise<Read> => {
      const known = rec.probes.find((x) => treeLabel(x) === treeLabel(t));
      if (known) return known;
      if (existsSync(paths.stop)) return 'stopped';
      step(role === 'probe' ? 'probe' : 'control', t.sha, `${role === 'probe' ? `candidate ${index! + 1} of ${n}` : `the ${role} end`} at ${treeLabel(t)}: replaying ${p.failure.deliveries} deliveries`);
      const at = Date.now();
      const r = await env.probe(t);
      rec.probes.push({ sha: t.sha, patch: t.patch, role, index, verdict: r.verdict, detail: r.detail, ms: Date.now() - at, at: now() });
      step(role === 'probe' ? 'probe' : 'control', t.sha, `${treeLabel(t)} reads ${r.verdict}: ${r.detail}`);
      return r;
    };
    const stopped = () => finish('stopped', null, 'stopped: the stop file was written');

    // 1. The ends: good must pass and bad must fail the same way.
    const g = await probe('good', null, goodTree);
    if (g === 'stopped') return stopped();
    if (g.verdict !== 'good') {
      const detail = g.verdict === 'bad' ? `the good end ${short(p.good.sha)} fails the same way: the break is older than it` : `the good end ${short(p.good.sha)} does not run under this harness (${g.detail})`;
      return finish('done', { kind: 'no-repro', detail }, detail);
    }
    const b = await probe('bad', badIndex < n ? badIndex : null, badTree);
    if (b === 'stopped') return stopped();
    if (b.verdict !== 'bad') {
      const lost = p.bad.dirty && !p.bad.patch;
      const detail =
        b.verdict === 'skip'
          ? `the bad end ${treeLabel(badTree)} does not run under this harness (${b.detail})`
          : lost
            ? `the failure ran on uncommitted edits to ${short(p.bad.sha)} that its session did not keep, and that commit alone passes: nothing recorded can replay it`
            : `the order passes at the bad end ${treeLabel(badTree)}: the failure does not reproduce there`;
      return finish('done', { kind: 'no-repro', detail }, detail);
    }

    // 2. Halve the candidates between the ends; a tree that does not run is a skip.
    let [lo, hi] = [-1, badIndex];
    const skipped = new Set<number>();
    for (;;) {
      const open = Array.from({ length: Math.max(0, hi - lo - 1) }, (_, i) => lo + 1 + i).filter((i) => !skipped.has(i));
      if (!open.length) break;
      const mid = Math.floor((lo + hi) / 2);
      const pick = open.sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid) || x - y)[0]!;
      const r = await probe('probe', pick, treeAt(pick));
      if (r === 'stopped') return stopped();
      if (r.verdict === 'skip') skipped.add(pick);
      else if (r.verdict === 'good') lo = pick;
      else hi = pick;
      if (r.verdict !== 'skip') step('narrow', treeAt(pick).sha, `${hi - lo - 1} candidate(s) left between ${lo < 0 ? 'good' : short(treeAt(lo).sha)} and ${hi >= n ? 'bad' : treeLabel(treeAt(hi))}`);
    }

    // 3. The answer.
    if (hi - lo === 1 && hi < n) {
      const c = p.candidates[hi]!;
      const answer: SimBisectAnswer = c.kind === 'commit' ? { kind: 'culprit', commit: c.commit } : { kind: 'edits', base: c.base, treePatch: c.treePatch };
      return finish('done', answer, simAnswerWords(answer));
    }
    if (hi - lo === 1) {
      const answer: SimBisectAnswer = { kind: 'range', candidates: [], detail: `every commit that touched ${SIM_SOURCES.join(', ')} reads good and the bad end reads bad: the change lies outside them; --all-commits searches every commit` };
      return finish('done', answer, simAnswerWords(answer));
    }
    const left = p.candidates.slice(lo + 1, Math.min(hi + 1, n));
    const answer: SimBisectAnswer = { kind: 'range', candidates: left, detail: `${skipped.size} commit(s) between ${lo < 0 ? 'good' : short(treeAt(lo).sha)} and ${hi >= n ? 'bad' : short(treeAt(hi).sha)} do not run under this harness` };
    return finish('done', answer, simAnswerWords(answer));
  } catch (e) {
    rec.status = 'failed';
    rec.finishedAt = now();
    step('error', null, (e instanceof Error ? e.message : String(e)).split('\n')[0]!);
    return rec;
  } finally {
    lock.release();
  }
}
