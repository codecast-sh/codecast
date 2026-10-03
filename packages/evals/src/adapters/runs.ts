import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { RunRow } from '@codecast/shared/contracts/evalsApi';
import type { RunSource, RunSummary } from '@platform/evals';
import { fsRunSource, parseRunId } from '@platform/evals/fs';

import { indexedRuns, rulerAt } from '../history/runIndex';
import { homePaths } from '../paths';

/** What a rep ran on, carried from the index (run.json): what attribution and the footing compare. */
export type RunProvenance = Pick<RunRow, 'gitHead' | 'dirty' | 'sourceHash' | 'sourceHashDisk' | 'promptSha' | 'freezeSha' | 'judgeModel' | 'visibility'>;

export interface SurfaceRun extends RunSummary, Partial<RunProvenance> {
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

/**
 * An indexed rep in the platform's summary shape. `costUsd` is the model's
 * spend plus the judge's, as the platform's summary counts it. The index
 * keeps no sends count or notes: read the run (codecastRunSource().get) for
 * those.
 */
export function surfaceRunOf(row: RunRow): SurfaceRun {
  return {
    id: row.id,
    scenario: parseRunId(row.id)?.scenario ?? `${row.surface}-${row.freezeId.slice(0, 8)}`,
    title: row.freezeName,
    seed: row.seed,
    startedAt: row.stamp,
    createdAt: row.stamp,
    status: row.status,
    score: row.score,
    gatesFailed: row.gatesFailed,
    missedFloors: row.missedFloors,
    sends: 0,
    costUsd: row.costUsd + row.judgeCostUsd,
    realMs: row.realMs,
    virtualMs: 0,
    freezeId: row.freezeId,
    model: row.model,
    batch: row.batch,
    cadence: row.cadence,
    liveReads: row.liveReads,
    gitHead: row.gitHead,
    dirty: row.dirty,
    sourceHash: row.sourceHash,
    sourceHashDisk: row.sourceHashDisk,
    promptSha: row.promptSha,
    freezeSha: row.freezeSha,
    judgeModel: row.judgeModel,
    visibility: row.visibility,
  };
}

/**
 * A surface's reps, newest first, read through the run index (only this
 * surface's folders are checked against it), with the batch each came from,
 * its live reads and what it ran on. Every rep, unless `limit` says otherwise.
 */
export async function surfaceRuns(surfaceId: string, opts: { limit?: number; freezeId?: string } = {}): Promise<SurfaceRun[]> {
  const rows = (await indexedRuns({ surface: surfaceId })).filter((r) => !opts.freezeId || r.freezeId === opts.freezeId || r.freezeId.startsWith(opts.freezeId));
  return (opts.limit ? rows.slice(0, opts.limit) : rows).map(surfaceRunOf);
}

/**
 * The ruler a rep was judged on (judgeRuler), read from the judge prompt in
 * its folder, so a rejudge that replaces the prompt moves the rep to the new
 * ruler with nothing else to keep in step. Null for a rep no judge graded.
 */
export const rulerOf = (r: Pick<SurfaceRun, 'id'>): string | null => rulerAt(join(homePaths().runs, r.id));
