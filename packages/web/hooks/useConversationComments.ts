import { useCallback, useEffect, useMemo } from "react";
import { useQuery } from "convex/react";
import { useShallow } from "zustand/react/shallow";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isConvexId } from "../lib/entityLinks";
import { useInboxStore } from "../store/inboxStore";
import {
  isCutoverMode,
  isLogTsMode,
  isShadowMode,
  localFirstSliceMode,
} from "../store/local-first/featureFlags";
import {
  commentsByConversationView,
  commentsByConversationViewV3,
} from "../store/local-first/referenceContracts";
import { useCutoverSpotCheck, useShadowEquivalence } from "../store/local-first/shadowValidation";
import { useConvexSync } from "./useConvexSync";
import { useLocalView } from "./useLocalView";
import { groupComments, threadKeyFor, type Comment, type CommentThread } from "../lib/commentThread";

// Project a comment onto the field set the v1 summary query delivers, so the
// v1↔v2 digest comparison judges exactly what today's readers render. The v2
// projection is a superset (it adds user.image); extra fields are additive
// for readers and deliberately outside the equivalence check.
export function comparableComment(row: any): Record<string, unknown> {
  const { user, ...rest } = row ?? {};
  return {
    ...rest,
    user: {
      _id: user?._id,
      name: user?.name,
      github_username: user?.github_username,
      github_avatar_url: user?.github_avatar_url,
    },
  };
}

// Comments funnel through the inboxStore cache like everything else. The feed
// runs ONCE per open conversation (useConversationCommentsSync, mounted in
// ConversationView); every reader pulls straight from the store (instant), and
// writes are store actions that paint optimistically and reconcile on the echo.

// Mount once per open conversation: pipe the live thread into the store.
// The declared local-first view rolls out beside it per its slice flag:
// "shadow" materializes the durable v2 view without touching readers;
// "cutover" makes that durable view the store's feed.
export function useConversationCommentsSync(conversationId: string | undefined): void {
  const canQuery = !!conversationId && isConvexId(conversationId);
  const mode = localFirstSliceMode("comments");
  const cutover = isCutoverMode(mode);
  const syncTable = useInboxStore((s) => s.syncTable);

  // Standing divergence monitor after cutover (matrix SHD-03): a sampled
  // fraction of mounts briefly re-subscribes v1 purely for digest comparison.
  const spotCheck = useCutoverSpotCheck(
    canQuery && cutover,
    `comments:${conversationId}`,
  );
  const raw = useQuery(
    api.comments.getConversationCommentSummary,
    canQuery && (!cutover || spotCheck)
      ? { conversation_id: conversationId as Id<"conversations"> }
      : "skip",
  );
  useConvexSync(raw, useCallback((data: any) => {
    // In cutover the durable view owns the store; a sampled v1 result feeds
    // only the digest comparison below.
    if (cutover) return;
    syncTable("comments", data ?? []);
  }, [syncTable, cutover]));

  // The -lts modes run the v3 stamped-log-ts contract (same server query,
  // coverage from the delivering transition's log timestamp).
  const viewContract = isLogTsMode(mode)
    ? commentsByConversationViewV3
    : commentsByConversationView;
  const view = useLocalView(
    viewContract,
    { conversationId: conversationId as Id<"conversations"> },
    { enabled: canQuery && mode !== "off" },
  );
  const viewRows = view.rows;
  useEffect(() => {
    if (!cutover || view.status !== "granted") return;
    // The durable view is COMPLETE for this conversation, so a row absent from
    // it is deleted, not merely unsynced. The comments registry entry is
    // isDelta (one conversation's feed must not prune another's), so without
    // this scoped prune a teammate's deletion would upsert-only into the store
    // and the ghost row would render forever (matrix VIEW-02). Pending local
    // optimistic rows are protected by applySyncTable itself.
    syncTable("comments", viewRows.map((row) => row.value), {
      pruneAbsentScope: (row: any) => row.conversation_id === conversationId,
    });
  }, [cutover, view.status, viewRows, syncTable, conversationId]);

  // Cutover gate evidence in shadow mode; sampled standing monitor in cutover.
  useShadowEquivalence({
    enabled: canQuery && (isShadowMode(mode) || spotCheck),
    contractId: viewContract.id,
    viewKey: `comments:conversation:${conversationId}`,
    authoritative: useMemo(() => Array.isArray(raw)
      ? raw.map((row: any) => ({ key: `comment:${row._id}`, value: comparableComment(row) }))
      : null, [raw]),
    materialized: useMemo(() => view.status === "granted"
      ? viewRows.map((row) => ({ key: row.entityKey, value: comparableComment(row.value) }))
      : null, [view.status, viewRows]),
  });
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
      await useInboxStore.getState().addComment(conversationId!, input.content, {
        messageId: input.messageId,
        parentCommentId: input.parentCommentId,
      });
    },
    [conversationId, canQuery],
  );
  const editComment = useCallback((commentId: string, content: string) => {
    if (content.trim()) useInboxStore.getState().editComment(commentId, content.trim());
  }, []);
  const deleteComment = useCallback(async (commentId: string) => {
    await useInboxStore.getState().deleteComment(commentId);
  }, []);
  const askAgent = useCallback(async (messageId?: string) => {
    if (canQuery) await useInboxStore.getState().askAgentInThread(conversationId!, { messageId });
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
