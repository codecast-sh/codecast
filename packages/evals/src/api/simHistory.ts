import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  SimCatalogResponse,
  SimEvent,
  SimFailureResult,
  SimFinal,
  SimInvariant,
  SimJob,
  SimMinimal,
  SimResult,
  SimRunResponse,
  SimRunRow,
  SimScenario,
  SimSession,
  SimSessionSummary,
  SimShrinkProgress,
  SimWorld,
} from '@codecast/shared/contracts/evalsApi';

import { readRuns, readSession, sessionsDir, simHome } from '../../../web/store/__tests__/sim/history';
import { simGridOf } from '../../../web/store/__tests__/sim/grid';
import { bisectCommand, parseOrder, replayCommands } from '../../../web/store/__tests__/sim/replay';
import { REPO_ROOT, writeJsonAtomic } from '../paths';
import { gitHead } from '../state';
import { readJsonFile } from './files';
import { launch, simRunner, stillRunning, type Launched } from './spawn';

// The multiplayer sim's history as the api child serves it (evals-ui.md
// sections 3.7, 4.6 and 4.7): the session folders `bun run sim` writes, read
// through the sim's own history.ts; the scenario and invariant catalog from
// `bun run sim --list --json` and `--invariants --json`; and the shrinks and
// sweeps the pages start, each in its own tmux session, tracked as jobs.
// The UI always calls this "Multiplayer sim".

/** The pseudo session that holds legacy `$TMPDIR/codecast-sim/*` artifact folders, read-only. */
export const UNSESSIONED = 'unsessioned';
const legacyRoot = (): string => join(tmpdir(), 'codecast-sim');

/** A session or run folder name the child accepts: never a path. */
export const SIM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const safe = (name: string): boolean => SIM_NAME_RE.test(name) && !name.includes('..');

const subdirs = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);

/** A legacy artifact folder's result.json as a runs.jsonl row. */
function legacyRow(dir: string, name: string): SimRunRow | null {
  const r = readJsonFile<SimResult>(join(dir, name, 'result.json'));
  if (!r) return null;
  return { scenario: r.scenario, mode: r.mode, seed: r.seed, passed: r.passed === true, deliveries: r.passed ? r.deliveries : r.delivery, ms: r.realMs ?? 0, dir: name };
}

/**
 * A legacy folder this user wrote. On a Linux host tmpdir() is the shared
 * /tmp, so another local user could plant a run whose replay lines the
 * founder would paste; the bridge holds the checkout to the same rule.
 */
function ownLegacy(root: string, name: string): boolean {
  try {
    const st = lstatSync(join(root, name));
    return st.isDirectory() && st.uid === (process.getuid?.() ?? st.uid);
  } catch {
    return false;
  }
}

function legacySession(): { session: SimSession; runs: SimRunRow[] } | null {
  const root = legacyRoot();
  const names = subdirs(root).filter((n) => safe(n) && ownLegacy(root, n));
  const runs = names.map((n) => legacyRow(root, n)).filter((r): r is SimRunRow => !!r);
  if (!runs.length) return null;
  const times = names.map((n) => statSync(join(root, n)).mtime.toISOString()).sort();
  return { session: { id: UNSESSIONED, argv: [], gitHead: null, dirty: false, treePatch: null, startedAt: times[0]!, finishedAt: times.at(-1)!, exit: null, unsessioned: true }, runs };
}

/** The folder a session's runs live in. */
const sessionPath = (id: string): string => (id === UNSESSIONED ? legacyRoot() : join(sessionsDir(), id));

function sessionAndRuns(id: string): { session: SimSession; runs: SimRunRow[] } | null {
  if (id === UNSESSIONED) return legacySession();
  if (!safe(id)) return null;
  const dir = join(sessionsDir(), id);
  const session = readSession(dir);
  return session ? { session, runs: readRuns(dir) } : null;
}

const summarize = (s: SimSession, runs: SimRunRow[]): SimSessionSummary => {
  const failing = runs.filter((r) => !r.passed).map(({ scenario, mode, seed, dir }) => ({ scenario, mode, seed, ...(dir ? { dir } : {}) }));
  return { ...s, runs: runs.length, failed: failing.length, scenarios: new Set(runs.map((r) => r.scenario)).size, failing };
};

/** Every session, newest first, with the legacy folders last as one read-only "unsessioned" entry. */
export function simSessions(): Array<{ session: SimSession; runs: SimRunRow[] }> {
  const ids = subdirs(sessionsDir()).filter(safe).sort().reverse();
  const out = ids.map(sessionAndRuns).filter((x): x is { session: SimSession; runs: SimRunRow[] } => !!x);
  const legacy = legacySession();
  return legacy ? [...out, legacy] : out;
}

