// The one writer of a painted sessionCommands row (lib/sessionCommands). A new
// request for the same target replaces the last (a conversation, or a machine
// for a switch), and rows age out after a day. A line edit's target is one
// project's keys: an edit replaces a settled one on the same keys, and edits
// still in flight on a project all stand, since each is applied in order.
export function stampSessionCommand(draft: { sessionCommands: Record<string, any> }, row: Record<string, any>) {
  const now = Date.now();
  for (const [id, prev] of Object.entries(draft.sessionCommands)) {
    const stale = now - (prev.executed_at ?? prev.requested_at ?? now) > 86400_000;
    if (stale || sameTarget(prev, row)) delete draft.sessionCommands[id];
  }
  draft.sessionCommands[row._id] = { requested_at: now, executed_at: null, result: null, error: null, ...row };
}

function sameTarget(prev: Record<string, any>, row: Record<string, any>): boolean {
  // A graph step's save replaces a settled save of the same step; saves in flight all stand.
  if (row.kind === "line_graph_edit") {
    return prev.kind === "line_graph_edit" && prev.workflow_id === row.workflow_id && prev.node === row.node && !!prev.executed_at;
  }
  if (row.kind === "line_edit") {
    return prev.kind === "line_edit" && prev.project_id === row.project_id && !!prev.executed_at
      && (prev.keys ?? []).every((k: string) => (row.keys ?? []).includes(k));
  }
  if (row.conversation_id) return prev.conversation_id === row.conversation_id;
  return prev.kind === row.kind && prev.device_id === row.device_id;
}
