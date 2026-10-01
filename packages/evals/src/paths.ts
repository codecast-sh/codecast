import { homedir } from 'node:os';
import { join } from 'node:path';

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
  };
}

/** The harness every model call goes through (pl-810). */
export const DRY_RUN_SCRIPT = join(REPO_ROOT, 'packages', 'cli', 'scripts', 'prompt-dry-run.ts');
export const DRY_RUN_SCRIPT_REL = 'packages/cli/scripts/prompt-dry-run.ts';

/** The real instruction file; CLAUDE.md is a symlink to it. */
export const AGENTS_MD = join(REPO_ROOT, 'AGENTS.md');

/** The private GitHub remote of EVALS_HOME/labels (founder decision sd-319). */
export const LABELS_REMOTE = 'ashot/codecast-eval-labels';
export const PUBLISH_TASK = 'ct-55687';
