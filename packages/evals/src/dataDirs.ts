import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { assertLabelsPushable, gitIn, labelsRemoteProblem, pushLabels } from './labels';
import { evalsHome } from './paths';

// EVALS_HOME/freezes and EVALS_HOME/snapshots are plain folders, and codecast
// keeps them the same on every machine of yours (`cast datasync`; the repo's
// .codecast/workspace.toml declares them). For a few days in November 2026
// evals synced them itself, by moving both into the labels repo behind
// symlinks. Every ./evals run undoes that first, before any labels git call,
// so the labels repo goes back to holding labels only. A machine with nothing
// to undo pays two lstat calls and one exists check.

const DIRS = ['freezes', 'snapshots'] as const;
/** Written into the labels clone's .git once its copy of freezes and snapshots is untracked and pushed. */
const DONE = 'evals-data-dirs-restored';

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Moves `from` into `to`, entry by entry, keeping what `to` already has. */
function mergeInto(from: string, to: string): void {
  for (const name of readdirSync(from)) {
    const src = join(from, name);
    const dest = join(to, name);
    if (!existsSync(dest)) renameSync(src, dest);
    else if (lstatSync(src).isDirectory() && lstatSync(dest).isDirectory()) mergeInto(src, dest);
  }
}

export interface RestoreOptions {
  root?: string;
  warn?: (line: string) => void;
  /** Tests stand in for the private remote's checks. */
  visibility?: () => string | null;
  remoteProblem?: (dir: string) => string | null;
}

/** Puts freezes and snapshots back as plain folders and takes them out of the labels repo. Never throws. */
export function restoreDataDirs(o: RestoreOptions = {}): void {
  const root = o.root ?? evalsHome();
  const labels = join(root, 'labels');
  const warn = o.warn ?? ((line: string) => process.stderr.write(`evals: ${line}\n`));
  try {
    for (const name of DIRS) {
      const local = join(root, name);
      if (!isLink(local)) continue;
      rmSync(local);
      const inRepo = join(labels, name);
      if (existsSync(inRepo)) renameSync(inRepo, local);
      else mkdirSync(local, { recursive: true });
    }
    // A pull may bring back copies another machine committed before it ran this; they join the plain folders.
    for (const name of DIRS) {
      const inRepo = join(labels, name);
      if (existsSync(inRepo) && !isLink(join(root, name))) {
        mkdirSync(join(root, name), { recursive: true });
        mergeInto(inRepo, join(root, name));
        rmSync(inRepo, { recursive: true, force: true });
      }
    }
    if (!existsSync(join(labels, '.git')) || existsSync(join(labels, '.git', DONE))) return;
    const git = gitIn(labels);
    const exclude = join(labels, '.git', 'info', 'exclude');
    const excluded = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    for (const name of DIRS) if (!excluded.split('\n').includes(`/${name}/`)) appendFileSync(exclude, `/${name}/\n`);
    if (git('ls-files', '--', ...DIRS).trim()) {
      const remoteProblem = o.remoteProblem ?? labelsRemoteProblem;
      assertLabelsPushable(labels, o.visibility, remoteProblem);
      git('rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...DIRS);
      const host = hostname().split('.')[0];
      // A fresh cloud host or a CI runner may have no git identity; the commit then carries the host's name.
      const who = spawnSync('git', ['config', 'user.email'], { cwd: labels, encoding: 'utf8' }).stdout.trim() ? [] : ['-c', `user.name=${host}`, '-c', `user.email=evals@${host}`];
      git(...who, 'commit', '-qm', `${host}: freezes and snapshots leave the labels repo (cast datasync carries them)`, '--', ...DIRS);
      pushLabels(labels);
      // The replay may have brought another machine's copies in under the old paths; they join the plain folders next run.
    }
    writeFileSync(join(labels, '.git', DONE), `${new Date().toISOString()}\n`);
  } catch (e) {
    warn(`freezes and snapshots are not out of the labels repo yet (${(e as Error).message.split('\n')[0]}); the next ./evals retries`);
  }
}