export const simSessionSummaries = (): SimSessionSummary[] => simSessions().map(({ session, runs }) => summarize(session, runs));

/** The newest real session, for the home wall's footer, from sessions the caller already read. */
export function latestSimSession(sessions = simSessions()): SimSessionSummary | null {
  const newest = sessions.find(({ session }) => !session.unsessioned);
  return newest ? summarize(newest.session, newest.runs) : null;
}

/**
 * The replay lines a failure prints, from the facts result.json holds: the
 * trace, the full recorded order, and the minimal order once a shrink has
 * run. Built by the sim's own replay.ts, the leaf report.ts prints from.
 */
export function simReplay(r: Pick<SimFailureResult, 'scenario' | 'seed' | 'order' | 'row' | 'minimalOrder'>): Omit<SimRunResponse['replay'], 'bisect'> {
  const [trace = '', order = '', minimal = null] = replayCommands(r.scenario, r.seed, parseOrder(r.order), r.row?.label ?? null, r.minimalOrder !== undefined ? parseOrder(r.minimalOrder) : undefined);
  return { trace, order, minimal };
}

function readEvents(dir: string): SimEvent[] {
  const path = join(dir, 'events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((l) => {
      if (!l.trim()) return [];
      try {
        return [JSON.parse(l) as SimEvent];
      } catch {
        return [];
      }
    });
}

/** One run in full, or null when the session or run folder is not there. */
export async function simRun(sessionId: string, run: string): Promise<SimRunResponse | null> {
  if (!safe(run)) return null;
  if (sessionId === UNSESSIONED && !ownLegacy(legacyRoot(), run)) return null;
  const found = sessionAndRuns(sessionId);
  if (!found) return null;
  const dir = join(sessionPath(sessionId), run);
  const result = readJsonFile<SimResult>(join(dir, 'result.json'));
  if (!result) return null;
  const row = found.runs.find((r) => r.dir === run) ?? { scenario: result.scenario, mode: result.mode, seed: result.seed, passed: result.passed === true, deliveries: result.passed ? result.deliveries : result.delivery, ms: result.realMs ?? 0, dir: run };
  const failure = result.passed ? null : result;
  const invariants = failure ? (await simCatalog()).invariants : [];
  return {
    session: found.session,
    run: row,
    result,
    events: readEvents(dir),
    world: readJsonFile<SimWorld>(join(dir, 'world.json')),
    final: readJsonFile<SimFinal>(join(dir, 'final.json')),
    minimal: readJsonFile<SimMinimal>(join(dir, 'minimal.json')),
    shrinking: readJsonFile<SimShrinkProgress>(join(dir, 'minimal.json.tmp')),
    invariant: failure ? (invariants.find((i) => i.id === failure.invariant.id) ?? { id: failure.invariant.id, meaning: failure.invariant.meaning, keys: [] }) : null,
    replay: failure ? { ...simReplay(failure), bisect: bisectCommand(dir) } : { trace: replayCommands(result.scenario, result.seed, [], null)[0]!, order: '', minimal: null, bisect: null },
  };
}

// ── The catalog ────────────────────────────────────────────────────────────

const simDir = (): string => join(REPO_ROOT, 'packages', 'web', 'store', '__tests__', 'sim');

/** What the catalog depends on: HEAD plus the newest mtime among the files the runner reads statically. */
function catalogKey(): string {
  const head = gitHead(REPO_ROOT);
  const dir = simDir();
  let newest = 0;
  for (const sub of ['scenarios', 'selftests']) for (const f of existsSync(join(dir, sub)) ? readdirSync(join(dir, sub)) : []) newest = Math.max(newest, statSync(join(dir, sub, f)).mtimeMs);
  for (const f of ['invariants.ts', 'invariantCoverage.ts']) if (existsSync(join(dir, f))) newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
  return `${head}|${newest}`;
}

async function runnerJson<T>(flag: string): Promise<T> {
  const { argv, cwd } = simRunner();
  const proc = Bun.spawn([...argv, flag, '--json'], { cwd, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`bun run sim ${flag} --json exited ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`);
  return JSON.parse(out) as T;
}

/**
 * invariantCoverage.ts NOT_COMPARED, read statically: the module imports the
 * store's registry, which the api child never loads. Each entry is one
 * `key: "reason",` line of the object literal.
 */
export function notComparedOf(source: string): Array<{ key: string; reason: string }> {
  const start = source.search(/\bNOT_COMPARED\b[^=]*=\s*\{/);
  if (start < 0) return [];
  const body = source.slice(source.indexOf('{', start) + 1);
  const end = body.search(/^\};?\s*$/m);
  const out: Array<{ key: string; reason: string }> = [];
  for (const line of (end < 0 ? body : body.slice(0, end)).split('\n')) {
    const m = /^\s*([\w$]+)\s*:\s*"((?:\\.|[^"\\])*)"\s*,?\s*$/.exec(line);
    if (!m) continue;
    try {
      out.push({ key: m[1]!, reason: JSON.parse(`"${m[2]}"`) as string });
    } catch {
      out.push({ key: m[1]!, reason: m[2]! });
    }
  }
  return out;
}

