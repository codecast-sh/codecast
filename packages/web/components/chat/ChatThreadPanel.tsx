import type { ReactNode } from "react";
import { memo } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { ChatAttachment } from "../../store/chatSlice";
import { ChatMessage } from "./ChatMessage";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer } from "./ChatComposer";
import type { ChatMessageView } from "./chatTypes";
import { EdgeResizeHandle, useEdgeResize } from "../../hooks/useEdgeResize";
import "./chat.css";

// The thread panel: Slack's right rail.
//
// The root message is the first row of the replies list, so the whole thread
// is one scroll. Pinned above the list, a long root (an agent's report) took
// most of the panel and left the replies a small second scroll pane under it.
//
// The replies use the same virtualized list as the channel, in `inThread` mode:
// no day separators, no nested thread affordance. Opening the panel pins to
// the latest reply; a permalink (`?m=`) is the only case that lands on a
// specific row instead. Reusing the list means a reply groups, links, reacts
// and fails to send exactly the way a channel message does, because it IS the
// same component.
//
// `rootId` is the REQUESTED root, `root` the loaded view of it. They are not the
// same thing for the first seconds of every thread, and the difference is not
// cosmetic: the composer's draft key and the list's height namespace are both
// identity. Keyed off the loaded root, a reply typed while the thread was
// opening went into the CHANNEL's draft — same key, byte for byte — and was left
// behind there when the root landed and the composer remounted.
//
// The width is the reader's, not the layout's: a drag on the left edge resizes
// the panel and the choice persists per client (same pattern as the comment
// rail, components/comments/CommentDock.tsx). There is no fixed cap: a thread
// full of code or an agent's long answer is worth most of the screen. The one
// bound is the transcript beside it, which keeps a readable column
// (MIN_TRANSCRIPT_W) however far the panel is dragged, measured against the
// shell at drag time rather than a saved number that may not fit this window.
//
// On a narrow surface the panel is the whole surface instead (chat.css, the
// ch-shell 860px query): a side panel there left neither column readable. The
// header then offers a back button to the channel in place of the close X.
// The width rides a CSS variable so that query can override it.

const MIN_W = 300;
const MIN_TRANSCRIPT_W = 360;
const DEFAULT_W = 384;
const WIDTH_KEY = "ch-thread-width";

// As wide as the shell allows while the transcript keeps its column.
const maxWidth = (handle: HTMLElement) =>
  (handle.parentElement?.parentElement?.clientWidth ?? Infinity) - MIN_TRANSCRIPT_W;

export const ChatThreadPanel = memo(function ChatThreadPanel({
  channelName,
  channelId,
  rootId,
  root,
  replies,
  viewerId,
  knownHandles,
  selfHandles,
  handleNames,
  teamId,
  composer,
  now,
  targetMessageId,
  onClose,
  onSend,
  onReact,
  onEdit,
  onDelete,
  onRetrySend,
  onRetryAgent,
}: {
  channelName: string;
  channelId: string;
  rootId: string;
  root: ChatMessageView | null;
  replies: ChatMessageView[];
  viewerId: string;
  knownHandles?: Set<string>;
  selfHandles?: Set<string>;
  handleNames?: Map<string, string>;
  /** The channel's team — scopes the composer's @ popup to the room's team. */
  teamId?: string;
  /** Replaces the reply composer: a visitor who cannot post sees a sign-in
   *  prompt where the box would be. */
  composer?: ReactNode;
  now: number;
  /** A permalink to a REPLY: the panel is the only place that message exists, so
   *  the link lands nowhere unless the panel scrolls to it. */
  targetMessageId?: string;
  onClose: () => void;
  onSend: (content: string, attachments?: ChatAttachment[], opts?: { broadcast?: boolean }) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
  onRetrySend?: (messageId: string) => void;
  onRetryAgent?: (messageId: string) => void;
}) {
  const { width, onResizeDown } = useEdgeResize({ storageKey: WIDTH_KEY, min: MIN_W, fallback: DEFAULT_W, max: maxWidth });

  return (
    <aside
      className="ch-thread"
      aria-label="Thread"
      style={{ "--ch-thread-w": `${width}px` } as React.CSSProperties}
    >
      <EdgeResizeHandle onResizeDown={onResizeDown} />
      <div className="ch-thread-head">
        <button type="button" className="ch-thread-back" title={`Back to #${channelName}`} onClick={onClose}>
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="ch-thread-heading">
          <div className="ch-thread-title">Thread</div>
          {/* The count lives on the divider under the root, where it separates
              subject from answers. Saying it twice, 150px apart, told the reader
              the same number in one glance. */}
          <div className="ch-thread-sub">#{channelName}</div>
        </div>
        <button type="button" className="ch-tool ch-thread-close" title="Close thread" onClick={onClose}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <ChatMessageList
        messages={replies}
        viewerId={viewerId}
        channelId={`thread:${rootId}`}
        permalinkChannelId={channelId}
        knownHandles={knownHandles}
        selfHandles={selfHandles}
        handleNames={handleNames}
        now={now}
        inThread
        targetMessageId={targetMessageId}
        header={root && (
          <>
            <div className="ch-thread-root">
              <ChatMessage
                message={root}
                channelId={channelId}
                knownHandles={knownHandles}
                selfHandles={selfHandles}
                now={now}
                mine={root.author.id === viewerId}
                inThread
                onReact={onReact}
                onEdit={onEdit}
                onDelete={onDelete}
                onRetrySend={onRetrySend}
                onRetryAgent={onRetryAgent}
              />
            </div>
            {replies.length > 0 && (
              <div className="ch-thread-replies-label">
                {replies.length} {replies.length === 1 ? "reply" : "replies"}
              </div>
            )}
          </>
        )}
        onReact={onReact}
        onEdit={onEdit}
        onDelete={onDelete}
        onRetrySend={onRetrySend}
        onRetryAgent={onRetryAgent}
      />

      {composer ?? <ChatComposer
        channelId={channelId}
        threadRootId={rootId}
        teamId={teamId}
        // A reply on a thread a session started is delivered into that
        // session (chat.ts maybeRelayToOriginSession) — say so where the
        // person is about to type, so it is not a surprise.
        placeholder={root?.author.session ? `Reply to ${root.author.name} — delivered into its session` : "Reply…"}
        channelName={channelName}
        onSend={onSend}
        compact
      />}
    </aside>
  );
});
