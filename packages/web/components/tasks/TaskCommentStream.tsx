import { useCallback, useRef, useState, type MutableRefObject } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { ArrowUp, ImagePlus, MessageSquare } from "lucide-react";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, type TaskCommentExternal } from "../../store/inboxStore";
import { compressImage } from "../../lib/compressImage";
import { formatDateFull, formatRelative } from "../../lib/utils";
import { useOpenLinkedSession } from "../../hooks/useOpenLinkedSession";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { AgentIcon } from "../ConversationList";
import { Badge } from "../ui/badge";
import { APP_LOOK, ISSUE_PROVIDER_NAME } from "../../lib/integrations";

import { useWatchEffect } from "../../hooks/useWatchEffect";
const api = _api as any;

// A task's comment stream: the comment rows and the composer that posts to
// them. The task detail page renders these pieces inside its Activity
// timeline (interleaved with history); the Threads page renders the stream
// whole inside a task card. One set of components, so a comment reads, and a
// reply posts, the same way on both.

// ── Small shared bits (the task page uses these in its other sections too) ──

export function TimeAgo({ ts, className }: { ts: number; className?: string }) {
  return (
    <span className={className} title={formatDateFull(ts)}>
      {formatRelative(ts)}
    </span>
  );
}

export function ClaudeIcon({ size = "sm" }: { size?: "sm" | "md" }) {
  const px = size === "md" ? "w-7 h-7" : "w-5 h-5";
  const svg = size === "md" ? "w-4 h-4" : "w-3 h-3";
  return (
    <span className={`${px} rounded bg-sol-orange flex items-center justify-center shrink-0`}>
      <svg className={`${svg} text-sol-bg`} viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
      </svg>
    </span>
  );
}

export function Avatar({ name, image, size = "sm" }: { name: string; image?: string; size?: "sm" | "md" }) {
  if (name.toLowerCase() === "claude") return <ClaudeIcon size={size} />;
  const px = size === "md" ? "w-7 h-7" : "w-5 h-5";
  const textSize = size === "md" ? "text-[10px]" : "text-[8px]";
  if (image) {
    return <img src={image} alt={name} className={`${px} rounded-full flex-shrink-0`} />;
  }
  const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className={`${px} rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center ${textSize} font-medium text-sol-text-muted`}>
      {initials}
    </div>
  );
}

export function UserBadge({ name, image, username }: { name: string; image?: string; username?: string }) {
  const content = (
    <span className={`inline-flex items-center gap-1.5 flex-shrink-0 ${username ? "hover:opacity-80 cursor-pointer" : ""}`}>
      <Avatar name={name} image={image} />
      <span className="text-xs text-sol-text font-medium">{name.split(" ")[0]}</span>
    </span>
  );
  if (username) {
    return <Link href={`/team/${username}`}>{content}</Link>;
  }
  return content;
}

// ── One comment ─────────────────────────────────────────────────────────────

export type TaskCommentRow = {
  _id: string;
  author: string;
  author_image?: string;
  text: string;
  comment_type?: string;
  created_at: number;
  session_info?: { agent_type?: string; title?: string } & Record<string, any>;
  external?: TaskCommentExternal;
};

/** "from Linear" / "from GitHub": the comment was pulled from, or pushed to,
 *  the provider (issue-sync S1.2). Links to the provider comment when it has
 *  a url of its own. */
function CommentProvenance({ external }: { external: TaskCommentExternal }) {
  const look = APP_LOOK[external.provider];
  const Icon = look.icon;
  const label = `from ${ISSUE_PROVIDER_NAME[external.provider]}`;
  const inner = (
    <>
      <Icon className="w-2.5 h-2.5 flex-shrink-0" style={{ color: look.accent }} />
      {label}
    </>
  );
  const cls = "inline-flex items-center gap-1 text-[10px] text-sol-text-dim flex-shrink-0";
  const title = external.author ? `${label}, by ${external.author}` : label;
  return external.url ? (
    <a href={external.url} target="_blank" rel="noopener noreferrer" className={`${cls} hover:text-sol-text`} title={title} onClick={(e) => e.stopPropagation()}>
      {inner}
    </a>
  ) : (
    <span className={cls} title={title}>{inner}</span>
  );
}

