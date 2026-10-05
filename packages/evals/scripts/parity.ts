#!/usr/bin/env bun
// The evals parity harness (docs/architecture/evals-converge.md section 7,
// C0). Every analysis or query move toward @platform/evals must leave what
// ./evals and the api child answer byte-identical, so this dumps those
// answers before and after a change and diffs the two dumps.
//
//   bun packages/evals/scripts/parity.ts pin               freeze the inputs (once per comparison)
//   bun packages/evals/scripts/parity.ts dump <label>      answers to /tmp/evals-parity/<label>/
//   bun packages/evals/scripts/parity.ts --compare <a> <b> exit 0 when identical, 1 with the diffs
//
// A dump holds three kinds of answer:
// - cli/: `./evals runs --json` and `./evals runs matrix --json`.
// - cli/check-verdicts.json: what `./evals check` prints as its verdict.
//   `check` has no --json, and `check --dry` replays every freeze and writes
//   dry reps into EVALS_HOME, which would move the index it then reads. So
//   this calls setVerdict, the function check and publish print through, on
//   each surface's newest batches as they stand, and spends nothing.
// - api/: every neutral route (evals-converge.md section 3, EvalsViewRoutes)
//   answered by a real `./evals api --stdio` child, for ids sampled from the
//   index by a seeded hash rank.
//
// Two dumps hours apart must read the same world, so `pin` builds a frozen
// EVALS_HOME under /tmp/evals-parity/home (run folders as symlinks, recent
// and mutable parts copied) and a copy of the sim home, and records a clock.
// Every child runs with this file preloaded, which pins Date to that clock:
// the 30-day windows, the "landing" test and /changes' cursor all read it.
// A dump records a fingerprint of the index it read; --compare warns when
// two dumps read different inputs (a symlinked run was rescored: pin again).
//
// Everything stays in /tmp: the dumps hold private freeze content and must
// never be uploaded.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

import type { BisectListResponse, EvalsBridgeRequest, EvalsBridgeResponse, OverviewResponse, RunRow, SurfaceResponse } from '@codecast/shared/contracts/evalsApi';

// ── The clock ───────────────────────────────────────────────────────────────

/** The env var that carries the pinned clock (ms) into every child. */
const NOW_ENV = 'EVALS_PARITY_NOW';

/** Pin Date to `raw` ms: `Date.now()` and `new Date()` answer it; `new Date(x)` is untouched. */
function pinClock(raw: string | undefined): void {
  const at = Number(raw);
  if (!raw || !Number.isFinite(at)) return;
  const Real = Date;
  function Pinned(...args: unknown[]): Date | string {
    if (!new.target) return new Real(at).toString();
    return args.length ? new (Real as unknown as new (...a: unknown[]) => Date)(...args) : new Real(at);
  }
  Object.setPrototypeOf(Pinned, Real);
  Pinned.prototype = Real.prototype;
  (Pinned as unknown as { now: () => number }).now = () => at;
  globalThis.Date = Pinned as unknown as DateConstructor;
}

// Runs first in every child this harness starts (bun --preload), before the evals load.
pinClock(process.env[NOW_ENV]);

// ── Where things live ───────────────────────────────────────────────────────

const SELF = import.meta.path;
const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const EVALS_ENTRY = join(REPO_ROOT, 'packages', 'evals', 'src', 'index.ts');
const ROOT = process.env.EVALS_PARITY_ROOT || '/tmp/evals-parity';
const PIN_FILE = join(ROOT, 'pin.json');
const PIN_HOME = join(ROOT, 'home');
const PIN_SIM = join(ROOT, 'sim');
/** The routes every product shares (EvalsViewRoutes): the ones whose answers must not move. */
const NEUTRAL_ROUTES = ['GET /health', 'GET /overview', 'GET /surface/:id', 'GET /freeze/:id', 'GET /run/:id', 'GET /compare', 'GET /batches', 'GET /epoch', 'GET /attribution', 'GET /commit/:sha', 'GET /changes', 'GET /bisects', 'GET /bisect/:id'] as const;
/** Files of a dump that describe it rather than answer anything. */
const META_FILE = 'meta.json';

