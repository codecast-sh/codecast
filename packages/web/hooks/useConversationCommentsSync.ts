import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useConvexSync } from "./useConvexSync";
import { isConvexId } from "../lib/entityLinks";
import { useInboxStore } from "../store/inboxStore";
import type { Comment } from "../lib/commentThread";

// The comment feeder and the raw reader, in a leaf (no sonner, no DOM) so the
// phone's session screen mounts the same feed and reads the same rows as the
// web conversation view.

// Mount once per open conversation: pipe the live thread into the store.
export function useConversationCommentsSync(conversationId: string | undefined): void {
  const canQuery = !!conversationId && isConvexId(conversationId);
  const syncTable = useInboxStore((s) => s.syncTable);

  const raw = useQueryNoThrow(
    api.comments.getConversationCommentSummary,
    canQuery
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip",
  ).data;
  useConvexSync(raw, useCallback((data: any) => {
    syncTable("comments", data ?? []);
  }, [syncTable]));
}

/** One conversation's comments, straight from the store. */
export function useConversationCommentRows(conversationId: string | undefined): Comment[] {
  return useInboxStore(
    useShallow((s) =>
      (Object.values(s.comments) as Comment[]).filter((c) => c.conversation_id === conversationId),
    ),
  );
}
