import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { mapLimit } from '@codecast/shared/async';
import { type GuardCounts, GUARD_STATUSES, type GuardStatus, type RunRow, runRowProblems } from '@codecast/shared/contracts/evalsApi';
import { parseRunId, summarizeRunFolder } from '@platform/evals/fs';

import { judgeRuler } from '../adapters/judge';
import { evalsHome, homePaths, publicFreezesDir } from '../paths';
import { type HeadsFile, readHeads } from '../provenance';

// EVALS_HOME/index/runs.jsonl: one RunRow per run folder (evals-ui.md 3.2).
// A cache, never the source of truth: every row can be rebuilt from its
// folder, and a row is trusted only while the mtimes of the folder's
// run.json, result.json and score.json match the key stored beside it, so a
// rescore or a rejudge is picked up on the next refresh.
//
// Each line is a RunRow plus that `key`. Keeping the key on the row's own
// line means one atomic rename writes both, so two processes refreshing at
// once can only leave a row whose key matches it.
//
// A refresh is a readdir plus three stats per folder, issued in parallel:
// under heavy load serial stats over ~5k folders take 25 to 45 s and parallel
// ones about a second. Only a folder whose key moved is read. batchAt, mainSha and offBranch depend on other rows and on
// heads.json, so they are recomputed over the whole set on every refresh.

/** Bump when a row's derivation changes: every stored key stops matching and the next refresh rebuilds all rows. */
export const INDEX_VERSION = 1;

/** `<surface>-<freeze8>`: the scenario part of a run folder's name. */
const SCENARIO = /^(.+)-([0-9a-f]{8})$/;
const SCORE_VERSION = /^score(\..+)?\.json$/;
/** A marked calls.log line, as layout.ts folds it into a cast_call event: `<STATUS> <argv>`. */
const GUARD_MARK = new RegExp(`^(${GUARD_STATUSES.join('|')})(?: |$)`);

export const runIndexPath = (home = evalsHome()): string => join(home, 'index', 'runs.jsonl');

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

const mtime = (path: string): number => statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? -1;

/** The files a row is read from; their mtimes are its rebuild key. */
const KEY_FILES = ['run.json', 'result.json', 'score.json'] as const;
const keyOf = (mtimes: number[]): string => `${INDEX_VERSION}|${mtimes.join(':')}`;

/** The rebuild key: the index version and the mtimes of the three files a row is read from (-1 when absent). */
export const folderKey = (dir: string): string => keyOf(KEY_FILES.map((f) => mtime(join(dir, f))));
const folderKeyAsync = async (dir: string): Promise<string> =>
  keyOf(
    await Promise.all(
      KEY_FILES.map((f) =>
        stat(join(dir, f)).then(
          (s) => s.mtimeMs,
          () => -1,
        ),
      ),
    ),
  );

const rulers = new Map<string, { mtimeMs: number; ruler: string | null }>();

/**
 * The ruler the rep in `dir` was judged on (judgeRuler over judge/prompt.md),
 * cached on the prompt's mtime. A rejudge replaces the prompt, so it moves
 * the rep to the new ruler with nothing else to keep in step. Null for a rep
 * no judge graded.
 */
export function rulerAt(dir: string): string | null {
  const path = join(dir, 'judge', 'prompt.md');
  const mtimeMs = mtime(path);
  if (mtimeMs < 0) return null;
  const hit = rulers.get(path);
  if (hit?.mtimeMs === mtimeMs) return hit.ruler;
  const ruler = judgeRuler(readFileSync(path, 'utf8'));
  rulers.set(path, { mtimeMs, ruler });
  return ruler;
}

/** The freeze ids each home holds, by file name only: no freeze file is read. */
export interface FreezeHomes {
  public: Set<string>;
  private: Set<string>;
}

export function freezeHomes(home = evalsHome(), publicDir = publicFreezesDir()): FreezeHomes {
  const ids = (dir: string) => new Set(existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : []);
  return { public: ids(publicDir), private: ids(homePaths(home).freezes) };
}

interface StoredRun {
  freezeId?: string | null;
  model?: string | null;
  route?: 'call' | 'agent';
  sourceHash?: string | null;
  sourceHashDisk?: string | null;
  treePatch?: string | null;
  freezeSha?: string | null;
  promptSha?: string | null;
  judgeModel?: string | null;
  gitHead?: string | null;
  dirty?: boolean;
  batch?: string | null;
  cadence?: string | null;
  liveReads?: number;
}

interface StoredScore {
  passMark?: number;
  checks?: Array<{ id: string; score: number }>;
  judgeModel?: string | null;
  judgeCostUsd?: number;
}

