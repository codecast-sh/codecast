// One CI run of a check issue as GitHub tells it: the store's row (fed by
// ciRuns.get), and a read from GitHub (ciRuns.read) the first time the page
// shows a run the server has not read, or one whose last read came back
// short and is worth trying again. The read lands in the same row, which the
// feeder brings back.
import { useState } from "react";
import { useAction } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useOpsCiRun, useSyncOpsCiRun } from "../../hooks/useSyncOps";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import type { OpsCiRun } from "./opsTypes";

const api = _api as any;

/** A short read is asked again after this, as the server's own retry window. */
const RETRY_SHORT_MS = 10 * 60_000;
/** Runs this tab already asked GitHub for, so remounts and other cards do not ask twice. */
const asked = new Set<string>();

export type CiRunState = { run: OpsCiRun | undefined; reading: boolean; failed: string | null };

export function useCiRun(groupRef: string, runId: string | null): CiRunState {
  const feed = useSyncOpsCiRun(groupRef, runId);
  const run = useOpsCiRun(runId);
  const read = useAction(api.ciRuns.read);
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const stale = !!run && (!!run.error || (!run.log_tail && !run.log_error && run.jobs.some((j) => j.conclusion === "failure"))) && Date.now() - run.fetched_at > RETRY_SHORT_MS;
  useWatchEffect(() => {
    if (!runId || !feed.ready || (run && !stale)) return;
    const key = `${groupRef}:${runId}`;
    if (asked.has(key)) return;
    asked.add(key);
    setReading(true);
    setFailed(null);
    read({ group: groupRef, run_id: runId }).then(
      (out: { ok: boolean; error?: string }) => {
        setReading(false);
        if (!out.ok) setFailed(out.error ?? "GitHub did not answer");
      },
      () => {
        setReading(false);
        setFailed("GitHub did not answer");
        asked.delete(key);
      },
    );
  }, [groupRef, runId, feed.ready, !!run, stale]);
  // Until the store's feeder answers, the run is still being read: never "not read" before anything was asked.
  return { run, reading: !run && (reading || (!!runId && !feed.ready)), failed: run ? null : failed };
}
