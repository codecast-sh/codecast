import { Bookmark, Copy, Link2, Maximize2, MessageSquare, Share2, Split } from "lucide-react";

type MessageActionToolbarProps = {
  messageId?: string;
  className: string;
  buttonClassName: string;
  iconClassName: string;
  commentCountClassName: string;
  commentCount?: number;
  isBookmarked?: boolean;
  canBookmark?: boolean;
  onStartShareSelection?: (messageId: string) => void;
  onCopyLink?: () => void;
  onToggleBookmark?: () => void;
  onOpenComments?: () => void;
  onFork?: () => void;
  onCopy?: () => void;
  onFullscreen?: () => void;
  bookmarkTitle?: string;
  copyTitle?: string;
  copyLinkTitle?: string;
  shareTitle?: string;
};

export function MessageActionToolbar({
  messageId,
  className,
  buttonClassName,
  iconClassName,
  commentCountClassName,
  commentCount,
  isBookmarked,
  canBookmark = true,
  onStartShareSelection,
  onCopyLink,
  onToggleBookmark,
  onOpenComments,
  onFork,
  onCopy,
  onFullscreen,
  bookmarkTitle = "Bookmark message",
  copyTitle = "Copy message",
  copyLinkTitle = "Copy link to message",
  shareTitle = "Share message",
}: MessageActionToolbarProps) {
  const bookmarkLabel = isBookmarked ? "Remove bookmark" : bookmarkTitle;

  return (
    <div className={className}>
      {onStartShareSelection && messageId && (
        <button
          onClick={() => onStartShareSelection(messageId)}
          className={buttonClassName}
          title={shareTitle}
          aria-label={shareTitle}
        >
          <Share2 className={iconClassName} />
        </button>
      )}
      {onCopyLink && (
        <button
          onClick={onCopyLink}
          className={buttonClassName}
          title={copyLinkTitle}
          aria-label={copyLinkTitle}
        >
          <Link2 className={iconClassName} />
        </button>
      )}
      {canBookmark && onToggleBookmark && (
        <button
          onClick={onToggleBookmark}
          className={`${buttonClassName} ${isBookmarked ? "text-amber-400" : ""}`}
          title={bookmarkLabel}
          aria-label={bookmarkLabel}
        >
          <Bookmark className={iconClassName} fill={isBookmarked ? "currentColor" : "none"} />
        </button>
      )}
      {onOpenComments && (
        <button
          onClick={onOpenComments}
          className={`${buttonClassName} flex items-center gap-1`}
          title="Comments"
          aria-label="Comments"
        >
          <MessageSquare className={iconClassName} />
          {commentCount !== undefined && commentCount > 0 && (
            <span className={commentCountClassName}>{commentCount}</span>
          )}
        </button>
      )}
      {onFork && (
        <button
          onClick={onFork}
          className={buttonClassName}
          title="Fork from this message"
          aria-label="Fork from this message"
        >
          <Split className={iconClassName} />
        </button>
      )}
      {onCopy && (
        <button
          onClick={onCopy}
          className={buttonClassName}
          title={copyTitle}
          aria-label={copyTitle}
        >
          <Copy className={iconClassName} />
        </button>
      )}
      {onFullscreen && (
        <button
          onClick={onFullscreen}
          className={buttonClassName}
          title="Fullscreen"
          aria-label="Fullscreen"
        >
          <Maximize2 className={iconClassName} />
        </button>
      )}
    </div>
  );
}