interface StoredResult {
  costUsd?: number;
  realElapsedMs?: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** calls.log marks per rep, from the cast_call events layout.ts folds the guard's log into. */
export function guardCounts(eventsJsonl: string): GuardCounts {
  const out: GuardCounts = { served: 0, unserved: 0, live: 0, refused: 0, unknown: 0, help: 0 };
  for (const line of eventsJsonl.split('\n')) {
    if (!line.includes('"cast_call"')) continue;
    let argv: unknown;
    try {
      const e = JSON.parse(line) as { kind?: string; payload?: { argv?: unknown } };
      if (e.kind !== 'cast_call') continue;
      argv = e.payload?.argv;
    } catch {
      continue;
    }
    const m = typeof argv === 'string' ? GUARD_MARK.exec(argv) : null;
    if (m) out[(m[1] as GuardStatus).toLowerCase() as keyof GuardCounts] += 1;
  }
  return out;
}

export interface BuiltRow {
  row: RunRow;
  /** Empty for a rep still being written: it is read again on every refresh until it lands. */
  key: string;
}

/**
 * One folder as a RunRow, before the fields that depend on the rest of the
 * set (batchAt, mainSha, offBranch: see finishRows). The status, title,
 * gates and floors are the platform's summary of the folder, the same rule
 * `./evals runs` lists by; the rest comes from run.json, score.json and
 * result.json. Null when the name is not a run folder.
 */
export function buildRunRow(runsDir: string, name: string, freezes: FreezeHomes): BuiltRow | null {
  const parsed = parseRunId(name);
  if (!parsed) return null;
  const dir = join(runsDir, name);
  const key = folderKey(dir);
  const summary = summarizeRunFolder(runsDir, name);
  if (!summary) return null;
  const run = readJson<StoredRun>(join(dir, 'run.json')) ?? {};
  const score = readJson<StoredScore>(join(dir, 'score.json'));
  const result = readJson<StoredResult>(join(dir, 'result.json'));
  const scenario = SCENARIO.exec(parsed.scenario);
  const freeze8 = scenario?.[2] ?? '';
  // A rep that died before writing run.json names its freeze only by the 8 characters in its folder name.
  const byPrefix = () => (freeze8 ? [...freezes.public, ...freezes.private].find((id) => id.startsWith(freeze8)) : undefined);
  const freezeId = str(run.freezeId) ?? summary.freezeId ?? byPrefix() ?? freeze8;
  const agent = run.route === 'agent';
  const empty: GuardCounts = { served: 0, unserved: 0, live: 0, refused: 0, unknown: 0, help: 0 };
  const eventsPath = join(dir, 'events.jsonl');

  const row: RunRow = {
    id: name,
    surface: scenario?.[1] ?? parsed.scenario,
    freezeId,
    freezeName: summary.title,
    // Anything not committed as a fixture is a real moment: private unless the public home holds it.
    visibility: freezes.public.has(freezeId) ? 'public' : 'private',
    seed: summary.seed,
    stamp: parsed.createdAt,
    batch: str(run.batch),
    batchAt: null,
    cadence: str(run.cadence),
    // A rep still being written has no RunRow status of its own; it reads as unscored until it lands.
    status: summary.status === 'running' ? 'unscored' : summary.status,
    score: summary.score,
    passMark: typeof score?.passMark === 'number' ? score.passMark : null,
    gatesFailed: summary.gatesFailed,
    checks: Object.fromEntries((score?.checks ?? []).filter((c) => typeof c?.id === 'string' && typeof c.score === 'number').map((c) => [c.id, c.score])),
    missedFloors: summary.missedFloors,
    model: str(run.model) ?? summary.model ?? null,
    judgeModel: str(score?.judgeModel) ?? str(run.judgeModel),
    ruler: rulerAt(dir),
    gitHead: str(run.gitHead),
    mainSha: null,
    dirty: run.dirty === true,
    offBranch: false,
    treePatch: str(run.treePatch),
    sourceHash: str(run.sourceHash),
    sourceHashDisk: str(run.sourceHashDisk),
    promptSha: str(run.promptSha),
    freezeSha: str(run.freezeSha),
    liveReads: num(run.liveReads),
    costUsd: num(result?.costUsd),
    judgeCostUsd: num(score?.judgeCostUsd),
    realMs: num(result?.realElapsedMs),
    // Only an agent rep runs behind the guard; a call rep has no cast_call events to read.
    guard: agent && existsSync(eventsPath) ? guardCounts(readFileSync(eventsPath, 'utf8')) : empty,
    scoreVersions: readdirSync(dir).filter((n) => SCORE_VERSION.test(n)).length,
  };
  return { row, key: summary.status === 'running' ? '' : key };
}

/**
 * Fill the fields that depend on the whole set, in place. batchAt is the
 * earliest stamp in the batch, because batch names do not all sort by time.
 * mainSha is the head itself on the main line, or its patch-id twin off it
 * (heads.json); a head heads.json does not name yet has none.
 */
export function finishRows(rows: Iterable<RunRow>, heads: HeadsFile | null): RunRow[] {
  const all = [...rows];
  const firstAt = new Map<string, string>();
  for (const r of all) if (r.batch && (!firstAt.has(r.batch) || r.stamp < firstAt.get(r.batch)!)) firstAt.set(r.batch, r.stamp);
  for (const r of all) {
    const head = r.gitHead ? heads?.heads[r.gitHead] : undefined;
    r.batchAt = r.batch ? (firstAt.get(r.batch) ?? null) : null;
    r.mainSha = head?.mainSha ?? null;
    r.offBranch = head ? head.on !== 'main' : false;
  }
  return all;
}

// ── The cache ──────────────────────────────────────────────────────────────

export interface IndexProgress {
  phase: 'idle' | 'loading' | 'scanning' | 'reading' | 'writing';
  /** Folders read so far in this refresh, and how many need reading. */
  done: number;
  total: number;
  rows: number;
}

export interface IndexRefresh {
  /** Rows in the index after the refresh. */
  rows: number;
  /** Folders checked against their keys. */
  scanned: number;
  /** Folders read because their key moved, they were new, or they are still being written. */
  rebuilt: number;
  removed: number;
  wrote: boolean;
  /** True when the refresh was skipped because the last one is younger than maxAgeMs. */
  cached: boolean;
  ms: number;
  /** Heads runs record that heads.json does not map: their rows have no mainSha until `./evals pin --backfill`. */
  unmappedHeads: string[];
  /** Folders whose row failed the contract, with why; they are left out of the index. */
  problems: Array<{ id: string; problems: string[] }>;
}

interface Store {
  path: string;
  entries: Map<string, BuiltRow>;
  loaded: boolean;
  /** When each scope ('' for every folder, else a surface) was last refreshed. */
  refreshedAt: Map<string, number>;
  progress: IndexProgress;
  inflight: Promise<IndexRefresh> | null;
}

const stores = new Map<string, Store>();

function storeFor(home: string): Store {
  let s = stores.get(home);
  if (!s) {
    s = { path: runIndexPath(home), entries: new Map(), loaded: false, refreshedAt: new Map(), progress: { phase: 'idle', done: 0, total: 0, rows: 0 }, inflight: null };
    stores.set(home, s);
  }
  return s;
}

/** Forget every in-memory index, so the next read loads from disk. For tests. */
export function resetRunIndexMemory(): void {
  stores.clear();
}

/** Where the refresh of `home`'s index stands: the api child's /health reads it while a first build runs. */
export function indexProgress(home = evalsHome()): IndexProgress {
  return { ...storeFor(home).progress };
}

/** The stored rows, each held to the contract: a line that fails it is dropped and its folder read again. */
function loadFile(path: string): Map<string, BuiltRow> {
  const out = new Map<string, BuiltRow>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const { key, ...row } = JSON.parse(line) as RunRow & { key?: unknown };
      if (typeof key === 'string' && key.startsWith(`${INDEX_VERSION}|`) && runRowProblems(row).length === 0) out.set(row.id, { key, row });
    } catch {
      // A torn or foreign line: its folder is read again.
    }
  }
  return out;
}

