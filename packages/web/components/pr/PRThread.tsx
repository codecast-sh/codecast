import { useState } from "react";
import { CheckCircle2, ExternalLink, RotateCcw } from "lucide-react";
import { CommentAvatar } from "../comments/CommentAvatar";
import { CommentComposer } from "../comments/CommentComposer";
import { CommentMarkdown } from "../comments/CommentMarkdown";
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useRepositoryTeamId } from "../../hooks/useRepoBrowse";
import { relTimeShort } from "../../lib/utils";
import { useTrackedStore } from "../../store/inboxStore";
import { threadResolved, type CodeCommentRow } from "../../lib/prView";
import "../chat/chat.css";

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
      enabled
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
  repository,
  threadKey,
  comments,
  authed,
  lineNumber,
  lineEnd,
  onReply,
  onResolve,
  onClose,
}: {
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
}) {
  const [replying, setReplying] = useState(comments.length === 0);
  const resolved = threadResolved(comments);
  const span =
    lineNumber !== undefined && lineEnd !== undefined && lineEnd !== lineNumber
      ? `lines ${lineNumber} to ${lineEnd}`
      : lineNumber !== undefined
        ? `line ${lineNumber}`
        : null;

  return (
    <div
      className={`my-1 ml-2 space-y-2 border-l-2 pl-2.5 py-1.5 font-sans whitespace-normal ${
        resolved ? "border-sol-green/40 opacity-70" : "border-sol-cyan/40"
      }`}
    >
      {span && (
        <div className="text-[10px] uppercase tracking-wider text-sol-text-dim">{span}</div>
      )}
      {comments.map((comment) => (
        <PRCommentCard key={comment._id} comment={comment} />
      ))}

      {replying && authed ? (
        <PRComposer
          repository={repository}
          threadKey={threadKey}
          placeholder={comments.length ? "Reply" : `Comment on ${span ?? "this line"}`}
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
