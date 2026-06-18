import { memo, useEffect, useState } from "react";
import { MessageSquare, ChevronDown } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { isConvexId } from "../../lib/entityLinks";
import { relTimeShort } from "../../lib/utils";
import { commentAuthorAvatar, commentAuthorName, isAgentComment } from "../../lib/commentThread";
import { useMessageComments } from "../../hooks/useConversationComments";
import { CommentAvatar } from "./CommentAvatar";
import { CommentThread } from "./CommentThread";

// A message's anchored comment thread, rendered INLINE in the conversation flow
// (pinned at the message, like the quoted notes on the left) — visible, not
// behind a click. Collapsed it shows a compact preview; clicking (or the message's
// comment gutter handle) expands the full thread + composer in place.

function InlineMessageCommentsImpl({ conversationId, messageId }: { conversationId: string; messageId: string }) {
  const { user, isAuthenticated } = useCurrentUser();
  const currentUserId = user?._id as string | undefined;
  const { thread, count, addComment, editComment, deleteComment, askAgent } = useMessageComments(conversationId, messageId);

  // The gutter comment handle opens this thread via the shared anchor signal.
  const anchor = useInboxStore((s) => s.commentRailAnchor);
  const nonce = useInboxStore((s) => s.commentRailNonce);
  const [expanded, setExpanded] = useState(false);
  const [autoFocus, setAutoFocus] = useState(false);

  useEffect(() => {
    if (anchor === messageId) {
      setExpanded(true);
      setAutoFocus(true);
    }
  }, [anchor, nonce, messageId]);

  // Nothing to show until there's a comment or the user opened it to add one.
  if (count === 0 && !expanded) return null;

  const busy = thread.comments.some((c) => isAgentComment(c) && (c.agent_status === "thinking" || c.agent_status === "streaming"));
  const last = thread.comments[thread.comments.length - 1];
  const facepile = Array.from(
    new Map(thread.comments.map((c) => [isAgentComment(c) ? "agent" : c.user_id, c])).values(),
  ).slice(0, 4);

  return (
    <div className={"cc-inline" + (expanded ? " cc-inline-expanded" : "")}>
      {!expanded ? (
        <button type="button" className="cc-inline-preview" onClick={() => setExpanded(true)}>
          <span className="cc-inline-faces">
            {facepile.map((c, i) => (
              <CommentAvatar
                key={i}
                name={commentAuthorName(c, currentUserId)}
                image={commentAuthorAvatar(c)}
                isAgent={isAgentComment(c)}
                size={18}
              />
            ))}
          </span>
          <span className="cc-inline-last">
            <b>{last ? commentAuthorName(last, currentUserId) : ""}</b>{" "}
            <span className="cc-inline-last-text">
              {busy && isAgentComment(last) ? "is replying…" : (last?.content || "").replace(/\s+/g, " ").trim().slice(0, 80)}
            </span>
          </span>
          <span className="cc-inline-meta">
            <MessageSquare className="w-3 h-3" />
            {count}
            {last && <span className="cc-inline-time">{relTimeShort(last.created_at)}</span>}
          </span>
        </button>
      ) : (
        <div className="cc-inline-thread">
          <div className="cc-inline-head">
            <MessageSquare className="w-3 h-3 text-sol-cyan" />
            <span className="cc-inline-title">{count} comment{count === 1 ? "" : "s"}</span>
            <button
              type="button"
              className="cc-inline-collapse"
              title="Collapse"
              onClick={() => { setExpanded(false); setAutoFocus(false); }}
            >
              <ChevronDown className="w-4 h-4" />
            </button>
          </div>
          <CommentThread
            thread={thread}
            conversationId={conversationId}
            variant="anchored"
            authed={isAuthenticated}
            canWrite={isAuthenticated}
            currentUserId={currentUserId}
            composerAutoFocus={autoFocus}
            emptyHint={count === 0 ? "Add the first comment on this message." : undefined}
            onAdd={addComment}
            onEdit={editComment}
            onDelete={deleteComment}
            onAskAgent={askAgent}
            agentBusy={busy}
          />
        </div>
      )}
    </div>
  );
}

export const InlineMessageComments = memo(function InlineMessageComments({
  conversationId,
  messageId,
}: {
  conversationId: string;
  messageId: string;
}) {
  if (!isConvexId(conversationId) || !isConvexId(messageId)) return null;
  return <InlineMessageCommentsImpl conversationId={conversationId} messageId={messageId} />;
});
