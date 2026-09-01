import { memo, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { SmilePlus, MessageSquare, MoreHorizontal, RotateCw, AlertTriangle, Link2, Pencil, Trash2, Forward, PhoneCall } from "lucide-react";
import { parseHuddleDigestContent } from "@codecast/shared/contracts";
import { openForwardToChat } from "../../lib/forwardToChat";
import { remarkSanitizeInvisibleUnicode } from "../tools/MarkdownRenderer";
import { MESSAGE_MD_COMPONENTS, MESSAGE_MD_REHYPE, USER_MD_REMARK } from "../messageMarkdown";
import { CommentAvatar } from "../comments/CommentAvatar";
import { remarkChatMentions } from "../../lib/remarkChatMentions";
import { compactAge } from "../../lib/threadState";
import { copyToClipboard } from "../../lib/utils";
import type { ChatAttachmentView, ChatMessageView } from "./chatTypes";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { useStorageImageUrl } from "../../hooks/useStorageImageUrl";
import { ChatVoiceBubble, VoicePlayButton } from "./ChatVoiceBubble";
import { CallTranscriptDisclosure } from "../calls/TranscriptTurns";
import { ImageLightbox } from "../ImageGallery";
import "./chat.css";
import "../editor/editor.css";

// One chat message.
//
// The row is a two column grid: a fixed gutter (--ch-gutter in chat.css) and the body. When a message
// is grouped under the one above it — same author, close in time — the gutter
// holds a hover-revealed timestamp instead of the avatar. Keeping the gutter the
// same width in both states is what stops the text shifting sideways as messages
// group, which is the detail that makes grouped chat feel calm rather than
// twitchy.
//
// Presentational only: it takes a ChatMessageView and callbacks. That keeps it
// renderable from a fixture and cheap to memo under a virtualizer, where rows
// remount constantly.

/** One attached image: resolves its storage URL, opens the shared lightbox.
 *  A tile that is still resolving keeps its footprint (no reflow when the URL
 *  lands); one that failed says so instead of leaving a hole. */
function AttachmentTile({ att, onOpen }: { att: ChatAttachmentView; onOpen: (src: string) => void }) {
  const url = useStorageImageUrl(att.storage_id);
  if (url === null) {
    return <span className="ch-att ch-att-missing">image unavailable</span>;
  }
  return (
    <button
      type="button"
      className="ch-att"
      onClick={() => url && onOpen(url)}
      title={att.name || "View image"}
    >
      {url ? <img src={url} alt={att.name || "attachment"} loading="lazy" /> : <span className="ch-att-loading" />}
    </button>
  );
}

function ChatAttachments({
  messageId,
  attachments,
}: {
  messageId: string;
  attachments: ChatAttachmentView[];
}) {
  const [lightbox, setLightbox] = useState<string | null>(null);
  // A recording is not a picture. Every attachment used to go through
  // AttachmentTile, which puts the storage id in an <img> — so a voice note
  // that arrived beside other files rendered as a broken thumbnail with no way
  // to hear it, which is the symptom diagnosis 7 was reported from. A row whose
  // ONLY attachment is audio becomes a voice bubble upstream and never reaches
  // this grid; these are the mixed rows, and they get the same play control the
  // bubble uses rather than a second one invented here.
  const audio = attachments.filter((a) => a.mime?.startsWith("audio/"));
  const images = attachments.filter((a) => !a.mime?.startsWith("audio/"));
  return (
    <>
      {audio.map((att) => (
        <div className="ch-voice ch-voice-att" key={att.storage_id}>
          {/* One player is shared by the whole app, so the key has to name this
              recording and not just its message. */}
          <VoicePlayButton playKey={`${messageId}:${att.storage_id}`} att={att} />
          <span className="ch-voice-text">{att.name || "recording"}</span>
        </div>
      ))}
      {images.length > 0 && (
        <div className={`ch-atts ${images.length > 1 ? "ch-atts-grid" : ""}`}>
          {images.map((att) => (
            <AttachmentTile key={att.storage_id} att={att} onOpen={setLightbox} />
          ))}
        </div>
      )}
      {lightbox && <ImageLightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

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

/** "3m ago" / "2h ago", on the app's one relative clock (lib/threadState's
 *  compactAge). Chat had its own copy that ROUNDED where every other surface
 *  floors, so a 90 minute old thread read "2h ago" here and "1h" everywhere
 *  else. */
export function relativeReplyTime(ts: number, now: number): string {
  const age = compactAge(Math.max(0, now - ts));
  return age === "just now" ? age : `${age} ago`;
}

/** The one-tap reactions the toolbar offers. Small on purpose: a full picker is
 *  a different surface, and six covers what people actually press. */
export const QUICK_REACTIONS = ["👍", "🎉", "❤️", "👀", "🚀", "😄"];

/** "Maya" / "Maya and Sam" / "Maya, Sam and Ada" — the reaction tooltip's
 *  who-list. */
function reactorNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type ChatMessageProps = {
  message: ChatMessageView;
  /** Suppress the header and avatar: this message continues the one above. */
  grouped?: boolean;
  /** The room this message is in. The timestamp is a PERMALINK
   *  (/chat/<channel>?m=<id>) — the one place a reader instinctively
   *  right-clicks to copy a link to a message — so the row has to know it. */
  channelId?: string;
  /** Handles that resolve to real members, so unknown @words stay plain text. */
  knownHandles?: Set<string>;
  /** The viewer's handles, for the louder self-mention treatment. */
  selfHandles?: Set<string>;
  /** handle → display name for the rendered chip. */
  handleNames?: Map<string, string>;
  /** Passed in rather than read from Date.now() so a virtualized list re-renders
   *  on a coarse clock instead of per row. */
  now: number;
  /** True when the viewer wrote this message: the only one who may edit or
   *  delete it, and the server agrees. */
  mine?: boolean;
  onOpenThread?: (messageId: string) => void;
  /** The emoji is the ARGUMENT. A pill reports its own emoji, the toolbar
   *  reports whichever one the picker was pointed at — a control that always
   *  posted a thumbs-up made the pill the reader pressed look broken. */
  onReact?: (messageId: string, emoji: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
  onRetryAgent?: (messageId: string) => void;
  /** Re-drive a send that failed. Local-first means the row appears instantly;
   *  if delivery then fails and nothing says so, the message sits there looking
   *  sent. That is the failure that makes people stop trusting a chat product. */
  onRetrySend?: (messageId: string) => void;
  /** Hides the thread affordance and hover tools — used inside the thread panel,
   *  where a nested thread would be meaningless. */
  inThread?: boolean;
};

export const ChatMessage = memo(function ChatMessage({
  message,
  grouped,
  channelId,
  knownHandles,
  selfHandles,
  handleNames,
  now,
  mine,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
  onRetryAgent,
  onRetrySend,
  inThread,
}: ChatMessageProps) {
  const { author, agentStatus } = message;
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);

  // The SESSION user-message pipeline (USER_MD_REMARK: entity pills + tight
  // newlines via remark-breaks + pasted tags shown literally), not the document
  // pipeline — a chat message is typed text, exactly like a session prompt, and
  // rendering the two through different codepaths is how "@x on its own airy
  // paragraph" happened here while sessions rendered the same text tight.
  //
  // On top of it: the invisible-Unicode sanitizer (teammate- and agent-authored
  // content is the last place to drop it) and the chat mention highlighter —
  // registered as a [plugin, options] tuple, not as remarkChatMentions(opts):
  // unified calls each array entry to OBTAIN the transformer, so handing it an
  // already-built transformer makes it run with the options slot as the tree.
  // (Mutable tuple: unified's Pluggable type refuses a readonly one.)
  const remarkPlugins = useMemo(
    () => [
      ...USER_MD_REMARK,
      remarkSanitizeInvisibleUnicode,
      [remarkChatMentions, { known: knownHandles, self: selfHandles, names: handleNames }] as [
        typeof remarkChatMentions,
        { known?: Set<string>; self?: Set<string>; names?: Map<string, string> },
      ],
    ],
    [knownHandles, selfHandles, handleNames],
  );

  const rowRef = useRef<HTMLDivElement | null>(null);
  // One outside click closes whichever popover is open. Both are anchored to the
  // hover toolbar, which disappears the moment the pointer leaves the row.
  useEffect(() => {
    if (!menuOpen && !pickerOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rowRef.current?.contains(e.target as Node)) return;
      setMenuOpen(false);
      setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenuOpen(false);
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, pickerOpen]);

  const permalink = channelId ? `/chat/${channelId}?m=${message.id}` : undefined;
  // A huddle digest is a system row about the call, not something its author
  // typed: the header names the huddle instead of the person who happened to
  // start it, and the gutter wears a call badge instead of their face. The
  // timeline builder already refuses to group anything under it (standalone).
  const isCall = !!message.call && !message.deletedAt;
  const callHead = isCall ? parseHuddleDigestContent(message.content) : null;
  // An untitled huddle's title IS "Huddle" — the kicker already says it once.
  const callTitle = callHead && callHead.title !== "Huddle" ? callHead.title : null;
  // A voice burst has no typed text to correct: its content is a transcript of
  // something already said out loud, and editing it would put words in the
  // speaker's mouth. Delete stays — you can take a voice note back.
  // A huddle digest's content is the server's summary of what was said, not
  // something its author typed — like a voice transcript, there is nothing of
  // theirs to correct.
  const canEdit = !!mine && !!onEdit && !message.deletedAt && !author.isAgent && !message.voice && !message.call;
  const canDelete = !!mine && !!onDelete && !message.deletedAt;

  const react = (emoji: string) => {
    setPickerOpen(false);
    onReact?.(message.id, emoji);
  };

  const saveEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (next && next !== message.content) onEdit?.(message.id, next);
  };

  const rowClass = [
    "ch-msg",
    grouped ? "" : "ch-msg-lead",
    message.mentionsMe ? "ch-msg-mentions-me" : "",
    // A send in flight looks like any other message: it is already readable,
    // and dimming (or a spinner) on every send made an ordinary action look
    // provisional. Only the one state the reader must act on is marked.
    message.failed ? "ch-msg-failed" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const thinking = agentStatus === "thinking" || agentStatus === "streaming";
  const errored = agentStatus === "error";

  return (
    <div className={rowClass} data-message-id={message.id} id={`chatmsg-${message.id}`} ref={rowRef}>
      <div className="ch-msg-gutter">
        {isCall ? (
          <span className="ch-call-badge" aria-hidden="true">
            <PhoneCall className="w-3 h-3" />
          </span>
        ) : grouped ? (
          <span className="ch-msg-hovertime" aria-hidden="true">
            {clockTime(message.createdAt)}
          </span>
        ) : (
          <CommentAvatar
            name={author.name}
            image={author.avatarUrl}
            isAgent={author.isAgent}
            agentType={author.session?.agentType}
            letters={2}
          />
        )}
      </div>

      <div className="min-w-0">
        {isCall ? (
          <div className="ch-msg-head ch-call-head">
            <span className="ch-call-kicker">Huddle</span>
            {callTitle && <span className="ch-msg-author">{callTitle}</span>}
            {callHead?.lead && <span className="ch-call-lead">{callHead.lead}</span>}
            <a
              className="ch-msg-time"
              href={permalink ?? `#chatmsg-${message.id}`}
              title={FULL_TIME.format(new Date(message.createdAt))}
            >
              {headerTime(message.createdAt, now)}
            </a>
          </div>
        ) : !grouped && (
          <div className="ch-msg-head">
            {author.session ? (
              <a
                className="ch-msg-author"
                href={`/conversation/${encodeURIComponent(author.session.id)}`}
                title="Open session"
              >
                {author.name}
              </a>
            ) : (
              <span className="ch-msg-author">{author.name}</span>
            )}
            {/* A session persona wears a "session" chip and credits the human
                it ran as; the anchor keeps its plain "agent" chip. */}
            {author.session ? (
              <>
                <span className="ch-agent-chip">session</span>
                {author.session.via && <span className="ch-msg-via">via {author.session.via}</span>}
              </>
            ) : (
              author.isAgent && <span className="ch-agent-chip">agent</span>
            )}
            <a
              className="ch-msg-time"
              // The permalink the server mints, not a DOM fragment: a fragment
              // is meaningless outside this tab, and clicking one asks the
              // browser to scroll a row the virtualizer may have unmounted.
              href={permalink ?? `#chatmsg-${message.id}`}
              title={FULL_TIME.format(new Date(message.createdAt))}
            >
              {headerTime(message.createdAt, now)}
            </a>
          </div>
        )}

        {/* A broadcast reply ("also send to #channel"): the only way a reply
            reaches the channel timeline. The context line is the way back to
            the conversation it belongs to. */}
        {!inThread && message.threadRootId && !message.deletedAt && (
          <button
            type="button"
            className="ch-msg-threadctx"
            onClick={() => onOpenThread?.(message.threadRootId!)}
          >
            <MessageSquare className="w-3 h-3" />
            replied to a thread
          </button>
        )}

        {message.deletedAt ? (
          <div className="ch-msg-deleted">This message was deleted</div>
        ) : message.voice ? (
          // Below the deleted branch on purpose: a canceled burst carries
          // `deleted_at`, so "this was deleted" answers first and a brushed key
          // never pulses at anybody.
          <ChatVoiceBubble message={message} />
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
        ) : editing ? (
          // Editing in place, not in the composer: the message stays where it is
          // in the transcript, so you can still see what you are answering.
          <div className="ch-edit">
            <textarea
              className="ch-edit-box"
              value={draft}
              autoFocus
              rows={Math.min(8, draft.split("\n").length + 1)}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setEditing(false);
                  setDraft(message.content);
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
              }}
            />
            <div className="ch-edit-foot">
              <button type="button" className="ch-edit-save" onClick={saveEdit}>
                Save
              </button>
              <button
                type="button"
                className="ch-edit-cancel"
                onClick={() => {
                  setEditing(false);
                  setDraft(message.content);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="ch-msg-body">
            <ReactMarkdown
              remarkPlugins={remarkPlugins}
              rehypePlugins={MESSAGE_MD_REHYPE}
              components={MESSAGE_MD_COMPONENTS}
            >
              {/* The digest's lead line moved into the header above. */}
              {callHead ? callHead.body : message.content}
            </ReactMarkdown>
            {message.attachments && message.attachments.length > 0 && (
              <ChatAttachments messageId={message.id} attachments={message.attachments} />
            )}
            {message.call && (
              <CallTranscriptDisclosure transcriptId={message.call.transcriptId} className="mt-1.5" />
            )}
            {message.editedAt && (
              <span className="ch-msg-edited" title={FULL_TIME.format(new Date(message.editedAt))}>
                (edited)
              </span>
            )}
          </div>
        )}

        {message.failed && (
          <div className="ch-send-failed">
            <AlertTriangle className="w-3 h-3" />
            <span>Not sent</span>
            {onRetrySend && (
              <button type="button" className="ch-send-retry" onClick={() => onRetrySend(message.id)}>
                Retry
              </button>
            )}
          </div>
        )}

        {message.reactions && message.reactions.length > 0 && (
          <div className="ch-reactions">
            <TooltipProvider delayDuration={250} skipDelayDuration={200}>
              {message.reactions.map((r) => (
                <Tooltip key={r.emoji}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={`ch-reaction ${r.mine ? "ch-reaction-mine" : ""}`}
                      onClick={() => react(r.emoji)}
                    >
                      <span aria-hidden="true">{r.emoji}</span>
                      <span className="ch-reaction-count">{r.count}</span>
                    </button>
                  </TooltipTrigger>
                  {r.names && r.names.length > 0 && (
                    <TooltipContent side="top" className="ch-reaction-tip">
                      <span className="ch-reaction-tip-emoji" aria-hidden="true">
                        {r.emoji}
                      </span>
                      <span>{reactorNames(r.names)} reacted</span>
                    </TooltipContent>
                  )}
                </Tooltip>
              ))}
            </TooltipProvider>
          </div>
        )}

        {!inThread && !!message.replyCount && message.replyCount > 0 && (
          <button type="button" className="ch-thread-link" onClick={() => onOpenThread?.(message.id)}>
            <span className="ch-thread-faces">
              {(message.replyFaces ?? []).slice(0, 4).map((f) => (
                <CommentAvatar
                  key={f.id}
                  name={f.name}
                  image={f.avatarUrl}
                  isAgent={f.isAgent}
                  size={16}
                  letters={2}
                  className="ch-thread-face"
                />
              ))}
            </span>
            <span className="ch-thread-count">
              {message.threadAgentStatus === "thinking" || message.threadAgentStatus === "streaming"
                ? "thinking…"
                : `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`}
            </span>
            {message.lastReplyAt && (
              <span className="ch-thread-last">{relativeReplyTime(message.lastReplyAt, now)}</span>
            )}
          </button>
        )}
      </div>

      {!message.deletedAt && !editing && (
        <div className={`ch-tools ${menuOpen || pickerOpen ? "ch-tools-open" : ""}`}>
          {onReact && (
            <button
              type="button"
              className="ch-tool"
              title="React"
              aria-haspopup="true"
              aria-expanded={pickerOpen}
              onClick={() => {
                setMenuOpen(false);
                setPickerOpen((v) => !v);
              }}
            >
              <SmilePlus className="w-3.5 h-3.5" />
            </button>
          )}
          {!inThread && onOpenThread && (
            <button
              type="button"
              className="ch-tool"
              title="Reply in thread"
              onClick={() => onOpenThread(message.id)}
            >
              <MessageSquare className="w-3.5 h-3.5" />
            </button>
          )}
          {/* Rendered only when it can do something, the way the retry buttons
              already are. An overflow button that opens nothing is worse than
              no overflow button. */}
          {(permalink || canEdit || canDelete) && (
            <button
              type="button"
              className="ch-tool"
              title="More"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => {
                setPickerOpen(false);
                setMenuOpen((v) => !v);
              }}
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          )}

          {pickerOpen && (
            <div className="ch-emoji-picker" role="menu" aria-label="React">
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className="ch-emoji-picker-item"
                  title={`React ${emoji}`}
                  onClick={() => react(emoji)}
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}

          {menuOpen && (
            <div className="ch-menu" role="menu" aria-label="Message actions">
              {permalink && (
                <button
                  type="button"
                  className="ch-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void copyToClipboard(
                      typeof window === "undefined" ? permalink : new URL(permalink, window.location.origin).toString(),
                    );
                  }}
                >
                  <Link2 className="w-3 h-3" />
                  Copy link
                </button>
              )}
              {permalink && (
                <button
                  type="button"
                  className="ch-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    openForwardToChat({
                      url: typeof window === "undefined" ? permalink : new URL(permalink, window.location.origin).toString(),
                      label: "message",
                    });
                  }}
                >
                  <Forward className="w-3 h-3" />
                  Forward to…
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  className="ch-menu-item"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    setDraft(message.content);
                    setEditing(true);
                  }}
                >
                  <Pencil className="w-3 h-3" />
                  Edit
                </button>
              )}
              {canDelete && (
                <button
                  type="button"
                  className="ch-menu-item ch-menu-danger"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete?.(message.id);
                  }}
                >
                  <Trash2 className="w-3 h-3" />
                  Delete
                </button>
              )}
            </div>
          )}
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
