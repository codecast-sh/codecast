import { useState } from "react";
import { CheckCircle2, ExternalLink, RotateCcw } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { CommentMarkdown } from "../comments/CommentMarkdown";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { relTimeShort } from "../../lib/utils";
import { useTrackedStore } from "../../store/inboxStore";
import { threadResolved, type CodeCommentRow } from "../../lib/prView";

// Code comments on the PR page. These are `review_comments` rows, not the
// conversation's own comments, so they cannot use the comment rail's cards —
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

export function PRComposer({
  placeholder,
  submitLabel,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  onSubmit: (content: string) => void | Promise<void>;
  onCancel?: () => void;
}) {
  const [value, setValue] = useState("");
  const send = () => {
    const content = value.trim();
    if (!content) return;
    setValue("");
    void onSubmit(content);
  };
  return (
    <div className="rounded-lg border border-sol-border/60 bg-sol-card p-2 focus-within:border-sol-cyan/50 transition-colors">
      <textarea
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
          if (e.key === "Escape" && onCancel) onCancel();
        }}
        placeholder={placeholder}
        rows={2}
        className="w-full resize-y bg-transparent px-1 py-0.5 text-[13px] text-sol-text placeholder:text-sol-text-dim focus:outline-none"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="mr-auto text-[10px] text-sol-text-dim flex items-center gap-1">
          <KeyCap size="xs">⌘</KeyCap>
          <KeyCap size="xs">↵</KeyCap>
          to post
        </span>
        {onCancel && (
          <button type="button" className="cc-comment-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="rounded-md bg-sol-cyan/15 px-2.5 py-1 text-[11px] font-medium text-sol-cyan hover:bg-sol-cyan/25 disabled:opacity-40 transition-colors"
          disabled={!value.trim()}
          onClick={send}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

export function PRCommentCard({ comment }: { comment: CodeCommentRow }) {
  const author = useAuthor(comment);
  return (
    <div className="flex gap-2">
      <CommentAvatar name={author.name} image={author.image} isAgent={author.isAgent} size={20} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-medium text-sol-text">{author.name}</span>
          <span className="text-sol-text-dim">{relTimeShort(comment.created_at)}</span>
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
        </div>
        <div className="text-[13px] text-sol-text-muted">
          <CommentMarkdown content={comment.content} />
        </div>
      </div>
    </div>
  );
}

/** One line's thread inside the diff: its comments, a reply box, and the
 *  resolve control. An empty thread renders as just the composer, which is how
 *  commenting on a fresh line works. */
export function PRLineThread({
  comments,
  authed,
  onReply,
  onResolve,
  onClose,
}: {
  comments: CodeCommentRow[];
  authed: boolean;
  onReply: (content: string) => void | Promise<void>;
  onResolve: (resolved: boolean) => void;
  onClose: () => void;
}) {
  const [replying, setReplying] = useState(comments.length === 0);
  const resolved = threadResolved(comments);

  return (
    <div
      className={`my-1 ml-2 space-y-2 border-l-2 pl-2.5 py-1.5 font-sans whitespace-normal ${
        resolved ? "border-sol-green/40 opacity-70" : "border-sol-cyan/40"
      }`}
    >
      {comments.map((comment) => (
        <PRCommentCard key={comment._id} comment={comment} />
      ))}

      {replying && authed ? (
        <PRComposer
          placeholder={comments.length ? "Reply" : "Comment on this line"}
          submitLabel={comments.length ? "Reply" : "Comment"}
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
        <div className="flex items-center gap-2">
          {authed && (
            <button type="button" className="cc-comment-btn" onClick={() => setReplying(true)}>
              Reply
            </button>
          )}
          {authed && comments.length > 0 && (
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
