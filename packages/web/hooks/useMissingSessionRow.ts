import { useMemo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { isConvexId, sessionRowFromSummary, type InboxSession } from "../store/inboxStore";

/**
 * A session the store does not hold (a teammate's, or one outside the inbox
 * window), fetched as an inbox row for the caller to put in the store.
 * `undefined` while loading or with no id; `null` when the server will not
 * hand it over (deleted, private to someone else, not a conversation id).
 *
 * No-throw: the id often comes straight from a URL or a deep link, so a
 * server rejection must degrade to "unavailable", not crash the surface.
 */
export function useMissingSessionRow(id: string | null): InboxSession | null | undefined {
  const valid = !!id && isConvexId(id);
  const { data, error } = useQueryNoThrow(
    api.conversations.getConversation,
    valid ? { conversation_id: id, limit: 1 } : "skip",
  );
  return useMemo(() => {
    if (!id) return undefined;
    if (!valid) return null;
    if (data === undefined && !error) return undefined;
    if (data == null) return null;
    // sessionRowFromSummary carries the triage stamps through, so a stashed or
    // dismissed target seeds hidden instead of flashing in as an active card.
    return sessionRowFromSummary({
      ...data,
      _id: id,
      // Carry the author so a teammate's session shows whose it is.
      author_name: data.user?.name ?? null,
    });
  }, [id, valid, data, error]);
}
