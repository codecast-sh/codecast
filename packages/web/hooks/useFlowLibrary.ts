import { useMemo } from "react";
import { usePoolFlowRows } from "./useSyncWorkflows";
import { useWorkspaceRuns } from "./useSyncRuns";
import { useLiveFlow } from "./useLiveFlow";
import { appPool, flowOfRun } from "../lib/line/flowPool";
import { flowLibrary, libraryFlows, type LibraryRow } from "../lib/line/flowLibrary";

/** A run as the Flows views read it. */
export type FlowRun = { _id: string; status: string; run_kind?: string; current_node_id?: string | null; current_node_label?: string | null; fail_reason?: string | null; task_id?: string | null; task_short_id?: string | null; task_title?: string | null; workflow_slug?: string; workflow_name?: string; user_id?: string; primary_conversation_id?: string | null; created_at: number; updated_at: number };

/** The library a workspace reads, its live flow, and its runs by flow. */
export function useFlowLibrary(space: string | null | undefined) {
  const rows = usePoolFlowRows(space) as LibraryRow[];
  const live = useLiveFlow(space);
  const pool = useMemo(() => appPool(rows), [rows]);
  const spine = live ? live.flow : null;
  const lib = useMemo(() => flowLibrary(pool, rows, spine), [pool, rows, spine]);
  const flows = useMemo(() => libraryFlows(lib), [lib]);
  // The workspace's own runs only: built-in flows share a slug in every
  // workspace, so matching by flow alone would list another team's runs.
  const runs = useWorkspaceRuns(space, { all: true }) as unknown as FlowRun[];
  const runsOf = useMemo(() => {
    const m = new Map<string, FlowRun[]>();
    for (const r of runs) {
      const f = flowOfRun(flows, r);
      if (f) m.set(f.slug, [...(m.get(f.slug) ?? []), r]);
    }
    return m;
  }, [runs, flows]);
  return { lib, flows, live, runsOf };
}
