import { CheckCircle, Clock, MessageSquare, Radio, XCircle } from "lucide-react";
import { FeedCard } from "../ActivityFeed";
import { EntityIdPill } from "../EntityIdPill";
import { CommentAvatar } from "../comments/CommentAvatar";
import { accentVar } from "../../lib/externalEvents";
import { relTimeShort } from "../../lib/utils";
import { REVIEW_STATE_ACCENT, type PrReviewRow } from "../../lib/prView";

// The right rail: everything about this PR that is not the PR — the sessions
// working it, the tasks it closes, the people who owe it a review, and what
// the shepherd last woke for.

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3 border-b border-sol-border/30 last:border-none">
      <h2 className="mb-2 text-[10px] uppercase tracking-wider text-sol-text-dim">{title}</h2>
      {children}
    </section>
  );
}

const REVIEW_ICON: Record<string, typeof CheckCircle> = {
  approved: CheckCircle,
  changes_requested: XCircle,
  commented: MessageSquare,
  pending: Clock,
};

function Reviewer({
  login,
  state,
}: {
  login: string;
  state?: string;
}) {
  const accent = state ? REVIEW_STATE_ACCENT[state] ?? "muted" : "muted";
  const Icon = state ? REVIEW_ICON[state] ?? MessageSquare : Clock;
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <CommentAvatar name={login} size={18} />
      <span className="text-sol-text-muted truncate">{login}</span>
      <Icon className="w-3.5 h-3.5 ml-auto shrink-0" style={{ color: accentVar(accent) }} />
    </div>
  );
}

export function PRRail({
  pr,
  sessions,
  reviews,
  onOpenSession,
}: {
  pr: any;
  sessions: any[];
  reviews: PrReviewRow[];
  onOpenSession: (id: string) => void;
}) {
  const shepherdId = pr.shepherd_conversation_id as string | undefined;
  const ordered = [...sessions].sort((a, b) => {
    if (a._id === shepherdId) return -1;
    if (b._id === shepherdId) return 1;
    return (b.updated_at ?? 0) - (a.updated_at ?? 0);
  });

  // The newest review per person is that person's standing opinion.
  const latestByReviewer = new Map<string, PrReviewRow>();
  for (const review of [...reviews].sort((a, b) => a.submitted_at - b.submitted_at)) {
    if (review.author_github_username) latestByReviewer.set(review.author_github_username, review);
  }
  const requested: string[] = (pr.requested_reviewers ?? []).filter(
    (login: string) => !latestByReviewer.has(login),
  );

  const taskIds: string[] = pr.task_ids ?? [];

  return (
    <div className="h-full overflow-y-auto">
      {ordered.length > 0 && (
        <Section title={`Sessions (${ordered.length})`}>
          <div className="space-y-1.5">
            {ordered.map((session) => (
              <div key={session._id}>
                {session._id === shepherdId && (
                  <div className="mb-1 flex items-center gap-1 text-[10px] text-sol-cyan">
                    <Radio className="w-3 h-3" /> Shepherd
                  </div>
                )}
                <FeedCard conv={session} showActor={false} onNavigate={() => onOpenSession(session._id)} />
              </div>
            ))}
          </div>
        </Section>
      )}

      {taskIds.length > 0 && (
        <Section title={`Tasks (${taskIds.length})`}>
          <div className="flex flex-wrap gap-1.5">
            {taskIds.map((id) => (
              <EntityIdPill key={id} id={id} type="task" />
            ))}
          </div>
        </Section>
      )}

      {(latestByReviewer.size > 0 || requested.length > 0) && (
        <Section title="Reviewers">
          <div className="space-y-1.5">
            {[...latestByReviewer.values()].map((review) => (
              <Reviewer
                key={review.author_github_username}
                login={review.author_github_username!}
                state={review.state}
              />
            ))}
            {requested.map((login) => (
              <Reviewer key={login} login={login} />
            ))}
          </div>
        </Section>
      )}

      {pr.shepherd_last_wake_at && (
        <Section title="Shepherd log">
          <div className="space-y-1 text-[12px] text-sol-text-muted">
            <div className="flex items-center gap-2">
              <span className="text-sol-text-dim">Last woke</span>
              <span>{relTimeShort(pr.shepherd_last_wake_at)}</span>
            </div>
            {pr.shepherd_last_wake_reason && (
              <p className="text-[12px] text-sol-text-muted">{pr.shepherd_last_wake_reason}</p>
            )}
            <div className="text-[11px] text-sol-text-dim">
              {pr.shepherd_wake_count ?? 0} wakes in all
            </div>
          </div>
        </Section>
      )}
    </div>
  );
}
