// A workflow run's log: the primary conversation a run created for itself
// (session `wf-<runId>`, workflow_runs.ts), written by the runner and never by
// an agent. Its stations nest under it as workers, so it looks like their
// parent. A real session that hosted a run is stamped is_workflow_primary
// too, and its agent reads and is revived like any other session's
// (web RunLogEndedBar.isEndedRunLog draws the same line).
export function isWorkflowRunLog(conv: { is_workflow_primary?: boolean; session_id?: string | null }): boolean {
  return conv.is_workflow_primary === true && !!conv.session_id?.startsWith("wf-");
}
