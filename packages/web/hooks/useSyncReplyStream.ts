// The feeder for the reply being written in one conversation (replyStreams.get)
// into the store's replyStreams collection: at most one row, keyed by the
// conversation id, stamped with when THIS browser received it. Staleness is
// judged by that stamp, never by comparing the daemon's clock with ours.
import { useCallback } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { ReplyStreamRow } from "@codecast/shared/contracts";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isConvexId } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";

// Pushes come a line at a time; a short window folds a burst into one apply,
// and while the person types the apply waits for a pause (useConvexSync).
const COALESCE_MS = 100;

export function useSyncReplyStream(conversationId: string, on: boolean): void {
  const select = useCallback(
    (row: ReplyStreamRow | null) => (row ? [{ ...row, _id: conversationId, received_at: Date.now() }] : []),
    [conversationId],
  );
  // A null answer (no reply being written, or not readable) drops the row.
  const dropAbsent = useCallback((row: { _id: string }) => row._id === conversationId, [conversationId]);
  useSyncCollection(
    "replyStreams",
    api.replyStreams.get,
    on && isConvexId(conversationId) ? { conversation_id: conversationId as Id<"conversations"> } : "skip",
    { select, dropAbsent, coalesceMs: COALESCE_MS },
  );
}