interface Pin {
  home: string;
  simHome: string;
  source: string;
  simSource: string;
  /** The pinned clock, ms. */
  at: number;
}

const liveHome = (): string => process.env.CODECAST_EVALS_HOME || join(homedir(), '.local', 'share', 'codecast', 'evals');
const liveSimHome = (): string => process.env.CODECAST_SIM_HOME || join(homedir(), '.local', 'share', 'codecast', 'sim');

// ── pin ─────────────────────────────────────────────────────────────────────

/** A run folder touched this recently may still be written: it is copied, never linked. */
const RECENT_MS = 6 * 3_600_000;

type Mode = 'copy' | 'link' | 'skip' | 'farm';

/**
 * `dest` as a frozen view of `src`: each top-level entry copied, linked,
 * skipped or (`farm`) rebuilt as a folder of per-entry links, by `plan`;
 * entries the plan does not name are linked when they are folders and copied
 * when they are files.
 */
function mirror(src: string, dest: string, plan: Record<string, Mode>): void {
  mkdirSync(dest, { recursive: true });
  if (!existsSync(src)) return;
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dest, name);
    const mode = plan[name] ?? (statSync(from).isDirectory() ? 'link' : 'copy');
    if (mode === 'skip') continue;
    if (mode === 'link') symlinkSync(from, to);
    else if (mode === 'copy') cpSync(from, to, { recursive: true, preserveTimestamps: true });
    else farm(from, to);
  }
}

/** Each run folder linked, except the ones still moving, which are copied as they stand. */
function farm(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const cutoff = Date.now() - RECENT_MS;
  let copied = 0;
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const newest = Math.max(...['', 'run.json', 'result.json', 'score.json'].map((f) => statSync(join(from, f), { throwIfNoEntry: false })?.mtimeMs ?? 0));
    if (newest >= cutoff) {
      cpSync(from, join(dest, name), { recursive: true, preserveTimestamps: true });
      copied += 1;
    } else symlinkSync(from, join(dest, name));
  }
  if (copied) console.log(`  copied ${copied} run folder(s) touched in the last ${RECENT_MS / 3_600_000}h`);
}

function pin(opts: { from?: string; simFrom?: string }): Pin {
  const source = opts.from ?? liveHome();
  const simSource = opts.simFrom ?? liveSimHome();
  if (!existsSync(source)) throw new Error(`no evals home at ${source}`);
  for (const dir of [PIN_HOME, PIN_SIM]) rmSync(dir, { recursive: true, force: true });
  console.log(`pinning ${source} → ${PIN_HOME}`);
  // Mutable state is copied so a child's writes stay in the pin; big read-only trees are linked.
  mirror(source, PIN_HOME, { runs: 'farm', index: 'copy', bisects: 'copy', locks: 'skip', scratch: 'skip', html: 'skip' });
  console.log(`pinning ${simSource} → ${PIN_SIM}`);
  mirror(simSource, PIN_SIM, { sessions: 'copy', jobs: 'copy', trees: 'link' });
  const p: Pin = { home: PIN_HOME, simHome: PIN_SIM, source, simSource, at: Date.now() };
  writeFileSync(PIN_FILE, `${JSON.stringify(p, null, 2)}\n`);
  console.log(`pinned at ${new Date(p.at).toISOString()}: every dump reads this home and this clock until the next pin`);
  return p;
}

const readPin = (): Pin | null => (existsSync(PIN_FILE) ? (JSON.parse(readFileSync(PIN_FILE, 'utf8')) as Pin) : null);

const childEnv = (p: Pin): NodeJS.ProcessEnv => ({ ...process.env, CODECAST_EVALS_HOME: p.home, CODECAST_SIM_HOME: p.simHome, [NOW_ENV]: String(p.at), NO_COLOR: '1', FORCE_COLOR: '0' });

