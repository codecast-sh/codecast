"use client";
import { useRef, useState, useCallback } from "react";
import { CollabDocEditor } from "./editor/CollabDocEditor";
import { useMentionQuery } from "../hooks/useMentionQuery";
import { useImageUpload } from "../hooks/useImageUpload";
import { ErrorBoundary } from "./ErrorBoundary";
import { ContextChatInput } from "./ContextChatInput";
import { MessageReview } from "./MessageReview";
import { MarkdownBlocks } from "./tools/MarkdownRenderer";
import { DocReviewBar } from "./DocReviewBar";
import { ArrowLeft, Edit3, Eye, MessageSquareQuote, MoreHorizontal, Copy, Check, X } from "lucide-react";
import Link from "next/link";
import { copyToClipboard } from "../lib/utils";
import { toast } from "sonner";

// Module-level so MessageReview's memo holds (a fresh inline arrow would defeat
// it). Renders the doc's markdown as a flat run of blocks — each a direct child
// of MessageReview's measurement container, so every block is hover-quotable.
const renderDocBlocks = (content: string) => <MarkdownBlocks content={content} />;

interface DocumentDetailLayoutProps {
  docId: string;
  title: string;
  markdownContent: string;
  editable?: boolean;
  placeholder?: string;
  onTitleChange: (title: string) => void;
  backHref: string;
  topBarLeft?: React.ReactNode;
  topBarRight?: React.ReactNode;
  /** Always-visible content shown between the title and the body editor (e.g. a plan's goal). */
  leadContent?: React.ReactNode;
  metaContent?: React.ReactNode;
  children?: React.ReactNode;
  footerContent?: React.ReactNode;
  contextType?: string;
  linkedObjectId?: string;
  cliEditedAt?: number;
  /** Forwarded to CollabDocEditor — see its `contentReady` doc. */
  contentReady?: boolean;
  /** The session this doc came from, if any — the default target when sending
   *  review annotations to an agent. */
  ownerConversationId?: string;
}

export function DocumentDetailLayout({
  docId,
  title,
  markdownContent,
  editable: initialEditable = true,
  placeholder = "Start writing, use / for commands, @ to mention...",
  onTitleChange,
  backHref,
  topBarLeft,
  topBarRight,
  leadContent,
  metaContent,
  children,
  footerContent,
  contextType = "doc",
  linkedObjectId,
  cliEditedAt,
  contentReady = true,
  ownerConversationId,
}: DocumentDetailLayoutProps) {
  const [isEditing, setIsEditing] = useState(initialEditable);
  const [reviewing, setReviewing] = useState(false);
  const reviewKey = `doc:${docId}`;
  const [showMeta, setShowMeta] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleMentionQuery = useMentionQuery();
  const handleImageUpload = useImageUpload();
  const getMarkdownRef = useRef<(() => string) | null>(null);
  const getContextBody = useCallback(
    () => getMarkdownRef.current?.() ?? markdownContent,
    [markdownContent]
  );

  const handleCopyMarkdown = () => {
    const md = getMarkdownRef.current?.() ?? markdownContent;
    const full = title ? `# ${title}\n\n${md}` : md;
    copyToClipboard(full)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        toast.success("Copied!");
      })
      .catch(() => toast.error("Failed to copy"));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Wraps the action cluster to a second row rather than letting it overflow
          (and clip its trailing icons) once the back/type/watch cluster and the
          icons can no longer share one line — e.g. a narrow split-pane doc view. */}
      <div className="flex flex-wrap items-center justify-between gap-y-2 px-6 py-2 border-b border-sol-border/10 flex-shrink-0">
        <div className="flex items-center gap-3">
          <Link
            href={backHref}
            className="text-sol-text-dim hover:text-sol-cyan transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </Link>
          {topBarLeft}
        </div>
        <div className="flex items-center gap-1 ml-auto">
          <button
            onClick={handleCopyMarkdown}
            className="p-1.5 rounded-md text-xs flex items-center gap-1 text-sol-text-dim hover:text-sol-text transition-colors"
            title="Copy as Markdown"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-sol-green" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button
            onClick={() => { setReviewing((r) => !r); setIsEditing(false); }}
            className={`p-1.5 rounded-md text-xs flex items-center gap-1 transition-colors ${
              reviewing ? "text-sol-yellow" : "text-sol-text-dim hover:text-sol-text"
            }`}
            title={reviewing ? "Exit review" : "Review: quote sections and send feedback to an agent"}
          >
            <MessageSquareQuote className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => { setIsEditing(!isEditing); setReviewing(false); }}
            className={`p-1.5 rounded-md text-xs flex items-center gap-1 transition-colors ${
              isEditing
                ? "text-sol-cyan"
                : "text-sol-text-dim hover:text-sol-text"
            }`}
            title={isEditing ? "Switch to view mode" : "Switch to edit mode"}
          >
            {isEditing ? <Edit3 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
          {topBarRight}
          <Link
            href={backHref}
            className="p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </Link>
          {metaContent && (
            <button
              onClick={() => setShowMeta(!showMeta)}
              className="p-1.5 rounded-md text-sol-text-dim hover:text-sol-text transition-colors"
              title="Info"
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {showMeta && metaContent && (
        <div className="px-10 py-3 border-b border-sol-border/10 flex-shrink-0 max-w-5xl mx-auto w-full">
          {metaContent}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col min-h-full">
        <div className="flex-1 max-w-5xl mx-auto px-10 pt-10 pb-8 w-full">
          <h1
            contentEditable={isEditing}
            suppressContentEditableWarning
            onBlur={(e) => {
              const text = e.currentTarget.textContent || "";
              if (text !== title) onTitleChange(text);
            }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLElement).blur(); } }}
            className={`text-3xl font-bold text-sol-text leading-tight mb-1 break-words ${isEditing ? "outline-none cursor-text" : ""}`}
          >
            {title || "Untitled"}
          </h1>

          {leadContent && <div className="mt-2">{leadContent}</div>}

          <div className="mt-4">
            {reviewing ? (
              <div className="prose prose-invert prose-sm max-w-none text-sol-text">
                <MessageReview
                  conversationId={reviewKey}
                  messageId={reviewKey}
                  content={markdownContent}
                  renderBlock={renderDocBlocks}
                />
              </div>
            ) : (
              <ErrorBoundary name="DocEditor" level="panel">
                <CollabDocEditor
                  key={docId}
                  docId={docId}
                  markdownContent={markdownContent}
                  onMentionQuery={handleMentionQuery}
                  onImageUpload={handleImageUpload}
                  editable={isEditing}
                  placeholder={placeholder}
                  getMarkdownRef={getMarkdownRef}
                  cliEditedAt={cliEditedAt}
                  contentReady={contentReady}
                />
              </ErrorBoundary>
            )}
          </div>

          {children && (
            <div className="mt-16 pt-8 border-t border-sol-border/15">
              {children}
            </div>
          )}
        </div>
        {footerContent && (
          <div className="max-w-5xl mx-auto px-10 pb-4 w-full">
            {footerContent}
          </div>
        )}
        {reviewing ? (
          <DocReviewBar
            reviewKey={reviewKey}
            docId={docId}
            title={title || "Untitled"}
            ownerConversationId={ownerConversationId}
            onSent={() => setReviewing(false)}
          />
        ) : (
          <ContextChatInput
            contextType={contextType}
            contextTitle={title || "Untitled"}
            getContextBody={getContextBody}
            linkedObjectId={linkedObjectId}
          />
        )}
        </div>
      </div>
    </div>
  );
}
