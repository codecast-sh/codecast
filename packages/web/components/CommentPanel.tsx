"use client";
import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

type CommentPanelProps = {
  conversationId: Id<"conversations">;
  messageId?: Id<"messages">;
  onClose: () => void;
};

export function CommentPanel({ conversationId, messageId, onClose }: CommentPanelProps) {
  const [newComment, setNewComment] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Id<"comments"> | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [showMentions, setShowMentions] = useState(false);
  const [mentionCursorPos, setMentionCursorPos] = useState(0);
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const comments = useQuery(api.comments.getComments, {
    conversation_id: conversationId,
    message_id: messageId,
  });

  const conversation = useQuery(api.conversations.getConversation, { id: conversationId });
  const teamMembers = useQuery(
    api.users.getTeamMembers,
    conversation?.team_id ? { team_id: conversation.team_id } : "skip"
  );

  const addComment = useMutation(api.comments.addComment);
  const deleteComment = useMutation(api.comments.deleteComment);

  const filteredMembers = teamMembers?.filter(member => {
    if (!mentionQuery) return true;
    const username = member.github_username || member.name || "";
    return username.toLowerCase().includes(mentionQuery.toLowerCase());
  }) || [];

  useEffect(() => {
    if (showMentions && filteredMembers.length > 0) {
      setSelectedMentionIndex(0);
    }
  }, [mentionQuery, showMentions, filteredMembers.length]);

  const handleCommentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    const cursorPos = e.target.selectionStart;
    setNewComment(value);

    const textBeforeCursor = value.slice(0, cursorPos);
    const match = textBeforeCursor.match(/@(\w*)$/);

    if (match) {
      setMentionQuery(match[1]);
      setMentionCursorPos(cursorPos);
      setShowMentions(true);
    } else {
      setShowMentions(false);
      setMentionQuery("");
    }
  };

  const handleMentionSelect = (username: string) => {
    const textBefore = newComment.slice(0, mentionCursorPos);
    const textAfter = newComment.slice(mentionCursorPos);
    const mentionStart = textBefore.lastIndexOf('@');
    const newText = textBefore.slice(0, mentionStart) + `@${username} ` + textAfter;

    setNewComment(newText);
    setShowMentions(false);
    setMentionQuery("");

    setTimeout(() => {
      textareaRef.current?.focus();
      const newCursorPos = mentionStart + username.length + 2;
      textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
    }, 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!showMentions || filteredMembers.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedMentionIndex((prev) =>
        prev < filteredMembers.length - 1 ? prev + 1 : 0
      );
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedMentionIndex((prev) =>
        prev > 0 ? prev - 1 : filteredMembers.length - 1
      );
    } else if (e.key === 'Enter' && showMentions) {
      e.preventDefault();
      const member = filteredMembers[selectedMentionIndex];
      if (member) {
        handleMentionSelect(member.github_username || member.name || '');
      }
    } else if (e.key === 'Escape') {
      setShowMentions(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || isSubmitting) return;

    setIsSubmitting(true);
    try {
      await addComment({
        conversation_id: conversationId,
        message_id: messageId,
        content: newComment.trim(),
        parent_comment_id: replyingTo || undefined,
      });
      setNewComment("");
      setReplyingTo(null);
      setShowMentions(false);
      toast.success("Comment added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add comment");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (commentId: Id<"comments">) => {
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
            <button
              onClick={() => handleDelete(comment._id)}
              className="text-sol-text-dim hover:text-sol-red text-xs p-1"
              title="Delete comment"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="text-sol-text text-sm prose prose-invert prose-sm max-w-none">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                p: ({ children }) => {
                  const processText = (text: string) => {
                    const parts = text.split(/(@[\w-]+)/g);
                    return parts.map((part, i) => {
                      if (part.match(/^@[\w-]+$/)) {
                        return (
                          <span key={i} className="text-sol-blue font-medium">
                            {part}
                          </span>
                        );
                      }
                      return part;
                    });
                  };

                  const processChildren = (children: any): any => {
                    if (typeof children === 'string') {
                      return processText(children);
                    }
                    if (Array.isArray(children)) {
                      return children.map((child, i) =>
                        typeof child === 'string' ? processText(child) : child
                      );
                    }
                    return children;
                  };

                  return <p>{processChildren(children)}</p>;
                },
              }}
            >
              {comment.content}
            </ReactMarkdown>
          </div>
          <button
            onClick={() => setReplyingTo(comment._id)}
            className="text-sol-blue hover:text-sol-cyan text-xs mt-2"
          >
            Reply
          </button>
        </div>
        {replies.map((reply) => renderComment(reply, depth + 1))}
      </div>
    );
  };

  const topLevelComments = comments?.filter((c) => !c.parent_comment_id) || [];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-sol-bg border border-sol-border rounded-lg max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-sol-border">
          <h2 className="text-sol-text text-sm font-medium">
            {messageId ? "Message Comments" : "Conversation Comments"}
          </h2>
          <button
            onClick={onClose}
            className="text-sol-text-dim hover:text-sol-text-secondary p-1"
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {topLevelComments.length === 0 ? (
            <div className="text-sol-text-dim text-center py-8 text-sm">
              No comments yet. Be the first to comment!
            </div>
          ) : (
            <div className="space-y-2">
              {topLevelComments.map((comment) => renderComment(comment))}
            </div>
          )}
        </div>

        <div className="border-t border-sol-border p-4">
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
          <form onSubmit={handleSubmit} className="relative">
            <textarea
              ref={textareaRef}
              value={newComment}
              onChange={handleCommentChange}
              onKeyDown={handleKeyDown}
              placeholder="Write a comment... (supports markdown and @mentions)"
              className="w-full px-3 py-2 bg-sol-bg-alt border border-sol-border rounded text-sol-text text-sm placeholder:text-sol-text-dim focus:outline-none focus:ring-1 focus:ring-sol-blue resize-none"
              rows={3}
              disabled={isSubmitting}
            />
            {showMentions && filteredMembers.length > 0 && (
              <div className="absolute bottom-full left-0 mb-1 w-full max-w-xs bg-sol-bg border border-sol-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-10">
                {filteredMembers.map((member, index) => {
                  const username = member.github_username || member.name || '';
                  return (
                    <button
                      key={member._id}
                      type="button"
                      onClick={() => handleMentionSelect(username)}
                      className={`w-full px-3 py-2 text-left flex items-center gap-2 hover:bg-sol-bg-alt transition-colors ${
                        index === selectedMentionIndex ? 'bg-sol-bg-alt' : ''
                      }`}
                    >
                      {member.github_avatar_url && (
                        <img
                          src={member.github_avatar_url}
                          alt={username}
                          className="w-6 h-6 rounded-full"
                        />
                      )}
                      <span className="text-sol-text text-sm">{username}</span>
                    </button>
                  );
                })}
              </div>
            )}
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
      </div>
    </div>
  );
}