let catalogCache: { key: string; value: Pick<SimCatalogResponse, 'gitHead' | 'scenarios' | 'invariants' | 'notCompared'> } | null = null;

async function staticCatalog(): Promise<Pick<SimCatalogResponse, 'gitHead' | 'scenarios' | 'invariants' | 'notCompared'>> {
  const key = catalogKey();
  if (catalogCache?.key === key) return catalogCache.value;
  const [scenarios, invariants] = await Promise.all([runnerJson<SimScenario[]>('--list'), runnerJson<SimInvariant[]>('--invariants')]);
  const coverage = join(simDir(), 'invariantCoverage.ts');
  const value = { gitHead: key.split('|')[0] || null, scenarios, invariants, notCompared: existsSync(coverage) ? notComparedOf(readFileSync(coverage, 'utf8')) : [] };
  catalogCache = { key, value };
  return value;
}

const resultCache = new Map<string, { mtimeMs: number; invariant: string | null }>();
/** The invariant a failing run broke, read once per result.json write. */
function failedInvariant(path: string): string | null {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return null;
  const hit = resultCache.get(path);
  if (hit?.mtimeMs === st.mtimeMs) return hit.invariant;
  const r = readJsonFile<SimResult>(path);
  const invariant = r && !r.passed ? r.invariant.id : null;
  resultCache.set(path, { mtimeMs: st.mtimeMs, invariant });
  return invariant;
}

/** The grid over the history, folded by the sim's own grid.ts; each failure's invariant comes from its result.json. */
export const simGrid = (scenarios: SimScenario[], sessions = simSessions()): Pick<SimCatalogResponse, 'grid' | 'caught'> =>
  simGridOf(scenarios, sessions, (session, dir) => failedInvariant(join(sessionPath(session), dir, 'result.json')));

export async function simCatalog(): Promise<SimCatalogResponse> {
  const base = await staticCatalog();
  return { ...base, ...simGrid(base.scenarios) };
}

// ── Jobs: shrinks and sweeps ───────────────────────────────────────────────

interface StoredJob extends SimJob {
  launched: Launched;
  /** A shrink's artifact folder. */
  dir: string | null;
  argv: string[];
}

const jobsDir = (): string => join(simHome(), 'jobs');
const jobPath = (id: string): string => join(jobsDir(), `${id}.json`);
const stamp = (at: Date): string => at.toISOString().replace(/[-:]/g, '').replace(/\.(\d+)Z$/, '$1z').toLowerCase();

function startJob(kind: SimJob['kind'], args: string[], o: { session: string | null; run: string | null; dir: string | null; total: number | null }): StoredJob {
  const now = new Date();
  const id = `${kind}-${stamp(now)}`;
  const { argv, cwd } = simRunner();
  const full = [...argv, ...args];
  const launched = launch(`evals-sim-${id}`, full, { cwd, log: join(jobsDir(), `${id}.log`) });
  const job: StoredJob = { id, kind, status: 'running', startedAt: now.toISOString(), updatedAt: now.toISOString(), tmux: launched.tmux, progress: { done: 0, total: o.total, text: 'starting' }, session: o.session, run: o.run, launched, dir: o.dir, argv: full };
  mkdirSync(jobsDir(), { recursive: true });
  writeJsonAtomic(jobPath(id), job);
  return job;
}

export class SimRequestError extends Error {}

/** Starts `bun run sim --shrink <artifact folder>` on a failing run of a scenario the suite still holds. */
export async function startShrink(sessionId: string, run: string): Promise<StoredJob> {
  if (sessionId === UNSESSIONED) throw new SimRequestError('a legacy unsessioned run is read-only; rerun it with bun run sim to shrink it');
  if (!safe(sessionId) || !safe(run)) throw new SimRequestError('session and run name folders, not paths');
  const dir = join(sessionsDir(), sessionId, run);
  const result = readJsonFile<SimResult>(join(dir, 'result.json'));
  if (!result) throw new SimRequestError(`no run ${run} in session ${sessionId}`);
  if (result.passed) throw new SimRequestError(`${run} passed; only a failure shrinks`);
  // sim.ts --shrink replays the scenario by name and exits at once when the suite no longer holds it,
  // so refuse here, where the reason can still reach the page.
  const { scenarios } = await staticCatalog();
  if (!scenarios.some((x) => x.name === result.scenario)) throw new SimRequestError(`${result.scenario} is no longer in the suite, so nothing can replay ${run} to shrink it`);
  return startJob('shrink', ['--shrink', dir], { session: sessionId, run, dir, total: null });
}

