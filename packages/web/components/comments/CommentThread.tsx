import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { type Comment, type CommentThread as Thread, commentAuthorName } from "../../lib/commentThread";
import { CommentCard } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";

// One thread (the global conversation thread, or a per-message anchored thread):
// an optional header, the chat cards oldest→newest, then the composer. Owns the
// local "replying to" target so a reply threads under the right comment.

export function CommentThread({
  thread,
  conversationId,
  variant,
  header,
  authed,
  canWrite,
  currentUserId,
  composerAutoFocus,
  emptyHint,
  collapsible,
  onAdd,
  onEdit,
  onDelete,
  onAskAgent,
  agentBusy,
  agentType,
}: {
  thread: Thread;
  conversationId: string;
  variant: "global" | "anchored";
  header?: ReactNode;
  authed: boolean;
  canWrite: boolean;
  currentUserId?: string;
  composerAutoFocus?: boolean;
  emptyHint?: string;
  collapsible?: boolean;
  onAdd: (input: { content: string; messageId?: string; parentCommentId?: string }) => void | Promise<void>;
  onEdit: (commentId: string, content: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
  onAskAgent?: (messageId?: string) => void | Promise<void>;
  agentBusy?: boolean;
  agentType?: string;
}) {
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const nameById = new Map(thread.comments.map((c) => [c._id, commentAuthorName(c, currentUserId, agentType)]));

  return (
    <div className={"cc-thread cc-thread-" + variant + (collapsed ? " cc-thread-collapsed" : "")}>
      {collapsible ? (
        <div className="cc-thread-acc-head">
          <button
            type="button"
            className="cc-thread-acc-toggle"
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
          >
            <ChevronDown className={"w-3 h-3 cc-thread-chev" + (collapsed ? " cc-thread-chev-collapsed" : "")} />
          </button>
          <div className="cc-thread-acc-header" onClick={() => setCollapsed((v) => !v)}>{header}</div>
          {thread.comments.length > 0 && <span className="cc-thread-acc-count">{thread.comments.length}</span>}
        </div>
      ) : (
        header
      )}
      {!collapsed && (
      <div className="cc-thread-list">
        {thread.comments.length === 0 && emptyHint && (
          <div className="cc-thread-empty">{emptyHint}</div>
        )}
        {thread.comments.map((c) => (
          <CommentCard
            key={c._id}
            comment={c}
            currentUserId={currentUserId}
            agentType={agentType}
            replyingToName={c.parent_comment_id ? nameById.get(c.parent_comment_id) : undefined}
            onReply={(rc) => setReplyTo(rc)}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
      )}
      {!collapsed && canWrite && (
        <CommentComposer
          conversationId={conversationId}
          messageId={thread.messageId}
          enabled
          authed={authed}
          replyTo={replyTo}
          currentUserId={currentUserId}
          onCancelReply={() => setReplyTo(null)}
          onPingAgent={onAskAgent && !agentBusy ? () => onAskAgent(thread.messageId) : undefined}
          agentType={agentType}
          autoFocus={composerAutoFocus}
          placeholder={variant === "anchored" ? "Reply…" : "Comment on this conversation…"}
          onSubmit={(content) =>
            onAdd({ content, messageId: thread.messageId, parentCommentId: replyTo?._id })
          }
        />
      )}
    </div>
  );
}
