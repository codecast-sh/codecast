// Store readers for the conversations a person has with the hosted
// assistant: the rows, their names, the approvals they wait on, and whether
// one is working. Every surface paints from the store: the inbox feeders
// (useSyncCore) bring the conversations and the decision queue.
import { useMemo } from "react";
import type { InboxSession, SessionDecisionItem } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useInboxStore } from "../../store/inboxStore";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { conversationState, conversationTitle, isLaneConversation, isOpenApproval, oldestFirst } from "./lane";

const laneWhere = (row: InboxSession) => isLaneConversation(row as any);
// The fields these readers render. Anything else (heartbeats, lease stamps)
// never wakes them.
const laneSig = (row: InboxSession) => [row.title, row.short_title, row.updated_at, row.last_user_message, (row as any).inbox_killed_at].map((v) => v ?? "").join("|");
const newestFirst = (a: InboxSession, b: InboxSession) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

/** The person's conversations with the assistant, newest first. */
export function useLaneConversations(): InboxSession[] {
  return useCollectionRows<InboxSession>("sessions", { where: laneWhere, sig: laneSig, sort: newestFirst });
}

/** Each conversation's name by id, for the rows that point at one. */
export function useLaneTitles(rows: InboxSession[]): Map<string, string> {
  return useMemo(() => new Map(rows.map((c) => [String(c._id), conversationTitle(c)])), [rows]);
}

const pendingWhere = (d: SessionDecisionItem) => d.status === "pending";
const decisionSig = (d: SessionDecisionItem) => `${d.status}|${d.question}|${d.context_md ?? ""}|${d.options.map((o) => o.label).join("\u0001")}`;

/** Every open approval on these conversations, oldest first. */
export function useOpenApprovals(conversationIds: Set<string>): SessionDecisionItem[] {
  const pending = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: pendingWhere, sig: decisionSig });
  return useMemo(() => oldestFirst(pending.filter((d) => isOpenApproval(d, conversationIds))), [pending, conversationIds]);
}

/** The approvals one conversation waits on, oldest first. */
export function useConversationApprovals(conversationId: string): SessionDecisionItem[] {
  const ids = useMemo(() => new Set([conversationId]), [conversationId]);
  return useOpenApprovals(ids);
}

/** Whether a conversation's turn is running (conversationState), read as one
 *  boolean so a heartbeat on its row wakes nobody. The clock re-asks it,
 *  because a stalled turn settles with time alone. */
export function useConversationWorking(conversationId: string): boolean {
  const now = useCoarseNow(15_000);
  return useInboxStore((s) => {
    const row = s.sessions[conversationId];
    return !!row && conversationState(row, 0, now) === "working";
  });
}
