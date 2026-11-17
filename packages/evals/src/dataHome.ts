import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { acquireLock, releaseLock } from '../../cli/src/capabilities/lock';
import { assertLabelsPushable, gitIn, labelsRemoteProblem, pushLabels } from './labels';
import { homePaths, LABELS_REMOTE } from './paths';

// The real eval data every machine shares. Labels, private freezes and their
// snapshots live in one private git repo (EVALS_HOME/labels, remote
// LABELS_REMOTE), so a freeze made on the laptop replays on any cloud host,
// and one made on a host reaches the laptop. EVALS_HOME/freezes and
// EVALS_HOME/snapshots are symlinks into that repo: every reader and writer
// keeps its path, and only this file knows the data is shared.
//
// Each ./evals run syncs at start (a fetch at most once a minute) and again at
// the end with `push`, which commits whatever the run wrote under freezes/ and
// snapshots/ and sends it, so new data leaves the machine with the command that
// made it; a run that wrote nothing costs nothing at the end. A machine with no clone gets one; anything
// its EVALS_HOME held before moves into the repo and is pushed. A sync that
// cannot reach the remote says so in one line and leaves the data local.

/** What the repo carries besides labels, as directories at its root. */
export const SHARED_DIRS = ['freezes', 'snapshots'] as const;

/** A fetch younger than this is fresh enough for a read. */
const FETCH_FRESH_MS = 60_000;

export interface DataSyncOptions {
  /** Commit what this machine wrote under freezes/ and snapshots/, and push it. */
  push?: boolean;
  /** The root of EVALS_HOME; tests point it at a scratch dir. */
  root?: string;
  /** Where a missing clone comes from; tests pass a local bare repo, and under `bun test` nothing syncs without one. */
  cloneUrl?: string;
  /** Why the clone's origin is not the private remote, or null; tests pass their own, since their origin is a local bare repo. */
  remoteProblem?: (dir: string) => string | null;
  /** The push guard's visibility answer; tests pass their own. */
  visibility?: () => string | null;
  /** Where a one-line problem goes. */
  warn?: (line: string) => void;
}

let syncedThisProcess = false;

/**
 * Brings this machine's eval data level with every other's. Skipped with
 * CODECAST_EVALS_NO_SYNC=1, and under `bun test` unless the test names its
 * own local remote (`cloneUrl`), so no test reaches the real one. Never throws: a problem is one warning, and the data stays
 * usable here.
 */
export function syncDataHome(o: DataSyncOptions = {}): void {
  if (process.env.CODECAST_EVALS_NO_SYNC === '1' || (process.env.NODE_ENV === 'test' && !o.cloneUrl)) return;
  if (syncedThisProcess && !o.push && !o.root) return;
  if (!o.root) syncedThisProcess = true;
  const warn = o.warn ?? ((line: string) => process.stderr.write(`evals: ${line}\n`));
  const home = homePaths(o.root);
  mkdirSync(home.root, { recursive: true });
  const lock = { name: 'data-sync.lock', ceilingMs: 120_000 };
  const lockRoot = join(home.root, 'locks');
  mkdirSync(lockRoot, { recursive: true });
  for (let waited = 0; !acquireLock(lockRoot, () => {}, lock).acquired; waited += 100) {
    if (waited > 60_000) return warn('eval data not synced: another ./evals has held the sync lock for a minute');
    Bun.sleepSync(100);
  }
  try {
    syncLocked(home, o, warn);
  } catch (e) {
    warn(`eval data not synced (${(e as Error).message.split('\n')[0]}); it stays on this machine until the next sync`);
  } finally {
    releaseLock(lockRoot, lock);
  }
}

/** A failed clone is not retried for this long, so a machine without access to the repo does not pay for one on every run. */
const CLONE_RETRY_MS = 60 * 60_000;

