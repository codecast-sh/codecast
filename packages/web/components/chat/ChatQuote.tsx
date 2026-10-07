import { Children, isValidElement, type ReactNode } from "react";
import Link from "next/link";
import { SlackLogo } from "../SlackLogo";
import { CommentAvatar } from "../comments/CommentAvatar";
import { useChatMembers, useChatMessageRow, useEnsureChatMessage } from "../../hooks/useChatSync";
import { authorFor, slackAuthorFor } from "../../lib/chatViews";
import { useInboxStore } from "../../store/inboxStore";

// A quoted message inside a chat line. The server writes one as a blockquote
// whose first line is only a link named for the author (slackText's
// sharedMessageMarkdown): to the quoted line's chat permalink when codecast
// holds a copy, else to Slack. That shape renders as a card with the author's
// face, the room and the time, and opens the original in place; any other
// blockquote stays a plain quote.

type QuoteHead = { name: string; href: string; channelId?: string; messageId?: string };

const CHAT_PERMALINK = /^\/chat\/([a-z0-9]{32})\?m=([a-z0-9]{32})$/;
const SLACK_PERMALINK = /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d+/;
const TIME = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const isElement = (n: any) => n?.type === "element";
const isBlankText = (n: any) => n?.type === "text" && !String(n.value ?? "").trim();
const hastText = (n: any): string => (n?.type === "text" ? n.value ?? "" : (n?.children ?? []).map(hastText).join(""));

function quoteHead(node: any): QuoteHead | null {
  const first = (node?.children ?? []).find(isElement);
  if (first?.tagName !== "p") return null;
  const parts = (first.children ?? []).filter((c: any) => !isBlankText(c));
  const link = parts.length === 1 && parts[0].tagName === "a" ? parts[0] : null;
  const href = typeof link?.properties?.href === "string" ? link.properties.href : "";
  const name = hastText(link).trim();
  if (!name) return null;
  const chat = CHAT_PERMALINK.exec(href);
  if (chat) return { name, href, channelId: chat[1], messageId: chat[2] };
  return SLACK_PERMALINK.test(href) ? { name, href } : null;
}

export function ChatBlockquote({ node, children, ...props }: any) {
  const head = quoteHead(node);
  if (!head) return <blockquote {...props}>{children}</blockquote>;
  // Drop the header paragraph: the card draws it.
  const kids = Children.toArray(children);
  const at = kids.findIndex((k) => isValidElement(k));
  return <ChatQuoteCard head={head}>{kids.filter((_, i) => i !== at)}</ChatQuoteCard>;
}

function ChatQuoteCard({ head, children }: { head: QuoteHead; children: ReactNode }) {
  useEnsureChatMessage(head.messageId);
  const row = useChatMessageRow(head.messageId);
  const { byId } = useChatMembers();
  const channel = useInboxStore((s) => (head.channelId ? s.chatChannels[head.channelId]?.name : undefined));
  const author = row ? slackAuthorFor(row) ?? authorFor(row.user_id, row.author_kind, byId) : null;
  const name = author?.name ?? head.name;
  const meta = (
    <>
      {author ? (
        <CommentAvatar name={name} image={author.avatarUrl} isAgent={author.isAgent} size={18} letters={2} />
      ) : (
        <span className="ch-quote-slack"><SlackLogo className="w-3 h-3" /></span>
      )}
      <span className="ch-quote-author">{name}</span>
      {channel && <span className="ch-quote-meta">#{channel}</span>}
      {row && <span className="ch-quote-meta">{TIME.format(new Date(row.created_at))}</span>}
    </>
  );
  return (
    <blockquote className="ch-quote">
      {head.messageId ? (
        <Link href={head.href} className="ch-quote-head" title="Open the original message">{meta}</Link>
      ) : (
        <a href={head.href} className="ch-quote-head" target="_blank" rel="noopener noreferrer" title="Open in Slack">{meta}</a>
      )}
      <div className="ch-quote-body">{children}</div>
    </blockquote>
  );
}
