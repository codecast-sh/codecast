import { Ban, CheckCircle, Clock, MessageSquare, XCircle } from "lucide-react";
import { EntityIdPill } from "../EntityIdPill";
import { CommentAvatar } from "../comments/CommentAvatar";
import { accentVar } from "../../lib/externalEvents";
import { REVIEW_STATE_ACCENT, type PrReviewRow } from "../../lib/prView";

// What surrounds the pull request, said inline in the header: who has
// reviewed it (and who still owes a review), and the sessions and tasks it is
// linked to. It lives in the header rather than in a column of its own, so a
// pull request with nothing linked costs no width at all.

const REVIEW_ICON: Record<string, typeof CheckCircle> = {
  approved: CheckCircle,
  changes_requested: XCircle,
  commented: MessageSquare,
  pending: Clock,
  dismissed: Ban,
};

const REVIEW_WORD: Record<string, string> = {
  approved: "approved",
  changes_requested: "requested changes",
  commented: "commented",
  pending: "is reviewing",
  dismissed: "was dismissed",
};

/** The newest review per person is that person's standing opinion. */
function latestReviews(reviews: PrReviewRow[]): PrReviewRow[] {
  const latest = new Map<string, PrReviewRow>();
  for (const review of [...reviews].sort((a, b) => a.submitted_at - b.submitted_at)) {
    if (review.author_github_username) latest.set(review.author_github_username, review);
  }
  return [...latest.values()];
}

/** Each reviewer with their verdict, then everyone asked who has not answered. */
export function PRReviewers({ pr, reviews }: { pr: any; reviews: PrReviewRow[] }) {
  const latest = latestReviews(reviews);
  const answered = new Set(latest.map((r) => r.author_github_username));
  const waiting: string[] = (pr.requested_reviewers ?? []).filter((login: string) => !answered.has(login));
  if (latest.length === 0 && waiting.length === 0) return null;
  return (
    <span className="flex items-center gap-3 flex-wrap">
      {latest.map((review) => {
        const Icon = REVIEW_ICON[review.state] ?? MessageSquare;
        const accent = REVIEW_STATE_ACCENT[review.state] ?? "muted";
        return (
          <span
            key={review.author_github_username}
            className="inline-flex items-center gap-1.5"
            title={`${review.author_github_username} ${REVIEW_WORD[review.state] ?? review.state}`}
          >
            <CommentAvatar name={review.author_github_username!} size={16} />
            <span className="text-sol-text-muted">{review.author_github_username}</span>
            <Icon className="w-3.5 h-3.5" style={{ color: accentVar(accent) }} />
          </span>
        );
      })}
      {waiting.map((login) => (
        <span key={login} className="inline-flex items-center gap-1.5 opacity-70" title={`${login} was asked to review`}>
          <CommentAvatar name={login} size={16} />
          <span className="text-sol-text-dim">{login}</span>
          <Clock className="w-3.5 h-3.5 text-sol-text-dim" />
        </span>
      ))}
    </span>
  );
}

/** The sessions that worked on it (the shepherd has its own line) and the
 *  tasks it closes, as pills that open them. */
export function PRLinked({ pr, sessionIds }: { pr: any; sessionIds: string[] }) {
  const shepherd = pr.shepherd_conversation_id as string | undefined;
  const sessions = sessionIds.filter((id) => id !== shepherd);
  const tasks: string[] = pr.task_ids ?? [];
  if (sessions.length === 0 && tasks.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 flex-wrap text-[11px]">
      <span className="text-sol-text-dim">Linked</span>
      {sessions.map((id) => (
        <EntityIdPill key={id} id={id} type="session" />
      ))}
      {tasks.map((id) => (
        <EntityIdPill key={id} id={id} type="task" />
      ))}
    </span>
  );
}