function syncLocked(home: ReturnType<typeof homePaths>, o: DataSyncOptions, warn: (line: string) => void): void {
  const repo = home.labels;
  if (!existsSync(join(repo, '.git')) && !cloneRepo(home, o)) return;
  const adopted = adoptIntoRepo(home, warn);
  const remoteProblem = o.remoteProblem ?? labelsRemoteProblem;
  const problem = remoteProblem(repo);
  if (problem) throw new Error(problem);
  const git = gitIn(repo);
  if (o.push || adopted) {
    git('add', '-A', '--', ...SHARED_DIRS);
    const staged = git('diff', '--cached', '--name-only', '--', ...SHARED_DIRS).trim();
    const host = hostname().split('.')[0];
    // A fresh cloud host may have no git identity; its commits then carry the host's name.
    const who = spawnSync('git', ['config', 'user.email'], { cwd: repo, encoding: 'utf8' }).stdout.trim() ? [] : ['-c', `user.name=${host}`, '-c', `user.email=evals@${host}`];
    if (staged) git(...who, 'commit', '-qm', `${host}: ${staged.split('\n').length} freeze and snapshot file(s)`, '--', ...SHARED_DIRS);
  }
  const ahead = spawnSync('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim() !== '0';
  const fetchHead = join(repo, '.git', 'FETCH_HEAD');
  const fresh = existsSync(fetchHead) && Date.now() - statSync(fetchHead).mtimeMs < FETCH_FRESH_MS;
  if (fresh && !ahead) return;
  // Only a push needs the guard; a fetch that only fast-forwards sends nothing.
  if (ahead) assertLabelsPushable(repo, o.visibility, remoteProblem);
  pushLabels(repo);
}

/** Clones the repo into EVALS_HOME/labels; false (and one warning per hour) when it cannot. */
function cloneRepo(home: ReturnType<typeof homePaths>, o: DataSyncOptions): boolean {
  const repo = home.labels;
  if (existsSync(repo) && readdirSync(repo).length) throw new Error(`${repo} holds files but is not a git repo`);
  const stamp = join(home.root, 'locks', 'data-clone-failed');
  if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < CLONE_RETRY_MS) return false;
  rmSync(repo, { recursive: true, force: true });
  const url = o.cloneUrl ?? `https://github.com/${LABELS_REMOTE}.git`;
  const cloned = spawnSync('git', ['clone', '-q', url, repo], { encoding: 'utf8', timeout: 120_000 });
  if (cloned.status === 0) {
    rmSync(stamp, { force: true });
    return true;
  }
  rmSync(repo, { recursive: true, force: true });
  writeFileSync(stamp, `${new Date().toISOString()}\n`);
  throw new Error(`cloning ${LABELS_REMOTE} failed (${(cloned.stderr || 'timed out').trim().split('\n').pop()}); on a cloud host, the codecast GitHub App needs access to it`);
}

/**
 * Makes EVALS_HOME/freezes and EVALS_HOME/snapshots links into the repo. A
 * real directory there (a machine's data from before the repo carried it, or
 * one an older checkout made) has its files moved in first. A file the repo
 * already holds with the same bytes is dropped; one with other bytes under the
 * same name is set aside in scratch, never lost. Returns whether anything moved.
 */
function adoptIntoRepo(home: ReturnType<typeof homePaths>, warn: (line: string) => void): boolean {
  let moved = false;
  for (const name of SHARED_DIRS) {
    const local = join(home.root, name);
    const inRepo = join(home.labels, name);
    mkdirSync(inRepo, { recursive: true });
    const st = existsSync(local) || isLink(local) ? lstatSync(local) : null;
    if (st?.isSymbolicLink()) continue;
    if (st?.isDirectory()) {
      // A served snapshot dir is read-only; its entries can only move out once it is writable again.
      spawnSync('chmod', ['-R', 'u+w', local]);
      const aside = join(home.scratch, 'data-adopt', `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      moved = mergeInto(local, inRepo, aside) || moved;
      if (existsSync(aside)) warn(`${name} files already in the shared repo were set aside in ${aside}`);
      rmSync(local, { recursive: true, force: true });
    } else if (st) {
      throw new Error(`${local} is a file, not a directory`);
    }
    symlinkSync(join('labels', name), local);
  }
  return moved;
}

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Moves every entry of `from` into `to`, recursing into directories both hold; a copy of a file `to` already has is dropped, and a clash goes to `aside`. */
function mergeInto(from: string, to: string, aside: string): boolean {
  let moved = false;
  for (const entry of readdirSync(from)) {
    const src = join(from, entry);
    const dest = join(to, entry);
    if (!existsSync(dest) && !isLink(dest)) {
      renameSync(src, dest);
      moved = true;
    } else if (lstatSync(src).isDirectory() && lstatSync(dest).isDirectory()) {
      moved = mergeInto(src, dest, join(aside, entry)) || moved;
    } else if (lstatSync(src).isFile() && lstatSync(dest).isFile() && readFileSync(src).equals(readFileSync(dest))) {
      rmSync(src);
    } else {
      mkdirSync(aside, { recursive: true });
      renameSync(src, join(aside, entry));
    }
  }
  return moved;
}
