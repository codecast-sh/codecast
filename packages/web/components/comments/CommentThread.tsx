import { Fragment, useRef, useState, type ReactNode } from "react";
import { CheckCircle2, MessageSquarePlus } from "lucide-react";
import {
  type Comment,
  type CommentThread as Thread,
  commentAuthorName,
  continuesPrevious,
  fileThreadKey,
  firstUnreadIndex,
  agentReplyState,
  isAgentAnswering,
  messageExcerpt,
  isOwnComment,
} from "../../lib/commentThread";
import { CommentCard, ResolveTool } from "./CommentCard";
import { CommentComposer } from "./CommentComposer";
import { PingAgentButton } from "./PingAgentButton";
import { useConversationSpeaker } from "../../hooks/useLiveIdentityRow";
import { useWatchEffect } from "../../hooks/useWatchEffect";

// Every comment thread draws here: the conversation's own thread in the rail,
// a message's thread beside it, a code line's thread under it, a decision's
// thread, and the Threads page. The cards oldest to newest, one row of thread
// actions (reply, ask the agent, resolve), then the composer: always open
// (`composeOnDemand` unset) or opened from a card's Reply or from outside
// (`composeSignal`). Owns the "replying to" target so a reply threads under
// the right comment. A read mark (`readAt`) draws a "New" line where the
// reader's news starts; `scopeKey` keys the draft and typing presence when
// the thread is not a conversation's (a decision's).

