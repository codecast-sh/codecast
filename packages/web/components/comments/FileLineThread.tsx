import { memo, useState } from "react";
import { CheckCircle2, MessageSquarePlus } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useCommentActions } from "../../hooks/useConversationComments";
import {
  commentAuthorName,
  fileThreadKey,
  isAgentComment,
  type Comment,
} from "../../lib/commentThread";
import { CommentCard } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";
import { PingAgentButton } from "./PingAgentButton";

// A durable code-anchored comment thread, rendered inline under its diff line.
// These are real `comments` rows (file_path + line_number anchor) — visible to
// every teammate, unlike the ephemeral review batch that rides the next reply.
// Reuses the rail's cards/composer so authorship, editing, and the agent reply
// flow behave identically everywhere.

function FileLineThreadImpl({
  conversationId,
  filePath,
  lineNumber,
  comments,
  composerClassName,
}: {
  conversationId: string;
  filePath: string;
  lineNumber?: number;
  comments: Comment[];
  /** Frame class for the composer — see CommentComposer's `className`. */
  composerClassName?: string;
}) {
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const { addComment, editComment, deleteComment, askAgent } = useCommentActions(conversationId);
  const agentType = useInboxStore((s) => ((s.conversations[conversationId] ?? s.sessions[conversationId]) as { agent_type?: string } | undefined)?.agent_type ?? "claude_code");

  const [composing, setComposing] = useState(false);
  const [replyTo, setReplyTo] = useState<Comment | null>(null);

  const agentBusy = comments.some((c) => isAgentComment(c) && (c.agent_status === "thinking" || c.agent_status === "streaming"));
  const nameById = new Map(comments.map((c) => [c._id, commentAuthorName(c, currentUserId)]));
  const pingAgent = () => askAgent(undefined, { filePath, lineNumber });

  const startReply = (c: Comment) => { setReplyTo(c); setComposing(true); };
  const closeComposer = () => { setComposing(false); setReplyTo(null); };

  return (
    <div className="cc-fline my-1 ml-2 border-l-2 border-sol-cyan/40 pl-2.5 space-y-1 font-sans text-sol-text whitespace-normal">
      {comments.map((c) => (
        <CommentCard
          key={c._id}
          comment={c}
          currentUserId={currentUserId}
          agentType={agentType}
          replyingToName={c.parent_comment_id ? nameById.get(c.parent_comment_id) : undefined}
          onReply={startReply}
          onEdit={editComment}
          onDelete={deleteComment}
        />
      ))}

      {composing && isAuthenticated ? (
        <CommentComposer
          conversationId={conversationId}
          messageId={fileThreadKey(filePath, lineNumber)}
          enabled
          authed={isAuthenticated}
          replyTo={replyTo}
          currentUserId={currentUserId}
          onCancelReply={() => setReplyTo(null)}
          onClose={closeComposer}
          onPingAgent={agentBusy ? undefined : pingAgent}
          agentType={agentType}
          autoFocus
          className={composerClassName}
          placeholder={replyTo ? "Reply…" : "Comment…"}
          onSubmit={(content) =>
            addComment({ content, filePath, lineNumber, parentCommentId: replyTo?._id })}
        />
      ) : (
        <div className="flex items-center gap-2">
          {isAuthenticated && (
            <button type="button" className="cc-comment-btn" onClick={() => setComposing(true)}>
              <MessageSquarePlus className="w-3 h-3" /> Reply
            </button>
          )}
          {isAuthenticated && !agentBusy && (
            <PingAgentButton agentType={agentType} onClick={pingAgent} />
          )}
          {isAuthenticated && (
            <button
              type="button"
              className="cc-comment-btn"
              title="Resolve this thread — it leaves the diff and the session's comment count"
              onClick={() =>
                useInboxStore.getState().resolveCommentThread(conversationId, { filePath, lineNumber }, true)}
            >
              <CheckCircle2 className="w-3 h-3" /> Resolve
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export const FileLineThread = memo(FileLineThreadImpl);
