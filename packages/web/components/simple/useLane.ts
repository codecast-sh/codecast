// The simple lane's store readers and its few writers. Every surface paints
// from the store: the inbox feeders (useSyncCore, mounted by SimpleShell)
// bring the conversations and the decision queue, useTriggers brings the
// routines, useWallet the month's usage. Writes are the store's own actions,
// so each one shows before the server answers.
import { useCallback, useMemo } from "react";
import type { InboxSession, SessionDecisionItem } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useTriggers } from "../../hooks/useSyncTriggers";
import type { TaskRow } from "../triggerTasks";
import { isConvexId, useInboxStore } from "../../store/inboxStore";
import { inboxFloorFlags } from "../../hooks/useSyncInboxSessions";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRetryHostedStart } from "../../lib/startHostedConversation";
import {
  buildTranscript, conversationState, conversationTitle, countByConversation, isLaneConversation, isLaneRoutine, isOpenApproval, isUnsent, oldestFirst,
  type ConversationState, type LaneMessage, type TranscriptItem,
} from "./lane";

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


/** One conversation as the lane's conversation screen reads it, on the web
 *  and the phone alike: its live id (a stub's real id once the server has
 *  it), the approvals it waits on, where it stands, its transcript, and the
 *  two writes (send and retry). `onRealId` runs when a stub's real id
 *  arrives, so the screen's address can follow it. Scrolling and the views
 *  are each platform's own. */
export function useLaneConversation(id: string, onRealId: (liveId: string) => void) {
  const liveId = useInboxStore((s) => s.resolveLiveSessionId(id));
  // The row's live state only, never the whole row: its other fields churn.
  // The clock re-asks it, because a stalled turn settles with time alone.
  const now = useCoarseNow(15_000);
  const rowState = useInboxStore((s) => {
    const row = s.sessions[liveId];
    return row ? conversationState(row, 0, now) : null;
  });
  const { conversation, hasMoreAbove, isLoadingOlder, loadOlder } = useConversationMessages(id);
  const retryStart = useRetryHostedStart();

  useWatchEffect(() => {
    if (liveId !== id && isConvexId(liveId)) onRealId(liveId);
  }, [liveId, id]);

  const ids = useMemo(() => new Set([String(liveId)]), [liveId]);
  const approvals = useOpenApprovals(ids);
  const state: ConversationState = approvals.length > 0 ? "waiting" : rowState ?? "done";
  const messages = (conversation?.messages ?? []) as LaneMessage[];
  const unsent = messages.some(isUnsent);
  const working = state === "working" || (unsent && approvals.length === 0);
  const items = useMemo(() => buildTranscript(messages, working), [messages, working]);
  // Nothing to show yet, and something is on its way: no row and no page,
  // or a row that has messages the page has not read back.
  const loading = items.length === 0 && (!conversation || (conversation.message_count ?? 0) > 0);

  const send = useCallback((text: string) => {
    const s = useInboxStore.getState();
    const clientId = s.addOptimisticMessage(liveId, text);
    s.sendMessageWhenReady(liveId, text, undefined, clientId);
  }, [liveId]);

  const retry = useCallback((item: Extract<TranscriptItem, { kind: "you" }>) => {
    if (isConvexId(liveId)) void useInboxStore.getState().retryPendingMessage(liveId, { clientId: item.id }).catch(() => {});
    else retryStart(liveId, item.id, item.text);
  }, [liveId, retryStart]);

  return { liveId, approvals, state, working, loading, items, hasMoreAbove, isLoadingOlder, loadOlder, send, retry };
}
