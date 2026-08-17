// Workflows and workflow runs — store-fed. Three server windows overlay one
// runs collection (registry: workflowRuns isDelta).
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";

const api = _api as any;

export function useSyncWorkflows(enabled = true) {
  return useSyncCollection("workflows", api.workflows.webList, enabled ? {} : "skip");
}

const newestFirst = (a: any, b: any) => (b.created_at ?? b._creationTime ?? 0) - (a.created_at ?? a._creationTime ?? 0);
const workflowSig = (w: any) => `${w.name}|${w.slug}|${w.goal ?? ""}|${w.updated_at ?? 0}|${w.nodes?.length ?? 0}`;

/** Reader: the viewer's workflows, newest first. */
export function useWorkflows(): { workflows: any[]; ready: boolean } {
  const { ready } = useSyncWorkflows();
  const workflows = useCollectionRows<any>("workflows", { sig: workflowSig, sort: newestFirst });
  return { workflows, ready };
}

/** Feeder: the viewer's dynamic (multi-agent) runs window. */
export function useSyncDynamicRuns(enabled = true) {
  return useSyncCollection("workflowRuns", api.workflow_runs.listDynamicRuns, enabled ? {} : "skip");
}

/** Feeder: one workflow's recent runs. */
export function useSyncWorkflowRuns(workflowId: string | null | undefined) {
  return useSyncCollection(
    "workflowRuns",
    api.workflow_runs.listForWorkflow,
    workflowId ? { workflow_id: workflowId } : "skip",
  );
}

/** Feeder: one run, enriched (node sessions). */
export function useSyncWorkflowRun(runId: string | null | undefined) {
  return useSyncCollection(
    "workflowRuns",
    api.workflow_runs.get,
    runId ? { id: runId } : "skip",
    // A single row → the collection's overlay takes an array.
    { select: (row: any) => (row ? [row] : []) },
  );
}

const runSig = (r: any) =>
  `${r.status}|${r.current_node_id ?? ""}|${r.updated_at ?? 0}|${r.total_tokens ?? 0}|${r.agent_count ?? 0}|${r.gate_prompt ?? ""}|` +
  (r.node_statuses ?? []).map((n: any) => `${n.node_id}:${n.status}:${n.session?._id ?? ""}:${n.session?.is_active ? 1 : 0}`).join(",");
const runNewestFirst = (a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

/** Reader: runs, optionally filtered. */
export function useWorkflowRuns(where?: (r: any) => boolean): any[] {
  return useCollectionRows<any>("workflowRuns", { where, sig: runSig, sort: runNewestFirst });
}

/** Reader: dynamic (multi-agent) runs, newest first. */
export function useDynamicRuns(): { runs: any[]; ready: boolean } {
  const { ready } = useSyncDynamicRuns();
  const where = useMemo(() => (r: any) => r.run_kind === "workflow", []);
  const runs = useWorkflowRuns(where);
  return { runs, ready };
}

/** Reader: one run by id (undefined while cold, null once the server said no). */
export function useWorkflowRun(runId: string | null | undefined): any | null | undefined {
  const { ready } = useSyncWorkflowRun(runId);
  const where = useMemo(() => (runId ? (r: any) => r._id === runId : () => false), [runId]);
  const rows = useWorkflowRuns(where);
  if (!runId) return undefined;
  if (rows[0]) return rows[0];
  return ready ? null : undefined;
}
