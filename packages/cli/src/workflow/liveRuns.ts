/**
 * The runs live on this machine, as the daemon and `cast land` both read them:
 * the server's running and paused runs here (a run at a card, or one a restart
 * left without a runner) and every run a live runner here holds. A run waiting
 * at a hold or a card has no process in its tree and can sit idle for days, so
 * only this set tells whether a run tree may go (worktreeGc.ts, land/scan.ts).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { liveRunnerPid, runnerPidFile } from "./runResume.js";

export type LiveRunsOnDevice = { runs?: Array<{ run_id: string; status: string; current_node_id: string | null; updated_at: number; restart_at?: number | null }>; failed?: string[] };

// The server answers at most this many runs of a status (workflow_runs.liveRunsForDevice).
export const LIVE_RUNS_PAGE = 100;

/** The ids of the live runs, or null when the server could not say or its answer may be cut short. */
export function liveRunIdsOf(data: LiveRunsOnDevice | null | undefined): Set<string> | null {
  if (!data?.runs) return null;
  for (const status of ["running", "paused"]) if (data.runs.filter((r) => r.status === status).length >= LIVE_RUNS_PAGE) return null;
  const ids = new Set(data.runs.map((r) => String(r.run_id)));
  try {
    for (const f of fs.readdirSync(path.dirname(runnerPidFile("run")))) {
      const id = f.endsWith(".pid") ? f.slice(0, -4) : null;
      if (id && liveRunnerPid(id)) ids.add(id);
    }
  } catch { /* no runner has run here */ }
  return ids;
}
