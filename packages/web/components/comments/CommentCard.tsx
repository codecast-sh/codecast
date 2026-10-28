import { memo, useLayoutEffect, useRef, useState } from "react";
import { Reply, Pencil, Trash2, Loader2, RotateCcw } from "lucide-react";
import { relTimeShort } from "../../lib/utils";
import {
  type Comment,
  commentAuthorAvatar,
  commentAuthorName,
  isAgentComment,
  isOwnComment,
} from "../../lib/commentThread";
import { CommentAvatar } from "./CommentAvatar";
import { CommentMarkdown } from "./CommentMarkdown";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useConversationSpeaker } from "../../hooks/useLiveIdentityRow";

function CommentCardImpl({
  comment,
  conversationId,
  currentUserId,
  agentType,
  replyingToName,
  onReply,
  onEdit,
  onDelete,
  onRetryAgent,
  fresh,
}: {
  comment: Comment;
  /** Past the reader's read mark: drawn as news. */
  fresh?: boolean;
  /** The conversation whose agent writes the agent comments. */
  conversationId: string;
  currentUserId?: string;
  agentType?: string;
  replyingToName?: string;
  onReply: (c: Comment) => void;
  onEdit: (commentId: string, content: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
  /** Ask the agent again; offered on a reply whose hand-off failed. */
  onRetryAgent?: () => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const agent = isAgentComment(comment);
  const mine = isOwnComment(comment, currentUserId);
  const speaker = useConversationSpeaker(conversationId, agentType);
  const name = commentAuthorName(comment, currentUserId, speaker.name);
  const avatar = commentAuthorAvatar(comment);
  const thinking = agent && comment.agent_status === "thinking";
  const failed = agent && comment.agent_status === "error";

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

  return (
    <div className={"cc-cmt group" + (agent ? " cc-cmt-agent" : " cc-cmt-user") + (fresh ? " cc-cmt-new" : "")} data-comment-fresh={fresh ? "" : undefined}>
      <CommentAvatar name={name} image={avatar} isAgent={agent} agentType={agentType} identity={speaker.row} />
      <div className="cc-cmt-main">
        <div className="cc-cmt-head">
          <span className="cc-cmt-name">{name}</span>
          {thinking ? (
            <span className="cc-cmt-thinking"><Loader2 className="w-3 h-3 animate-spin" /> thinking…</span>
          ) : failed ? (
            <span className="cc-cmt-time text-sol-red">no reply</span>
          ) : (
            <span className="cc-cmt-time">{relTimeShort(comment.created_at)}</span>
          )}
        </div>

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
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveEdit(); }
                else if (e.key === "Escape") { e.preventDefault(); setEditing(false); setDraft(comment.content); }
              }}
            />
            <div className="cc-comment-editor-footer">
              <button type="button" className="cc-comment-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => { setEditing(false); setDraft(comment.content); }}>
                Cancel <KeyCap size="xs">Esc</KeyCap>
              </button>
              <button type="button" className="cc-comment-btn cc-comment-btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={saveEdit}>
                Save <span className="cc-bar-keys"><KeyCap size="xs">⌘</KeyCap><KeyCap size="xs">↵</KeyCap></span>
              </button>
            </div>
          </div>
        ) : thinking && !comment.content ? null : (
          <>
            {replyingToName && (
              <div className="cc-cmt-replying"><Reply className="w-2.5 h-2.5" /> {replyingToName}</div>
            )}
            <div className="cc-cmt-body">
              <CommentMarkdown content={comment.content} />
            </div>
            <div className="cc-cmt-actions">
              {failed && onRetryAgent && (
                <button
                  type="button"
                  className="cc-comment-btn"
                  data-comment-agent-retry
                  onClick={() => {
                    // The failed placeholder is the asker's row; it gives way to the new ask.
                    if (currentUserId && comment.user_id === currentUserId) void onDelete(comment._id);
                    void onRetryAgent();
                  }}
                >
                  <RotateCcw className="w-3 h-3" /> Retry
                </button>
              )}
              <button type="button" className="cc-comment-btn" onClick={() => onReply(comment)}>
                <Reply className="w-3 h-3" /> Reply
              </button>
              {mine && (
                <>
                  <button type="button" className="cc-comment-btn" onClick={() => { setDraft(comment.content); setEditing(true); }}>
                    <Pencil className="w-3 h-3" /> Edit
                  </button>
                  <button type="button" className="cc-comment-btn cc-comment-btn-danger" onClick={() => onDelete(comment._id)}>
                    <Trash2 className="w-3 h-3" /> Remove
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export const CommentCard = memo(CommentCardImpl);