// ── dump ────────────────────────────────────────────────────────────────────

/** A rank that does not move when other ids join the set: the sample stays put as the index grows. */
const rank = (seed: string, id: string): string => createHash('sha256').update(`${seed}:${id}`).digest('hex');
const sample = <T>(seed: string, items: T[], idOf: (t: T) => string, n: number): T[] =>
  items
    .map((t) => ({ t, k: rank(seed, idOf(t)) }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .slice(0, n)
    .map((x) => x.t);

const pretty = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function write(dir: string, file: string, value: unknown): void {
  const path = join(dir, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, pretty(value));
}

/** One ./evals command, with the pin's home and clock: its exit code and its stdout as JSON (or as text when it is not). */
function evalsCli(p: Pin, args: string[]): { exit: number | null; stdout: unknown } {
  const r = spawnSync('bun', ['--preload', SELF, EVALS_ENTRY, ...args], { cwd: REPO_ROOT, env: childEnv(p), encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  if (r.error) throw r.error;
  let stdout: unknown = r.stdout;
  try {
    stdout = JSON.parse(r.stdout);
  } catch {
    // Not JSON: kept as text, so a change in it still shows.
  }
  return { exit: r.status, stdout };
}

/** A running `./evals api --stdio`: one request at a time, as the daemon's bridge would send it. */
function apiChild(p: Pin) {
  const child = spawn('bun', ['--preload', SELF, EVALS_ENTRY, 'api', '--stdio'], { cwd: REPO_ROOT, env: childEnv(p), stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, { resolve: (r: EvalsBridgeResponse) => void; reject: (e: Error) => void }>();
  const stderr: string[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const r = JSON.parse(line) as EvalsBridgeResponse;
    waiting.get(r.id)?.resolve(r);
    waiting.delete(r.id);
  });
  createInterface({ input: child.stderr }).on('line', (l) => stderr.push(l));
  const exited = new Promise<void>((resolve) =>
    child.once('exit', (code) => {
      for (const w of waiting.values()) w.reject(new Error(`the api child exited (${code}) mid-request:\n${stderr.slice(-20).join('\n')}`));
      waiting.clear();
      resolve();
    }),
  );
  let next = 1;
  return {
    ask(method: EvalsBridgeRequest['method'], path: string, query: Record<string, string> = {}): Promise<EvalsBridgeResponse> {
      const id = next++;
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ id, method, path, query } satisfies EvalsBridgeRequest)}\n`);
      });
    },
    async close(): Promise<void> {
      child.stdin.end();
      await exited;
    },
  };
}

/** A file name for one request: its path and sorted query, nothing a filesystem minds. */
const slugOf = (path: string, query: Record<string, string>): string =>
  [path.replace(/^\/+/, ''), ...Object.keys(query).sort().map((k) => `${k}=${query[k]}`)]
    .join('~')
    .replace(/[^\w.=~-]+/g, '_');

/** The index rows the api child read, without their rebuild keys: what the sample draws from and the dump fingerprints. */
function indexRows(p: Pin): RunRow[] {
  const path = join(p.home, 'index', 'runs.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const { key: _key, ...row } = JSON.parse(l) as RunRow & { key?: unknown };
      return row as RunRow;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const fingerprint = (rows: RunRow[]): string => createHash('sha256').update(rows.map((r) => JSON.stringify(r)).join('\n')).digest('hex');

async function dumpApi(p: Pin, dir: string, seed: string, perSurface: number): Promise<{ requests: number; covered: string[]; rows: RunRow[] }> {
  const api = apiChild(p);
  const files = new Set<string>();
  const covered = new Set<string>();
  let requests = 0;
  const get = async <T>(route: (typeof NEUTRAL_ROUTES)[number], path: string, query: Record<string, string> = {}): Promise<T | null> => {
    const r = await api.ask('GET', path, query);
    requests += 1;
    if (r.status === 200) covered.add(route);
    let body = r.body;
    // The pid is the process's own; nothing about the answer.
    if (route === 'GET /health' && body && typeof body === 'object') body = { ...(body as object), pid: '<pid>' };
    let file = `api/${slugOf(path, query)}.json`;
    for (let n = 2; files.has(file); n++) file = `api/${slugOf(path, query)}~${n}.json`;
    files.add(file);
    write(dir, file, { request: { method: 'GET', path, query }, status: r.status, body });
    return r.status === 200 ? (r.body as T) : null;
  };
  try {
    // The overview first: it loads the index, so /health answers warm and the sample reads a built index.
    const overview = await get<OverviewResponse>('GET /overview', '/overview');
    await get('GET /health', '/health');
    const rows = indexRows(p);
    const cadences = [...new Set(rows.flatMap((r) => (r.cadence ? [r.cadence] : [])))].sort();
    for (const cadence of ['named', ...cadences]) await get('GET /overview', '/overview', { cadence });

    const surfaces = (overview?.surfaces ?? []).map((s) => s.id).sort();
    const sampled: RunRow[] = [];
    for (const surface of surfaces) {
      const view = await get<SurfaceResponse>('GET /surface/:id', `/surface/${encodeURIComponent(surface)}`);
      await get('GET /surface/:id', `/surface/${encodeURIComponent(surface)}`, { dry: '1', bisect: '1' });
      for (const e of view?.epochs ?? []) await get('GET /epoch', '/epoch', { surface, n: String(e.n) });
      // Neighbouring batches, newest pairs: what the surface page's flip view asks for.
      const batches = (view?.batches ?? []).map((b) => b.batch);
      for (let i = Math.max(1, batches.length - 3); i < batches.length; i++) await get('GET /batches', '/batches', { surface, a: batches[i - 1]!, b: batches[i]! });
      await get('GET /attribution', '/attribution', { surface });

      const mine = rows.filter((r) => r.surface === surface);
      const picked = sample(seed, mine, (r) => r.id, perSurface);
      sampled.push(...picked);
      for (const r of picked) await get('GET /run/:id', `/run/${encodeURIComponent(r.id)}`);
      // Each picked rep against another rep of its freeze, as the compare page pairs them.
      for (const r of picked.slice(0, 2)) {
        const other = sample(seed, mine.filter((o) => o.freezeId === r.freezeId && o.id !== r.id), (o) => o.id, 1)[0];
        if (other) await get('GET /compare', '/compare', { a: other.id, b: r.id });
      }
      for (const f of sample(seed, [...new Set(mine.map((r) => r.freezeId))], (f) => f, 2)) await get('GET /freeze/:id', `/freeze/${encodeURIComponent(f)}`);
    }

    const heads = sample(seed, [...new Map(sampled.flatMap((r) => (r.gitHead ? [[r.gitHead, r] as const] : []))).values()], (r) => r.gitHead!, 8);
    for (const [i, r] of heads.entries()) await get('GET /commit/:sha', `/commit/${r.gitHead}`, i === 0 ? { surface: r.surface, whole: '1' } : { surface: r.surface });

    await get('GET /changes', '/changes', { since: '0' });
    const bisects = await get<BisectListResponse>('GET /bisects', '/bisects');
    for (const b of sample(seed, bisects?.bisects ?? [], (b) => b.id, 6)) await get('GET /bisect/:id', `/bisect/${encodeURIComponent(b.id)}`, { since: '0' });
    return { requests, covered: NEUTRAL_ROUTES.filter((r) => covered.has(r)), rows };
  } finally {
    await api.close();
  }
}

async function dump(label: string, opts: { seed: string; perSurface: number }): Promise<number> {
  if (!/^[\w.-]+$/.test(label)) throw new Error('a label is letters, digits, dots and dashes');
  const p = readPin() ?? pin({});
  const dir = join(ROOT, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`dumping to ${dir} (home ${p.home}, clock ${new Date(p.at).toISOString()}, seed ${opts.seed})`);

  write(dir, 'cli/runs.json', evalsCli(p, ['runs', '--json']));
  write(dir, 'cli/runs-matrix.json', evalsCli(p, ['runs', 'matrix', '--json']));
  const verdicts = spawnSync('bun', [SELF, 'verdicts', join(dir, 'cli', 'check-verdicts.json')], { cwd: REPO_ROOT, env: childEnv(p), encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (verdicts.status !== 0) throw new Error(`the verdict child failed (exit ${verdicts.status})`);
  console.log('  cli: runs, runs matrix, check verdicts');

  const api = await dumpApi(p, dir, opts.seed, opts.perSurface);
  const missing = NEUTRAL_ROUTES.filter((r) => !api.covered.includes(r));
  console.log(`  api: ${api.requests} requests, ${api.covered.length}/${NEUTRAL_ROUTES.length} neutral routes answered 200${missing.length ? ` (none for ${missing.join(', ')}: the pinned home has no input for them)` : ''}`);
  const head = spawnSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  write(dir, META_FILE, { label, pin: p, seed: opts.seed, perSurface: opts.perSurface, gitHead: head, inputs: { rows: api.rows.length, fingerprint: fingerprint(api.rows) }, covered: api.covered });
  console.log(`done: compare with  bun packages/evals/scripts/parity.ts --compare <before> ${label}`);
  return 0;
}

// ── check's verdicts (a child, with the pin's home and clock) ───────────────

/** How many of a surface's newest batches of real reps get check's verdict. */
const VERDICT_BATCHES = 3;

async function emitVerdicts(out: string): Promise<number> {
  const { surfaces } = await import('../src/registry');
  const { surfaceRuns } = await import('../src/adapters/runs');
  const { setVerdict } = await import('../src/commands/verdict');
  const { stripAnsi } = await import('@platform/cli-kit/render');
  const sets: unknown[] = [];
  for (const meta of surfaces()) {
    const history = await surfaceRuns(meta.id);
    // Newest first, as check and publish read it; a dry or unscored rep is never a set of its own.
    const batches = [...new Set(history.filter((r) => r.batch && r.status !== 'dry' && r.status !== 'unscored').map((r) => r.batch!))].slice(0, VERDICT_BATCHES);
    const one = async (batch: string, against?: string) => {
      const v = await setVerdict(meta, batch, history, against);
      sets.push({ surface: meta.id, batch, against: against ?? null, lines: v.lines.map(stripAnsi), regression: v.regression, scored: v.scored.map((r) => r.id), verdict: v.verdict });
    };
    for (const batch of batches) await one(batch);
    // check --against: the newest set weighed against the oldest of these.
    if (batches.length > 1) await one(batches[0]!, batches[batches.length - 1]!);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, pretty(sets));
  return 0;
}

// ── compare ─────────────────────────────────────────────────────────────────

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (lstatSync(path).isDirectory()) walk(path);
      else out.push(relative(dir, path));
    }
  };
  walk(dir);
  return out.filter((f) => f !== META_FILE).sort();
}

const preview = (v: unknown): string => {
  const s = JSON.stringify(v) ?? 'undefined';
  return s.length > 100 ? `${s.slice(0, 100)}…` : s;
};

/** Where two JSON values differ, as paths with both values, at most `limit` of them. */
function diffJson(a: unknown, b: unknown, path: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${path}.length: ${a.length} → ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffJson(a[i], b[i], `${path}[${i}]`, out, limit);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) diffJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`, out, limit);
    return;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${preview(a)} → ${preview(b)}`);
}

/** A dump file as compared: /health's capabilities are the one field a move may add. */
function comparable(file: string, text: string): unknown {
  const v = JSON.parse(text) as { request?: { path?: string }; body?: Record<string, unknown> };
  if (v.request?.path === '/health' && v.body) delete v.body.capabilities;
  return v;
}

function compare(a: string, b: string): number {
  const [da, db] = [a, b].map((l) => (l.includes('/') ? l : join(ROOT, l)));
  for (const d of [da!, db!]) if (!existsSync(d)) throw new Error(`no dump at ${d}`);
  const meta = (d: string) => (existsSync(join(d, META_FILE)) ? (JSON.parse(readFileSync(join(d, META_FILE), 'utf8')) as { pin?: Pin; seed?: string; inputs?: { fingerprint?: string; rows?: number } }) : {});
  const [ma, mb] = [meta(da!), meta(db!)];
  if (ma.pin?.at !== mb.pin?.at || ma.pin?.home !== mb.pin?.home) console.log(`warning: the two dumps read different pins (${ma.pin?.at} vs ${mb.pin?.at}); differences may be the inputs, not the code`);
  else if (ma.inputs?.fingerprint !== mb.inputs?.fingerprint) console.log(`warning: the pinned index moved between the dumps (${ma.inputs?.rows} vs ${mb.inputs?.rows} rows): a linked run folder changed. Pin again and dump both sides`);
  if (ma.seed !== mb.seed) console.log(`warning: different seeds (${ma.seed} vs ${mb.seed}) sample different ids`);

  const [fa, fb] = [filesUnder(da!), filesUnder(db!)];
  const inB = new Set(fb);
  const inA = new Set(fa);
  const onlyA = fa.filter((f) => !inB.has(f));
  const onlyB = fb.filter((f) => !inA.has(f));
  const changed: Array<{ file: string; diffs: string[] }> = [];
  for (const f of fa.filter((f) => inB.has(f))) {
    const [ta, tb] = [readFileSync(join(da!, f), 'utf8'), readFileSync(join(db!, f), 'utf8')];
    if (ta === tb) continue;
    const diffs: string[] = [];
    diffJson(comparable(f, ta), comparable(f, tb), '', diffs, 8);
    if (diffs.length) changed.push({ file: f, diffs });
  }
  for (const f of onlyA) console.log(`only in ${a}: ${f}`);
  for (const f of onlyB) console.log(`only in ${b}: ${f}`);
  for (const c of changed) {
    console.log(`differs: ${c.file}`);
    for (const d of c.diffs) console.log(`  ${d}`);
  }
  const same = fa.length - onlyA.length - changed.length;
  if (!onlyA.length && !onlyB.length && !changed.length) {
    console.log(`identical: ${same} files (${a} and ${b})`);
    return 0;
  }
  console.log(`not identical: ${changed.length} differ, ${onlyA.length} only in ${a}, ${onlyB.length} only in ${b}; ${same} identical`);
  return 1;
}

// ── main ────────────────────────────────────────────────────────────────────

const USAGE = `usage:
  bun packages/evals/scripts/parity.ts pin [--from <evals home>] [--sim-from <sim home>]
  bun packages/evals/scripts/parity.ts dump <label> [--seed <s>] [--per-surface <n>]
  bun packages/evals/scripts/parity.ts --compare <a> <b>
Dumps live in ${ROOT}/<label>; a dump pins the inputs first when no pin exists.`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  const [cmd, ...rest] = args;
  if (cmd === '--compare' || cmd === 'compare') {
    if (rest.length !== 2) throw new Error(USAGE);
    return compare(rest[0]!, rest[1]!);
  }
  if (cmd === 'pin') {
    pin({ from: flagValue(rest, '--from'), simFrom: flagValue(rest, '--sim-from') });
    return 0;
  }
  if (cmd === 'dump' && rest[0] && !rest[0].startsWith('-')) {
    const perSurface = Number(flagValue(rest, '--per-surface') ?? 4);
    if (!Number.isInteger(perSurface) || perSurface < 1) throw new Error('--per-surface takes a whole number');
    return dump(rest[0], { seed: flagValue(rest, '--seed') ?? 'c0', perSurface });
  }
  if (cmd === 'verdicts' && rest[0]) return emitVerdicts(rest[0]);
  console.log(USAGE);
  return cmd === undefined || cmd === '--help' || cmd === '-h' ? 0 : 2;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`parity: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 2;
  }
}

export {};
