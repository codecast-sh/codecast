// Messages guests suggested for one of the owner's shared sessions
// (convex guestSuggestions.ts) — store-fed, per conversation.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { isConvexId } from "../lib/entityLinks";

const api = _api as any;

const sig = (r: any) => `${r.status}|${r.body}|${r.guest_name}`;
const byCreatedAsc = (a: any, b: any) => (a.created_at ?? 0) - (b.created_at ?? 0);

/** Feeder + reader: one conversation's waiting suggestions, oldest first. Each
 *  push is the COMPLETE waiting set, so a decided suggestion leaves the store. */
export function useGuestSuggestions(conversationId: string, enabled = true): any[] {
  const live = enabled && isConvexId(conversationId);
  const syncOpts = useMemo(() => ({ pruneAbsentScope: (row: any) => row?.conversation_id === conversationId }), [conversationId]);
  useSyncCollection("guestSuggestions", api.guestSuggestions.listPending, live ? { conversation_id: conversationId } : "skip", { syncOpts });
  const where = useMemo(() => (r: any) => r.conversation_id === conversationId && r.status === "pending", [conversationId]);
  return useCollectionRows<any>("guestSuggestions", { where, sig, sort: byCreatedAsc });
}
