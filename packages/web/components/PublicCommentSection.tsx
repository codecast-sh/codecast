"use client";
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

type PublicCommentSectionProps = {
  conversationId: Id<"conversations">;
  conversationOwnerId: Id<"users">;
  currentUserId: Id<"users"> | null | undefined;
};

export function PublicCommentSection({
  conversationId,
  conversationOwnerId,
  currentUserId
}: PublicCommentSectionProps) {
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Id<"public_comments"> | null>(null);

  const comments = useQuery(api.publicComments.getPublicComments, {
    conversation_id: conversationId,
  });

  const addComment = useMutation(api.publicComments.addPublicComment);
  const deleteComment = useMutation(api.publicComments.deletePublicComment);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || isSubmitting || !currentUserId) return;

    setIsSubmitting(true);
    try {
      await addComment({
        conversation_id: conversationId,
        content: newComment.trim(),
        parent_comment_id: replyingTo || undefined,
      });
      setNewComment("");
      setReplyingTo(null);
      toast.success("Comment posted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to post comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (commentId: Id<"public_comments">) => {
    try {
      await deleteComment({ comment_id: commentId });
      toast.success("Comment deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete comment");
    }
  };

  const formatTimestamp = (ts: number) => {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric" });
  };

  const renderComment = (comment: any, depth = 0) => {
    const replies = comments?.filter((c) => c.parent_comment_id === comment._id) || [];
    const displayName = comment.user?.name || comment.user?.github_username || "Unknown";
    const avatarUrl = comment.user?.github_avatar_url || comment.user?.image;
    const canDelete = currentUserId && (
      comment.user_id.toString() === currentUserId.toString() ||
      conversationOwnerId.toString() === currentUserId.toString()
    );

    return (
      <div key={comment._id} className={`${depth > 0 ? "ml-6 mt-2" : "mt-3"}`}>
        <div className="bg-sol-bg-alt/40 border border-sol-border/30 rounded-lg p-3">
          <div className="flex items-start gap-2 mb-2">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-6 h-6 rounded-full"
              />
            ) : (
              <div className="w-6 h-6 rounded-full bg-sol-blue flex items-center justify-center text-xs text-white">
                {displayName[0]?.toUpperCase()}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sol-text-secondary text-xs font-medium">{displayName}</span>
                <span className="text-sol-text-dim text-xs">{formatTimestamp(comment.created_at)}</span>
              </div>
            </div>
            {canDelete && (
              <button
                onClick={() => handleDelete(comment._id)}
                className="text-sol-text-dim hover:text-sol-red text-xs p-1"
                title="Delete comment"
              >
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <div className="text-sol-text text-sm prose prose-invert prose-sm max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {comment.content}
            </ReactMarkdown>
          </div>
          {currentUserId && (
            <button
              onClick={() => setReplyingTo(comment._id)}
              className="text-sol-blue hover:text-sol-cyan text-xs mt-2"
            >
              Reply
            </button>
          )}
        </div>
        {replies.map((reply) => renderComment(reply, depth + 1))}
      </div>
    );
  };

  const topLevelComments = comments?.filter((c) => !c.parent_comment_id) || [];

  return (
    <div>
      {topLevelComments.length === 0 ? (
        <div className="text-sol-text-dim text-sm py-8">
          No comments yet. {currentUserId ? "Be the first to comment!" : "Sign in to comment."}
        </div>
      ) : (
        <div className="space-y-2 mb-6">
          {topLevelComments.map((comment) => renderComment(comment))}
        </div>
      )}

      {currentUserId ? (
        <div className="mt-4">
          {replyingTo && (
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sol-text-dim text-xs">Replying to comment</span>
              <button
                onClick={() => setReplyingTo(null)}
                className="text-sol-blue hover:text-sol-cyan text-xs"
              >
                Cancel
              </button>
            </div>
          )}
          <form onSubmit={handleSubmit}>
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              placeholder="Write a comment... (supports markdown)"
              className="w-full px-3 py-2 bg-sol-bg-alt border border-sol-border rounded text-sol-text text-sm placeholder:text-sol-text-dim focus:outline-none focus:ring-1 focus:ring-sol-blue resize-none"
              rows={3}
              disabled={isSubmitting}
            />
            <div className="flex justify-end mt-2">
              <button
                type="submit"
                disabled={!newComment.trim() || isSubmitting}
                className="px-4 py-2 bg-sol-blue hover:bg-sol-cyan text-white rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Posting..." : "Post Comment"}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <div className="text-sol-text-dim text-sm text-center py-4 border border-sol-border/30 rounded-lg bg-sol-bg-alt/20">
          Sign in to join the discussion
        </div>
      )}
    </div>
  );
}
