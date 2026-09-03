import { CheckCircle, MessageSquare, XCircle, Clock } from "lucide-react";
import { ExternalEventRow } from "../feed/ExternalEventRow";
import { CommentAvatar } from "../comments/CommentAvatar";
import { CommentMarkdown } from "../comments/CommentMarkdown";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { PRCommentCard, PRComposer } from "./PRThread";
import { accentSoft, accentVar, externalEventRowToExternalEvent, type ExternalEventRecord } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import {
  REVIEW_STATE_ACCENT,
  dayLabel,
  threadResolved,
  type PrTimelineItem,
  type PrReviewRow,
} from "../../lib/prView";

// The Conversation tab: what the PR says about itself, then everything that
// happened to it in one list, oldest first. Three kinds of thing share the
// list — events from GitHub, reviews, and comments left here — and a day
// divider keeps a long list legible.

const REVIEW_ICON: Record<string, typeof CheckCircle> = {
  approved: CheckCircle,
  changes_requested: XCircle,
  commented: MessageSquare,
  pending: Clock,
};

function ReviewItem({ review }: { review: PrReviewRow }) {
  const accent = REVIEW_STATE_ACCENT[review.state] ?? "muted";
  const Icon = REVIEW_ICON[review.state] ?? MessageSquare;
  const verb = review.state.replace(/_/g, " ");
  return (
    <div
      className="rounded-lg border px-3 py-2"
      style={{ borderColor: accentSoft(accent, 30), background: accentSoft(accent, 6) }}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <Icon className="w-3.5 h-3.5" style={{ color: accentVar(accent) }} />
        <CommentAvatar name={review.author_github_username ?? "?"} size={18} />
        <span className="font-medium text-sol-text">{review.author_github_username ?? "A reviewer"}</span>
        <span style={{ color: accentVar(accent) }}>{verb}</span>
        <span className="text-sol-text-dim">{relTimeShort(review.submitted_at)}</span>
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
    </div>
  );
}

export function PRTimeline({
  pr,
  items,
  authed,
  onPostComment,
  onResolve,
  onNavigate,
}: {
  pr: any;
  items: PrTimelineItem[];
  authed: boolean;
  onPostComment: (content: string) => void | Promise<void>;
  onResolve: (commentId: string, resolved: boolean) => void;
  onNavigate?: (path: string) => void;
}) {
  let lastDay = "";

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4" data-main-scroll>
        {pr.body ? (
          <div className="pr-rise rounded-xl border border-sol-border/50 bg-sol-card px-4 py-3" style={{ ["--d" as string]: "220ms" }}>
            <MarkdownRenderer content={pr.body} />
          </div>
        ) : (
          <p className="text-[13px] text-sol-text-dim italic">This pull request has no description.</p>
        )}

        <div className="mt-4 space-y-2">
          {items.map((item) => {
            const day = dayLabel(item.at);
            const divider = day !== lastDay ? day : null;
            lastDay = day;
            return (
              <div key={item.key}>
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
                    omitRefs={["pr"]}
                    onNavigate={onNavigate}
                  />
                )}
                {item.kind === "review" && <ReviewItem review={item.review} />}
                {item.kind === "comment" && (
                  <div
                    className={`rounded-lg border px-3 py-2 space-y-2 ${
                      threadResolved([item.comment, ...item.replies])
                        ? "border-sol-green/30 opacity-70"
                        : "border-sol-border/50"
                    }`}
                  >
                    <PRCommentCard comment={item.comment} />
                    {item.replies.map((reply) => (
                      <div key={reply._id} className="pl-6">
                        <PRCommentCard comment={reply} />
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
      </div>

      {authed && (
        <div className="border-t border-sol-border/50 px-5 py-3 shrink-0">
          <PRComposer
            placeholder="Comment on this pull request. It is mirrored to GitHub."
            submitLabel="Comment"
            onSubmit={onPostComment}
          />
        </div>
      )}
    </div>
  );
}
