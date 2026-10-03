import { spawnSync } from 'node:child_process';
import { existsSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { EVALS_PATCH_SHA_RE, EVALS_SHA_RE, type CommitRef, type CommitResponse, type PatchResponse } from '@codecast/shared/contracts/evalsApi';

import { declaredPaths, repoGit } from '../history/attribution';
import { homePaths, treeRoot } from '../paths';
import { mainLineRefs, readHeads, resolveCommit } from '../provenance';

// The git the api child reads for the pages: one commit in full (the commit
// panel), and the commits that touched a surface's declared sources inside a
// window (the surface page and the epoch sheet). Every call is an argv
// array, never a shell string, and every sha a client sends is checked
// against EVALS_SHA_RE and `git rev-parse --verify <sha>^{commit}` first.

const SESSION_TRAILER = 'Codecast-Session';
const FORMAT = `--format=%H%x1f%s%x1f%an%x1f%aI%x1f%(trailers:key=${SESSION_TRAILER},valueonly,separator=%x2C)%x1f%P%x1e`;

const git = (args: string[], root = treeRoot()) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export class BadSha extends Error {}

/** The full sha a client-sent name stands for; throws BadSha when it is not a sha of a commit in this repo. */
export function verifiedSha(sha: string): string {
  if (!EVALS_SHA_RE.test(sha)) throw new BadSha(`${sha} is not a sha (7 to 40 lowercase hex)`);
  const full = resolveCommit(sha);
  if (!full) throw new BadSha(`${sha} is not a commit in this repo`);
  return full;
}

interface Logged extends CommitRef {
  parents: string[];
}

/** Whether `sha` is on the main line, asked once per process per sha. */
const onMainCache = new Map<string, boolean>();
function onMain(sha: string): boolean {
  const hit = onMainCache.get(sha);
  if (hit !== undefined) return hit;
  const yes = mainLineRefs().some((ref) => git(['merge-base', '--is-ancestor', sha, ref]).status === 0);
  onMainCache.set(sha, yes);
  return yes;
}

/** `git log` rows as CommitRefs, each mapped to its main-line twin through heads.json when it sits on no branch. */
function log(args: string[], known: { onMain?: boolean } = {}): Logged[] {
  const r = git(['log', FORMAT, ...args]);
  if (r.status !== 0) return [];
  const heads = readHeads();
  return r.stdout
    .split('\x1e')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sha = '', subject = '', author = '', at = '', session = '', parents = ''] = l.split('\x1f');
      const main = known.onMain ?? onMain(sha);
      const entry = heads?.heads[sha];
      return { sha, subject, author, at, session: session.trim().split(',')[0] || null, mainSha: main ? sha : (entry?.mainSha ?? null), onMain: main, parents: parents.split(' ').filter(Boolean) };
    });
}

/** One commit as the pages name it. */
export function commitRef(sha: string): CommitRef | null {
  const [c] = log(['-1', sha]);
  if (!c) return null;
  const { parents: _, ...ref } = c;
  return ref;
}

/**
 * The commits on the main line that touched what a surface declares (its
 * sources, its own dir, the harness, and what every prompt rests on),
 * between two instants, oldest first.
 */
export function commitsTouching(surface: string, from: string | null, to: string | null, max = 200): CommitRef[] {
  const refs = mainLineRefs();
  if (!refs.length) return [];
  const paths = declaredPaths(surface, [], repoGit());
  const rows = log([`--max-count=${max}`, ...(from ? [`--since=${from}`] : []), ...(to ? [`--until=${to}`] : []), refs[0]!, '--', ...paths], { onMain: true });
  return rows.reverse().map(({ parents: _, ...c }) => c);
}

/**
 * The commits between two heads that touched a surface's declared paths,
 * oldest first: the ancestry path when `a` is an ancestor of `b`, else
 * nothing (an epoch whose heads sit on two branches has no honest range).
 */
export function commitsBetween(surface: string, a: string, b: string): CommitRef[] {
  const g = repoGit();
  if (a === b || !g.isAncestor(a, b)) return [];
  return g.path(a, b, declaredPaths(surface, [a, b], g));
}

/**
 * One commit in full: its message, its files with line counts, and its diff,
 * limited to the surface's declared paths unless `whole` (or when no surface
 * is named).
 */
export function commitDetail(sha: string, surface: string | null, whole: boolean): CommitResponse {
  const full = verifiedSha(sha);
  const [c] = log(['-1', full]);
  if (!c) throw new BadSha(`${sha} is not a commit in this repo`);
  const limit = !whole && surface ? ['--', ...declaredPaths(surface, [full], repoGit())] : [];
  const body = git(['show', '-s', '--format=%B', full]).stdout.trimEnd();
  const numstat = git(['show', '--format=', '--numstat', '-z', full, ...limit]).stdout;
  const status = git(['show', '--format=', '--name-status', '-z', full, ...limit]).stdout.split('\0');
  const statusOf = new Map<string, string>();
  for (let i = 0; i + 1 < status.length; ) {
    const s = status[i]!;
    if (!s) {
      i++;
      continue;
    }
    // A rename or copy names two paths: the old one, then the new one.
    if (/^[RC]/.test(s)) {
      statusOf.set(status[i + 2] ?? '', s[0]!);
      i += 3;
    } else {
      statusOf.set(status[i + 1] ?? '', s);
      i += 2;
    }
  }
  const files: CommitResponse['files'] = [];
  const parts = numstat.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!;
    const m = /^\s*(\d+|-)\t(\d+|-)\t(.*)$/s.exec(head);
    if (!m) continue;
    let path = m[3]!;
    // With -z a rename's numstat line ends in a tab and the two paths follow as their own fields.
    if (!path) {
      path = parts[i + 2] ?? '';
      i += 2;
    }
    files.push({ path, status: statusOf.get(path) ?? 'M', additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  const diff = git(['show', '--format=', '--patch', '--no-color', full, ...limit]).stdout;
  const { parents, ...commit } = c;
  return { commit, parents, body, whole: whole || !surface, files, diff };
}

/** How much of a patch's text the page gets: a huge one would stall the diff view. */
export const PATCH_TEXT_MAX = 2 * 1024 * 1024;

/**
 * One kept tree patch (EVALS_HOME/trees/<sha>.patch): its files with line
 * counts (`git apply --numstat`, which reads the patch and applies nothing)
 * and its text. Null when no patch by that name is kept.
 */
export function patchDetail(sha: string): PatchResponse | null {
  if (!EVALS_PATCH_SHA_RE.test(sha)) throw new BadSha(`${sha} is not a patch name (64 lowercase hex)`);
  const path = join(homePaths().trees, `${sha}.patch`);
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  const buf = Buffer.alloc(Math.min(size, PATCH_TEXT_MAX));
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, 0);
  } finally {
    closeSync(fd);
  }
  const files: PatchResponse['files'] = [];
  for (const line of git(['apply', '--numstat', path]).stdout.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (m) files.push({ path: m[3]!, additions: m[1] === '-' ? 0 : Number(m[1]), deletions: m[2] === '-' ? 0 : Number(m[2]) });
  }
  return { sha, files, diff: buf.toString('utf8'), truncated: size > PATCH_TEXT_MAX };
}
