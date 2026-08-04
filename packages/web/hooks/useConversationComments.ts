import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isConvexId } from "../lib/entityLinks";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { useConvexSync } from "./useConvexSync";
import { groupComments, threadKeyFor, type Comment, type CommentThread } from "../lib/commentThread";
import { toast } from "sonner";

// Comments funnel through the inboxStore cache like everything else. The feed
// runs ONCE per open conversation (useConversationCommentsSync, mounted in
// ConversationView); every reader pulls straight from the store (instant), and
// writes are store actions that paint optimistically and reconcile on the echo.

// Mount once per open conversation: pipe the live thread into the store.
export function useConversationCommentsSync(conversationId: string | undefined): void {
  const canQuery = !!conversationId && isConvexId(conversationId);
  const syncTable = useInboxStore((s) => s.syncTable);

  const raw = useQuery(
    api.comments.getConversationCommentSummary,
    canQuery
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip",
  );
  useConvexSync(raw, useCallback((data: any) => {
    syncTable("comments", data ?? []);
  }, [syncTable]));
}

export type CommentActions = {
  addComment: (input: { content: string; messageId?: string; parentCommentId?: string }) => Promise<void>;
  editComment: (commentId: string, content: string) => void;
  deleteComment: (commentId: string) => Promise<void>;
  askAgent: (messageId?: string) => Promise<void>;
};

export function useCommentActions(conversationId: string | undefined): CommentActions {
  const canQuery = !!conversationId && isConvexId(conversationId);
  const addComment = useCallback(
    async (input: { content: string; messageId?: string; parentCommentId?: string }) => {
      if (!input.content.trim() || !canQuery) return;
      try {
        await useInboxStore.getState().addComment(conversationId!, input.content, {
          messageId: input.messageId,
          parentCommentId: input.parentCommentId,
        });
      } catch (error) {
        if (!isParkedDispatchError(error)) throw error;
      }
    },
    [conversationId, canQuery],
  );
  const editComment = useCallback((commentId: string, content: string) => {
    const next = content.trim();
    if (!next) return;
    void useInboxStore.getState().editComment(commentId, next).catch((error) => {
      if (isParkedDispatchError(error)) return;
      toast.error(
        error instanceof Error ? error.message : "Couldn't edit comment",
      );
    });
  }, []);
  const deleteComment = useCallback(async (commentId: string) => {
    try {
      await useInboxStore.getState().deleteComment(commentId);
    } catch (error) {
      if (!isParkedDispatchError(error)) throw error;
    }
  }, []);
  const askAgent = useCallback(async (messageId?: string) => {
    if (!canQuery) return;
    try {
      await useInboxStore.getState().askAgentInThread(conversationId!, { messageId });
    } catch (error) {
      if (!isParkedDispatchError(error)) throw error;
    }
  }, [conversationId, canQuery]);
  return { addComment, editComment, deleteComment, askAgent };
}

export type ConversationComments = CommentActions & {
  global: CommentThread;
  anchored: CommentThread[];
  countByMessageId: Map<string, number>;
  totalCount: number;
};

// Read the whole conversation's threads from the store (used by the global dock).
export function useConversationComments(conversationId: string | undefined): ConversationComments {
  const mine = useInboxStore(
    useShallow((s) =>
      (Object.values(s.comments) as Comment[]).filter((c) => c.conversation_id === conversationId),
    ),
  );
  const grouped = useMemo(() => groupComments(mine), [mine]);
  const countByMessageId = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of grouped.anchored) if (t.messageId) m.set(t.messageId, t.comments.length);
    return m;
  }, [grouped]);
  const actions = useCommentActions(conversationId);
  return { ...actions, global: grouped.global, anchored: grouped.anchored, countByMessageId, totalCount: mine.length };
}

// Read just ONE message's anchored thread (used by the inline per-message thread).
export function useMessageComments(conversationId: string | undefined, messageId: string) {
  const thread = useInboxStore(
    useShallow((s) =>
      (Object.values(s.comments) as Comment[])
        .filter((c) => c.conversation_id === conversationId && c.message_id === messageId)
        .sort((a, b) => a.created_at - b.created_at),
    ),
  );
  const actions = useCommentActions(conversationId);
  const t: CommentThread = useMemo(
    () => ({ key: threadKeyFor(messageId), messageId, comments: thread, lastActivity: thread.length ? thread[thread.length - 1].created_at : 0 }),
    [thread, messageId],
  );
  return { thread: t, count: thread.length, ...actions };
}
