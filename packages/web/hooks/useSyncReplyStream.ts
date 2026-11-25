// The feeder for the reply being written in one conversation (replyStreams.get)
// into the store's replyStreams collection: one row per conversation, keyed by
// the row's own conversation id, stamped with when THIS browser received it
// (replyStreamReceivedAt). Staleness is judged by that stamp, never by
// comparing the daemon's clock with ours.
//
// Bespoke rather than useSyncCollection: a coalesced apply runs after the view
// may have moved to another conversation, with that conversation's callback.
// So every answer is tagged, when it arrives, with the conversation it answers,
// and the apply reads only the tag: an answer for A writes or drops A's row,
// never B's.
import { useMemo } from "react";
import { getFunctionName } from "convex/server";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import type { ReplyStreamRow } from "@codecast/shared/contracts";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { replyStreamReceivedAt } from "../lib/replyStreamHandoff";
import { useConvexSync } from "./useConvexSync";
import { useFeederError } from "./useSyncCollection";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";

// Pushes come a line at a time; a short window folds a burst into one apply,
// and while the person types the apply waits for a pause (useConvexSync).
const COALESCE_MS = 100;

type TaggedAnswer = { conversationId: string; row: ReplyStreamRow | null };

/** Apply one answer to the store. A row that names another conversation than
 *  the one asked about is ignored. */
export function applyReplyStreamAnswer({ conversationId, row }: TaggedAnswer, now: number = Date.now()): void {
  const store = useInboxStore.getState();
  if (!row) {
    if (store.replyStreams[conversationId]) store.dropRows("replyStreams", [conversationId]);
    return;
  }
  if (row.conversation_id !== conversationId) return;
  const held = store.replyStreams[conversationId];
  store.syncTable("replyStreams", [{ ...row, _id: conversationId, received_at: replyStreamReceivedAt(held, row, now) }]);
}

export function useSyncReplyStream(conversationId: string, on: boolean): void {
  // Held at "skip" until the server has confirmed the caller (useSyncCollection).
  const authSettled = useServerAuthSettled();
  const args = on && authSettled && isConvexId(conversationId) ? { conversation_id: conversationId as Id<"conversations"> } : "skip";
  const { data, error } = useQueryNoThrow(api.replyStreams.get, args);
  useFeederError(getFunctionName(api.replyStreams.get), error);
  // `data` is always the answer for the args of this render, so the tag is
  // taken here, never at apply time.
  const tagged = useMemo<TaggedAnswer | undefined>(
    () => (data === undefined ? undefined : { conversationId, row: data }),
    [data, conversationId],
  );
  useConvexSync(tagged, applyReplyStreamAnswer, { coalesceMs: COALESCE_MS });
}