function writeFile(path: string, entries: Iterable<BuiltRow>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const lines: string[] = [];
  for (const { key, row } of entries) lines.push(JSON.stringify({ ...row, key }));
  writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '');
  renameSync(tmp, path);
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

export interface RunIndexOptions {
  /** EVALS_HOME; the default is the real one. */
  home?: string;
  /** Committed freezes; the default is the checkout's. */
  publicFreezes?: string;
  /** Check only this surface's folders; the rest of the index is kept as it stands. */
  surface?: string;
  /** Skip the refresh when this scope was refreshed less than this long ago (the api child passes 2000). 0, the default, always refreshes. */
  maxAgeMs?: number;
  /** Read every folder again, keys or not. */
  full?: boolean;
  onProgress?: (p: IndexProgress) => void;
}

async function doRefresh(store: Store, opts: RunIndexOptions, started: number): Promise<IndexRefresh> {
  const home = opts.home ?? evalsHome();
  const runsDir = homePaths(home).runs;
  const scope = opts.surface ?? '';
  const progress = (p: Partial<IndexProgress>) => {
    store.progress = { ...store.progress, ...p, rows: store.entries.size };
    opts.onProgress?.(store.progress);
  };
  let dirty = false;
  if (!store.loaded) {
    progress({ phase: 'loading', done: 0, total: 0 });
    store.entries = loadFile(store.path);
    store.loaded = true;
  }

  progress({ phase: 'scanning', done: 0, total: 0 });
  const prefix = scope ? `${scope}-` : '';
  const inScope = (name: string) => !scope || (name.startsWith(prefix) && SCENARIO.exec(parseRunId(name)?.scenario ?? '')?.[1] === scope);
  const names = (existsSync(runsDir) ? readdirSync(runsDir) : []).filter((n) => inScope(n) && parseRunId(n));
  const present = new Set(names);
  let removed = 0;
  for (const id of [...store.entries.keys()]) {
    if (inScope(id) && !present.has(id)) {
      store.entries.delete(id);
      removed += 1;
    }
  }

  // A stat holds no descriptor, so thousands can be in flight; the cap only bounds a home that grows without end.
  const keys = await mapLimit(names, 2048, async (name) => {
    const hit = store.entries.get(name);
    return opts.full || !hit?.key ? null : folderKeyAsync(join(runsDir, name));
  });
  const stale = names.filter((name, i) => keys[i] === null || keys[i] !== store.entries.get(name)?.key);

  const problems: IndexRefresh['problems'] = [];
  if (stale.length) {
    const freezes = freezeHomes(home, opts.publicFreezes);
    progress({ phase: 'reading', done: 0, total: stale.length });
    for (let i = 0; i < stale.length; i++) {
      const name = stale[i]!;
      let built: BuiltRow | null = null;
      try {
        built = buildRunRow(runsDir, name, freezes);
      } catch (e) {
        // A folder deleted mid-scan, or unreadable: leave it out; the next refresh tries again.
        problems.push({ id: name, problems: [e instanceof Error ? e.message : String(e)] });
      }
      const why = built ? runRowProblems(built.row) : [];
      if (built && why.length === 0) {
        const before = store.entries.get(name);
        store.entries.set(name, built);
        if (!before || before.key !== built.key || JSON.stringify(before.row) !== JSON.stringify(built.row)) dirty = true;
      } else {
        if (built) problems.push({ id: name, problems: why });
        if (store.entries.delete(name)) dirty = true;
      }
      if ((i + 1) % 100 === 0) {
        progress({ done: i + 1 });
        await yieldToLoop();
      }
    }
    progress({ done: stale.length });
  }

  // The set-wide fields: a new batch rep or a remapped head moves rows nobody re-read.
  const before = new Map([...store.entries].map(([id, e]) => [id, `${e.row.batchAt}|${e.row.mainSha}|${e.row.offBranch}`]));
  const heads = readHeads(homePaths(home).heads);
  finishRows(
    [...store.entries.values()].map((e) => e.row),
    heads,
  );
  for (const [id, e] of store.entries) if (before.get(id) !== `${e.row.batchAt}|${e.row.mainSha}|${e.row.offBranch}`) dirty = true;

  const wrote = dirty || removed > 0 || !existsSync(store.path);
  if (wrote) {
    progress({ phase: 'writing' });
    writeFile(store.path, store.entries.values());
  }
  const now = Date.now();
  store.refreshedAt.set(scope, now);
  progress({ phase: 'idle', done: 0, total: 0 });
  const unmapped = new Set<string>();
  for (const { row } of store.entries.values()) if (row.gitHead && !heads?.heads[row.gitHead]) unmapped.add(row.gitHead);
  return { rows: store.entries.size, scanned: names.length, rebuilt: stale.length, removed, wrote, cached: false, ms: now - started, unmappedHeads: [...unmapped], problems };
}

