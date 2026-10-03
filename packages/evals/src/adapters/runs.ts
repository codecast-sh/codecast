import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { RunSource, RunSummary } from '@platform/evals';
import { fsRunSource } from '@platform/evals/fs';

import { homePaths } from '../paths';
import { judgeRuler } from './judge';

export interface SurfaceRun extends RunSummary {
  /** The `check` invocation this rep belonged to. */
  batch: string | null;
  /** The standing run it belonged to (check --cadence), or null. */
  cadence: string | null;
  /** Agent reads that went to the live workspace (run.json). */
  liveReads: number;
}

/** A listed rep with the replay bookkeeping the platform's summary leaves out: its batch, cadence and live reads (run.json). */
function withRunJson(root: string, r: RunSummary): SurfaceRun {
  const path = join(root, r.id, 'run.json');
  let run: { batch?: string; cadence?: string | null; liveReads?: number } = {};
  if (existsSync(path)) {
    try {
      run = JSON.parse(readFileSync(path, 'utf8')) as typeof run;
    } catch {
      run = {};
    }
  }
  return { ...r, batch: run.batch ?? null, cadence: run.cadence ?? null, liveReads: run.liveReads ?? 0 };
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

const rulers = new Map<string, { mtimeMs: number; ruler: string | null }>();

/**
 * The ruler a rep was judged on (judgeRuler), read from the judge prompt in
 * its folder, so a rejudge that replaces the prompt moves the rep to the new
 * ruler with nothing else to keep in step. Null for a rep no judge graded.
 */
export function rulerOf(r: Pick<SurfaceRun, 'id'>): string | null {
  const path = join(homePaths().runs, r.id, 'judge', 'prompt.md');
  if (!existsSync(path)) return null;
  const mtimeMs = statSync(path).mtimeMs;
  const hit = rulers.get(path);
  if (hit?.mtimeMs === mtimeMs) return hit.ruler;
  const ruler = judgeRuler(readFileSync(path, 'utf8'));
  rulers.set(path, { mtimeMs, ruler });
  return ruler;
}
