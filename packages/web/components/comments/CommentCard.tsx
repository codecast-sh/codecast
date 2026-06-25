import { memo, useLayoutEffect, useRef, useState } from "react";
import { Reply, Pencil, Trash2, Loader2 } from "lucide-react";
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

function CommentCardImpl({
  comment,
  currentUserId,
  agentType,
  replyingToName,
  onReply,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  currentUserId?: string;
  agentType?: string;
  replyingToName?: string;
  onReply: (c: Comment) => void;
  onEdit: (commentId: string, content: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const agent = isAgentComment(comment);
  const mine = isOwnComment(comment, currentUserId);
  const name = commentAuthorName(comment, currentUserId, agentType);
  const avatar = commentAuthorAvatar(comment);
  const thinking = agent && comment.agent_status === "thinking";

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

  return (
    <div className={"cc-cmt group" + (agent ? " cc-cmt-agent" : " cc-cmt-user")}>
      <CommentAvatar name={name} image={avatar} isAgent={agent} agentType={agentType} />
      <div className="cc-cmt-main">
        <div className="cc-cmt-head">
          <span className="cc-cmt-name">{name}</span>
          {thinking ? (
            <span className="cc-cmt-thinking"><Loader2 className="w-3 h-3 animate-spin" /> thinking…</span>
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