/** Starts `bun run sim [filter] --sweep N`; the filter must name a scenario or a scenario file. */
export async function startSweep(filter: string | undefined, seeds: number): Promise<StoredJob> {
  if (!Number.isInteger(seeds) || seeds < 1 || seeds > 1000) throw new SimRequestError('seeds takes a whole number from 1 to 1000');
  if (filter) {
    // A leading dash would reach sim.ts as a flag, and a dash can sit inside a file name the match below accepts.
    if (!/^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/.test(filter)) throw new SimRequestError('a filter is a scenario or file name');
    const { scenarios } = await staticCatalog();
    if (!scenarios.some((s) => s.name === filter || s.file.includes(filter))) throw new SimRequestError(`no scenario or scenario file matches "${filter}"`);
  }
  return startJob('sweep', [...(filter ? [filter] : []), '--sweep', String(seeds)], { session: null, run: null, dir: null, total: null });
}

/** A job brought up to date: a shrink reads minimal.json(.tmp) beside its run, a sweep the session it opened. */
function refreshJob(job: StoredJob, sessions: () => Array<{ session: SimSession; runs: SimRunRow[] }>): StoredJob {
  if (job.status !== 'running') return job;
  const alive = stillRunning(job.launched);
  const next = { ...job, progress: { ...job.progress } };
  if (job.kind === 'shrink' && job.dir) {
    const minimal = join(job.dir, 'minimal.json');
    const progress = readJsonFile<SimShrinkProgress>(join(job.dir, 'minimal.json.tmp'));
    if (progress) next.progress = { done: progress.attempts, total: null, text: `${progress.phase}: ${progress.attempts} attempts, shortest failing order ${progress.best} of ${progress.recorded}` };
    const st = statSync(minimal, { throwIfNoEntry: false });
    if (st && st.mtimeMs >= Date.parse(job.startedAt) - 1000) {
      const m = readJsonFile<SimMinimal>(minimal);
      next.status = 'done';
      next.progress = { done: m?.attempts ?? next.progress.done, total: m?.attempts ?? null, text: m ? `${m.order.length + m.removed.length} recorded, ${m.order.length} needed${m.oneMinimal ? ' (1-minimal)' : ' (a cap stopped the search)'}` : 'done' };
    } else if (!alive) {
      next.status = 'failed';
      next.progress.text = 'the shrink ended with no minimal order: the recorded order no longer fails the same way, or it crashed (see its tmux or log)';
    }
  } else if (job.kind === 'sweep') {
    const mine = sessions().find(({ session }) => !session.unsessioned && Date.parse(session.startedAt) >= Date.parse(job.startedAt) - 2000 && session.argv.includes('--sweep'));
    if (mine) {
      next.session = mine.session.id;
      const failed = mine.runs.filter((r) => !r.passed).length;
      next.progress = { done: mine.runs.length, total: null, text: `${mine.runs.length} runs, ${failed} failed` };
      if (mine.session.finishedAt) next.status = 'done';
    }
    if (next.status === 'running' && !alive) {
      next.status = mine?.session.finishedAt ? 'done' : 'failed';
      if (next.status === 'failed') next.progress.text = 'the sweep ended before its session closed (see its tmux or log)';
    }
  }
  if (JSON.stringify(next) !== JSON.stringify(job)) {
    next.updatedAt = new Date().toISOString();
    writeJsonAtomic(jobPath(job.id), next);
  }
  return next;
}

/** Every job, refreshed, newest first, as SimJob (the launch bookkeeping stays in its file). */
export function simJobs(): SimJob[] {
  const dir = jobsDir();
  if (!existsSync(dir)) return [];
  let sessions: Array<{ session: SimSession; runs: SimRunRow[] }> | null = null;
  const lazy = () => (sessions ??= simSessions());
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonFile<StoredJob>(join(dir, f)))
    .filter((j): j is StoredJob => !!j?.id)
    .map((j) => refreshJob(j, lazy))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .map(({ launched: _, dir: __, argv: ___, ...job }) => job);
}
