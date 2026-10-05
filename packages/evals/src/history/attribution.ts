import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Attribution } from '@codecast/shared/contracts/evalsApi';
import { attribute as attributeWith, type AttributionGit, type AttributionInput as CoreAttributionInput, type AttributionMeta } from '@platform/evals/analysis';

import { codecastVerdict } from '../commands/verdict';
import { git, gitLog, onMainLine, resolveCommit } from '../git';
import { DRY_RUN_SCRIPT_REL, publicFreezesDir, treeRoot } from '../paths';
import { readHeads } from '../provenance';
import { surfaceMeta } from '../registry';
import { surfaceDir } from '../surface';
import { folderPromptReader } from './epochs';

// Tier 0 attribution (@platform/evals/analysis attribution.ts) over codecast's
// records: the repo's git, the paths each surface declares, heads.json, and the
// committed snapshots of public freezes.

export { freezeFileChange, largestDrops } from '@platform/evals/analysis';
export type { AttributionGit, AttributionMeta } from '@platform/evals/analysis';

/** The repo's git, argv only, never a shell string. */
export function repoGit(root = treeRoot()): AttributionGit {
  const run = (args: string[]) => git(root, args);
  return {
    resolve: (name) => resolveCommit(name, root),
    isAncestor: (a, b) => run(['merge-base', '--is-ancestor', a, b]).ok,
    path: (good, bad, paths) => gitLog(['--reverse', '--ancestry-path', `${good}..${bad}`, ...(paths ? ['--', ...paths] : [])], onMainLine, root).map(({ parents: _, ...c }) => c),
    changed: (a, b, paths) => {
      const r = run(['diff', '--name-only', a, b, '--', ...paths]);
      return r.ok ? r.out.split('\n').filter(Boolean) : [];
    },
    show: (sha, path) => {
      const r = run(['show', `${sha}:${path}`]);
      return r.ok ? r.out : null;
    },
  };
}

/** A public freeze's committed snapshot, as a repo path (its pointer's meta.snapshot), or null. */
function publicSnapshotPath(freezeId: string): string | null {
  try {
    const snapshot = (JSON.parse(readFileSync(join(publicFreezesDir(), `${freezeId}.json`), 'utf8')) as { meta?: { snapshot?: string } }).meta?.snapshot;
    return snapshot ? `packages/evals/${snapshot}` : null;
  } catch {
    return null;
  }
}

/** What a surface's prompt rests on beyond its declared sources: the frozen moments, the judge and the model pins. */
export const ATTRIBUTION_EXTRA_PATHS = ['packages/evals/fixtures', 'packages/evals/freezes', 'packages/evals/src/adapters/judge.ts', 'packages/evals/src/models.ts'];

/**
 * The paths a surface declares, on today's registry and on each named
 * commit's (the repo paths quoted in its meta.ts then), plus what every
 * prompt rests on (ATTRIBUTION_EXTRA_PATHS).
 */
export function declaredPaths(surface: string, shas: string[], git: AttributionGit): string[] {
  const dir = `packages/evals/src/surfaces/${surfaceDir(surface)}`;
  const then = shas.flatMap((sha) => [...(git.show(sha, `${dir}/meta.ts`) ?? '').matchAll(/['"`](packages\/[^'"`$]+)['"`]/g)].map((m) => m[1]!));
  return [...new Set([...(surfaceMeta(surface)?.sources ?? []), ...then, dir, DRY_RUN_SCRIPT_REL, ...ATTRIBUTION_EXTRA_PATHS])].sort();
}

/** What codecast knows that the attribution reads: its registry's surfaces, heads.json and the public freezes' snapshots. */
export const codecastAttributionMeta: AttributionMeta = {
  declaredPaths,
  surfaceInfo: (surface) => {
    const meta = surfaceMeta(surface);
    return meta ? { model: meta.model, route: meta.route, sources: meta.sources ?? [] } : null;
  },
  readHeads: () => readHeads(),
  freezeSnapshotPath: publicSnapshotPath,
};

/** Attribution's input with codecast's defaults: the repo's git and the run folders' prompt reader. */
export type AttributionInput = Omit<CoreAttributionInput, 'git' | 'reader'> & Partial<Pick<CoreAttributionInput, 'git' | 'reader'>>;

/**
 * Tier 0 attribution for a regression on one surface, on codecast's verdict.
 * Endpoints left out are found from the records (@platform/evals/analysis attribution.ts).
 * Examples (reply text) are left to flipExamples.
 */
export function attribute(input: AttributionInput): Attribution {
  return attributeWith({ ...input, git: input.git ?? repoGit(), reader: input.reader ?? folderPromptReader() }, codecastAttributionMeta, codecastVerdict);
}
