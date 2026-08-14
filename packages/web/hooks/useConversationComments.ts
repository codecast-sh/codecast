import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isConvexId } from "../lib/entityLinks";
import { useInboxStore } from "../store/inboxStore";
import { isParkedDispatchError } from "../store/mutativeMiddleware";
import { useConvexSync } from "./useConvexSync";
import { groupComments, isThreadResolved, threadKeyFor, type Comment, type CommentThread } from "../lib/commentThread";
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
  addComment: (input: { content: string; messageId?: string; parentCommentId?: string; filePath?: string; lineNumber?: number }) => Promise<void>;
  editComment: (commentId: string, content: string) => void;
  deleteComment: (commentId: string) => Promise<void>;
  askAgent: (messageId?: string, fileAnchor?: { filePath: string; lineNumber?: number }) => Promise<void>;
};

export function useCommentActions(conversationId: string | undefined): CommentActions {
  const canQuery = !!conversationId && isConvexId(conversationId);
  const addComment = useCallback(
    async (input: { content: string; messageId?: string; parentCommentId?: string; filePath?: string; lineNumber?: number }) => {
      if (!input.content.trim() || !canQuery) return;
      try {
        await useInboxStore.getState().addComment(conversationId!, input.content, {
          messageId: input.messageId,
          parentCommentId: input.parentCommentId,
          filePath: input.filePath,
          lineNumber: input.lineNumber,
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
  const askAgent = useCallback(async (messageId?: string, fileAnchor?: { filePath: string; lineNumber?: number }) => {
    if (!canQuery) return;
    try {
      await useInboxStore.getState().askAgentInThread(conversationId!, {
        messageId,
        filePath: fileAnchor?.filePath,
        lineNumber: fileAnchor?.lineNumber,
      });
    } catch (error) {
      if (!isParkedDispatchError(error)) throw error;
    }
  }, [conversationId, canQuery]);
  return { addComment, editComment, deleteComment, askAgent };
}

export type ConversationComments = CommentActions & {
  global: CommentThread;
  anchored: CommentThread[];
  files: CommentThread[];
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
  return { ...actions, global: grouped.global, anchored: grouped.anchored, files: grouped.files, countByMessageId, totalCount: mine.length };
}

const EMPTY_FILE_COMMENTS: Comment[] = [];

// Read one FILE's durable line comments (used by DiffView to render code-anchored
// threads inline under their diff lines). Only subscribes when a filePath is
// given, so inert diffs pay nothing.
export function useFileComments(conversationId: string | undefined, filePath: string | undefined) {
  const mine = useInboxStore(
    useShallow((s) =>
      conversationId && filePath
        ? (Object.values(s.comments) as Comment[]).filter(
            (c) => c.conversation_id === conversationId && !c.message_id && c.file_path === filePath,
          )
        : EMPTY_FILE_COMMENTS,
    ),
  );
  return useMemo(() => {
    const byLine = new Map<number, Comment[]>();
    for (const c of mine) {
      const line = c.line_number ?? 0;
      const arr = byLine.get(line);
      if (arr) arr.push(c);
      else byLine.set(line, [c]);
    }
    // Resolved threads leave the diff (they stay reachable from the rail);
    // one unresolved comment — e.g. a reply after resolution — keeps it inline.
    for (const [line, arr] of byLine) {
      if (arr.every((c) => !!c.resolved_at)) byLine.delete(line);
      else arr.sort((a, b) => a.created_at - b.created_at);
    }
    return byLine;
  }, [mine]);
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
    () => ({ key: threadKeyFor(messageId), messageId, comments: thread, lastActivity: thread.length ? thread[thread.length - 1].created_at : 0, resolved: isThreadResolved(thread) }),
    [thread, messageId],
  );
  return { thread: t, count: thread.length, ...actions };
}
