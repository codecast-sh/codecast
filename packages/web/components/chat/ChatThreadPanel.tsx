import { memo } from "react";
import { X } from "lucide-react";
import { ChatMessage } from "./ChatMessage";
import { ChatMessageList } from "./ChatMessageList";
import { ChatComposer } from "./ChatComposer";
import type { ChatMessageView } from "./chatTypes";
import "./chat.css";

// The thread panel: Slack's right rail.
//
// The root message is pinned above the scroll region rather than folded into it.
// A thread is read as "what was said about THIS", and a root that scrolls away
// takes the subject with it — three replies down you are reading answers to a
// question you can no longer see.
//
// The replies use the same virtualized list as the channel, in `inThread` mode:
// no day separators, no nested thread affordance. Reusing it means a reply
// groups, links, reacts and fails to send exactly the way a channel message
// does, because it IS the same component.
//
// `rootId` is the REQUESTED root, `root` the loaded view of it. They are not the
// same thing for the first seconds of every thread, and the difference is not
// cosmetic: the composer's draft key and the list's height namespace are both
// identity. Keyed off the loaded root, a reply typed while the thread was
// opening went into the CHANNEL's draft — same key, byte for byte — and was left
// behind there when the root landed and the composer remounted.

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
  now: number;
  /** A permalink to a REPLY: the panel is the only place that message exists, so
   *  the link lands nowhere unless the panel scrolls to it. */
  targetMessageId?: string;
  onClose: () => void;
  onSend: (content: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
  onRetrySend?: (messageId: string) => void;
  onRetryAgent?: (messageId: string) => void;
}) {
  return (
    <aside className="ch-thread" aria-label="Thread">
      <div className="ch-thread-head">
        <div>
          <div className="ch-thread-title">Thread</div>
          {/* The count lives on the divider under the root, where it separates
              subject from answers. Saying it twice, 150px apart, told the reader
              the same number in one glance. */}
          <div className="ch-thread-sub">#{channelName}</div>
        </div>
        <button type="button" className="ch-tool" title="Close thread" onClick={onClose}>
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {root && (
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
      )}

      {replies.length > 0 && (
        <div className="ch-thread-replies-label">
          {replies.length} {replies.length === 1 ? "reply" : "replies"}
        </div>
      )}

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
        onReact={onReact}
        onEdit={onEdit}
        onDelete={onDelete}
        onRetrySend={onRetrySend}
        onRetryAgent={onRetryAgent}
      />

      <ChatComposer
        channelId={channelId}
        threadRootId={rootId}
        teamId={teamId}
        placeholder="Reply…"
        onSend={onSend}
        compact
      />
    </aside>
  );
});
