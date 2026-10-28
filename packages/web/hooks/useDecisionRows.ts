// The decision rows the Decisions list arranges, read from the one decision
// collection through a wake signature of the fields the list draws, never the
// whole collection (an answer anywhere would repaint it). `workspace` is the
// active workspace's: what the Team view's feed and the line feed brought for
// it. `mine` adds the viewer's own queue from every workspace, which is what
// Mine and the sidebar's count read, as the queue always has. In hosted mode's
// Assistant scope (lib/assistantScope) only the assistant's asks are listed
// and counted, as the queue's cards are (useScopedDecisionQueue).
import { useMemo } from "react";
import { useInboxStore, type SessionDecisionItem } from "../store/inboxStore";
import { isOpen, ownedBy } from "../lib/decisions/decisionRows";
import { useCollectionRows } from "./useCollectionRows";
import { useActiveWorkspaceKey } from "./useWorkspaceCollection";
import { inViewerQueue } from "../lib/decisionQueue";
import { useAssistantConversationIds, useAssistantScope } from "../lib/surfaces";

/** What a row of the list shows and is arranged by. */
export const decisionRowSig = (d: SessionDecisionItem): string => [
  d.status, d.question, d.short_id, d.blocking ? 1 : 0, d.holder_key, d.passed_to ? `${d.passed_to.kind}:${d.passed_to.id}` : "",
  (d.asked_user_ids ?? []).join(","), d.escalated ? `${d.escalated.at}` : "", d.area_project_id, d.source_flow, d.problem_severity, d.problem_findings, d.problem_reach,
  d.card ? 1 : 0, d.gate_node_id, d.category, d.created_at, d.resolved_at, d.in_queue ? 1 : 0, d.team_workspace, d.line_workspace,
  d.options.map((o) => o.label).join("\u0001"), d.session_title, d.kind,
].join("\u0002");

export const inWorkspaceList = (d: SessionDecisionItem, key: string | null) => !!key && (d.team_workspace === key || d.line_workspace === key);

/** Whether a row is listed at all: no trial ask, and in the Assistant scope when it is on. */
function useListed(): (d: SessionDecisionItem) => boolean {
  const { only } = useAssistantScope();
  const assistant = useAssistantConversationIds();
  return useMemo(() => (d: SessionDecisionItem) => !d.trial && (!only || assistant.has(String(d.conversation_id))), [only, assistant]);
}

export function useDecisionRows(): { workspace: SessionDecisionItem[]; mine: SessionDecisionItem[]; workspaceKey: string | null } {
  const key = useActiveWorkspaceKey();
  const listed = useListed();
  const where = useMemo(() => (d: SessionDecisionItem) => listed(d) && (inWorkspaceList(d, key) || inViewerQueue(d)), [key, listed]);
  const rows = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig: decisionRowSig });
  return useMemo(() => ({ workspace: rows.filter((d) => inWorkspaceList(d, key)), mine: rows, workspaceKey: key }), [rows, key]);
}

const ownedSig = (d: SessionDecisionItem) => `${d.status}|${d.passed_to?.id ?? ""}|${d.holder_key ?? ""}|${(d.asked_user_ids ?? []).join(",")}|${d.user_id ?? ""}`;

/** How many open decisions the viewer owns: the Decisions row's count, Mine's. */
export function useOwnedDecisionCount(): number {
  const me = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const key = useActiveWorkspaceKey();
  const listed = useListed();
  // The rows Mine lists (useDecisionRows), so the count and the tab agree.
  const where = useMemo(() => (d: SessionDecisionItem) => listed(d) && isOpen(d) && ownedBy(d, me) && (inWorkspaceList(d, key) || inViewerQueue(d)), [me, key, listed]);
  return useCollectionRows<SessionDecisionItem>("sessionDecisions", { where, sig: ownedSig }).length;
}
