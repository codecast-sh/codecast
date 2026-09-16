import type { SessionDecisionItem } from "../store/inboxStore";

// The route of a decision's document page: its short id when it has one.
export function decisionHref(d: Pick<SessionDecisionItem, "_id" | "short_id">): string {
  return `/decisions/${d.short_id ?? d._id}`;
}

// The latest recommendation on the ladder, if any role gave one.
export function ladderRecommendation(d: Pick<SessionDecisionItem, "hops">): number | undefined {
  for (let i = (d.hops?.length ?? 0) - 1; i >= 0; i--) {
    const r = d.hops![i].recommendation;
    if (r !== undefined) return r;
  }
  return undefined;
}

// The run chip on a gate decision (the-line.md L4, L10): the workflow's name
// and the gate node's label from the workflowRuns store row. A row that has
// not synced yet reads as "a workflow run"; the chip still links to the run.
export type GateRunLabel = { workflow: string; node?: string; known: boolean };

export function gateRunLabel(
  run: { workflow_name?: string; current_node_id?: string; current_node_label?: string; node_statuses?: Array<{ node_id: string; label?: string }> } | null | undefined,
  gateNodeId?: string,
): GateRunLabel {
  if (!run) return { workflow: "a workflow run", node: gateNodeId, known: false };
  const nodeId = gateNodeId ?? run.current_node_id;
  const fromStatuses = nodeId ? run.node_statuses?.find((n) => n.node_id === nodeId)?.label : undefined;
  // current_node_label is listRuns's join against the stored graph; the get
  // channel carries only the row, whose node_statuses may label the node.
  const node = (gateNodeId === undefined || gateNodeId === run.current_node_id ? run.current_node_label : undefined) ?? fromStatuses ?? nodeId;
  return { workflow: run.workflow_name ?? "a workflow run", node, known: true };
}

export function runHref(runId: string): string {
  return `/workflows/runs/${runId}`;
}
