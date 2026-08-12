import { Hash } from "lucide-react";
import { ChatAvatar } from "./ChatMessage";
import "./chat.css";

// The in-app toast for an arriving chat message.
//
// This fills a real hole rather than adding a new one: the native OS banner
// suppresses itself whenever the window is focused (lib/desktop.ts:192), so
// today a focused reader gets nothing but a silent bell badge. The toast is the
// focused-window half of that system.
//
// It shows enough to decide whether to switch context — who, where, and two
// lines of what — and no more. A toast that shows the whole message stops being
// a notification and becomes a second, worse reader.

export type ChatToastData = {
  messageId: string;
  channelId: string;
  channelName: string;
  authorName: string;
  authorAvatarUrl?: string;
  authorIsAgent?: boolean;
  preview: string;
  mentionsMe?: boolean;
  /** Set when several messages collapsed into this one card. */
  collapsedCount?: number;
  /** Present when the message is a reply, so the card can say so. */
  inThread?: boolean;
};

export function ChatToast({ data, onOpen }: { data: ChatToastData; onOpen: (d: ChatToastData) => void }) {
  const where = data.inThread ? `thread in #${data.channelName}` : `#${data.channelName}`;
  return (
    <div
      className={`ch-toast ${data.mentionsMe ? "ch-toast-mention" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(data)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(data);
        }
      }}
    >
      <ChatAvatar
        name={data.authorName}
        avatarUrl={data.authorAvatarUrl}
        isAgent={data.authorIsAgent}
        size={26}
      />
      <div className="ch-toast-main">
        <div className="ch-toast-head">
          <span className="ch-toast-author">{data.authorName}</span>
          <span className="ch-toast-where">
            <Hash className="w-2.5 h-2.5 inline-block -mt-px mr-0.5 opacity-70" aria-hidden="true" />
            {where}
          </span>
        </div>
        <div className="ch-toast-preview">{data.preview}</div>
        {!!data.collapsedCount && data.collapsedCount > 1 && (
          <div className="ch-toast-count">
            and {data.collapsedCount - 1} more {data.collapsedCount === 2 ? "message" : "messages"}
          </div>
        )}
      </div>
    </div>
  );
}

/** Strip a message body down to one glanceable line.
 *
 *  Markdown syntax reads as noise at toast size, and a fenced block would blow
 *  the card's height, so code becomes a short label rather than its contents. */
export function toastPreview(markdown: string, max = 160): string {
  let text = markdown
    // Fenced blocks first, before their contents can be mistaken for prose.
    .replace(/```[\s\S]*?```/g, " [code] ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " [image] ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > max) text = text.slice(0, max - 1).trimEnd() + "…";
  return text;
}
