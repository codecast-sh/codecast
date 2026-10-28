import { Fragment, useState, type ReactNode } from "react";
import { CheckCircle2, ChevronDown, RotateCcw } from "lucide-react";
import { type Comment, type CommentThread as Thread, commentAuthorName, firstUnreadIndex, isOwnComment } from "../../lib/commentThread";
import { CommentCard } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";
import { useConversationSpeaker } from "../../hooks/useLiveIdentityRow";

// One thread (the global conversation thread, or a per-message anchored thread):
// an optional header, the chat cards oldest→newest, then the composer. Owns the
// local "replying to" target so a reply threads under the right comment.
// Optional: a read mark (`readAt`) draws a "New" line where the reader's news
// starts; `onResolve` adds Resolve / Reopen; `scopeKey` keys the draft and
// typing presence when the thread is not a conversation's (a decision's).

export function CommentThread({
  thread,
  conversationId,
  variant,
  header,
  authed,
  canWrite,
  currentUserId,
  composerAutoFocus,
  composerClassName,
  emptyHint,
  collapsible,
  onAdd,
  onEdit,
  onDelete,
  onAskAgent,
  agentBusy,
  agentType,
  readAt,
  onResolve,
  scopeKey,
  placeholder,
  mentionTeamId,
}: {
  thread: Thread;
  conversationId: string;
  variant: "global" | "anchored";
  header?: ReactNode;
  authed: boolean;
  canWrite: boolean;
  currentUserId?: string;
  composerAutoFocus?: boolean;
  /** Frame class for the composer — see CommentComposer's `className`. */
  composerClassName?: string;
  emptyHint?: string;
  collapsible?: boolean;
  onAdd: (input: { content: string; messageId?: string; parentCommentId?: string }) => void | Promise<void>;
  onEdit: (commentId: string, content: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
  onAskAgent?: (messageId?: string) => void | Promise<void>;
  agentBusy?: boolean;
  agentType?: string;
  /** The reader's read mark: comments past it from someone else are news. */
  readAt?: number;
  /** Resolve (true) or reopen (false) the whole thread. */
  onResolve?: (resolved: boolean) => void;
  scopeKey?: string;
  placeholder?: string;
  mentionTeamId?: string;
}) {
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  const agentName = useConversationSpeaker(conversationId, agentType).name;
  const nameById = new Map(thread.comments.map((c) => [c._id, commentAuthorName(c, currentUserId, agentName)]));
  const firstNew = firstUnreadIndex(thread.comments, readAt, currentUserId);

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
        {thread.comments.map((c, i) => (
          <Fragment key={c._id}>
          {i === firstNew && <div className="cc-thread-new" data-comment-new-line>New</div>}
          <CommentCard
            conversationId={conversationId}
            comment={c}
            fresh={firstNew >= 0 && i >= firstNew && !isOwnComment(c, currentUserId)}
            currentUserId={currentUserId}
            agentType={agentType}
            replyingToName={c.parent_comment_id ? nameById.get(c.parent_comment_id) : undefined}
            onReply={(rc) => setReplyTo(rc)}
            onEdit={onEdit}
            onDelete={onDelete}
            onRetryAgent={onAskAgent ? () => onAskAgent(thread.messageId) : undefined}
          />
          </Fragment>
        ))}
      </div>
      )}
      {!collapsed && onResolve && thread.comments.length > 0 && (
        <div className="cc-thread-resolve">
          <button type="button" className="cc-comment-btn" onClick={() => onResolve(!thread.resolved)} data-comment-resolve={thread.resolved ? "reopen" : "resolve"}>
            {thread.resolved ? <><RotateCcw className="w-3 h-3" /> Reopen</> : <><CheckCircle2 className="w-3 h-3" /> Resolve</>}
          </button>
          {thread.resolved && <span className="cc-thread-resolved">Resolved</span>}
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
          className={composerClassName}
          scopeKey={scopeKey}
          mentionTeamId={mentionTeamId}
          chatMentionMode={!!mentionTeamId}
          placeholder={placeholder ?? (variant === "anchored" ? "Reply…" : "Comment on this conversation…")}
          onSubmit={(content) =>
            onAdd({ content, messageId: thread.messageId, parentCommentId: replyTo?._id })
          }
        />
      )}
    </div>
  );
}
