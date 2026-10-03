import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import { homePaths, LABELS_REMOTE } from './paths';

// The labels repo: where a freeze's label lives, the one write path into it
// (every label write commits and pushes, sd-319), and the safety checks that
// path and `doctor` share: real labels go only to the private LABELS_REMOTE.

/** A freeze's label: EVALS_HOME/labels/<surface>/<freezeId>.json. */
export const labelPath = (surface: string, freezeId: string, dir = homePaths().labels): string => join(dir, surface, `${freezeId}.json`);

const REMOTE_RE = new RegExp(`[:/]${LABELS_REMOTE.replace('/', '\\/')}(\\.git)?/?$`);

/** Why the labels dir cannot push to the private labels remote, or null when its origin is that remote. */
export function labelsRemoteProblem(dir: string): string | null {
  if (!existsSync(join(dir, '.git'))) return `${dir} is not a git repo`;
  const remote = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).stdout.trim();
  return REMOTE_RE.test(remote) ? null : `labels remote is "${remote || 'none'}", not ${LABELS_REMOTE}`;
}

/** LABELS_REMOTE's visibility on GitHub (PRIVATE, PUBLIC, INTERNAL), or null when gh cannot see it. */
export function labelsRepoVisibility(): string | null {
  const r = spawnSync('gh', ['repo', 'view', LABELS_REMOTE, '--json', 'visibility', '-q', '.visibility'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Throws unless a push from `dir` can only reach the private labels repo. */
export function assertLabelsPushable(dir: string, visibility: () => string | null = labelsRepoVisibility): void {
  const problem = labelsRemoteProblem(dir);
  if (problem) throw new Error(`${problem}: real labels push only to the private ${LABELS_REMOTE}`);
  const vis = visibility();
  if (vis !== 'PRIVATE') throw new Error(`${LABELS_REMOTE} is ${vis ?? 'not visible to gh'}: real labels push only to a private repo`);
}

/**
 * Commits `paths` (relative to the labels repo `dir`) and pushes the commit to
 * the private remote. `write` runs after the push guard, so nothing lands in a
 * repo that cannot push. Nothing new under the paths commits nothing; a commit
 * an earlier push left behind still goes out. Every label write ends here.
 */
export function commitLabels(dir: string, paths: string[], message: string, o: { write?: () => void; visibility?: () => string | null } = {}): void {
  if (!existsSync(join(dir, '.git'))) throw new Error(`${dir} is not a git repo; run ./evals doctor --init first`);
  assertLabelsPushable(dir, o.visibility);
  o.write?.();
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  git('add', '-A', '--', ...paths);
  if (git('diff', '--cached', '--name-only', '--', ...paths).trim()) git('commit', '-qm', message, '--', ...paths);
  git('push', '-q', '-u', 'origin', 'HEAD');
}

/** Writes a freeze's label and commits and pushes it (commitLabels); returns the label's path. */
export function writeLabel(surface: string, freezeId: string, label: unknown, dir = homePaths().labels, visibility?: () => string | null): string {
  const path = labelPath(surface, freezeId, dir);
  commitLabels(dir, [relative(dir, path)], `${surface}: label for freeze ${freezeId.slice(0, 8)}`, {
    visibility,
    write: () => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(label, null, 2)}\n`);
    },
  });
  return path;
}
