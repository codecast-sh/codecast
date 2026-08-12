import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Bot, SmilePlus, MessageSquare, MoreHorizontal, RotateCw, AlertTriangle } from "lucide-react";
import { MD_COMPONENTS } from "../tools/MarkdownRenderer";
import { remarkChatMentions } from "../../lib/remarkChatMentions";
import { entityRemarkPlugins } from "../../lib/remarkEntityIds";
import type { ChatMessageView } from "./chatTypes";
import "./chat.css";

// One chat message.
//
// The row is a two column grid: a fixed 46px gutter and the body. When a message
// is grouped under the one above it — same author, close in time — the gutter
// holds a hover-revealed timestamp instead of the avatar. Keeping the gutter the
// same width in both states is what stops the text shifting sideways as messages
// group, which is the detail that makes grouped chat feel calm rather than
// twitchy.
//
// Presentational only: it takes a ChatMessageView and callbacks. That keeps it
// renderable from a fixture and cheap to memo under a virtualizer, where rows
// remount constantly.

const HOVER_TIME = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function clockTime(ts: number): string {
  return HOVER_TIME.format(new Date(ts));
}

/** "3:04 PM" for today, "Tue 3:04 PM" for older — the header timestamp carries a
 *  weekday once the message is no longer from today, so a scrolled-back reader
 *  is never guessing. */
