import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { canonical } from './adapters/resolver';
import { evalsHome, homePaths, PIN_REF_PREFIX, REPO_ROOT, treeRoot, writeJsonAtomic } from './paths';
import { sourceHashes } from './state';
import type { SurfaceMeta } from './surface';

// Which code a run ran. A run records the commit it ran on (run.json
// gitHead), and a rebase or a history rewrite can leave that commit on no
// branch, where `git gc` collects it and the record names nothing. So every
// recorded head is pinned under refs/evals/heads/, and heads.json says where
// each head sits now and which main-line commit carries the same change.

const SHA = /^[0-9a-f]{40}$/;

interface GitResult {
  ok: boolean;
  out: string;
  err: string;
}

function git(root: string, args: string[], input?: string, env?: Record<string, string>): GitResult {
  const r = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: env ? { ...process.env, ...env } : undefined });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '').trim() || (r.error?.message ?? '') };
}

function gitOrThrow(root: string, args: string[], input?: string): string {
  const r = git(root, args, input);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed in ${root}: ${r.err}`);
  return r.out;
}

/** The full sha a name resolves to as a commit, or null. */
export function resolveCommit(name: string, root = treeRoot()): string | null {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
  const sha = r.out.trim();
  return r.ok && SHA.test(sha) ? sha : null;
}

/** Where a head sits: on the main line, on another branch only, on no branch, or gone from the repo. */
export type HeadPlace = 'main' | 'branch' | 'none' | 'missing';

export interface HeadEntry {
  on: HeadPlace;
  /** The main-line commit that carries this head's change: itself on main, its patch-id twin off it, null when none does. */
  mainSha: string | null;
  how: 'self' | 'patch-id' | null;
  /** Why mainSha is null, in a sentence. */
  reason?: string;
  /** A main-line commit with this head's author, date and subject but a different patch: amended when it landed. Never used as mainSha. */
  near?: string;
  subject?: string;
  authoredAt?: string;
  pinned: boolean;
}

export interface HeadsFile {
  updatedAt: string;
  /** The refs read as the main line when this was written. */
  mainLine: string[];
  heads: Record<string, HeadEntry>;
}

export function readHeads(path = homePaths().heads): HeadsFile | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HeadsFile;
  } catch {
    return null;
  }
}

/** The main line: local main and origin/main, whichever exist. */
export function mainLineRefs(root = treeRoot()): string[] {
  return ['refs/heads/main', 'refs/remotes/origin/main'].filter((ref) => git(root, ['rev-parse', '--verify', '--quiet', ref]).ok);
}

/** The commits among `shas` this repo still holds. One `cat-file --batch-check` for all of them. */
function present(root: string, shas: string[]): Set<string> {
  if (!shas.length) return new Set();
  const out = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], `${shas.join('\n')}\n`).out;
  return new Set(
    out
      .split('\n')
      .map((l) => l.split(' '))
      .filter(([sha, type]) => sha && type === 'commit')
      .map(([sha]) => sha!),
  );
}

/** The pinned heads, read back from the refs. */
export function pinnedHeads(root = treeRoot()): string[] {
  return git(root, ['for-each-ref', '--format=%(objectname)', PIN_REF_PREFIX]).out.split('\n').filter((s) => SHA.test(s));
}

export interface PinResult {
  pinned: string[];
  already: string[];
  /** Named heads the repo no longer holds: nothing can pin them now. */
  missing: string[];
}

/**
 * Pin each head under refs/evals/heads/<sha>, in one ref transaction. A batch
 * pins its head when it starts; `pin --backfill` pins every head the run
 * folders record. Refs stay local: they sit outside refs/heads and refs/tags.
 */
export function pinHeads(shas: string[], root = treeRoot()): PinResult {
  const want = [...new Set(shas.filter((s) => SHA.test(s)))];
  const have = present(root, want);
  const already = new Set(pinnedHeads(root));
  const todo = want.filter((s) => have.has(s) && !already.has(s));
  if (todo.length) gitOrThrow(root, ['update-ref', '--stdin'], todo.map((s) => `update ${PIN_REF_PREFIX}${s} ${s}\n`).join(''));
  return { pinned: todo, already: want.filter((s) => already.has(s)), missing: want.filter((s) => !have.has(s)) };
}

/** Pin one head (a batch's HEAD at start). Never throws: a run must not fail because a ref could not be written. */
export function pinHead(sha: string, root = treeRoot()): boolean {
  try {
    return pinHeads([sha], root).missing.length === 0;
  } catch {
    return false;
  }
}

/** Every head the run folders record, with its run count. */
export function recordedHeads(runsDir = homePaths().runs): Map<string, number> {
  const heads = new Map<string, number>();
  if (!existsSync(runsDir)) return heads;
  for (const name of readdirSync(runsDir)) {
    let head: unknown;
    try {
      head = (JSON.parse(readFileSync(resolve(runsDir, name, 'run.json'), 'utf8')) as { gitHead?: unknown }).gitHead;
    } catch {
      continue;
    }
    if (typeof head === 'string' && SHA.test(head)) heads.set(head, (heads.get(head) ?? 0) + 1);
  }
  return heads;
}

interface CommitFacts {
  parents: number;
  authorTime: number;
  authorEmail: string;
  subject: string;
}

function commitFacts(root: string, sha: string): CommitFacts {
  const [parents = '', at = '0', ae = '', subject = ''] = gitOrThrow(root, ['log', '-1', '--format=%P%x00%at%x00%ae%x00%s', sha]).replace(/\n$/, '').split('\0');
  return { parents: parents.split(' ').filter(Boolean).length, authorTime: Number(at), authorEmail: ae, subject };
}

/** Patch ids by commit, for `git log -p` over `revs` (or for named commits). */
function patchIds(root: string, logArgs: string[]): Map<string, string> {
  const patches = gitOrThrow(root, ['log', '-p', '--no-merges', '--no-color', '--format=%H', ...logArgs]);
  const ids = new Map<string, string>();
  for (const line of gitOrThrow(root, ['patch-id', '--stable'], patches).split('\n')) {
    const [pid, sha] = line.split(' ');
    if (pid && sha) ids.set(sha, pid);
  }
  return ids;
}

/** Which branch refs contain `sha`, one `for-each-ref --contains` call. */
function containingRefs(root: string, sha: string): string[] {
  return git(root, ['for-each-ref', '--contains', sha, '--format=%(refname)', 'refs/heads', 'refs/remotes']).out.split('\n').filter((r) => r && !r.endsWith('/HEAD'));
}

/**
 * Where each head sits, and its main-line twin when it is off the main line.
 * A twin is the main-line commit with the same `git patch-id --stable`: the
 * commit a rebase or a rewrite made of it. The search reads main-line commits
 * since a day before the oldest head off it: first the ones with the head's
 * author, date and subject (cheap), then, for heads still unmatched, every
 * patch in that window. A squash or an amend changes the patch, so those
 * heads map to null with the reason.
 */
export function mapHeads(shas: string[], root = treeRoot(), prior: HeadsFile | null = null): HeadsFile {
  const mainLine = mainLineRefs(root);
  const have = present(root, shas);
  const pinned = new Set(pinnedHeads(root));
  const heads: Record<string, HeadEntry> = {};
  const off: Array<{ sha: string; facts: CommitFacts }> = [];

  for (const sha of shas) {
    if (!have.has(sha)) {
      const before = prior?.heads[sha];
      heads[sha] = before
        ? { ...before, on: 'missing', pinned: false }
        : { on: 'missing', mainSha: null, how: null, reason: 'the commit is gone from this repo: it was collected before it was pinned', pinned: false };
      continue;
    }
    const facts = commitFacts(root, sha);
    const refs = containingRefs(root, sha);
    const on: HeadPlace = refs.some((r) => mainLine.includes(r)) ? 'main' : refs.length ? 'branch' : 'none';
    const base = { on, subject: facts.subject, authoredAt: new Date(facts.authorTime * 1000).toISOString(), pinned: pinned.has(sha) };
    if (on === 'main') {
      heads[sha] = { ...base, mainSha: sha, how: 'self' };
      continue;
    }
    heads[sha] = { ...base, mainSha: null, how: null };
    if (!mainLine.length) heads[sha]!.reason = 'this repo has no main or origin/main to map onto';
    else if (facts.parents > 1) heads[sha]!.reason = 'a merge commit has no single patch to match';
    else off.push({ sha, facts });
  }
  if (!off.length) return { updatedAt: new Date().toISOString(), mainLine, heads };

  const since = String(Math.min(...off.map((o) => o.facts.authorTime)) - 86_400);
  const window = gitOrThrow(root, ['log', '--no-merges', '--format=%H%x00%at%x00%ae%x00%s', `--since=${since}`, ...mainLine])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha = '', at = '', ae = '', subject = ''] = l.split('\0');
      return { sha, key: `${at}\0${ae}\0${subject}` };
    });
  const own = patchIds(root, ['--no-walk', ...off.map((o) => o.sha)]);

  let windowIds: Map<string, string> | null = null;
  const twinIn = (ids: Map<string, string>, pid: string): string | undefined => window.find((c) => ids.get(c.sha) === pid)?.sha;

  for (const { sha, facts } of off) {
    const entry = heads[sha]!;
    const pid = own.get(sha);
    if (!pid) {
      entry.reason = 'the commit changes no file, so no patch identifies it';
      continue;
    }
    const key = `${facts.authorTime}\0${facts.authorEmail}\0${facts.subject}`;
    const alike = window.filter((c) => c.key === key).map((c) => c.sha);
    let twin = alike.length ? twinIn(patchIds(root, ['--no-walk', ...alike]), pid) : undefined;
    if (!twin) {
      windowIds ??= patchIds(root, [`--since=${since}`, ...mainLine]);
      twin = twinIn(windowIds, pid);
    }
    if (twin) {
      entry.mainSha = twin;
      entry.how = 'patch-id';
    } else if (alike.length) {
      entry.near = alike[0];
      entry.reason = `main has ${alike[0]!.slice(0, 9)} with the same author, date and subject but a different patch: amended or squashed when it landed`;
    } else {
      entry.reason = 'no main-line commit carries the same patch: squashed or amended when it landed, or not landed yet';
    }
  }
  return { updatedAt: new Date().toISOString(), mainLine, heads };
}

export interface BackfillResult extends PinResult {
  heads: HeadsFile;
  runs: Map<string, number>;
}

/**
 * Pin every recorded head and every head pinned before, then rewrite
 * heads.json from where each sits now. Safe to run any number of times.
 */
export function backfillPins(opts: { root?: string; runsDir?: string; headsPath?: string; extra?: string[] } = {}): BackfillResult {
  const root = opts.root ?? treeRoot();
  const headsPath = opts.headsPath ?? homePaths().heads;
  const runs = recordedHeads(opts.runsDir);
  const result = pinHeads([...runs.keys(), ...(opts.extra ?? [])], root);
  const heads = mapOrphans(root, headsPath);
  return { ...result, heads, runs };
}

/** Rewrite heads.json for every pinned head, keeping what it knew about heads the repo has since lost. */
export function mapOrphans(root = treeRoot(), headsPath = homePaths().heads): HeadsFile {
  const prior = readHeads(headsPath);
  const shas = [...new Set([...pinnedHeads(root), ...Object.keys(prior?.heads ?? {})])].sort();
  const heads = mapHeads(shas, root, prior);
  writeJsonAtomic(headsPath, heads);
  return heads;
}

const inside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Record this checkout as the one that last ran ./evals: `{root, at}` in
 * EVALS_HOME/checkout.json, which the daemon's evals bridge reads to find the
 * code it runs. A tool copy running from a scratch worktree under EVALS_HOME
 * (a line or bisect base) is not a checkout and leaves the pointer alone.
 * Best effort: a pointer that cannot be written never fails the command.
 */
export function writeCheckoutPointer(root = REPO_ROOT, home = evalsHome()): boolean {
  const at = real(root);
  if (inside(at, real(home))) return false;
  try {
    writeJsonAtomic(homePaths(home).checkout, { root: at, at: new Date().toISOString() });
    return true;
  } catch {
    return false;
  }
}

// What a rep actually ran. sourceHash names HEAD's sources (state.ts), which
// is what staleness wants and what a dirty checkout did not run. So a rep
// also records its sources as the disk held them, a patch that rebuilds that
// disk on its gitHead, and the identity of the freeze it replayed.

/** What every replay reads besides a surface's declared sources: the committed fixtures and freezes. */
export const REPLAY_INPUTS = ['packages/evals/fixtures', 'packages/evals/freezes'];

/** The paths sourceHashDisk and treePatch cover for a surface. */
export const diskPaths = (meta: Pick<SurfaceMeta, 'sources'>): string[] => [...new Set([...meta.sources, ...REPLAY_INPUTS])];

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * The tree the disk holds for `paths`: HEAD, with those paths as they sit in
 * the checkout (untracked files in, ignored ones out). It is written through
 * a private index, so the checkout's own index is never touched. Null when it
 * cannot be read, such as a repo with no HEAD: provenance never fails a run.
 */
export function diskTree(paths: string[], root = treeRoot()): string | null {
  const env = { GIT_INDEX_FILE: join(tmpdir(), `evals-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`) };
  try {
    if (!git(root, ['read-tree', 'HEAD'], undefined, env).ok) return null;
    const here = paths.filter((p) => existsSync(resolve(root, p)));
    const gone = paths.filter((p) => !here.includes(p));
    if (here.length && !git(root, ['add', '-A', '--', ...here], undefined, env).ok) return null;
    if (gone.length && !git(root, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...gone], undefined, env).ok) return null;
    const tree = git(root, ['write-tree'], undefined, env);
    return tree.ok ? tree.out.trim() : null;
  } finally {
    rmSync(env.GIT_INDEX_FILE, { force: true });
    rmSync(`${env.GIT_INDEX_FILE}.lock`, { force: true });
  }
}

/** Keep a patch under EVALS_HOME/trees by its sha256, written once; null for an empty one. */
function storePatch(patch: string, home: string): string | null {
  if (!patch) return null;
  const sha = sha256(patch);
  const dir = homePaths(home).trees;
  const path = join(dir, `${sha}.patch`);
  if (!existsSync(path)) {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, patch);
    renameSync(tmp, path);
  }
  return sha;
}

export interface DiskSources {
  /** Per surface: diskPaths hashed as the disk holds them, by sourceHashes' formula, so equal disks hash equal at any HEAD. */
  hashes: Map<string, string>;
  /** Per surface: the sha256 of `git diff --binary HEAD` over diskPaths (untracked files included), kept at EVALS_HOME/trees/<sha>.patch; null when the disk matches HEAD there. */
  patches: Map<string, string | null>;
}

/**
 * What each surface's reps run on: one disk tree for every surface of a
 * check, read once per check. `git apply` of a surface's patch on its gitHead
 * rebuilds that tree. Null when git cannot say.
 */
export function diskSources(metas: Array<Pick<SurfaceMeta, 'id' | 'sources'>>, root = treeRoot(), home = evalsHome()): DiskSources | null {
  const wide = metas.map((m) => ({ ...m, sources: diskPaths(m) })) as SurfaceMeta[];
  const tree = diskTree([...new Set(wide.flatMap((m) => m.sources))], root);
  if (!tree) return null;
  try {
    const hashes = sourceHashes(wide, root, tree);
    const atHead = sourceHashes(wide, root, 'HEAD');
    const patches = new Map(
      wide.map((m) => [m.id, hashes.get(m.id) === atHead.get(m.id) ? null : storePatch(gitOrThrow(root, ['diff', '--binary', '--no-color', '--no-ext-diff', 'HEAD', tree, '--', ...m.sources]), home)] as const),
    );
    return { hashes, patches };
  } catch {
    return null;
  }
}

/** A snapshot's content: a file's bytes, or a served dir's files by relative path. */
function contentDigest(path: string | null): string {
  if (!path || !existsSync(path)) return 'missing';
  if (!statSync(path).isDirectory()) return sha256(readFileSync(path));
  const files = (readdirSync(path, { recursive: true }) as string[]).filter((rel) => statSync(join(path, rel)).isFile()).sort();
  return sha256(files.map((rel) => `${rel} ${sha256(readFileSync(join(path, rel)))}`).join('\n'));
}

/**
 * A freeze as a replay reads it: its JSON (criteria, tags and snapshot
 * pointer included) and its snapshot's content (resolver.ts snapshotPath).
 * A changed moment or criterion then reads as a freeze change, never as a
 * prompt change.
 */
export function freezeSha(f: unknown, snapshot: string | null): string {
  return sha256(`${JSON.stringify(canonical(f))}\0${contentDigest(snapshot)}`);
}
