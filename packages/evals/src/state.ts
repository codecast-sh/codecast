import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { homePaths, treeRoot } from './paths';
import type { SurfaceMeta } from './surface';

// The cadence state: per surface, the source hash its last real run saw, the
// hash an agent surface was last flagged at, its crash streak and its last
// cost per rep. Hashes come from git at HEAD and never from the disk, so a
// half-saved edit never makes a surface stale.

export interface SurfaceState {
  lastRunHash?: string;
  lastNotifiedHash?: string;
  crash?: { hash: string; count: number };
  lastCostPerRep?: number;
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

/** One rep's expected cost: the last real run's average, or the surface's declared ceiling before any real run. */
export function perRepUsd(meta: SurfaceMeta, state: EvalsState): number {
  return state[meta.id]?.lastCostPerRep ?? meta.maxUsdPerRep;
}

/** What `check` estimates for one surface, and refuses on when it is over `--budget`. */
export function checkCostUsd(meta: SurfaceMeta, freezes: number, state: EvalsState, reps = meta.reps.check): number {
  return reps * freezes * perRepUsd(meta, state);
}

/**
 * A `--budget` to suggest for an estimate: half again on top, in whole
 * dollars, because a rep can cost more than the last run's average and
 * `check` stops the moment the next rep would cross the budget.
 */
export function suggestedBudget(estimateUsd: number): number {
  return Math.max(1, Math.ceil(estimateUsd * 1.5));
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
 * Each surface's source hash at HEAD: one `git ls-tree` for every declared
 * path, which names the same object `git rev-parse HEAD:<path>` would. A
 * path HEAD lacks hashes as "missing", so it changes the hash when it lands.
 */
export function sourceHashes(metas: SurfaceMeta[], root = treeRoot()): Map<string, string> {
  const paths = [...new Set(metas.flatMap((m) => m.sources))];
  const objects = new Map<string, string>();
  if (paths.length) {
    for (const entry of git(root, ['ls-tree', '-z', 'HEAD', '--', ...paths]).split('\0')) {
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
 * surface that crashed twice on this hash is blocked, not stale. A stale call
 * surface with dirty sources waits: replaying it would grade a tree HEAD
 * does not hold, and counting it would fire the trigger on nothing.
 */
export function staleness(metas: SurfaceMeta[], state = readState(), root = treeRoot()): Staleness {
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
    const seen = m.route === 'call' ? [s.lastRunHash] : [s.lastRunHash, s.lastNotifiedHash];
    if (!seen.includes(h)) stale.push(m);
  }
  const dirty = dirtySurfaces(stale.filter((m) => m.route === 'call'), root);
  return { stale, waiting: stale.filter((m) => dirty.has(m.id)), due: stale.filter((m) => !dirty.has(m.id)), blocked, hashes };
}

/** HEAD of the tree, for run.json. */
export function gitHead(root = treeRoot()): string {
  try {
    return git(root, ['rev-parse', 'HEAD']).trim();
  } catch {
    return 'unknown';
  }
}
