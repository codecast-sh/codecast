// The simple lane's store readers and its few writers. Every surface paints
// from the store: the inbox feeders (useSyncCore, mounted by SimpleShell)
// bring the conversations and the decision queue, useTriggers brings the
// routines, useWallet the month's usage. Writes are the store's own actions,
// so each one shows before the server answers.
import { useMemo } from "react";
import type { InboxSession, SessionDecisionItem } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useTriggers } from "../../hooks/useSyncTriggers";
import type { TaskRow } from "../triggerTasks";
import { useInboxStore } from "../../store/inboxStore";
import { inboxFloorFlags } from "../../hooks/useSyncInboxSessions";
import { conversationTitle, countByConversation, isLaneConversation, isLaneRoutine, isOpenApproval, oldestFirst } from "./lane";

const laneWhere = (row: InboxSession) => isLaneConversation(row as any);
// The fields the lane renders, and the live facts conversationState reads
// (lib/liveness). A hosted row's heartbeat beats only while a turn runs, so
// carrying it costs a few wakes per turn and keeps the settle rule fed with
// the row's current facts. Anything else (lease stamps) never wakes it.
const laneSig = (row: InboxSession) => {
  const r = row as any;
  return [
    row.title, row.short_title, row.updated_at, row.last_user_message, row.idle_summary, r.inbox_killed_at,
    row.agent_status, r.agent_status_raw, r.agent_status_updated_at, r.last_heartbeat, r.daemon_alive_until, r.producing_until,
    r.message_count, r.last_role_is_user ? 1 : 0, row.has_pending ? 1 : 0, row.awaiting_input ? 1 : 0, r.auq_open ? 1 : 0,
  ].map((v) => v ?? "").join("|");
};
const newestFirst = (a: InboxSession, b: InboxSession) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

/** The person's conversations with the assistant, newest first. */
export function useLaneConversations(): InboxSession[] {
  return useCollectionRows<InboxSession>("sessions", { where: laneWhere, sig: laneSig, sort: newestFirst });
}

export function useLaneIds(rows: InboxSession[]): Set<string> {
  return useMemo(() => new Set(rows.map((r) => String(r._id))), [rows]);
}

/** Whether the conversation list can be trusted to be complete: the cache
 *  is read back from disk and the inbox's first full read has landed once
 *  (its watermark persists, so a warm reload is ready at once). Until then
 *  an empty list means "not here yet", never "nothing". */
export function useLaneReady(): boolean {
  return useInboxStore((s) => {
    if (!s.clientStateInitialized) return false;
    return inboxFloorFlags(s, s.currentUser?._id?.toString()).floorStamped;
  });
}

/** Each conversation's name by id, for the cards and rows that point at one. */
export function useLaneTitles(rows: InboxSession[]): Map<string, string> {
  return useMemo(() => new Map(rows.map((c) => [String(c._id), conversationTitle(c)])), [rows]);
}

const pendingWhere = (d: SessionDecisionItem) => d.status === "pending";
const decisionSig = (d: SessionDecisionItem) => `${d.status}|${d.question}|${d.context_md ?? ""}|${d.options.map((o) => o.label).join("\u0001")}`;

/** Every open approval on the lane's conversations, oldest first. */
export function useOpenApprovals(laneIds: Set<string>): SessionDecisionItem[] {
  const pending = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: pendingWhere, sig: decisionSig });
  return useMemo(() => oldestFirst(pending.filter((d) => isOpenApproval(d, laneIds))), [pending, laneIds]);
}

export function useApprovalCounts(approvals: SessionDecisionItem[]): Map<string, number> {
  return useMemo(() => countByConversation(approvals), [approvals]);
}

/** The routines bound to the lane's conversations, soonest first. */
export function useLaneRoutines(laneIds: Set<string>): { routines: TaskRow[]; ready: boolean } {
  const { tasks, ready } = useTriggers();
  const routines = useMemo(
    () => (tasks as TaskRow[]).filter((t) => isLaneRoutine(t, laneIds)).sort((a, b) => (a.run_at ?? Infinity) - (b.run_at ?? Infinity)),
    [tasks, laneIds],
  );
  return { routines, ready };
}

/** Everything home and the tab bar need, read once. */
export function useLaneData() {
  const conversations = useLaneConversations();
  const laneIds = useLaneIds(conversations);
  const approvals = useOpenApprovals(laneIds);
  const approvalCounts = useApprovalCounts(approvals);
  const titles = useLaneTitles(conversations);
  const ready = useLaneReady();
  return { conversations, laneIds, approvals, approvalCounts, titles, ready };
}

