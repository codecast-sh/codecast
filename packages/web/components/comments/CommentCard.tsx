import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Reply, Pencil, Trash2, Check, X } from "lucide-react";
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

function CommentCardImpl({
  comment,
  currentUserId,
  agentType,
  onReply,
  onEdit,
  onDelete,
}: {
  comment: Comment;
  currentUserId?: string;
  agentType?: string;
  onReply: (c: Comment) => void;
  onEdit: (commentId: string, content: string) => void | Promise<void>;
  onDelete: (commentId: string) => void | Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const agent = isAgentComment(comment);
  const mine = isOwnComment(comment, currentUserId);
  const name = commentAuthorName(comment, currentUserId);
  const avatar = commentAuthorAvatar(comment);
  const thinking = agent && comment.agent_status === "thinking";

  // Live elapsed counter while the agent works — concrete proof it's running (the
  // first reply pays a real session spin-up, so this can run a while).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!thinking) return;
    const iv = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(iv);
  }, [thinking]);
  const elapsed = thinking ? Math.max(0, Math.floor((Date.now() - comment.created_at) / 1000)) : 0;
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;

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
    <div className={"cc-cmt group" + (agent ? " cc-cmt-agent" : "")}>
      <CommentAvatar name={name} image={avatar} isAgent={agent} agentType={agentType} />
      <div className="cc-cmt-main">
        <div className="cc-cmt-head">
          <span className={"cc-cmt-name" + (agent ? " text-sol-violet" : "")}>{name}</span>
          {!thinking && <span className="cc-cmt-time">{relTimeShort(comment.created_at)}</span>}
          {thinking && (
            <span className="cc-cmt-thinking">
              drafting<span className="cc-dots"><i /><i /><i /></span>
              <span className="cc-cmt-elapsed">{elapsedLabel}</span>
            </span>
          )}

          {!editing && !thinking && (
            <span className="cc-cmt-actions">
              <button type="button" className="cc-cmt-act" title="Reply" onClick={() => onReply(comment)}>
                <Reply className="w-3 h-3" />
              </button>
              {mine && (
                <>
                  <button
                    type="button"
                    className="cc-cmt-act"
                    title="Edit"
                    onClick={() => { setDraft(comment.content); setEditing(true); }}
                  >
                    <Pencil className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    className="cc-cmt-act cc-cmt-act-danger"
                    title="Delete"
                    onClick={() => onDelete(comment._id)}
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </>
              )}
            </span>
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
            <div className="cc-cmt-edit-foot">
              <button type="button" className="cc-cmt-mini" onMouseDown={(e) => e.preventDefault()} onClick={() => { setEditing(false); setDraft(comment.content); }}>
                <X className="w-3 h-3" /> Cancel
              </button>
              <button type="button" className="cc-cmt-mini cc-cmt-mini-primary" onMouseDown={(e) => e.preventDefault()} onClick={saveEdit}>
                <Check className="w-3 h-3" /> Save
              </button>
            </div>
          </div>
        ) : thinking && !comment.content ? (
          <div className="cc-cmt-body cc-cmt-shimmer">Drafting a reply from the thread…</div>
        ) : (
          <div className="cc-cmt-body">
            <CommentMarkdown content={comment.content} />
          </div>
        )}
      </div>
    </div>
  );
}

export const CommentCard = memo(CommentCardImpl);
