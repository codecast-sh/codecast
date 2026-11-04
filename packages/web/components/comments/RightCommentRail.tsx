import { memo } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useMessageComments } from "../../hooks/useConversationComments";
import { useConversationAgentType } from "../../hooks/useConversationAgentType";
import { CommentThread } from "./CommentThread";

// This message's teammate comments, rendered to the RIGHT of the message — the
// mirror of the left quote rail. MessageReview owns the placement: it floats the
// rail in the right page margin on wide screens (text keeps full width) or, when
// the margin is tight, shrinks the text into a right column. The thread itself
// is the shared one, with its composer opened on demand: from its Reply, or from
// the gutter handle and the rail's jump (commentRailAnchor + nonce).

type RailMode = "margin" | "column" | "below";

function RightCommentRailImpl({ conversationId, messageId, mode }: { conversationId: string; messageId: string; mode: RailMode }) {
  const { user, isAuthenticated } = useCurrentUser();
  const { thread, addComment, editComment, deleteComment, askAgent } = useMessageComments(conversationId, messageId);
  const agentType = useConversationAgentType(conversationId);
  const openNonce = useInboxStore((s) => (s.commentRailAnchor === messageId ? s.commentRailNonce : -1));

  return (
    <aside className={"cc-rright cc-rright-" + mode}>
      <CommentThread
        thread={thread}
        conversationId={conversationId}
        variant="anchored"
        authed={isAuthenticated}
        canWrite={isAuthenticated}
        currentUserId={user?._id as string | undefined}
        composeOnDemand
        composeSignal={openNonce}
        onComposerClose={() => { if (useInboxStore.getState().commentRailAnchor === messageId) useInboxStore.getState().openCommentThread(null); }}
        onAdd={addComment}
        onEdit={editComment}
        onDelete={deleteComment}
        onAskAgent={askAgent}
        onResolve={(resolved) => useInboxStore.getState().resolveCommentThread(conversationId, { messageId }, resolved)}
        agentType={agentType}
      />
    </aside>
  );
}

export const RightCommentRail = memo(function RightCommentRail(props: { conversationId: string; messageId: string; mode: RailMode }) {
  return <RightCommentRailImpl {...props} />;
});
