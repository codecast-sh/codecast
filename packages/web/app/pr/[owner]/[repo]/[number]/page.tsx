"use client";

import { useState, useMemo } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AuthGuard } from "../../../../../components/AuthGuard";
import { DashboardLayout } from "../../../../../components/DashboardLayout";
import { FileDiffLayout, DiffFile } from "../../../../../components/FileDiffLayout";
import { LoadingSkeleton } from "../../../../../components/LoadingSkeleton";
import { Button } from "../../../../../components/ui/button";
import { useCurrentUser } from "../../../../../hooks/useCurrentUser";
import {
  GitPullRequest,
  GitMerge,
  ExternalLink,
  User,
  Calendar,
  ArrowLeft,
  Check,
  X,
  MessageSquare,
  Clock,
  CheckCircle,
  XCircle,
  AlertCircle,
  Send,
} from "lucide-react";
import { cn } from "../../../../../lib/utils";
import { Id } from "@codecast/convex/convex/_generated/dataModel";

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes === 1) return "1 minute ago";
  if (minutes < 60) return `${minutes} minutes ago`;
  if (hours === 1) return "1 hour ago";
  if (hours < 24) return `${hours} hours ago`;
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function PRStateBadge({ state }: { state: "open" | "closed" | "merged" }) {
  const config = {
    open: {
      icon: GitPullRequest,
      label: "Open",
      className: "bg-sol-green/20 text-sol-green border-sol-green/30",
    },
    merged: {
      icon: GitMerge,
      label: "Merged",
      className: "bg-sol-violet/20 text-sol-violet border-sol-violet/30",
    },
    closed: {
      icon: X,
      label: "Closed",
      className: "bg-sol-red/20 text-sol-red border-sol-red/30",
    },
  };

  const { icon: Icon, label, className } = config[state];

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border",
        className
      )}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </span>
  );
}

function ReviewStateIcon({ state }: { state: string }) {
  switch (state) {
    case "approved":
      return <CheckCircle className="w-4 h-4 text-sol-green" />;
    case "changes_requested":
      return <XCircle className="w-4 h-4 text-sol-red" />;
    case "commented":
      return <MessageSquare className="w-4 h-4 text-sol-blue" />;
    case "pending":
      return <Clock className="w-4 h-4 text-sol-yellow" />;
    default:
      return <AlertCircle className="w-4 h-4 text-sol-text-muted" />;
  }
}

interface ReviewComment {
  _id: Id<"review_comments">;
  file_path?: string;
  line_number?: number;
  content: string;
  resolved: boolean;
  created_at: number;
  author_github_username?: string;
  author_user_id?: Id<"users">;
}