export function TaskCommentItem({
  comment,
  openLinkedSession,
}: {
  comment: TaskCommentRow;
  openLinkedSession: (info: any) => void;
}) {
  return (
    <div className="py-2.5 relative">
      <div className="flex items-center gap-2 mb-1.5">
        {comment.session_info ? (
          <button
            type="button"
            onClick={() => openLinkedSession(comment.session_info)}
            className="inline-flex items-center gap-1.5 flex-shrink-0 min-w-0 hover:opacity-80 cursor-pointer"
            title={comment.author}
          >
            <AgentIcon agentType={comment.session_info.agent_type || "claude_code"} className="w-5 h-5" />
            <span className="text-xs text-sol-text font-medium truncate max-w-[260px]">
              {comment.session_info.title || comment.author}
            </span>
          </button>
        ) : (
          <UserBadge name={comment.author} image={comment.author_image} />
        )}
        {comment.comment_type && comment.comment_type !== "note" && (
          <Badge variant="outline" className="text-[10px] px-1">{comment.comment_type}</Badge>
        )}
        {comment.external && <CommentProvenance external={comment.external} />}
        <TimeAgo ts={comment.created_at} className="text-[11px] text-gray-400" />
      </div>
      <div className="ml-[26px] border-l-2 border-sol-border/30 pl-3">
        <MarkdownRenderer content={comment.text} className="text-sm text-sol-text prose-sm prose-invert max-w-none" />
      </div>
    </div>
  );
}

// ── The composer ────────────────────────────────────────────────────────────

type PendingImage = { file: File; previewUrl: string; storageId?: string; uploading: boolean };

/** Posts a note on the task through the store's optimistic addTaskComment.
 *  Owns its draft and its image uploads. `dropFilesRef` lets a surrounding
 *  drop zone (the task page) land files in this composer's strip. */
