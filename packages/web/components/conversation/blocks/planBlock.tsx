import { useRef, useState, memo } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Id } from "@codecast/convex/convex/_generated/dataModel";
import { copyToClipboard } from "../../../lib/utils";
import { entityRemarkPlugins } from "../../../lib/remarkEntityIds";
import { MESSAGE_MD_REHYPE, MESSAGE_MD_COMPONENTS } from "../../messageMarkdown";
import { isConvexId } from "../../../store/inboxStore";
import { useMessageBookmark } from "../../../hooks/useMessageBookmark";
import { ChevronDown, ChevronUp, Forward } from "lucide-react";
import { useTeamFeature } from "../../../lib/teamFeatures";
import { FooterIconButton, FullscreenIcon } from "./shared";
import { copyMessageLink, formatRelativeTime, forwardMessageToChat } from "../format";
import { ReactMarkdown } from "../markdown";

const PLAN_MAX_HEIGHT = 1800;

function PlanBlockImpl({ content, timestamp, collapsed, messageId, conversationId, onOpenComments, onStartShareSelection }: { content: string; timestamp: number; collapsed?: boolean; messageId?: string; conversationId?: Id<"conversations">; onOpenComments?: (messageId: string) => void; onStartShareSelection?: (messageId: string) => void }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  const isRealMessageId = !!messageId && isConvexId(messageId);
  const { isBookmarked, toggleBookmark: handleToggleBookmark } = useMessageBookmark(conversationId, messageId);

  useWatchEffect(() => {
    if (contentRef.current && !isExpanded) {
      setIsOverflowing(contentRef.current.scrollHeight > PLAN_MAX_HEIGHT);
    }
  }, [content, isExpanded]);

  useWatchEffect(() => {
    if (!fullscreen) return;
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    document.addEventListener('keydown', handleKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', handleKey); document.body.style.overflow = ''; };
  }, [fullscreen]);

  const handleCopy = () => {
    setTimeout(() => { copyToClipboard(content || "").then(() => toast.success("Copied!")).catch(() => toast.error("Failed to copy")); });
  };

  const handleCopyLink = () => messageId && copyMessageLink(conversationId, messageId);
  const chatOn = useTeamFeature("chat");
  const handleForwardToChat = () => messageId && forwardMessageToChat(conversationId, messageId);

  const title = content.match(/^#\s+(.+)$/m)?.[1] || "Plan";

  if (collapsed) {
    return (
      <div className="mb-2 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-sol-text-muted">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="font-medium">{title}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="group/plan relative mb-6 rounded-lg border border-sol-border/60 bg-sol-bg-alt/30 overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-sol-border/40">
        <div className="flex items-center gap-2">
          <svg className="w-3.5 h-3.5 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
          </svg>
          <span className="text-xs font-medium text-sol-text-muted">Plan</span>
          <span className="text-xs text-sol-text-dim">{formatRelativeTime(timestamp)}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {onStartShareSelection && messageId && (
            <button onClick={() => onStartShareSelection(messageId)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Share">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
            </button>
          )}
          {messageId && (
            <button onClick={handleCopyLink} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy link">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
            </button>
          )}
          {chatOn && messageId && (
            <button onClick={handleForwardToChat} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Send to chat">
              <Forward className="w-3.5 h-3.5" />
            </button>
          )}
          {isRealMessageId && conversationId && (
            <button onClick={handleToggleBookmark} className={`p-1 rounded hover:bg-sol-bg-highlight ${isBookmarked ? "text-amber-400" : "text-sol-text-dim hover:text-sol-text-muted"} transition-colors`} title={isBookmarked ? "Remove bookmark" : "Bookmark"}>
              <svg className="w-3.5 h-3.5" fill={isBookmarked ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
            </button>
          )}
          <button onClick={handleCopy} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Copy">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
          <button onClick={() => setFullscreen(true)} className="p-1 rounded hover:bg-sol-bg-highlight text-sol-text-dim hover:text-sol-text-muted transition-colors" title="Fullscreen">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        <div
          ref={contentRef}
          className="relative prose prose-invert prose-sm max-w-none"
          style={!isExpanded && isOverflowing ? { maxHeight: PLAN_MAX_HEIGHT, overflowY: 'hidden' } : undefined}
        >
          <ReactMarkdown
            remarkPlugins={entityRemarkPlugins}
            rehypePlugins={MESSAGE_MD_REHYPE}
            components={MESSAGE_MD_COMPONENTS}
          >
            {content}
          </ReactMarkdown>
          {!isExpanded && isOverflowing && (
            <div className="absolute bottom-0 left-0 right-0 h-20 pointer-events-none bg-gradient-to-b from-transparent to-[var(--sol-bg)]" />
          )}
        </div>
        {(isOverflowing || isExpanded) && (
          <div className="flex items-center gap-1 mt-2 pt-1 border-t border-sol-border/30">
            <FooterIconButton onClick={() => setFullscreen(true)} title="Fullscreen" label="Full Screen">
              <FullscreenIcon />
            </FooterIconButton>
            <FooterIconButton onClick={() => setIsExpanded(e => !e)} title={isExpanded ? "Collapse" : "Expand"}>
              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </FooterIconButton>
          </div>
        )}
      </div>

      {fullscreen && createPortal(
        <div className="fixed inset-0 z-[10001] bg-sol-bg overflow-auto" onClick={() => setFullscreen(false)}>
          <div className="conv-col mx-auto px-8 py-12" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-sol-cyan" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
                </svg>
                <span className="text-sol-text-secondary text-sm font-medium">Plan</span>
              </div>
              <button
                onClick={() => setFullscreen(false)}
                className="text-sol-text-dim hover:text-sol-text-muted transition-colors p-1"
                title="Close"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="prose prose-invert prose-sm max-w-none text-sol-text">
              <ReactMarkdown
                remarkPlugins={entityRemarkPlugins}
                rehypePlugins={MESSAGE_MD_REHYPE}
                components={MESSAGE_MD_COMPONENTS}
              >
                {content}
              </ReactMarkdown>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  );
}
export const PlanBlock = memo(PlanBlockImpl);
