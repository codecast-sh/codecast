// The decision rows the Decisions list arranges, read from the one decision
// collection through a wake signature of the fields the list draws, never the
// whole collection (an answer anywhere would repaint it). `workspace` is the
// active workspace's: what the Team view's feed and the line feed brought for
// it. `mine` adds the viewer's own queue from every workspace, which is what
// Mine reads.
import { useMemo } from "react";
import type { SessionDecisionItem } from "../store/inboxStore";
import { useCollectionRows } from "./useCollectionRows";
import { useActiveWorkspaceKey } from "./useWorkspaceCollection";
import { inViewerQueue } from "../lib/decisionQueue";

/** What a row of the list shows and is arranged by. */
export const decisionRowSig = (d: SessionDecisionItem): string => [
  d.status, d.question, d.short_id, d.blocking ? 1 : 0, d.holder_key, d.passed_to ? `${d.passed_to.kind}:${d.passed_to.id}` : "",
  (d.asked_user_ids ?? []).join(","), d.escalated ? `${d.escalated.at}` : "", d.area_project_id, d.source_flow, d.problem_severity, d.problem_findings, d.problem_reach,
  d.card ? 1 : 0, d.gate_node_id, d.category, d.created_at, d.resolved_at, d.in_queue ? 1 : 0, d.team_workspace, d.line_workspace,
  d.options.map((o) => o.label).join("\u0001"), d.session_title, d.kind,
].join("\u0002");

export const inWorkspaceList = (d: SessionDecisionItem, key: string | null) => !!key && (d.team_workspace === key || d.line_workspace === key);

/** Whether a row is listed at all: no trial ask. */
const listed = (d: SessionDecisionItem) => !d.trial;

export function useDecisionRows(): { workspace: SessionDecisionItem[]; mine: SessionDecisionItem[]; workspaceKey: string | null } {
  const key = useActiveWorkspaceKey();
  const where = useMemo(() => (d: SessionDecisionItem) => listed(d) && (inWorkspaceList(d, key) || inViewerQueue(d)), [key]);
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig: decisionRowSig });
  return useMemo(() => ({ workspace: rows.filter((d) => inWorkspaceList(d, key)), mine: rows, workspaceKey: key }), [rows, key]);
}
