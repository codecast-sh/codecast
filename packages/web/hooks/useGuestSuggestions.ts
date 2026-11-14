// Suggestions for one session (convex guestSuggestions.ts, teamSuggestions.ts),
// store-fed, per conversation: the owner's waiting cards, and a teammate's own
// with what became of each.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { isConvexId } from "../lib/entityLinks";

const api = _api as any;

const sig = (r: any) => `${r.status}|${r.body}|${r.guest_name}|${r.kind ?? ""}|${r.decision ?? ""}`;
const byCreatedAsc = (a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0);

/** Feeder + reader: one conversation's waiting suggestions, oldest first. Each
 *  push is the COMPLETE waiting set, so a decided suggestion leaves the store.
 *  Answer and permission proposals ride along; their own cards read them. */
export function useGuestSuggestions(conversationId: string, enabled = true, meId: string | null = null): any[] {
  useSyncPendingSuggestions(conversationId, enabled, meId);
  return useSessionSuggestions(conversationId, null);
}

/** Feeder only: the owner's waiting suggestions for one session. */
export function useSyncPendingSuggestions(conversationId: string, enabled = true, meId: string | null = null): void {
  const live = enabled && isConvexId(conversationId);
  // My own rows are listMine's to prune (an assigned owner mounts both feeds).
  const syncOpts = useMemo(
    () => ({ pruneAbsentScope: (row: any) => row?.conversation_id === conversationId && (!meId || String(row?.author_user_id) !== meId) }),
    [conversationId, meId],
  );
  useSyncCollection("guestSuggestions", api.guestSuggestions.listPending, live ? { conversation_id: conversationId } : "skip", { syncOpts });
}

/** Feeder for a teammate's own suggestions in one session (teamSuggestions.listMine). */
export function useSyncMyTeamSuggestions(conversationId: string, meId: string | null, enabled = true): void {
  const live = enabled && !!meId && isConvexId(conversationId);
  const syncOpts = useMemo(
    () => ({ pruneAbsentScope: (row: any) => row?.conversation_id === conversationId && String(row?.author_user_id) === meId }),
    [conversationId, meId],
  );
  useSyncCollection("guestSuggestions", api.teamSuggestions.listMine, live ? { conversation_id: conversationId } : "skip", { syncOpts });
}

/** Reader: one session's suggestions, oldest first. `authorId` narrows to one
 *  author's rows in any state; null reads every waiting row. */
export function useSessionSuggestions(conversationId: string, authorId: string | null): any[] {
  const where = useMemo(
    () => authorId
      ? (r: any) => r.conversation_id === conversationId && String(r.author_user_id) === authorId
      : (r: any) => r.conversation_id === conversationId && r.status === "pending",
    [conversationId, authorId],
  );
  return useCollectionRows<any>("guestSuggestions", { where, sig, sort: byCreatedAsc });
}
