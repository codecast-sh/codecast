import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, CornerDownRight, ExternalLink, Link2, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { CommentComposer } from "../comments/CommentComposer";
import { CommentMarkdown } from "../comments/CommentMarkdown";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useRepositoryTeamId } from "../../hooks/useRepoBrowse";
import { relTimeShort } from "../../lib/utils";
import { copyText } from "../../lib/copyText";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { isOptimisticComment, threadResolved, type CodeCommentRow } from "../../lib/prView";
import { AnchorPlacementNote, placementBorderClass } from "../comments/AnchorPlacementNote";
import type { AnchorPlacement } from "@codecast/shared/comments";
import "../chat/chat.css";

/** Where a new line note goes: into the reader's review, or straight out. */
export type NoteMode = "review" | "now";

// Code comments on the PR page. These are `review_comments` rows, not the
// conversation's own comments, so they cannot use the comment rail's cards
// but they read the same: one avatar, one name, one relative time, a markdown
// body, and the thread's own resolve control.

/** Who wrote it: the GitHub login when GitHub sent it, otherwise the teammate
 *  from the live roster, so a name change shows up without a round trip. */
function useAuthor(comment: CodeCommentRow): { name: string; image?: string; isAgent: boolean } {
  const s = useTrackedStore([(st: any) => st.teamMembers?.length ?? 0]);
  if (comment.author_kind === "agent") return { name: "Agent", isAgent: true };
  if (comment.author_github_username) {
    return { name: comment.author_github_username, image: comment.author_avatar_url, isAgent: false };
  }
  const member = (s as any).teamMembers?.find((m: any) => m?._id === comment.author_user_id);
  return {
    name: member?.name || member?.github_username || "Someone",
    image: comment.author_avatar_url || member?.image || member?.github_avatar_url,
    isAgent: false,
  };
}

/**
 * The composer for a comment on code. The conversation's own MessageInput
 * underneath (mentions of teammates and sessions, image paste, drafts), scoped
 * to the team that owns the repository, keyed by the thread it writes into.
 */
