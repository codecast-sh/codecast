import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { homePaths, treeRoot } from './paths';
import type { SurfaceMeta } from './surface';

// The cadence state: per surface, the source hash its last real run saw, the
// hash an agent surface was last flagged at, its crash streak, and its last
// cost and wall time per rep on each model. Hashes come from git at HEAD and never from the disk, so a
// half-saved edit never makes a surface stale.

export interface SurfaceState {
  lastRunHash?: string;
  /** When `lastRunHash` was recorded: a stale run over its budget runs the surfaces stale longest first. */
  lastRunAt?: string;
  lastNotifiedHash?: string;
  /** The hash an unattended `check --stale` refused on its budget: named once per source change, then left for a run by hand or a bigger budget. */
  lastRefusedHash?: string;
  /** The `--budget` that refused `lastRefusedHash`: a later firing with more than this tries the same sources again. */
  lastRefusedBudget?: number;
  crash?: { hash: string; count: number };
  /**
   * Per model: a rep's average cost and wall time in the last real run on it,
   * as the machine's load and that run's parallelism left it. Keyed by model
   * because a pin move changes both several times over (org-review: $1.76 a
   * rep on sonnet, about $7 on opus).
   */
  perRep?: Record<string, RepCost>;
}

export interface RepCost {
  usd: number;
  seconds: number;
}

export type EvalsState = Record<string, SurfaceState>;

export function readState(path = homePaths().state): EvalsState {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as EvalsState;
  } catch {
    return {};
  }
}

export function writeState(state: EvalsState, path = homePaths().state): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/** One rep's expected cost on a model: the last real run's average on it, or the surface's declared ceiling before any real run on that model. */
export function perRepUsd(meta: SurfaceMeta, state: EvalsState, model = meta.model): number {
  return state[meta.id]?.perRep?.[model]?.usd ?? meta.maxUsdPerRep;
}

/** What `check` estimates for one surface, and refuses on when it is over `--budget`. */
export function checkCostUsd(meta: SurfaceMeta, freezes: number, state: EvalsState, reps = meta.reps.check, model = meta.model): number {
  return reps * freezes * perRepUsd(meta, state, model);
}

/**
 * About how long `check` takes with `parallel` reps in flight: each
 * surface's reps at its last recorded seconds per rep on their model, spread
 * over the slots. Null until every surface has a real run on that model on record.
 */
export function checkMinutes(work: Array<{ meta: SurfaceMeta; reps: number; model?: string }>, state: EvalsState, parallel: number): number | null {
  let seconds = 0;
  for (const w of work) {
    const per = state[w.meta.id]?.perRep?.[w.model ?? w.meta.model]?.seconds;
    if (per == null) return null;
    seconds += w.reps * per;
  }
  return seconds / Math.max(1, parallel) / 60;
}

/** Each model's average cost and wall time over a run set's real reps, for SurfaceState.perRep. */
export function repCostsByModel(reps: Array<{ model?: string | null; costUsd: number; realMs: number }>, fallbackModel: string): Record<string, RepCost> {
  const by = new Map<string, Array<{ costUsd: number; realMs: number }>>();
  for (const r of reps) by.set(r.model ?? fallbackModel, [...(by.get(r.model ?? fallbackModel) ?? []), r]);
  return Object.fromEntries([...by].map(([model, rs]) => [model, { usd: rs.reduce((t, r) => t + r.costUsd, 0) / rs.length, seconds: rs.reduce((t, r) => t + r.realMs, 0) / rs.length / 1000 }]));
}

/**
 * A `--budget` to suggest for an estimate: half again on top, in whole
 * dollars, because a rep can cost more than the last run's average and
 * `check` stops the moment the next rep would cross the budget.
 */
export function suggestedBudget(estimateUsd: number): number {
  return Math.max(1, Math.ceil(estimateUsd * 1.5));
}

/**
 * What an unattended day may spend: `check --stale` (the cadence trigger)
 * refuses once today's real spend reaches it, and `stale` stops firing. A
 * check by hand is never refused, but its spend counts toward the day.
 */
export const DAILY_USD = 20;

interface DailySpend {
  day: string;
  usd: number;
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** The one-number ledger spend.jsonl replaced; what it holds for its own day still counts toward that day. */
const legacySpend = (path: string): number => {
  const old = join(dirname(path), 'spend.json');
  if (!existsSync(old)) return 0;
  try {
    const s = JSON.parse(readFileSync(old, 'utf8')) as DailySpend;
    return s.day === today() ? s.usd : 0;
  } catch {
    return 0;
  }
};

/** Real spend recorded today (UTC) across every check: the sum of today's lines in the ledger. */
export function spentToday(path = homePaths().spend): number {
  let usd = legacySpend(path);
  if (!existsSync(path)) return usd;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      const s = JSON.parse(line) as DailySpend;
      if (s.day === today() && s.usd > 0) usd += s.usd;
    } catch {
      // A blank or torn line adds nothing.
    }
  }
  return usd;
}

