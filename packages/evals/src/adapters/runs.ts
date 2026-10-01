import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunSource, RunSummary } from '@platform/evals';
import { fsRunSource } from '@platform/evals/fs';

import { homePaths } from '../paths';

/** Every replay rep, one folder each under EVALS_HOME/runs, in the platform's layout. */
export const codecastRunSource = (): RunSource => fsRunSource({ root: homePaths().runs });

export interface SurfaceRun extends RunSummary {
  /** The `check` invocation this rep belonged to. */
  batch: string | null;
}

/** A surface's reps, newest first, with the batch each came from (run.json). */
export async function surfaceRuns(surfaceId: string, opts: { limit?: number; freezeId?: string } = {}): Promise<SurfaceRun[]> {
  const rows = await codecastRunSource().list({ scenario: `${surfaceId}-`, limit: opts.limit ?? 2000, freezeId: opts.freezeId });
  return rows
    .filter((r) => r.scenario.startsWith(`${surfaceId}-`))
    .map((r) => {
      const path = join(homePaths().runs, r.id, 'run.json');
      let batch: string | null = null;
      if (existsSync(path)) {
        try {
          batch = (JSON.parse(readFileSync(path, 'utf8')) as { batch?: string }).batch ?? null;
        } catch {
          batch = null;
        }
      }
      return { ...r, batch };
    });
}
