// The simple lane's store readers and its few writers. Every surface paints
// from the store: the inbox feeders (useSyncCore, mounted by SimpleShell)
// bring the conversations and the decision queue, useTriggers brings the
// routines, useWallet the month's usage. Writes are the store's own actions,
// so each one shows before the server answers.
import { useCallback, useMemo } from "react";
import { useNavigate } from "react-router";
import { useInboxStore, type InboxSession, type SessionDecisionItem } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useTriggers } from "../../hooks/useSyncTriggers";
import type { TaskRow } from "../triggerTasks";
import { LANE_PATHS, countByConversation, isLaneConversation, isLaneRoutine, oldestFirst, type Lane } from "./lane";

const laneWhere = (row: InboxSession) => isLaneConversation(row as any);
// The fields the lane renders. Anything else on the row (heartbeats, lease
// stamps) never wakes it.
const laneSig = (row: InboxSession) =>
  `${row.title ?? ""}|${row.short_title ?? ""}|${row.updated_at}|${row.agent_status ?? ""}|${row.has_pending ? 1 : 0}|${row.awaiting_input ? 1 : 0}|${row.last_user_message ?? ""}|${row.idle_summary ?? ""}|${(row as any).inbox_killed_at ?? ""}`;
const newestFirst = (a: InboxSession, b: InboxSession) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

/** The person's conversations with the assistant, newest first. */
export function useLaneConversations(): InboxSession[] {
  return useCollectionRows<InboxSession>("sessions", { where: laneWhere, sig: laneSig, sort: newestFirst });
}

export function useLaneIds(rows: InboxSession[]): Set<string> {
  return useMemo(() => new Set(rows.map((r) => String(r._id))), [rows]);
}

const pendingWhere = (d: SessionDecisionItem) => d.status === "pending";
const decisionSig = (d: SessionDecisionItem) => `${d.status}|${d.question}|${d.context_md ?? ""}|${d.options.map((o) => o.label).join("\u0001")}`;

/** Every open approval on the lane's conversations, oldest first. */
export function useOpenApprovals(laneIds: Set<string>): SessionDecisionItem[] {
  const pending = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: pendingWhere, sig: decisionSig });
  return useMemo(() => oldestFirst(pending.filter((d) => laneIds.has(String(d.conversation_id)))), [pending, laneIds]);
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
  return { conversations, laneIds, approvals, approvalCounts };
}

/** Moves the person between the lane and the full app: the preference is
 *  written first (it follows them to every device), then the view moves. */
export function useSetLane(): (lane: Lane) => void {
  const navigate = useNavigate();
  return useCallback(
    (lane: Lane) => {
      useInboxStore.getState().updateClientUI({ lane });
      navigate(lane === "simple" ? LANE_PATHS.home : "/inbox");
    },
    [navigate],
  );
}
