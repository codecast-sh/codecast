import { CheckCircle, MessageSquare, XCircle, Clock, Ban, Link2 } from "lucide-react";
import { ExternalEventRow } from "../feed/ExternalEventRow";
import { CommentAvatar } from "../comments/CommentAvatar";
import { CommentMarkdown } from "../comments/CommentMarkdown";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { PRCommentCard, PRComposer } from "./PRThread";
import { codeThreadRootKey } from "@codecast/shared/comments";
import { accentSoft, accentVar, externalEventRowToExternalEvent, type ExternalEventRecord } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import { copyText } from "../../lib/copyText";
import {
  REVIEW_STATE_ACCENT,
  dayLabel,
  notePlace,
  reviewLineComments,
  threadResolved,
  type CodeCommentRow,
  type PrTimelineItem,
  type PrReviewRow,
} from "../../lib/prView";

// The Conversation tab: what the PR says about itself, then everything that
// happened to it in one list, oldest first. Three kinds of thing share the
// list, events from GitHub, reviews, and comments left here, and a day
// divider keeps a long list legible.

const REVIEW_ICON: Record<string, typeof CheckCircle> = {
  approved: CheckCircle,
  changes_requested: XCircle,
  commented: MessageSquare,
  pending: Clock,
  dismissed: Ban,
};

const REVIEW_VERB: Record<string, string> = {
  approved: "approved",
  changes_requested: "requested changes",
  commented: "commented",
  pending: "is reviewing",
  dismissed: "review dismissed",
};