function CommentThread({
  comments,
  onResolve,
  onUnresolve,
}: {
  comments: ReviewComment[];
  onResolve: (id: Id<"review_comments">) => void;
  onUnresolve: (id: Id<"review_comments">) => void;
}) {
  if (comments.length === 0) return null;

  const firstComment = comments[0];
  const isResolved = firstComment.resolved;

  return (
    <div
      className={cn(
        "border rounded-lg overflow-hidden",
        isResolved ? "border-sol-border/30 opacity-60" : "border-sol-border"
      )}
    >
      <div className="bg-sol-bg-alt/30 px-3 py-2 flex items-center justify-between border-b border-sol-border/50">
        <div className="text-xs text-sol-text-muted">
          {firstComment.file_path && (
            <span className="font-mono">{firstComment.file_path}</span>
          )}
          {firstComment.line_number && (
            <span className="ml-1">line {firstComment.line_number}</span>
          )}
        </div>
        <button
          onClick={() =>
            isResolved ? onUnresolve(firstComment._id) : onResolve(firstComment._id)
          }
          className={cn(
            "text-xs px-2 py-0.5 rounded",
            isResolved
              ? "text-sol-text-muted hover:text-sol-text"
              : "text-sol-green hover:bg-sol-green/20"
          )}
        >
          {isResolved ? "Unresolve" : "Resolve"}
        </button>
      </div>
      <div className="divide-y divide-sol-border/30">
        {comments.map((comment) => (
          <div key={comment._id} className="px-3 py-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-sol-text">
                {comment.author_github_username || "Unknown"}
              </span>
              <span className="text-xs text-sol-text-dim">
                {formatRelativeTime(comment.created_at)}
              </span>
            </div>
            <p className="text-sm text-sol-text-muted whitespace-pre-wrap">
              {comment.content}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewPanel({
  prId,
  onSubmitReview,
  isSubmitting,
}: {
  prId: Id<"pull_requests">;
  onSubmitReview: (event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body?: string) => void;
  isSubmitting: boolean;
}) {
  const [reviewBody, setReviewBody] = useState("");
  const [selectedAction, setSelectedAction] = useState<
    "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null
  >(null);

  const handleSubmit = () => {
    if (!selectedAction) return;
    onSubmitReview(selectedAction, reviewBody || undefined);
    setReviewBody("");
    setSelectedAction(null);
  };

  return (
    <div className="border-t border-sol-border bg-sol-bg p-4">
      <h3 className="text-sm font-medium text-sol-text mb-3">Submit Review</h3>
      <textarea
        value={reviewBody}
        onChange={(e) => setReviewBody(e.target.value)}
        placeholder="Leave a comment (optional)"
        className="w-full h-20 px-3 py-2 text-sm border border-sol-border rounded-lg bg-sol-bg-alt resize-none focus:outline-none focus:ring-2 focus:ring-sol-violet/50"
      />
      <div className="flex items-center gap-2 mt-3">
        <Button
          variant={selectedAction === "COMMENT" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedAction("COMMENT")}
          className={cn(
            selectedAction === "COMMENT" && "bg-sol-blue text-white"
          )}
        >
          <MessageSquare className="w-3 h-3 mr-1" />
          Comment
        </Button>
        <Button
          variant={selectedAction === "APPROVE" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedAction("APPROVE")}
          className={cn(
            selectedAction === "APPROVE" && "bg-sol-green text-white"
          )}
        >
          <Check className="w-3 h-3 mr-1" />
          Approve
        </Button>
        <Button
          variant={selectedAction === "REQUEST_CHANGES" ? "default" : "outline"}
          size="sm"
          onClick={() => setSelectedAction("REQUEST_CHANGES")}
          className={cn(
            selectedAction === "REQUEST_CHANGES" && "bg-sol-red text-white"
          )}
        >
          <X className="w-3 h-3 mr-1" />
          Request Changes
        </Button>
        <div className="flex-1" />
        <Button
          size="sm"
          disabled={!selectedAction || isSubmitting}
          onClick={handleSubmit}
          className="bg-sol-violet hover:bg-sol-violet/90"
        >
          <Send className="w-3 h-3 mr-1" />
          {isSubmitting ? "Submitting..." : "Submit Review"}
        </Button>
      </div>
    </div>
  );
}

function PRContent() {
  const params = useParams();
  const owner = params.owner as string;
  const repo = params.repo as string;
  const number = parseInt(params.number as string, 10);
  const repository = `${owner}/${repo}`;

  const { user } = useCurrentUser();
  const pr = useQuery(api.pull_requests.getPRByNumber, { repository, number });
  const reviews = useQuery(
    api.reviews.getReviewsForPR,
    pr ? { pull_request_id: pr._id } : "skip"
  );
  const comments = useQuery(
    api.reviews.getCommentsForPR,
    pr ? { pull_request_id: pr._id } : "skip"
  );

  const submitReview = useAction(api.reviews.submitReview);
  const resolveComment = useMutation(api.reviews.resolveComment);
  const unresolveComment = useMutation(api.reviews.unresolveComment);
  const addComment = useMutation(api.reviews.addCommentToPR);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [commentingFile, setCommentingFile] = useState<string | null>(null);
  const [newComment, setNewComment] = useState("");

  const handleSubmitReview = async (
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string
  ) => {
    if (!pr || !user?.github_access_token) return;

    setIsSubmitting(true);
    try {
      await submitReview({
        pull_request_id: pr._id,
        reviewer_user_id: user._id,
        event,
        body,
        github_access_token: user.github_access_token,
      });
    } catch (e) {
      console.error("Failed to submit review:", e);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResolveComment = async (id: Id<"review_comments">) => {
    await resolveComment({ comment_id: id });
  };

  const handleUnresolveComment = async (id: Id<"review_comments">) => {
    await unresolveComment({ comment_id: id });
  };

  const handleAddComment = async (filename: string) => {
    if (!pr || !user || !newComment.trim()) return;

    await addComment({
      pull_request_id: pr._id,
      author_user_id: user._id,
      file_path: filename,
      content: newComment.trim(),
    });
    setNewComment("");
    setCommentingFile(null);
  };

  const groupedComments = useMemo(() => {
    if (!comments) return new Map<string, ReviewComment[]>();
    const grouped = new Map<string, ReviewComment[]>();

    for (const comment of comments) {
      const key = comment.file_path || "_general";
      if (!grouped.has(key)) {
        grouped.set(key, []);
      }
      grouped.get(key)!.push(comment as ReviewComment);
    }

    return grouped;
  }, [comments]);

  if (pr === undefined) {
    return <LoadingSkeleton />;
  }

  if (!pr) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-sol-text-muted">
        <GitPullRequest className="w-12 h-12 mb-4 opacity-30" />
        <h2 className="text-lg font-medium mb-2">Pull request not found</h2>
        <p className="text-sm mb-4">
          PR #{number} in{" "}
          <code className="font-mono text-sol-violet">{repository}</code> was not found.
        </p>
        <a
          href={`https://github.com/${repository}/pull/${number}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Button variant="outline">
            <ExternalLink className="w-4 h-4 mr-2" />
            View on GitHub
          </Button>
        </a>
      </div>
    );
  }

  const files: DiffFile[] = (pr.files || []).map((f) => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    patch: f.patch,
  }));

  const githubUrl = `https://github.com/${repository}/pull/${number}`;

  return (
    <div className="h-full flex flex-col">
      {/* PR Header */}
      <div className="px-4 py-3 border-b border-sol-border bg-sol-bg-alt/30 shrink-0">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-sol-green to-sol-green/80 flex items-center justify-center shrink-0">
            <GitPullRequest className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <PRStateBadge state={pr.state} />
                  <span className="text-sm text-sol-text-muted">#{pr.number}</span>
                </div>
                <h2 className="text-base font-semibold text-sol-text leading-snug">
                  {pr.title}
                </h2>
              </div>
              <a
                href={githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0"
              >
                <Button variant="outline" size="sm" className="h-8">
                  <ExternalLink className="w-3 h-3 mr-1.5" />
                  GitHub
                </Button>
              </a>
            </div>

            {pr.body && (
              <p className="mt-2 text-sm text-sol-text-muted line-clamp-2">{pr.body}</p>
            )}

            <div className="flex items-center gap-4 mt-3 text-xs text-sol-text-muted flex-wrap">
              <div className="flex items-center gap-1">
                <User className="w-3 h-3" />
                <span>{pr.author_github_username}</span>
              </div>
              {pr.head_ref && pr.base_ref && (
                <div className="flex items-center gap-1 font-mono">
                  <span className="text-sol-cyan">{pr.head_ref}</span>
                  <span className="text-sol-text-dim">into</span>
                  <span className="text-sol-violet">{pr.base_ref}</span>
                </div>
              )}
              <div className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                <span>{formatDate(pr.created_at)}</span>
              </div>
              {pr.additions !== undefined && pr.deletions !== undefined && (
                <div className="flex items-center gap-2">
                  <span className="text-sol-green font-medium">+{pr.additions}</span>
                  <span className="text-sol-red font-medium">-{pr.deletions}</span>
                  {pr.changed_files && (
                    <span className="text-sol-text-dim">
                      ({pr.changed_files} {pr.changed_files === 1 ? "file" : "files"})
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Linked Sessions */}
            {pr.linked_session_ids.length > 0 && (
              <div className="mt-2 flex items-center gap-2 flex-wrap">
                <span className="text-xs text-sol-text-dim">Linked sessions:</span>
                {pr.linked_session_ids.slice(0, 3).map((sessionId) => (
                  <Link
                    key={sessionId}
                    href={`/conversation/${sessionId}`}
                    className="text-xs text-sol-yellow hover:underline"
                  >
                    View session
                  </Link>
                ))}
                {pr.linked_session_ids.length > 3 && (
                  <span className="text-xs text-sol-text-dim">
                    +{pr.linked_session_ids.length - 3} more
                  </span>
                )}
              </div>
            )}

            {/* Reviews */}
            {reviews && reviews.length > 0 && (
              <div className="mt-2 flex items-center gap-3">
                <span className="text-xs text-sol-text-dim">Reviews:</span>
                {reviews.map((review) => (
                  <div
                    key={review._id}
                    className="flex items-center gap-1 text-xs"
                    title={`${review.state} - ${formatRelativeTime(review.submitted_at)}`}
                  >
                    <ReviewStateIcon state={review.state} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0">
          <FileDiffLayout
            files={files}
            title={`PR #${pr.number}`}
            subtitle={
              <span className="text-sm text-sol-text-muted font-mono">{repository}</span>
            }
            onFileComment={(filename) => setCommentingFile(filename)}
            renderFileExtra={(file) => {
              const fileComments = groupedComments.get(file.filename) || [];
              return (
                <div className="px-4 pb-4 space-y-3">
                  {fileComments.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="text-xs font-medium text-sol-text-muted">
                        Comments ({fileComments.length})
                      </h4>
                      <CommentThread
                        comments={fileComments}
                        onResolve={handleResolveComment}
                        onUnresolve={handleUnresolveComment}
                      />
                    </div>
                  )}

                  {commentingFile === file.filename && (
                    <div className="border border-sol-border rounded-lg p-3">
                      <textarea
                        value={newComment}
                        onChange={(e) => setNewComment(e.target.value)}
                        placeholder="Add a comment..."
                        className="w-full h-16 px-2 py-1 text-sm border border-sol-border rounded bg-sol-bg-alt resize-none focus:outline-none focus:ring-2 focus:ring-sol-violet/50"
                        autoFocus
                      />
                      <div className="flex justify-end gap-2 mt-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setCommentingFile(null);
                            setNewComment("");
                          }}
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => handleAddComment(file.filename)}
                          disabled={!newComment.trim()}
                        >
                          Add Comment
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            }}
          />
        </div>
      </div>

      {/* Review Panel */}
      {pr.state === "open" && user?.github_access_token && (
        <ReviewPanel
          prId={pr._id}
          onSubmitReview={handleSubmitReview}
          isSubmitting={isSubmitting}
        />
      )}
    </div>
  );
}

export default function PRPage() {
  const params = useParams();
  const owner = params.owner as string;
  const repo = params.repo as string;
  const number = params.number as string;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-[calc(100vh-56px)] flex flex-col">
          <div className="px-4 py-2 border-b border-sol-border bg-sol-bg flex items-center gap-3 shrink-0">
            <Link href="/timeline">
              <Button variant="ghost" size="sm" className="h-8">
                <ArrowLeft className="w-4 h-4 mr-1" />
                Timeline
              </Button>
            </Link>
            <div className="text-sm text-sol-text-muted">
              <span className="font-mono">
                {owner}/{repo}
              </span>
              <span className="mx-2 text-sol-text-dim">/</span>
              <span>PR #{number}</span>
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <PRContent />
          </div>
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
