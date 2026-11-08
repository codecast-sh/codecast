// A conversation's side answers (`/btw`, the Ask panel): the per-view feeder
// (sideAnswers.listForConversation into the sideAnswers collection) and the
// rows read from the store. Before the backend has the query, the feeder's
// error stays inside useSyncCollection (useQueryNoThrow) and the panel shows
// what the store holds, the viewer's own pending rows included.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { SideAnswerRow } from "@codecast/shared/contracts";
import { isConvexId } from "../store/inboxStore";
import { isSideAnswerStub } from "../store/sideAnswerTypes";
import { SIDE_ANSWER_STALL_MS } from "../lib/sideAnswers";
import { useCollectionRows } from "./useCollectionRows";
import { useSyncCollection } from "./useSyncCollection";

const api = _api as any;

export function useSideAnswersFeed(conversationId: string): void {
  // The answer is the viewer's whole list for this conversation: a row it no
  // longer holds is gone (only the newest are kept). Stubs wait for their echo.
  const opts = useMemo(() => ({
    // A stub its server row never superseded (the send never landed) goes once it is past the answer bound.
    syncOpts: { pruneAbsentScope: (r: SideAnswerRow) => r.conversation_id === conversationId && (!isSideAnswerStub(r) || Date.now() - r.created_at > SIDE_ANSWER_STALL_MS) },
  }), [conversationId]);
  useSyncCollection("sideAnswers", api.sideAnswers.listForConversation, isConvexId(conversationId) ? { conversation_id: conversationId } : "skip", opts);
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