export function TaskCommentComposer({
  shortId,
  dropFilesRef,
  autoOpen,
  autoFocus,
}: {
  shortId: string | undefined;
  dropFilesRef?: MutableRefObject<((files: File[]) => void) | null>;
  /** Start with the box open and keep it open (the Threads card). */
  autoOpen?: boolean;
  /** Grab keyboard focus on mount — only on the user's own gesture. */
  autoFocus?: boolean;
}) {
  const addTaskComment = useInboxStore((s) => s.addTaskComment);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const [comment, setComment] = useState("");
  const [commentImages, setCommentImages] = useState<PendingImage[]>([]);
  const [commentOpen, setCommentOpen] = useState(!!autoOpen);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  const uploadCommentImage = useCallback(async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setCommentImages(prev => [...prev, { file, previewUrl, uploading: true }]);
    try {
      const uploaded = await compressImage(file);
      const uploadUrl = await generateUploadUrl({});
      const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": uploaded.type }, body: uploaded });
      if (!result.ok) throw new Error(`Upload failed: ${result.status} ${result.statusText}`);
      const { storageId } = await result.json();
      setCommentImages(prev => prev.map(img => img.previewUrl === previewUrl ? { ...img, storageId, uploading: false } : img));
    } catch (err: any) {
      console.error("[uploadCommentImage] failed:", err);
      toast.error(`Failed to upload image: ${err?.message || "unknown error"}`);
      URL.revokeObjectURL(previewUrl);
      setCommentImages(prev => prev.filter(img => img.previewUrl !== previewUrl));
    }
  }, [generateUploadUrl]);

  // Dropped files open the box: a drop onto a closed composer must land somewhere visible.
  useWatchEffect(() => {
    if (!dropFilesRef) return;
    dropFilesRef.current = (files: File[]) => {
      setCommentOpen(true);
      files.forEach((f) => void uploadCommentImage(f));
    };
    return () => { dropFilesRef.current = null; };
  }, [dropFilesRef, uploadCommentImage]);

  useWatchEffect(() => {
    if (autoFocus) setTimeout(() => commentRef.current?.focus(), 0);
  }, [autoFocus]);

  const clearCommentImage = useCallback((idx: number) => {
    setCommentImages(prev => {
      const img = prev[idx];
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleCommentPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) void uploadCommentImage(file);
      }
    }
  }, [uploadCommentImage]);

  const handleAddComment = useCallback(() => {
    const hasText = comment.trim().length > 0;
    const hasImages = commentImages.some(i => i.storageId);
    if ((!hasText && !hasImages) || !shortId) return;
    const anyUploading = commentImages.some(i => i.uploading);
    if (anyUploading) { toast.error("Wait for images to finish uploading"); return; }
    const text = comment.trim() || "(image)";
    const imageIds = commentImages.filter(i => i.storageId).map(i => i.storageId!);
    setComment("");
    setCommentImages([]);
    // Local-first: the optimistic comment renders instantly and the dispatch
    // (which delegates to tasks.webAddComment for notifications + images)
    // retries on its own, so no submit spinner or error rollback is needed.
    addTaskComment(shortId, text, "note", imageIds.length > 0 ? imageIds : undefined);
    if (!autoOpen) setCommentOpen(false);
  }, [comment, commentImages, shortId, addTaskComment, autoOpen]);

  const canSend = comment.trim().length > 0 || commentImages.some(i => i.storageId);

  if (!commentOpen) {
    return (
      <div className="mb-2">
        <button
          type="button"
          onClick={() => {
            setCommentOpen(true);
            setTimeout(() => commentRef.current?.focus(), 0);
          }}
          className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border border-sol-border text-sol-text-muted bg-sol-bg-alt/50 hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
        >
          <MessageSquare className="w-3.5 h-3.5" />
          Add comment
        </button>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <div className="flex flex-col border px-3 py-2 rounded-xl bg-sol-bg-alt border-sol-border/50">
        {commentImages.length > 0 && (
          <div className="flex items-center gap-2 pb-2 mb-2 border-b border-sol-border/50 flex-wrap">
            {commentImages.map((img, idx) => (
              <div key={idx} className="relative group cursor-pointer">
                <div className="relative h-16 w-16 rounded-lg overflow-hidden bg-sol-bg shrink-0">
                  <img src={img.previewUrl} alt="Attached" className="h-full w-full object-cover" />
                  {img.uploading && (
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                      <svg className="w-5 h-5 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    </div>
                  )}
                </div>
                <button type="button" onClick={() => clearCommentImage(idx)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-sol-bg-alt border border-sol-border flex items-center justify-center text-sol-text-dim hover:text-sol-text transition-colors opacity-0 group-hover:opacity-100">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <label className="shrink-0 cursor-pointer text-sol-text-dim hover:text-sol-text transition-colors py-1 flex items-center">
            <ImagePlus className="w-4 h-4" />
            <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { Array.from(e.target.files || []).forEach(f => void uploadCommentImage(f)); e.target.value = ""; }} />
          </label>
          <textarea
            ref={commentRef}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleAddComment();
              }
              if (e.key === "Escape") {
                if (!comment.trim() && commentImages.length === 0 && !autoOpen) setCommentOpen(false);
              }
            }}
            onPaste={handleCommentPaste}
            placeholder="Leave a comment..."
            rows={1}
            className="flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none resize-none overflow-hidden leading-relaxed py-1 text-sol-text"
          />
          <div className="shrink-0">
            <button
              onClick={handleAddComment}
              disabled={!canSend}
              className={`w-7 h-7 rounded-full transition-colors flex items-center justify-center border ${!canSend ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed" : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue"}`}
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── The stream ──────────────────────────────────────────────────────────────

/** Comments oldest first, then the composer — the Threads card's expanded body. */
export function TaskCommentStream({
  shortId,
  comments,
  composerAutoOpen,
  composerAutoFocus,
  initialLimit,
}: {
  shortId: string | undefined;
  comments: TaskCommentRow[];
  composerAutoOpen?: boolean;
  composerAutoFocus?: boolean;
  /** Render only the newest N comments, the rest behind a "show earlier"
   *  reveal (the Threads card). Unset renders the whole stream. */
  initialLimit?: number;
}) {
  const openLinkedSession = useOpenLinkedSession();
  const [showAll, setShowAll] = useState(false);
  // A cached row poisoned by a stale pending lock once carried a lone comment
  // OBJECT here and crashed the whole Threads page. Hydration heals such rows
  // now; this guard keeps one bad row from ever taking the page down again.
  const sorted = (Array.isArray(comments) ? [...comments] : []).sort((a, b) => a.created_at - b.created_at);
  const hidden = initialLimit !== undefined && !showAll ? Math.max(0, sorted.length - initialLimit) : 0;
  const visible = hidden > 0 ? sorted.slice(hidden) : sorted;
  return (
    <div className="th-task-stream">
      {sorted.length === 0 ? (
        <div className="th-card-note">No comments yet.</div>
      ) : (
        <div className="space-y-0">
          {hidden > 0 && (
            <button type="button" className="th-task-earlier" onClick={() => setShowAll(true)}>
              Show {hidden} earlier {hidden === 1 ? "comment" : "comments"}
            </button>
          )}
          {visible.map((c) => (
            <TaskCommentItem key={c._id} comment={c} openLinkedSession={openLinkedSession} />
          ))}
        </div>
      )}
      <TaskCommentComposer shortId={shortId} autoOpen={composerAutoOpen} autoFocus={composerAutoFocus} />
    </div>
  );
}
