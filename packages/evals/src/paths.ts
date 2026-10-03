import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Where the evals read code from, and where they keep data. Code lives in the
// checkout this file sits in. Data lives in two homes: the synthetic freezes
// and fixtures in git under packages/evals, and everything real (private
// freezes, snapshots, runs, labels, pages, cadence state) in EVALS_HOME,
// which is never inside the repo because the repo is public.

/** The checkout this code runs from: its scripts are what a replay spawns. */
export const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

/**
 * The git tree `stale` hashes and the public freezes live in. The checkout
 * itself, unless a test points CODECAST_EVALS_REPO_ROOT at a scratch repo.
 */
export function treeRoot(): string {
  return process.env.CODECAST_EVALS_REPO_ROOT || REPO_ROOT;
}

/** Committed freeze pointers: synthetic fixtures only. */
export const publicFreezesDir = (): string => join(treeRoot(), 'packages', 'evals', 'freezes');
/** Committed synthetic snapshot content, one file per case, label inline. */
export const fixturesDir = (): string => join(treeRoot(), 'packages', 'evals', 'fixtures');

/** A data dir, not a cache: hand labels live here and are precious. */
export function evalsHome(): string {
  return process.env.CODECAST_EVALS_HOME || join(homedir(), '.local', 'share', 'codecast', 'evals');
}

export function homePaths(root = evalsHome()) {
  return {
    root,
    freezes: join(root, 'freezes'),
    snapshots: join(root, 'snapshots'),
    runs: join(root, 'runs'),
    labels: join(root, 'labels'),
    html: join(root, 'html'),
    site: join(root, 'html', 'site'),
    scratch: join(root, 'scratch'),
    state: join(root, 'state.json'),
    spend: join(root, 'spend.jsonl'),
    /** Every recorded run head: where it sits in git and its main-line twin (provenance.ts). */
    heads: join(root, 'heads.json'),
    /** `{root, at}`: the checkout that last ran ./evals, which the daemon's evals bridge execs. */
    checkout: join(root, 'checkout.json'),
    /** `<sha256>.patch`: a dirty rep's edits over its sources, so it can be replayed on its gitHead (provenance.ts diskSources). */
    trees: join(root, 'trees'),
  };
}

/** Local refs that keep every run head alive through a rebase and `git gc`. Outside refs/heads and refs/tags, so no push carries them. */
export const PIN_REF_PREFIX = 'refs/evals/heads/';

/** Write JSON through a temp file and a rename, so a reader never sees half a file. */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * The checkout whose harness and guard every model call runs. A bisect probe
 * runs an old tree's surfaces, but the harness is how a rep reaches the model,
 * not what is being bisected, so the probe points this at the checkout that
 * started it (CODECAST_EVALS_HARNESS_ROOT).
 */
const HARNESS_ROOT = process.env.CODECAST_EVALS_HARNESS_ROOT || REPO_ROOT;

/** The harness every model call goes through (pl-810). */
export const DRY_RUN_SCRIPT = join(HARNESS_ROOT, 'packages', 'cli', 'scripts', 'prompt-dry-run.ts');
export const DRY_RUN_SCRIPT_REL = 'packages/cli/scripts/prompt-dry-run.ts';
/** The guard `cast` a dry run puts first on PATH; its read list is the one answer to whether a call writes. */
export const GUARD_CAST = join(HARNESS_ROOT, 'packages', 'cli', 'scripts', 'prompt-dry-run-bin', 'cast');
/** The file in an agent rep's folder naming the guard classifier its refusals were graded with (replay.ts guardClassifierSha); part of its ruler. */
export const GUARD_STAMP = 'guard.sha';

/** The real instruction file; CLAUDE.md is a symlink to it. */
export const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');

/** The private GitHub remote of EVALS_HOME/labels (founder decision sd-319). */
export const LABELS_REMOTE = 'ashot/codecast-eval-labels';
export const PUBLISH_TASK = 'ct-55687';
