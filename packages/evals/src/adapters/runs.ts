import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunSource, RunSummary } from '@platform/evals';
import { fsRunSource } from '@platform/evals/fs';

import { homePaths } from '../paths';

export interface SurfaceRun extends RunSummary {
  /** The `check` invocation this rep belonged to. */
  batch: string | null;
  /** Agent reads that went to the live workspace (run.json). */
  liveReads: number;
}

/** A listed rep with the replay bookkeeping the platform's summary leaves out: its batch and live reads (run.json). */
function withRunJson(root: string, r: RunSummary): SurfaceRun {
  const path = join(root, r.id, 'run.json');
  let run: { batch?: string; liveReads?: number } = {};
  if (existsSync(path)) {
    try {
      run = JSON.parse(readFileSync(path, 'utf8')) as typeof run;
    } catch {
      run = {};
    }
  }
  return { ...r, batch: run.batch ?? null, liveReads: run.liveReads ?? 0 };
}

/**
 * Every replay rep, one folder each under EVALS_HOME/runs, in the platform's
 * layout. Each listed rep carries its batch, so `runs list --json` can tell
 * one check from another that ran the same day with the same notes.
 */
export const codecastRunSource = (): Omit<RunSource, 'list'> & { list: (...a: Parameters<RunSource['list']>) => Promise<SurfaceRun[]> } => {
  const root = homePaths().runs;
  const base = fsRunSource({ root });
  return { ...base, list: async (filter) => (await base.list(filter)).map((r) => withRunJson(root, r)) };
};

/** A surface's reps, newest first, with the batch each came from and its live reads. */
export async function surfaceRuns(surfaceId: string, opts: { limit?: number; freezeId?: string } = {}): Promise<SurfaceRun[]> {
  const rows = await codecastRunSource().list({ scenario: `${surfaceId}-`, limit: opts.limit ?? 2000, freezeId: opts.freezeId });
  return rows.filter((r) => r.scenario.startsWith(`${surfaceId}-`));
}