/**
 * Records one rep's real spend the moment it finishes, as a line of its own:
 * a check killed partway has still recorded what it spent, the daily ceiling
 * sees a long check's spend while it runs, and concurrent checks cannot lose
 * each other's lines (a short O_APPEND write lands whole).
 */
export function addSpend(usd: number, path = homePaths().spend): void {
  if (!(usd > 0)) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ day: today(), usd } satisfies DailySpend)}\n`);
}

export function patchSurfaceState(id: string, patch: (s: SurfaceState) => SurfaceState): void {
  const state = readState();
  state[id] = patch(state[id] ?? {});
  writeState(state);
}

const git = (root: string, args: string[]): string => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${root}: ${(r.stderr || '').trim()}`);
  return r.stdout;
};

/**
 * Each surface's source hash at a commit (HEAD by default): one `git ls-tree`
 * for every declared path, which names the same object `git rev-parse
 * <rev>:<path>` would. A path the commit lacks hashes as "missing", so it
 * changes the hash when it lands.
 */
export function sourceHashes(metas: SurfaceMeta[], root = treeRoot(), rev = 'HEAD'): Map<string, string> {
  const paths = [...new Set(metas.flatMap((m) => m.sources))];
  const objects = new Map<string, string>();
  if (paths.length) {
    for (const entry of git(root, ['ls-tree', '-z', rev, '--', ...paths]).split('\0')) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      objects.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2]!);
    }
  }
  return new Map(metas.map((m) => [m.id, createHash('sha256').update(m.sources.map((p) => `${p} ${objects.get(p) ?? 'missing'}`).join('\n')).digest('hex')]));
}

/** Surfaces with a declared source changed or untracked in the checkout. */
export function dirtySurfaces(metas: SurfaceMeta[], root = treeRoot()): Set<string> {
  const paths = [...new Set(metas.flatMap((m) => m.sources))];
  if (!paths.length) return new Set();
  const changed = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...paths])
    .split('\0')
    .filter((e) => e.length > 3)
    .map((e) => e.slice(3));
  const touches = (src: string) => changed.some((p) => p === src || p.startsWith(`${src}/`));
  return new Set(metas.filter((m) => m.sources.some(touches)).map((m) => m.id));
}

export interface Staleness {
  stale: SurfaceMeta[];
  /** Stale call surfaces whose sources are dirty in the checkout: they wait for the edit to be committed. */
  waiting: SurfaceMeta[];
  /** What `check --stale` acts on, and what the precheck counts: the stale surfaces that are not waiting. */
  due: SurfaceMeta[];
  blocked: SurfaceMeta[];
  hashes: Map<string, string>;
}

/**
 * A call surface is stale when its hash moved since its last run; an agent
 * surface when it moved since its last run and since it was last flagged. A
 * call surface refused on its budget at this hash is not stale again, unless
 * `budget` is more than the one that refused it. A surface that crashed twice
 * on this hash is blocked, not stale. A stale call surface with dirty sources
 * waits: replaying it would grade a tree HEAD does not hold, and counting it
 * would fire the trigger on nothing.
 */
export function staleness(metas: SurfaceMeta[], state = readState(), root = treeRoot(), budget?: number): Staleness {
  const hashes = sourceHashes(metas, root);
  const stale: SurfaceMeta[] = [];
  const blocked: SurfaceMeta[] = [];
  for (const m of metas) {
    const h = hashes.get(m.id)!;
    const s = state[m.id] ?? {};
    if (s.crash && s.crash.hash === h && s.crash.count >= 2) {
      blocked.push(m);
      continue;
    }
    const refusedStands = budget == null || s.lastRefusedBudget == null || budget <= s.lastRefusedBudget;
    const seen = m.route === 'call' ? [s.lastRunHash, refusedStands ? s.lastRefusedHash : undefined] : [s.lastRunHash, s.lastNotifiedHash];
    if (!seen.includes(h)) stale.push(m);
  }
  const dirty = dirtySurfaces(stale.filter((m) => m.route === 'call'), root);
  return { stale, waiting: stale.filter((m) => dirty.has(m.id)), due: stale.filter((m) => !dirty.has(m.id)), blocked, hashes };
}

/** Where a branch left `ref`: the commit both share, so a base that moved on is not read as the branch's change. */
export function mergeBase(ref: string, root = treeRoot()): string {
  return git(root, ['merge-base', ref, 'HEAD']).trim();
}

/**
 * The surfaces a branch touches: a declared source differs between the
 * merge base with `ref` and HEAD, or is dirty in the checkout. Unlike
 * `staleness`, no state is read: the question is what this change moves.
 */
export function changedSince(metas: SurfaceMeta[], ref: string, root = treeRoot()): { base: string; changed: SurfaceMeta[] } {
  const base = mergeBase(ref, root);
  const before = sourceHashes(metas, root, base);
  const after = sourceHashes(metas, root);
  const dirty = dirtySurfaces(metas, root);
  return { base, changed: metas.filter((m) => before.get(m.id) !== after.get(m.id) || dirty.has(m.id)) };
}

/** HEAD of the tree, for run.json. */
export function gitHead(root = treeRoot()): string {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    return 'unknown';
  }
}