/** A review, with the line notes that went out inside it, each a jump to its thread. */
function ReviewItem({
  review,
  comments,
  onJump,
  linkUrl,
}: {
  review: PrReviewRow;
  comments: CodeCommentRow[];
  onJump?: (comment: CodeCommentRow) => void;
  linkUrl?: string;
}) {
  const accent = REVIEW_STATE_ACCENT[review.state] ?? "muted";
  const Icon = REVIEW_ICON[review.state] ?? MessageSquare;
  const verb = REVIEW_VERB[review.state] ?? review.state.replace(/_/g, " ");
  const notes = reviewLineComments(review, comments);
  return (
    <div
      id={`review-${review._id}`}
      className="group/review rounded-lg border px-3 py-2"
      style={{ borderColor: accentSoft(accent, 30), background: accentSoft(accent, 6) }}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <Icon className="w-3.5 h-3.5" style={{ color: accentVar(accent) }} />
        <CommentAvatar name={review.author_github_username ?? "?"} size={18} />
        <span className="font-medium text-sol-text">{review.author_github_username ?? "A reviewer"}</span>
        <span style={{ color: accentVar(accent) }}>{verb}</span>
        <span className="text-sol-text-dim">{relTimeShort(review.submitted_at)}</span>
        {linkUrl && (
          <button
            type="button"
            className="text-sol-text-dim opacity-0 group-hover/review:opacity-100 hover:text-sol-cyan transition-opacity"
            title="Copy a link to this review"
            aria-label="Copy a link to this review"
            onClick={() => void copyText(linkUrl, "Link to the review copied")}
          >
            <Link2 className="w-3 h-3" />
          </button>
        )}
        {review.html_url && (
          <a
            href={review.html_url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto text-[11px] text-sol-text-dim hover:text-sol-cyan transition-colors"
          >
            on GitHub
          </a>
        )}
      </div>
      {review.body && (
        <div className="mt-1.5 pl-6 text-[13px] text-sol-text-muted">
          <CommentMarkdown content={review.body} />
        </div>
      )}
      {notes.length > 0 && (
        <ul className="mt-2 pl-6 space-y-1">
          {notes.map((note) => (
            <li key={note._id}>
              <button
                type="button"
                className={`w-full text-left flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-sol-bg-alt/60 ${note.resolved ? "opacity-60" : ""}`}
                onClick={() => onJump?.(note)}
                title="Open this thread in Files"
              >
                <span className="font-mono text-[11px] text-sol-cyan shrink-0">{notePlace(note)}</span>
                <span className="text-[12px] text-sol-text-muted truncate">{note.content}</span>
                {note.resolved && <span className="ml-auto shrink-0 text-[10px] text-sol-green">resolved</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function PRTimeline({
  pr,
  items,
  comments,
  authed,
  onPostComment,
  onResolve,
  onNavigate,
  onJumpToThread,
  lastSeenAt,
  anchorLink,
}: {
  /** The shareable address of an item on this page, by its element id
   *  (`comment-<id>`, `review-<id>`). */
  anchorLink?: (anchor: string) => string;
  pr: any;
  items: PrTimelineItem[];
  /** Every comment on the pull request, for the notes under each review. */
  comments: CodeCommentRow[];
  authed: boolean;
  onPostComment: (content: string) => void | Promise<void>;
  onResolve: (commentId: string, resolved: boolean) => void;
  onNavigate?: (path: string) => void;
  onJumpToThread?: (comment: CodeCommentRow) => void;
  /** When the reader last had the page open: a line goes before what is new. */
  lastSeenAt?: number;
}) {
  let lastDay = "";
  // The first item newer than the last visit gets the line; none when
  // nothing is new, or when this is the first visit.
  // The description card says who opened it and when, so the "opened" event
  // would only repeat the description's first lines under it.
  const opened = pr.body ? items.find((item) => item.kind === "event" && (item.event as any).kind === "pr_opened") : undefined;
  const shown = items.filter((item) => item !== opened);
  const firstNew = lastSeenAt ? shown.find((item) => item.at > lastSeenAt)?.key : undefined;
  const openedAt = opened?.at ?? pr.github_created_at ?? pr.created_at;

  return (
    <div className="px-5 py-4">
      {pr.body ? (
        <div className="pr-rise min-w-0 rounded-xl border border-sol-border/50 bg-sol-card [overflow-wrap:anywhere]" style={{ ["--d" as string]: "220ms" }}>
          <div className="flex items-center gap-2 border-b border-sol-border/40 px-4 py-2 text-[12px] text-sol-text-muted">
            <CommentAvatar name={pr.author_github_username ?? "?"} image={pr.author_avatar_url} size={18} />
            <span className="text-sol-text">{pr.author_github_username}</span>
            <span className="text-sol-text-dim">opened this</span>
            {openedAt ? <span className="ml-auto text-[11px] text-sol-text-dim" title={new Date(openedAt).toLocaleString()}>{relTimeShort(openedAt)}</span> : null}
          </div>
          <div className="px-4 py-3">
            <MarkdownRenderer content={pr.body} />
          </div>
        </div>
      ) : (
        <p className="text-[13px] text-sol-text-dim italic">This pull request has no description.</p>
      )}

      <div className="mt-4 space-y-2">
        {shown.map((item) => {
          const day = dayLabel(item.at);
          const divider = day !== lastDay ? day : null;
          lastDay = day;
          return (
            <div key={item.key}>
              {item.key === firstNew && (
                <div className="pr-since -mx-1 mb-2 mt-4 flex items-center gap-3 py-1">
                  <span className="h-px flex-1 bg-sol-cyan/50" />
                  <span className="text-[10px] uppercase tracking-wider text-sol-cyan">Since you last looked</span>
                  <span className="h-px flex-1 bg-sol-cyan/50" />
                </div>
              )}
              {divider && (
                <div className="pr-day -mx-1 mb-2 mt-4 flex items-center gap-3 bg-sol-bg/80 py-1 first:mt-0">
                  <span className="text-[10px] uppercase tracking-wider text-sol-text-dim">{divider}</span>
                  <span className="h-px flex-1 bg-sol-border/40" />
                </div>
              )}
              {item.kind === "event" && (
                <ExternalEventRow
                  event={externalEventRowToExternalEvent(item.event as ExternalEventRecord)}
                  density="feed"
                  showActor
                  // The page is the pull request, and its sessions are named in
                  // the header and the rail: repeating them on every event is noise.
                  omitRefs={["pr", "session_id"]}
                  omitBranch={pr.head_ref}
                  onNavigate={onNavigate}
                />
              )}
              {item.kind === "review" && <ReviewItem review={item.review} comments={comments} onJump={onJumpToThread} linkUrl={anchorLink?.(`review-${item.review._id}`)} />}
              {item.kind === "comment" && (
                <div
                  id={`comment-${item.comment._id}`}
                  className={`scroll-mt-16 rounded-lg border px-3 py-2 space-y-2 ${
                    threadResolved([item.comment, ...item.replies])
                      ? "border-sol-green/30 opacity-70"
                      : "border-sol-border/50"
                  }`}
                >
                  <PRCommentCard comment={item.comment} linkUrl={anchorLink?.(`comment-${item.comment._id}`)} />
                  {item.replies.map((reply) => (
                    <div key={reply._id} id={`comment-${reply._id}`} className="pl-6">
                      <PRCommentCard comment={reply} linkUrl={anchorLink?.(`comment-${reply._id}`)} />
                    </div>
                  ))}
                  {authed && (
                    <button
                      type="button"
                      className="cc-comment-btn"
                      onClick={() =>
                        onResolve(item.comment._id, !threadResolved([item.comment, ...item.replies]))
                      }
                    >
                      {threadResolved([item.comment, ...item.replies]) ? "Unresolve" : "Resolve"}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {authed && (
        <div className="mt-4 border-t border-sol-border/50 pt-4">
          <PRComposer
            repository={pr.repository}
            threadKey={codeThreadRootKey(pr.repository, pr.head_sha ?? "", {})}
            placeholder="Comment on this pull request. It is mirrored to GitHub."
            onSubmit={onPostComment}
          />
        </div>
      )}
    </div>
  );
}
