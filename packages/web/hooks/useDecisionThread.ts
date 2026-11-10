import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import type { DecisionCommentRow } from "../store/decisionThreadTypes";
import { useCollectionRows } from "./useCollectionRows";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useFeederError } from "./useSyncCollection";
import { decisionThreadRowId } from "../lib/decisionThread";

const api = _api as any;

// A decision's team thread: the per-view feeder (decisionThread.thread fans
// out into decisionThreads, decisionComments and the viewer's threadInbox
// row) and the thread read from the store. `enabled: false` mounts nothing,
// for a card nobody opened whose thread holds nothing.

export function useDecisionThreadFeed(decisionId: string, enabled = true): { ready: boolean } {
  const authSettled = useServerAuthSettled();
  const args = enabled && authSettled && isConvexId(decisionId) ? { decision_id: decisionId } : "skip";
  const { data, error } = useQueryNoThrow(api.decisionThread.thread, args);
  useFeederError("decisionThread.thread", error);
  useConvexSync(data, useCallback((d: any) => {
    if (!d) return;
    const { syncTable } = useInboxStore.getState();
    syncTable("decisionThreads", [{ _id: String(d._id), decision_short_id: d.decision_short_id, owner: d.owner }]);
    // The answer is the whole thread: a row it no longer holds was deleted. Stubs wait for their echo.
    syncTable("decisionComments", d.comments ?? [], { pruneAbsentScope: (r: DecisionCommentRow) => r.decision_id === String(d._id) && !r._id.startsWith("dcstub-") });
    if (d.read) syncTable("threadInbox", [d.read]);
  }, []));
  return { ready: data !== undefined };
}

// One `where` per decision, so the slice signature is shared, not rebuilt per render.
const wheres = new Map<string, (row: DecisionCommentRow) => boolean>();
const whereFor = (decisionId: string) => {
  let fn = wheres.get(decisionId);
  if (!fn) wheres.set(decisionId, (fn = (row) => row.decision_id === decisionId));
  return fn;
};
const commentSig = (r: DecisionCommentRow) => `${r.content.length}|${r.updated_at ?? 0}|${r.agent_status ?? ""}|${r.resolved_at ?? 0}|${r.author_name}`;
const byTime = (a: DecisionCommentRow, b: DecisionCommentRow) => a.created_at - b.created_at;

/** The thread's rows, oldest first, from the store. */
export function useDecisionComments(decisionId: string): DecisionCommentRow[] {
  return useCollectionRows<DecisionCommentRow>("decisionComments", { where: whereFor(decisionId), sig: commentSig, sort: byTime });
}

/** The viewer's unread count on a decision's thread (0 when none). */
export function useDecisionThreadUnread(decisionId: string): number {
  return useInboxStore((s) => (s.threadInbox[decisionThreadRowId(decisionId)] as { unread?: number } | undefined)?.unread ?? 0);
}

/** The viewer's read mark on the thread, for the "new" line. */
export function useDecisionThreadReadAt(decisionId: string): number {
  return useInboxStore((s) => (s.threadInbox[decisionThreadRowId(decisionId)] as { last_read_at?: number } | undefined)?.last_read_at ?? 0);
}

export function useDecisionThread(decisionId: string, enabled = true) {
  const { ready } = useDecisionThreadFeed(decisionId, enabled);
  const owner = useInboxStore((s) => s.decisionThreads[decisionId]?.owner ?? null);
  const rows = useDecisionComments(decisionId);
  return { ready, owner, rows };
}