/**
 * Bring the index up to date with the run folders and write it back when
 * anything moved. Concurrent calls share one refresh. With `surface`, only
 * that surface's folders are checked, which is what a CLI command asking
 * about one surface pays for; the api child refreshes everything.
 */
export async function refreshRunIndex(opts: RunIndexOptions = {}): Promise<IndexRefresh> {
  const home = opts.home ?? evalsHome();
  const store = storeFor(home);
  const started = Date.now();
  const scope = opts.surface ?? '';
  const last = Math.max(store.refreshedAt.get(scope) ?? 0, store.refreshedAt.get('') ?? 0);
  if (store.loaded && opts.maxAgeMs && started - last < opts.maxAgeMs && !opts.full) {
    return { rows: store.entries.size, scanned: 0, rebuilt: 0, removed: 0, wrote: false, cached: true, ms: 0, unmappedHeads: [], problems: [] };
  }
  while (store.inflight) await store.inflight.catch(() => null);
  store.inflight = doRefresh(store, opts, started);
  try {
    return await store.inflight;
  } finally {
    store.inflight = null;
  }
}

/** The indexed rows, newest first (by folder stamp), after a refresh. With `surface`, only that surface's. */
export async function indexedRuns(opts: RunIndexOptions = {}): Promise<RunRow[]> {
  await refreshRunIndex(opts);
  const rows = [...storeFor(opts.home ?? evalsHome()).entries.values()].map((e) => e.row);
  return (opts.surface ? rows.filter((r) => r.surface === opts.surface) : rows).sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : a.id < b.id ? 1 : -1));
}
