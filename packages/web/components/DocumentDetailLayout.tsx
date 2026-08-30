"use client";
import { useRef, useState, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Components } from "react-markdown";
import { CollabDocEditor } from "./editor/CollabDocEditor";
import { AppLoader } from "./AppLoader";
import { useMentionQuery, useActiveMentionScope } from "../hooks/useMentionQuery";
import { useImageUpload } from "../hooks/useImageUpload";
import { ErrorBoundary } from "./ErrorBoundary";
import { ContextChatInput } from "./ContextChatInput";
import { MessageReview } from "./MessageReview";
import { MarkdownBlocks, MD_COMPONENTS } from "./tools/MarkdownRenderer";
import { DocReviewBar } from "./DocReviewBar";
import { SlotActions } from "./workspace/Slot";
import { useInboxStore } from "../store/inboxStore";
import { ArrowLeft, Edit3, MoreHorizontal, Copy, Check, MessageSquareQuote } from "lucide-react";
import Link from "next/link";
import { copyToClipboard } from "../lib/utils";
import { toast } from "sonner";
import { useTitlebarHead } from "../hooks/useTitlebarHead";
import { KeyCap } from "./KeyboardShortcutsHelp";
import { isMac } from "../shortcuts";

// The reading view uses the EDITOR's type scale (editor.css), not chat's
// compact one, so toggling edit mode doesn't reflow the whole document.
// MD_COMPONENTS stays the base — entity pills, code blocks, images and the
// security plugins are shared; only the heading scale diverges.
const DOC_MD_COMPONENTS: Components = {
  ...MD_COMPONENTS,
  h1: ({ children }) => (
    <h1 className="text-[21px] font-bold mt-10 first:mt-0 mb-3 leading-[1.3] text-sol-text">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[17px] font-semibold mt-8 mb-2 leading-[1.3] text-sol-text">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[15px] font-semibold mt-6 mb-1.5 leading-[1.4] text-sol-text">{children}</h3>
  ),
};

// Module-level so MessageReview's memo holds (a fresh inline arrow would defeat
// it). Renders the doc's markdown as a flat run of blocks — each a direct child
// of MessageReview's measurement container, so every block is hover-quotable.
const renderDocBlocks = (content: string) => (
  <MarkdownBlocks content={content} components={DOC_MD_COMPONENTS} />
);

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
  /** Mount in edit mode. Defaults true: editing IS the doc surface; the
   *  quotable read view is the opt-in Review mode. */
  defaultEditing?: boolean;
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
  defaultEditing = true,
}: DocumentDetailLayoutProps) {
  const router = useRouter();
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  // Edit mode is the default: the doc opens as the live collaborative editor
  // (rich pills, dates, checkboxes in place). Review mode is the opt-in
  // toggle — the body re-renders as quotable blocks (hover any block to
  // annotate and send to the agent).
  const [isEditing, setIsEditing] = useState(defaultEditing && initialEditable);
  const reviewKey = `doc:${docId}`;
  // The review submit bar replaces the context chat only while a batch of
  // pending notes exists — quoting a first block summons it, sending/clearing
  // the batch dismisses it.
  const hasReviewNotes = useInboxStore(
    (s) => (s.reviewComments[reviewKey] ?? []).length > 0
  );
  const [showMeta, setShowMeta] = useState(false);
  const [copied, setCopied] = useState(false);
  const handleMentionQuery = useMentionQuery(useActiveMentionScope());
  const handleImageUpload = useImageUpload();
  const getMarkdownRef = useRef<(() => string) | null>(null);

  // Cmd/Ctrl+E toggles edit mode from anywhere on the surface — including
  // while the editor itself has focus (a modifier chord is never typing).
  useEffect(() => {
    if (!initialEditable) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        setIsEditing((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [initialEditable]);
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
      <div ref={titlebarRef} className="cc-panel__head justify-between">
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
          {initialEditable && (
            // Editing is the default state, so the button offers the opt-in:
            // Review renders the body as quotable blocks to annotate and send
            // to the agent. While reviewing it flips to an accent-filled state
            // so the departure from the default is unmistakable.
            <button
              onClick={() => setIsEditing(!isEditing)}
              className={`px-2 py-1 mx-0.5 rounded-md text-xs font-medium flex items-center gap-1.5 border transition-colors ${
                isEditing
                  ? "text-sol-text-muted border-sol-border/40 hover:text-sol-text hover:border-sol-border hover:bg-sol-bg-alt/60"
                  : "bg-sol-cyan/15 text-sol-cyan border-sol-cyan/40 hover:bg-sol-cyan/25"
              }`}
              title={isEditing ? "Review mode — quote blocks to the agent" : "Back to editing"}
            >
              {isEditing ? <MessageSquareQuote className="w-3.5 h-3.5" /> : <Edit3 className="w-3.5 h-3.5" />}
              <span>{isEditing ? "Review" : "Edit"}</span>
              <KeyCap size="xs">{isMac ? "⌘E" : "Ctrl+E"}</KeyCap>
            </button>
          )}
          {topBarRight}
          {/* Shared controls in the detail's own header. Closing here is a
              navigation, so the slot's default hide is overridden — the
              affordance stays identical either way. */}
          <SlotActions slot="primary" onClose={() => router.push(backHref)} />
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
            {isEditing ? (
              <ErrorBoundary name="DocEditor" level="panel">
                <CollabDocEditor
                  key={docId}
                  docId={docId}
                  markdownContent={markdownContent}
                  onMentionQuery={handleMentionQuery}
                  onImageUpload={handleImageUpload}
                  editable
                  placeholder={placeholder}
                  getMarkdownRef={getMarkdownRef}
                  cliEditedAt={cliEditedAt}
                  contentReady={contentReady}
                />
              </ErrorBoundary>
            ) : !markdownContent.trim() && !contentReady ? (
              // The detail (which carries the content) hasn't synced yet — an
              // empty body here means "loading", never "empty document".
              <AppLoader className="min-h-0 bg-transparent py-8" size={24} />
            ) : !markdownContent.trim() && initialEditable ? (
              // An empty doc in read mode is a dead end (nothing to read,
              // nothing clickable) — offer the way in directly.
              <button
                onClick={() => setIsEditing(true)}
                className="block w-full text-left py-6 text-sm text-sol-text-dim hover:text-sol-text-muted transition-colors cursor-text"
              >
                Empty document — click to start writing
              </button>
            ) : (
              // doc-read-body aligns the reading view with the editor's visual
              // language (editor.css) so mode toggles don't restyle the doc.
              // Double-click anywhere in the text is the direct path into
              // editing; the review rail's hover-quote (single-click) and text
              // selection are untouched by it.
              <div
                className="prose prose-invert prose-sm max-w-none text-sol-text doc-read-body"
                onDoubleClick={initialEditable ? () => setIsEditing(true) : undefined}
              >
                <MessageReview
                  conversationId={reviewKey}
                  messageId={reviewKey}
                  content={markdownContent}
                  renderBlock={renderDocBlocks}
                />
              </div>
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
        {hasReviewNotes && !isEditing ? (
          <DocReviewBar
            reviewKey={reviewKey}
            docId={docId}
            title={title || "Untitled"}
            ownerConversationId={ownerConversationId}
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
