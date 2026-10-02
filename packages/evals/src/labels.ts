import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { LABELS_REMOTE } from './paths';

// The labels repo's safety checks, shared by `doctor` and every code path that
// pushes labels: real labels go only to the private LABELS_REMOTE (sd-319).

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