export type ThreadAddInput = { content: string; messageId?: string; parentCommentId?: string; filePath?: string; lineNumber?: number };

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
  composeOnDemand,
  composeSignal,
  onComposerClose,
  onAdd,
  onEdit,
  onDelete,
  onAskAgent,
  pingAgent = true,
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
  /** The composer stays shut until Reply (or `composeSignal`) opens it. */
  composeOnDemand?: boolean;
  /** Opens the on-demand composer each time it changes to a value ≥ 0. */
  composeSignal?: number;
  onComposerClose?: () => void;
  onAdd: (input: ThreadAddInput) => void | Promise<void>;
  onEdit: (commentId: string, content: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
  onAskAgent?: (messageId?: string, fileAnchor?: { filePath: string; lineNumber?: number }) => void | Promise<void>;
  /** Offer Ping in the tools; off where the surface has its own ask control
   *  (a decision's "Discuss with …"). Retry on a failed reply stays. */
  pingAgent?: boolean;
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
  const [composingOwn, setComposing] = useState(false);
  // A resolved thread folds to one line until someone opens it.
  const [openResolved, setOpenResolved] = useState(false);
  useWatchEffect(() => { if (composeSignal !== undefined && composeSignal >= 0) setComposing(true); }, [composeSignal]);

  const agentName = useConversationSpeaker(conversationId, agentType).name;
  // What each reply answers: the parent's author and opening words.
  const replyTargets = new Map(thread.comments.map((c) => [c._id, { name: commentAuthorName(c, currentUserId, agentName).split(" ")[0], excerpt: messageExcerpt(c.content, 48) }]));
  const firstNew = firstUnreadIndex(thread.comments, readAt, currentUserId);
  const fileAnchor = thread.filePath ? { filePath: thread.filePath, lineNumber: thread.lineNumber } : undefined;
  const anchorKey = thread.messageId ?? (fileAnchor ? fileThreadKey(fileAnchor.filePath, fileAnchor.lineNumber) : undefined);
  const askAgent = onAskAgent ? () => onAskAgent(thread.messageId, fileAnchor) : undefined;

  const writable = canWrite && authed;
  const composing = writable && (!composeOnDemand || composingOwn);
  const hasComments = thread.comments.length > 0;
  const closeComposer = () => { setComposing(false); setReplyTo(null); onComposerClose?.(); };
  // Reply moves the caret into this thread's box, whether it was open or not.
  const rootRef = useRef<HTMLDivElement>(null);
  const focusComposer = () => requestAnimationFrame(() => rootRef.current?.querySelector<HTMLTextAreaElement>(".cc-cmt-composer textarea")?.focus());
  const startReply = (c: Comment) => { setReplyTo(c); setComposing(true); focusComposer(); };

  // With comments, each card's own Reply opens the box; the row offers it only to start a thread.
  const showReply = writable && composeOnDemand && !composing && !hasComments;
  // The last word is a failed agent reply: its own Retry asks again.
  const lastFailed = hasComments && agentReplyState(thread.comments[thread.comments.length - 1]) === "failed";
  // Asking the agent and resolving need no box: a signed-in reader may do both.
  const showPing = authed && pingAgent && !!askAgent && hasComments && !lastFailed && !(composeOnDemand && composing) && !isAgentAnswering(thread.comments);
  const showResolve = authed && !!onResolve && hasComments;
  // The thread's own actions ride in each card's hover tools, so a quiet
  // thread draws no row of buttons under itself.
  const threadTools = showPing || showResolve ? (
    <>
      {showPing && <PingAgentButton conversationId={conversationId} agentType={agentType} onClick={() => void askAgent!()} compact />}
      {showResolve && <ResolveTool resolved={thread.resolved} onToggle={() => onResolve!(!thread.resolved)} />}
      <span className="cc-cmt-tools-sep" aria-hidden />
    </>
  ) : undefined;

  if (thread.resolved && hasComments && !openResolved) {
    const first = thread.comments[0];
    return (
      <div className={"cc-thread cc-thread-" + variant + " cc-thread-folded"} data-comment-thread data-comment-thread-folded>
        {header}
        <button type="button" className="cc-thread-fold" onClick={() => setOpenResolved(true)}>
          <CheckCircle2 className="cc-thread-fold-icon" />
          <span className="cc-thread-fold-text">{messageExcerpt(first.content, 120) ?? commentAuthorName(first, currentUserId, agentName)}</span>
          <span className="cc-thread-fold-count">{thread.comments.length}</span>
        </button>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={"cc-thread cc-thread-" + variant + (thread.resolved ? " cc-thread-is-resolved" : "")} data-comment-thread>
      {header}
      {hasComments && (
        <div className="cc-thread-list">
          {thread.comments.map((c, i) => (
            <Fragment key={c._id}>
              {i === firstNew && <div className="cc-thread-new" data-comment-new-line>New</div>}
              <CommentCard
                conversationId={conversationId}
                comment={c}
                continued={i !== firstNew && continuesPrevious(thread.comments[i - 1], c)}
                fresh={firstNew >= 0 && i >= firstNew && !isOwnComment(c, currentUserId)}
                currentUserId={currentUserId}
                agentType={agentType}
                replyingTo={c.parent_comment_id ? replyTargets.get(c.parent_comment_id) : undefined}
                // Thread actions act on the whole thread, so they ride on its first card.
                threadTools={i === 0 ? threadTools : undefined}
                onReply={writable ? startReply : undefined}
                onEdit={onEdit}
                onDelete={onDelete}
                onRetryAgent={askAgent}
              />
            </Fragment>
          ))}
        </div>
      )}
      {showReply && (
        <div className="cc-thread-foot">
          <button type="button" className="cc-comment-btn" onClick={() => setComposing(true)} data-comment-reply>
            <MessageSquarePlus className="w-3 h-3" /> Comment
          </button>
        </div>
      )}
      {composing && (
        <CommentComposer
          conversationId={conversationId}
          messageId={anchorKey}
          enabled
          authed={authed}
          replyTo={replyTo}
          currentUserId={currentUserId}
          onCancelReply={() => setReplyTo(null)}
          onClose={composeOnDemand ? closeComposer : undefined}
          agentType={agentType}
          autoFocus={composeOnDemand ? true : composerAutoFocus}
          className={composerClassName}
          scopeKey={scopeKey}
          mentionTeamId={mentionTeamId}
          chatMentionMode={!!mentionTeamId}
          placeholder={replyTo ? "Reply…" : placeholder ?? (hasComments ? "Reply…" : "Comment…")}
          onSubmit={(content) => {
            const sent = onAdd({ content, messageId: thread.messageId, parentCommentId: replyTo?._id, ...fileAnchor });
            if (composeOnDemand) closeComposer();
            return sent;
          }}
        />
      )}
    </div>
  );
}
