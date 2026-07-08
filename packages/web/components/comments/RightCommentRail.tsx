import { memo, useEffect, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { isAgentComment, commentAuthorName, type Comment } from "../../lib/commentThread";
import { useMessageComments } from "../../hooks/useConversationComments";
import { CommentCard } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";
import { PingAgentButton } from "./PingAgentButton";

// This message's teammate comments, rendered to the RIGHT of the message — the
// mirror of the left quote rail. MessageReview owns the placement: it floats the
// rail in the right page margin on wide screens (text keeps full width) or, when
// the margin is tight, shrinks the text into a right column. This component is a
// dumb renderer: the cards (reusing CommentCard, so the agent shows its
// Claude/Codex identity), an on-demand composer, and the foot actions.

type RailMode = "margin" | "column" | "below";

function RightCommentRailImpl({ conversationId, messageId, mode }: { conversationId: string; messageId: string; mode: RailMode }) {
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const { thread, addComment, editComment, deleteComment, askAgent } = useMessageComments(conversationId, messageId);
  const agentType = useInboxStore((s) => ((s.conversations[conversationId] ?? s.sessions[conversationId]) as { agent_type?: string } | undefined)?.agent_type ?? "claude_code");

  // The gutter comment handle (or a jump from the dock) opens this message's
  // composer by anchoring here + bumping the nonce.
  const openNonce = useInboxStore((s) => (s.commentRailAnchor === messageId ? s.commentRailNonce : -1));
  const [composing, setComposing] = useState(false);
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  useEffect(() => { if (openNonce >= 0) setComposing(true); }, [openNonce]);

  const composeOpen = composing && isAuthenticated;
  const agentBusy = thread.comments.some((c) => isAgentComment(c) && (c.agent_status === "thinking" || c.agent_status === "streaming"));

  const nameById = new Map(thread.comments.map((c) => [c._id, commentAuthorName(c, currentUserId)]));

  const startReply = (c: Comment) => { setReplyTo(c); setComposing(true); };
  const closeComposer = () => {
    setComposing(false);
    setReplyTo(null);
    if (openNonce >= 0) useInboxStore.getState().openCommentThread(null);
  };

  return (
    <aside className={"cc-rright cc-rright-" + mode}>
      <div className="cc-rright-cards">
        {thread.comments.map((c) => (
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
      </div>

      {composeOpen && (
        <CommentComposer
          conversationId={conversationId}
          messageId={messageId}
          enabled
          authed={isAuthenticated}
          replyTo={replyTo}
          currentUserId={currentUserId}
          onCancelReply={() => setReplyTo(null)}
          onClose={closeComposer}
          onPingAgent={agentBusy ? undefined : () => askAgent(messageId)}
          agentType={agentType}
          autoFocus
          placeholder={replyTo ? "Reply…" : "Comment…"}
          onSubmit={(content) => addComment({ content, messageId, parentCommentId: replyTo?._id })}
        />
      )}

      {!composeOpen && (
        <div className="cc-rright-foot">
          {isAuthenticated && (
            <button type="button" className="cc-comment-btn" onClick={() => setComposing(true)}>
              <MessageSquarePlus className="w-3 h-3" /> Comment
            </button>
          )}
          {isAuthenticated && !agentBusy && (
            <PingAgentButton agentType={agentType} onClick={() => askAgent(messageId)} />
          )}
        </div>
      )}
    </aside>
  );
}

export const RightCommentRail = memo(function RightCommentRail(props: { conversationId: string; messageId: string; mode: RailMode }) {
  return <RightCommentRailImpl {...props} />;
});
