// Why a run failed, in the words the run row and the task carry.
import type { WorkflowGraph } from "./types";

/**
 * A dead end names the task fields its node's edges route on, as they read:
 * an implement that ended without a handoff says so, not a review_verdict no
 * edge of its own asks about.
 */
export function deadEndReason(graph: WorkflowGraph, nodeId: string, outcome: string, context: Record<string, string>): string {
  const routedOn = ["handoff", "review_verdict"].filter((k) =>
    k in context && graph.edges.some((e) => e.from === nodeId && new RegExp(`\\b${k}\\b`).test(e.condition ?? "")));
  return `no outgoing edge from ${nodeId} (outcome ${outcome}${routedOn.map((k) => `, ${k} ${context[k]}`).join("")})`;
}

/**
 * A run the daemon handed a runner that cannot read the line profile fails
 * with the profile's words. Left unreported it stayed taken until the server's
 * sweep called it unclaimed (a profile key newer than the machine's cast,
 * Union 2026-10-15).
 */
export function profileFailure(startNodeId: string, message: string) {
  return {
    current_node_id: startNodeId,
    node_id: startNodeId,
    node_status: "failed" as const,
    run_status: "failed" as const,
    fail_reason: `the line profile could not be read on this machine: ${message}`,
  };
}
