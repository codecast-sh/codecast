import { memo, useLayoutEffect, useState, type ReactNode } from "react";
import { Reply, Pencil, Trash2, Loader2, RotateCcw, CheckCircle2 } from "lucide-react";
import { relTimeShort } from "../../lib/utils";
import {
  type Comment,
  agentReplyState,
  commentAuthorAvatar,
  commentAuthorName,
  isAgentComment,
  isOwnComment,
} from "../../lib/commentThread";
import { CommentAvatar } from "./CommentAvatar";
import { CommentMarkdown } from "./CommentMarkdown";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useConversationSpeaker } from "../../hooks/useLiveIdentityRow";
import { useHeldTextareaRef } from "../../lib/holdTextareaTextNode";

// One comment: avatar, name and time, the body. Reply, edit and delete float
// over the card's corner on hover, so a quiet thread is only its words. Delete
// takes a second press on the same spot.

function CommentCardImpl({
  comment,
  conversationId,
  currentUserId,
  agentType,
  replyingTo,
  onReply,
  onEdit,
  onDelete,
  onRetryAgent,
  fresh,
  continued,
  status,
  headExtra,
  extraTools,
  threadTools,
}: {
  /** The thread's own actions (ask the agent, resolve), offered in every card's hover tools. */
  threadTools?: ReactNode;
  /** Stands in for the time (a note held in a review: "not sent"). */
  status?: ReactNode;
  /** After the time in the head row (a link to the answer). */
  headExtra?: ReactNode;
  /** More hover tools before reply / edit / delete (copy link, open on GitHub). */
  extraTools?: ReactNode;
  comment: Comment;
  /** Follows the same author's previous comment: no avatar or name of its own. */
  continued?: boolean;
  /** Past the reader's read mark: drawn as news. */
  fresh?: boolean;
  /** The conversation whose agent writes the agent comments. */
  conversationId: string;
  currentUserId?: string;
  agentType?: string;
  /** The comment this one answers: its author and opening words. */
  replyingTo?: { name: string; excerpt?: string };
  onReply?: (c: Comment) => void;
  onEdit: (commentId: string, content: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
  /** Ask the agent again; offered on a reply whose hand-off failed. */
  onRetryAgent?: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const taRef = useHeldTextareaRef();

  const agent = isAgentComment(comment);
  const mine = isOwnComment(comment, currentUserId);
  const speaker = useConversationSpeaker(conversationId, agentType);
  const name = commentAuthorName(comment, currentUserId, speaker.name);
  const avatar = commentAuthorAvatar(comment);
  const state = agentReplyState(comment);
  const thinking = state === "thinking";
  const failed = state === "failed";

  useLayoutEffect(() => {
    if (!editing) return;
    const el = taRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      el.style.height = "auto";
      el.style.height = el.scrollHeight + "px";
    }
  }, [editing]);

  const cancelEdit = () => { setEditing(false); setDraft(comment.content); };
  const saveEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== comment.content) onEdit(comment._id, next);
    else setDraft(comment.content);
  };

  if (comment.event) {
    return (
      <div className={"cc-cmt cc-cmt-event" + (fresh ? " cc-cmt-new" : "")} data-comment-event>
        <div className="cc-cmt-main">
          <div className="cc-cmt-head">
            <span className="cc-cmt-name">{name}</span>
            <span className="cc-cmt-event-words">{comment.event}</span>
            <span className="cc-cmt-time">{relTimeShort(comment.created_at)}</span>
          </div>
          {comment.content && <div className="cc-cmt-body"><CommentMarkdown content={comment.content} /></div>}
        </div>
      </div>
    );
  }

  const hasTools = !editing && !thinking && (!!onReply || mine || !!extraTools || !!threadTools);
  const showHead = !continued || thinking || failed;
  const retry = failed && onRetryAgent ? (
    <button
      type="button"
      className="cc-cmt-retry"
      data-comment-agent-retry
      onClick={() => {
        // The failed placeholder is the asker's row; it gives way to the new ask.
        if (currentUserId && comment.user_id === currentUserId) void onDelete(comment._id);
        void onRetryAgent();
      }}
    >
      <RotateCcw className="w-3 h-3" /> Retry
    </button>
  ) : null;
  const tools = hasTools ? (
    <div className={"cc-cmt-tools" + (showHead ? "" : " cc-cmt-tools-float")} data-comment-tools>
      {threadTools}
      {extraTools}
      {onReply && (
        <button type="button" className="cc-cmt-tool" title="Reply" aria-label="Reply" onClick={() => onReply(comment)}>
          <Reply className="w-3.5 h-3.5" />
        </button>
      )}
      {mine && (
        <>
          <button type="button" className="cc-cmt-tool" title="Edit" aria-label="Edit" onClick={() => { setDraft(comment.content); setEditing(true); }}>
            <Pencil className="w-3.5 h-3.5" />
          </button>
          {confirmDelete ? (
            <button type="button" className="cc-cmt-tool cc-cmt-tool-confirm" data-comment-delete-confirm onClick={() => { setConfirmDelete(false); void onDelete(comment._id); }}>
              Delete
            </button>
          ) : (
            <button type="button" className="cc-cmt-tool cc-cmt-tool-danger" title="Delete" aria-label="Delete" data-comment-delete onClick={() => setConfirmDelete(true)}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </>
      )}
    </div>
  ) : null;

  return (
    <div
      className={"cc-cmt group" + (agent ? " cc-cmt-agent" : " cc-cmt-user") + (fresh ? " cc-cmt-new" : "") + (editing ? " cc-cmt-editing" : "") + (continued ? " cc-cmt-continued" : "")}
      data-comment-fresh={fresh ? "" : undefined}
      onMouseLeave={() => setConfirmDelete(false)}
    >
      {continued ? (
        <span className="cc-cmt-gutter" title={new Date(comment.created_at).toLocaleString()}>{clockTime(comment.created_at)}</span>
      ) : (
        <CommentAvatar name={name} image={avatar} isAgent={agent} agentType={agentType} identity={speaker.row} />
      )}
      <div className="cc-cmt-main">
        {showHead && <div className="cc-cmt-head">
          <span className="cc-cmt-name">{name}</span>
          {thinking ? (
            <span className="cc-cmt-thinking"><Loader2 className="w-3 h-3 animate-spin" /> thinking</span>
          ) : failed ? (
            <><span className="cc-cmt-failed">reply failed</span>{retry}</>
          ) : status ?? (
            <span className="cc-cmt-time" title={new Date(comment.created_at).toLocaleString()}>{relTimeShort(comment.created_at)}</span>
          )}
          {headExtra}
          {replyingTo && (
            <span className="cc-cmt-replying" title={`Reply to ${replyingTo.name}${replyingTo.excerpt ? `: ${replyingTo.excerpt}` : ""}`}>
              <Reply className="w-2.5 h-2.5" />
              <span><b>{replyingTo.name}</b>{replyingTo.excerpt && <> {replyingTo.excerpt}</>}</span>
            </span>
          )}
          {tools}
        </div>}
        {!showHead && tools}

        {editing ? (
          <div className="cc-cmt-edit">
            <textarea
              ref={taRef}
              value={draft}
              className="cc-cmt-textarea"
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = e.target.scrollHeight + "px";
              }}
              onKeyDown={(e) => {
                e.stopPropagation();
                // Enter saves, as Enter sends in the composer; Shift+Enter breaks the line.
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); saveEdit(); }
                else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
              }}
            />
            <div className="cc-cmt-edit-foot">
              <button type="button" className="cc-comment-btn" onMouseDown={(e) => e.preventDefault()} onClick={cancelEdit}>
                Cancel <KeyCap size="xs">Esc</KeyCap>
              </button>
              <button type="button" className="cc-comment-btn cc-comment-btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={saveEdit}>
                Save <KeyCap size="xs">↵</KeyCap>
              </button>
            </div>
          </div>
        ) : thinking && !comment.content ? null : (
          comment.content ? (
            <div className={"cc-cmt-body" + (failed ? " cc-cmt-body-failed" : "")}>
              <CommentMarkdown content={comment.content} />
            </div>
          ) : null
        )}

      </div>

    </div>
  );
}

/** Resolve / reopen a thread, as one of the cards' hover tools. */
export function ResolveTool({ resolved, onToggle }: { resolved: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={"cc-cmt-tool" + (resolved ? " cc-cmt-tool-resolved" : "")}
      onClick={onToggle}
      data-comment-resolve={resolved ? "reopen" : "resolve"}
      title={resolved ? "Reopen" : "Resolve"}
      aria-label={resolved ? "Reopen" : "Resolve"}
    >
      {resolved ? <RotateCcw className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
    </button>
  );
}

/** The hover time in a continued comment's gutter: "3:42". */
function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
}

export const CommentCard = memo(CommentCardImpl);