function headerTime(ts: number, now: number): string {
  const d = new Date(ts);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return clockTime(ts);
  return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${clockTime(ts)}`;
}

export function relativeReplyTime(ts: number, now: number): string {
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

// Stable per-name colour for the initials fallback, so a person keeps the same
// identity colour everywhere without storing one.
const AVATAR_HUES = [
  "var(--sol-blue)",
  "var(--sol-cyan)",
  "var(--sol-green)",
  "var(--sol-violet)",
  "var(--sol-magenta)",
  "var(--sol-orange)",
];

function hueFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

export function ChatAvatar({
  name,
  avatarUrl,
  isAgent,
  size = 22,
  className = "",
}: {
  name: string;
  avatarUrl?: string;
  isAgent?: boolean;
  size?: number;
  className?: string;
}) {
  const style = { width: size, height: size };
  if (isAgent) {
    return (
      <span className={`ch-avatar ch-avatar-agent ${className}`} style={style} title={name}>
        <Bot style={{ width: size * 0.6, height: size * 0.6 }} />
      </span>
    );
  }
  if (avatarUrl) {
    return <img className={`ch-avatar ${className}`} style={style} src={avatarUrl} alt={name} title={name} />;
  }
  return (
    <span
      className={`ch-avatar ch-avatar-fallback ${className}`}
      style={{ ...style, background: hueFor(name) }}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export type ChatMessageProps = {
  message: ChatMessageView;
  /** Suppress the header and avatar: this message continues the one above. */
  grouped?: boolean;
  /** Handles that resolve to real members, so unknown @words stay plain text. */
  knownHandles?: Set<string>;
  /** The viewer's handles, for the louder self-mention treatment. */
  selfHandles?: Set<string>;
  /** Passed in rather than read from Date.now() so a virtualized list re-renders
   *  on a coarse clock instead of per row. */
  now: number;
  onOpenThread?: (messageId: string) => void;
  onReact?: (messageId: string) => void;
  onMore?: (messageId: string) => void;
  onRetryAgent?: (messageId: string) => void;
  /** Hides the thread affordance and hover tools — used inside the thread panel,
   *  where a nested thread would be meaningless. */
  inThread?: boolean;
};

export const ChatMessage = memo(function ChatMessage({
  message,
  grouped,
  knownHandles,
  selfHandles,
  now,
  onOpenThread,
  onReact,
  onMore,
  onRetryAgent,
  inThread,
}: ChatMessageProps) {
  const { author, agentStatus } = message;

  const remarkPlugins = useMemo(
    () => [...entityRemarkPlugins, remarkChatMentions({ known: knownHandles, self: selfHandles })],
    [knownHandles, selfHandles],
  );

  const rowClass = [
    "ch-msg",
    grouped ? "" : "ch-msg-lead",
    message.mentionsMe ? "ch-msg-mentions-me" : "",
    message.pending ? "opacity-60" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const thinking = agentStatus === "thinking" || agentStatus === "streaming";
  const errored = agentStatus === "error";

  return (
    <div className={rowClass} data-message-id={message.id} id={`chatmsg-${message.id}`}>
      <div className="ch-msg-gutter">
        {grouped ? (
          <span className="ch-msg-hovertime" aria-hidden="true">
            {clockTime(message.createdAt)}
          </span>
        ) : (
          <ChatAvatar name={author.name} avatarUrl={author.avatarUrl} isAgent={author.isAgent} />
        )}
      </div>

      <div className="min-w-0">
        {!grouped && (
          <div className="ch-msg-head">
            <span className="ch-msg-author">{author.name}</span>
            {author.isAgent && <span className="ch-agent-chip">agent</span>}
            <a
              className="ch-msg-time"
              href={`#chatmsg-${message.id}`}
              title={FULL_TIME.format(new Date(message.createdAt))}
            >
              {headerTime(message.createdAt, now)}
            </a>
          </div>
        )}

        {message.deletedAt ? (
          <div className="ch-msg-deleted">This message was deleted</div>
        ) : thinking ? (
          // The placeholder the server writes the moment an anchor is mentioned,
          // so the thread exists before the agent has said anything.
          <div className="ch-thinking">
            <span className="ch-thinking-dots" aria-hidden="true">
              <span className="ch-thinking-dot" />
              <span className="ch-thinking-dot" />
              <span className="ch-thinking-dot" />
            </span>
            <span>{author.name} is thinking</span>
          </div>
        ) : errored ? (
          <div className="ch-agent-error">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{author.name} could not answer</span>
            {onRetryAgent && (
              <button type="button" className="ch-agent-retry" onClick={() => onRetryAgent(message.id)}>
                <RotateCw className="w-3 h-3 inline-block mr-1 -mt-px" />
                try again
              </button>
            )}
          </div>
        ) : (
          <div className="ch-msg-body">
            <ReactMarkdown remarkPlugins={remarkPlugins} components={MD_COMPONENTS}>
              {message.content}
            </ReactMarkdown>
            {message.editedAt && (
              <span className="ch-msg-edited" title={FULL_TIME.format(new Date(message.editedAt))}>
                (edited)
              </span>
            )}
          </div>
        )}

        {message.reactions && message.reactions.length > 0 && (
          <div className="ch-reactions">
            {message.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={`ch-reaction ${r.mine ? "ch-reaction-mine" : ""}`}
                title={r.names?.join(", ")}
                onClick={() => onReact?.(message.id)}
              >
                <span aria-hidden="true">{r.emoji}</span>
                <span className="ch-reaction-count">{r.count}</span>
              </button>
            ))}
          </div>
        )}

        {!inThread && !!message.replyCount && message.replyCount > 0 && (
          <button type="button" className="ch-thread-link" onClick={() => onOpenThread?.(message.id)}>
            <span className="ch-thread-faces">
              {(message.replyFaces ?? []).slice(0, 4).map((f) => (
                <ChatAvatar
                  key={f.id}
                  name={f.name}
                  avatarUrl={f.avatarUrl}
                  isAgent={f.isAgent}
                  size={16}
                  className="ch-thread-face"
                />
              ))}
            </span>
            <span className="ch-thread-count">
              {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
            </span>
            {message.lastReplyAt && (
              <span className="ch-thread-last">{relativeReplyTime(message.lastReplyAt, now)}</span>
            )}
          </button>
        )}
      </div>

      {!message.deletedAt && (
        <div className="ch-tools">
          <button type="button" className="ch-tool" title="React" onClick={() => onReact?.(message.id)}>
            <SmilePlus className="w-3.5 h-3.5" />
          </button>
          {!inThread && (
            <button
              type="button"
              className="ch-tool"
              title="Reply in thread"
              onClick={() => onOpenThread?.(message.id)}
            >
              <MessageSquare className="w-3.5 h-3.5" />
            </button>
          )}
          <button type="button" className="ch-tool" title="More" onClick={() => onMore?.(message.id)}>
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
});

// ── Dividers ────────────────────────────────────────────────────────────────

export function ChatDayDivider({ label }: { label: string }) {
  return (
    <div className="ch-day">
      <span className="ch-day-label">{label}</span>
    </div>
  );
}

export function ChatNewDivider() {
  return (
    <div className="ch-new" role="separator" aria-label="New messages">
      <span className="ch-new-label">new</span>
    </div>
  );
}