export function PRComposer({
  repository,
  threadKey,
  placeholder,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  repository: string;
  /** The thread's identity (codeThreadRootKey): the draft lives under it. */
  threadKey: string;
  placeholder: string;
  autoFocus?: boolean;
  onSubmit: (content: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const { isAuthenticated } = useCurrentUser();
  const teamId = useRepositoryTeamId(repository);
  return (
    <CommentComposer
      conversationId={threadKey}
      // Typing presence is a conversation feature: the presence query only
      // knows syncable entities, and a thread on code is not one.
      enabled={false}
      authed={isAuthenticated}
      mentionTeamId={teamId}
      chatMentionMode
      placeholder={placeholder}
      autoFocus={autoFocus}
      className="ch-composer"
      onSubmit={onSubmit}
      onClose={onCancel}
    />
  );
}

export function PRCommentCard({ comment, linkUrl }: {
  comment: CodeCommentRow;
  /** This comment's own address, offered as a copy on hover. */
  linkUrl?: string;
}) {
  const author = useAuthor(comment);
  const { user } = useCurrentUser();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.content);
  const mine = !!user && comment.author_user_id === user._id && !isOptimisticComment(comment._id);
  const pending = !!comment.pending_review;

  return (
    <div className={`group/card flex gap-2 ${pending ? "pr-pending -ml-2.5 pl-2 border-l-2 rounded-r" : ""}`}>
      <CommentAvatar name={author.name} image={author.image} isAgent={author.isAgent} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-medium text-sol-text">{author.name}</span>
          {pending ? (
            <span className="rounded-full border border-dashed border-sol-yellow/60 px-1.5 text-[10px] text-sol-yellow" title="Held in your review. Only you can see it until you finish the review.">
              not sent
            </span>
          ) : (
            <span className="text-sol-text-dim">{relTimeShort(comment.created_at)}</span>
          )}
          {comment.answered_message_id && comment.sent_to_conversation_id && (
            <Link
              href={`/conversation/${comment.sent_to_conversation_id}#msg-${comment.answered_message_id}`}
              className="inline-flex items-center gap-1 rounded-full border border-sol-green/40 px-1.5 text-[10px] text-sol-green hover:bg-sol-green/10 transition-colors"
              title="The agent answered this note: jump to its reply"
            >
              <CornerDownRight className="w-2.5 h-2.5" />
              answered
            </Link>
          )}
          {linkUrl && (
            <button
              type="button"
              className="text-sol-text-dim opacity-0 group-hover/card:opacity-100 hover:text-sol-cyan transition-opacity"
              title="Copy a link to this comment"
              aria-label="Copy a link to this comment"
              onClick={() => void copyText(linkUrl, "Link to the comment copied")}
            >
              <Link2 className="w-3 h-3" />
            </button>
          )}
          {comment.html_url && (
            <a
              href={comment.html_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sol-text-dim hover:text-sol-cyan transition-colors"
              title="Open this comment on GitHub"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {mine && !editing && (
            <span className="ml-auto flex items-center gap-1 opacity-0 group-hover/thread:opacity-100 transition-opacity">
              <button type="button" className="text-sol-text-dim hover:text-sol-text" title="Edit" onClick={() => { setText(comment.content); setEditing(true); }}>
                <Pencil className="w-3 h-3" />
              </button>
              <button type="button" className="text-sol-text-dim hover:text-sol-red" title="Delete" onClick={() => useInboxStore.getState().deleteCodeComment(comment._id)}>
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          )}
        </div>
        {editing ? (
          <form
            className="mt-1 space-y-1.5"
            onSubmit={async (e) => {
              e.preventDefault();
              const content = text.trim();
              if (content && content !== comment.content) useInboxStore.getState().editCodeComment(comment._id, content);
              setEditing(false);
            }}
          >
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              className="w-full resize-none rounded-md border border-sol-border/60 bg-sol-bg-alt/40 px-2 py-1.5 text-[13px] text-sol-text focus:border-sol-cyan focus:outline-none"
              onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
            />
            <div className="flex gap-2">
              <button type="submit" className="cc-comment-btn">Save</button>
              <button type="button" className="cc-comment-btn" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <div className="text-[13px] text-sol-text-muted">
            <CommentMarkdown content={comment.content} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The two places a new note can go, as one small switch above the composer. */
export function NoteModePill({ mode, onChange, pendingCount }: { mode: NoteMode; onChange: (m: NoteMode) => void; pendingCount: number }) {
  return (
    <div className="inline-flex items-center rounded-full border border-sol-border/50 p-0.5 text-[10px]" role="radiogroup" aria-label="Where this note goes">
      {(["review", "now"] as NoteMode[]).map((key) => {
        const active = mode === key;
        return (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(key)}
            className={`rounded-full px-2 py-0.5 transition-colors ${active ? (key === "review" ? "bg-sol-yellow/15 text-sol-yellow" : "bg-sol-cyan/15 text-sol-cyan") : "text-sol-text-dim hover:text-sol-text"}`}
            title={key === "review" ? "Held in your review, visible only to you, until you finish the review" : "Posted to GitHub at once, where everyone sees it"}
          >
            {key === "review" ? (pendingCount ? `Add to review · ${pendingCount}` : "Start a review") : "Post now"}
          </button>
        );
      })}
    </div>
  );
}

/** One line's thread inside the diff: its comments, a reply box, and the
 *  resolve control. An empty thread renders as just the composer, which is how
 *  commenting on a fresh line works. */
export function PRLineThread({
  repository,
  threadKey,
  comments,
  authed,
  lineNumber,
  lineEnd,
  onReply,
  onResolve,
  onClose,
  noteMode,
  onNoteMode,
  pendingCount = 0,
  landed,
  onFinishReview,
  linkHref,
  onSelectLines,
  placement,
}: {
  /** Where the thread's passage is now, when it moved or is gone. */
  placement?: AnchorPlacement | null;
  /** The address of the lines this thread is on, and selecting them. */
  linkHref?: string;
  onSelectLines?: () => void;
  repository: string;
  /** The thread's identity (codeThreadRootKey), for the composer's draft. */
  threadKey: string;
  comments: CodeCommentRow[];
  authed: boolean;
  /** The lines this thread covers, so a reader can see what a range comment is
   *  about without counting rows. */
  lineNumber?: number;
  lineEnd?: number;
  onReply: (content: string) => void | Promise<void>;
  onResolve: (resolved: boolean) => void;
  onClose: () => void;
  /** Where a new note on a fresh line goes. Absent on surfaces with no review. */
  noteMode?: NoteMode;
  onNoteMode?: (mode: NoteMode) => void;
  pendingCount?: number;
  /** The reader just jumped here: light it for a moment. */
  landed?: boolean;
  /** Open the review, from a thread that is still only in it. */
  onFinishReview?: () => void;
}) {
  const [replying, setReplying] = useState(comments.length === 0);
  const resolved = threadResolved(comments);
  const pending = comments.length > 0 && comments.every((c) => c.pending_review);
  // A moved thread names the lines it sits on now; the note says where from.
  const shownStart = placement?.state === "moved" ? placement.line : lineNumber;
  const shownEnd = placement?.state === "moved" ? placement.lineEnd : lineEnd;
  const span =
    shownStart !== undefined && shownEnd !== undefined && shownEnd !== shownStart
      ? `lines ${shownStart} to ${shownEnd}`
      : shownStart !== undefined
        ? `line ${shownStart}`
        : null;

  return (
    <div
      className={`group/thread my-1 ml-2 space-y-2 border-l-2 pl-2.5 py-1.5 font-sans whitespace-normal ${
        pending ? "pr-pending" : resolved ? "border-sol-green/40 opacity-70" : placementBorderClass(placement) ?? "border-sol-cyan/40"
      } ${landed ? "pr-thread-landed" : ""}`}
    >
      <div className="flex items-center gap-2">
        {span && (linkHref ? (
          <a
            href={linkHref}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !onSelectLines) return;
              e.preventDefault();
              onSelectLines();
            }}
            className="text-[10px] uppercase tracking-wider text-sol-text-dim hover:text-sol-cyan transition-colors"
            title="Select these lines; the address then points at this thread"
          >
            {span}
          </a>
        ) : (
          <div className="text-[10px] uppercase tracking-wider text-sol-text-dim">{span}</div>
        ))}
        {noteMode && onNoteMode && (comments.length === 0 || replying) && (
          <span className="ml-auto"><NoteModePill mode={noteMode} onChange={onNoteMode} pendingCount={pendingCount} /></span>
        )}
      </div>
      <AnchorPlacementNote placement={placement} anchorLines={comments.find((c) => c.anchor_lines)?.anchor_lines} />
      {comments.map((comment) => (
        <PRCommentCard key={comment._id} comment={comment} />
      ))}

      {replying && authed ? (
        <PRComposer
          repository={repository}
          threadKey={threadKey}
          placeholder={
            comments.length
              ? noteMode === "review" ? "Reply, held for your review" : "Reply"
              : noteMode === "review" ? `Note on ${span ?? "this line"} for your review` : `Comment on ${span ?? "this line"}`
          }
          autoFocus
          onSubmit={async (content) => {
            await onReply(content);
            setReplying(false);
            if (comments.length === 0) onClose();
          }}
          onCancel={() => {
            setReplying(false);
            if (comments.length === 0) onClose();
          }}
        />
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          {authed && (
            <button type="button" className="cc-comment-btn" onClick={() => setReplying(true)}>
              Reply
            </button>
          )}
          {pending && (
            <span className="ml-auto text-[11px] text-sol-text-dim">
              Only you can see this. It goes out when you{" "}
              {onFinishReview ? (
                <button type="button" className="text-sol-yellow hover:underline underline-offset-2" onClick={onFinishReview}>
                  finish your review
                </button>
              ) : "finish your review"}
              .
            </span>
          )}
          {authed && comments.length > 0 && !pending && (
            <button type="button" className="cc-comment-btn" onClick={() => onResolve(!resolved)}>
              {resolved ? (
                <>
                  <RotateCcw className="w-3 h-3" /> Unresolve
                </>
              ) : (
                <>
                  <CheckCircle2 className="w-3 h-3" /> Resolve
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
