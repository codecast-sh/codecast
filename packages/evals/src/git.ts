import { spawnSync } from 'node:child_process';

import type { CommitRef } from '@codecast/shared/contracts/evalsApi';

import { treeRoot } from './paths';

// The one git the eval tool runs: argv arrays only, never a shell string. The
// provenance, the staleness hashes, attribution and the api child's pages all
// call git through here, and read `git log` through one reader, so a commit
// is parsed and placed on the main line the same way everywhere.

export interface GitResult {
  /** Exit 0, with nothing cut short. */
  ok: boolean;
  out: string;
  err: string;
}

/** git `args` in `root`. Output past 256 MiB is cut, and reads as not ok. */
export function git(root: string, args: string[], input?: string | Buffer, env?: Record<string, string>): GitResult {
  const r = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: env ? { ...process.env, ...env } : undefined });
  return { ok: r.status === 0 && !r.error, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

/** git's output, or a throw naming the command, the root and git's own words. */
export function gitOrThrow(root: string, args: string[], input?: string | Buffer): string {
  const r = git(root, args, input);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${root}: ${r.err}`);
  return r.out;
}

/** A full commit sha. */
export const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/** The full sha a name resolves to as a commit, or null. */
export function resolveCommit(name: string, root = treeRoot()): string | null {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
  const sha = r.out.trim();
  return r.ok && FULL_SHA_RE.test(sha) ? sha : null;
}

/** The trailer an agent commit names its codecast session in. */
export const SESSION_TRAILER = 'Codecast-Session';
const LOG_FORMAT = `--format=%H%x1f%s%x1f%an%x1f%aI%x1f%(trailers:key=${SESSION_TRAILER},valueonly,separator=%x2C)%x1f%P%x1e`;

export interface LoggedCommit extends CommitRef {
  parents: string[];
}

/** Where a logged commit sits: on the main line, and the main-line commit that carries its change. */
export type CommitPlace = (sha: string) => Pick<CommitRef, 'onMain' | 'mainSha' | 'twinReason' | 'near'>;

/** For a log walked along the main line: every commit is its own main-line commit. */
export const onMainLine: CommitPlace = (sha) => ({ onMain: true, mainSha: sha });

/** `git log <args>` as commits in git's order, each placed by `place`. */
export function gitLog(args: string[], place: CommitPlace, root = treeRoot()): LoggedCommit[] {
  const r = git(root, ['log', LOG_FORMAT, ...args]);
  if (!r.ok) return [];
  return r.out
    .split('\x1e')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha = '', subject = '', author = '', at = '', session = '', parents = ''] = l.split('\x1f');
      return { sha, subject, author, at, session: session.trim().split(',')[0] || null, ...place(sha), parents: parents.split(' ').filter(Boolean) };
    });
}
