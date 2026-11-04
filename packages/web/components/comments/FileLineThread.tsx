import { memo, useMemo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useCommentActions } from "../../hooks/useConversationComments";
import { useConversationAgentType } from "../../hooks/useConversationAgentType";
import { fileThreadKey, isThreadResolved, type Comment, type CommentThread as Thread } from "../../lib/commentThread";
import { CommentThread } from "./CommentThread";
import { AnchorPlacementNote } from "./AnchorPlacementNote";
import type { AnchorPlacement } from "@codecast/shared/comments";

// A durable code-anchored comment thread, rendered inline under its diff line.
// These are real `comments` rows (file_path + line_number anchor) — visible to
// every teammate, unlike the ephemeral review batch that rides the next reply.
// The shared thread draws it, so authorship, editing, resolving and the agent
// reply behave as they do everywhere.

function FileLineThreadImpl({
  conversationId,
  filePath,
  lineNumber,
  comments,
  composerClassName,
  placement,
}: {
  conversationId: string;
  filePath: string;
  lineNumber?: number;
  comments: Comment[];
  /** Frame class for the composer — see CommentComposer's `className`. */
  composerClassName?: string;
  /** Where the thread's passage is now, when it moved or is gone. */
  placement?: AnchorPlacement | null;
}) {
  const { user, isAuthenticated } = useCurrentUser();
  const { addComment, editComment, deleteComment, askAgent } = useCommentActions(conversationId);
  const agentType = useConversationAgentType(conversationId);
  const thread: Thread = useMemo(() => ({
    key: fileThreadKey(filePath, lineNumber),
    filePath,
    lineNumber,
    comments,
    lastActivity: comments.length ? comments[comments.length - 1].created_at : 0,
    resolved: isThreadResolved(comments),
  }), [filePath, lineNumber, comments]);

  return (
    <div className="cc-fline" data-placement={placement?.state}>
      <AnchorPlacementNote placement={placement} anchorLines={comments.find((c) => c.anchor_lines)?.anchor_lines} />
      <CommentThread
        thread={thread}
        conversationId={conversationId}
        variant="anchored"
        authed={isAuthenticated}
        canWrite={isAuthenticated}
        currentUserId={user?._id as string | undefined}
        composeOnDemand
        composerClassName={composerClassName}
        onAdd={addComment}
        onEdit={editComment}
        onDelete={deleteComment}
        onAskAgent={askAgent}
        onResolve={(resolved) => useInboxStore.getState().resolveCommentThread(conversationId, { filePath, lineNumber }, resolved)}
        agentType={agentType}
      />
    </div>
  );
}

export const FileLineThread = memo(FileLineThreadImpl);
