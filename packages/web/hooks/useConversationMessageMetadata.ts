import { useCallback, useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { isConvexId } from "../store/inboxStore";

export type MessageMetadata = {
  commentCount: number | undefined;
  isBookmarked: boolean | undefined;
};

type CommentSummaryEntry = {
  message_id?: string | null;
};

type ConversationMessageMetadataArgs = {
  commentSummary?: readonly CommentSummaryEntry[];
  bookmarkedMessageIds?: readonly unknown[];
};

export function buildConversationMessageMetadata({
  commentSummary,
  bookmarkedMessageIds,
}: ConversationMessageMetadataArgs) {
  const commentCountsByMessageId = new Map<string, number>();
  if (commentSummary) {
    for (const comment of commentSummary) {
      if (!comment.message_id) continue;
      const messageId = String(comment.message_id);
      commentCountsByMessageId.set(messageId, (commentCountsByMessageId.get(messageId) ?? 0) + 1);
    }
  }

  const bookmarkedMessageIdSet = new Set<string>();
  if (bookmarkedMessageIds) {
    for (const messageId of bookmarkedMessageIds) {
      bookmarkedMessageIdSet.add(String(messageId));
    }
  }

  return {
    commentCountsByMessageId,
    bookmarkedMessageIdSet,
    commentsLoaded: commentSummary !== undefined,
    bookmarksLoaded: bookmarkedMessageIds !== undefined,
  };
}

export function useConversationMessageMetadata(conversationId: string | undefined) {
  const canQuery = !!conversationId && isConvexId(conversationId);
  const convexConversationId = conversationId as Id<"conversations">;

  const commentSummary = useQuery(
    api.comments.getConversationCommentSummary,
    canQuery ? { conversation_id: convexConversationId } : "skip"
  );
  const bookmarkedMessageIds = useQuery(
    api.bookmarks.getConversationBookmarks,
    canQuery ? { conversation_id: convexConversationId } : "skip"
  );

  const metadata = useMemo(
    () => buildConversationMessageMetadata({ commentSummary, bookmarkedMessageIds }),
    [commentSummary, bookmarkedMessageIds]
  );

  return useCallback(
    (messageId: string | undefined): MessageMetadata => {
      if (!messageId) {
        return { commentCount: undefined, isBookmarked: undefined };
      }
      return {
        commentCount: metadata.commentsLoaded
          ? metadata.commentCountsByMessageId.get(messageId) ?? 0
          : undefined,
        isBookmarked: metadata.bookmarksLoaded
          ? metadata.bookmarkedMessageIdSet.has(messageId)
          : undefined,
      };
    },
    [metadata]
  );
}
