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
  return useMissingSessionLookup(id).row;
}

/**
 * The same lookup, with `failed` set when the `null` is a server error rather
 * than an answer: nothing is known about the row then, so a surface that says
 * why it cannot open the session must not claim it was deleted or withheld.
 */
export function useMissingSessionLookup(id: string | null): { row: InboxSession | null | undefined; failed: boolean } {
  const valid = !!id && isConvexId(id);
  const { data, error } = useQueryNoThrow(
    api.conversations.getConversation,
    valid ? { conversation_id: id, limit: 1 } : "skip",
  );
  const row = useMemo(() => {
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
  return { row, failed: valid && !!error };
}
