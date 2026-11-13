// Whether a runner ever took a workflow run past its start, read from the
// stations it reported on. A runner continues a live run it took that far,
// where it stands, and starts only a pending run afresh (cast workflow
// run-daemon). So a run no runner ever took past its start has nothing to
// continue: a resume puts it back to pending (workflow_runs.resumeRunAt).
// Marked running, every runner reads it as a run another runner drives and
// refuses it, and it stays running with nothing driving it.

export type RunStart = {
  current_node_id?: string | null;
  node_statuses?: ReadonlyArray<{ node_id: string; status: string }>;
};

export const tookPastStart = (run: RunStart): boolean =>
  !!run.current_node_id && (run.node_statuses ?? []).some((n) => n.node_id !== run.current_node_id || n.status !== "pending");
