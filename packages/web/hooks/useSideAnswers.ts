// A conversation's side answers (`/btw`, the Ask panel): the per-view feeder
// (sideAnswers.listForConversation into the sideAnswers collection) and the
// rows read from the store. Before the backend has the query, the feeder's
// error is swallowed by useQueryNoThrow and the panel shows what the store
// holds, the viewer's own pending rows included.
import { useCallback } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { SideAnswerRow } from "@codecast/shared/contracts";
import { useInboxStore, isConvexId } from "../store/inboxStore";
import { isSideAnswerStub } from "../store/sideAnswerTypes";
import { useCollectionRows } from "./useCollectionRows";
import { useConvexSync } from "./useConvexSync";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useFeederError } from "./useSyncCollection";

const api = _api as any;

export function useSideAnswersFeed(conversationId: string): void {
  const authSettled = useServerAuthSettled();
  const args = authSettled && isConvexId(conversationId) ? { conversation_id: conversationId } : "skip";
  const { data, error } = useQueryNoThrow(api.sideAnswers.listForConversation, args);
  useFeederError("sideAnswers.listForConversation", error);
  useConvexSync(data, useCallback((rows: SideAnswerRow[] | undefined) => {
    if (!rows) return;
    // The answer is the viewer's whole list for this conversation: a row it no
    // longer holds is gone (the newest are kept). Stubs wait for their echo.
    useInboxStore.getState().syncTable("sideAnswers", rows, {
      pruneAbsentScope: (r: SideAnswerRow) => r.conversation_id === conversationId && !isSideAnswerStub(r),
    });
  }, [conversationId]));
}

// One `where` per conversation, so the slice signature is shared, not rebuilt per render.
const wheres = new Map<string, (row: SideAnswerRow) => boolean>();
const whereFor = (conversationId: string) => {
  let fn = wheres.get(conversationId);
  if (!fn) wheres.set(conversationId, (fn = (row) => row.conversation_id === conversationId));
  return fn;
};
const rowSig = (r: SideAnswerRow) => `${r.status}|${r.answer?.length ?? 0}|${r.error_code ?? ""}|${r.answered_at ?? 0}`;
const byTime = (a: SideAnswerRow, b: SideAnswerRow) => a.created_at - b.created_at;

/** The viewer's side answers on a conversation, oldest first, from the store. */
export function useSideAnswers(conversationId: string): SideAnswerRow[] {
  useSideAnswersFeed(conversationId);
  return useCollectionRows<SideAnswerRow>("sideAnswers", { where: whereFor(conversationId), sig: rowSig, sort: byTime });
}
