import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ArrowDown, Loader2 } from "lucide-react";
import { useBottomAnchoredList, prefersReducedMotion } from "../../hooks/useBottomAnchoredList";
import { buildChatTimeline, type TimelineRow } from "../../lib/chatTimeline";
import { ChatMessage, ChatDayDivider, ChatNewDivider } from "./ChatMessage";
import type { ChatMessageView } from "./chatTypes";
import "./chat.css";

// The channel transcript.
//
// Presentational: it takes messages and handlers, never the store, so it renders
// identically from a fixture and from live data — which is how the whole surface
// gets screenshot-verified before any wiring exists.
//
// Two behaviours here are product decisions rather than mechanics, and both come
// from the design critique:
//
//  1. A channel with unread messages OPENS AT THE UNREAD RULE, not at the bottom.
//     Landing at the bottom means the first thing you do in a busy channel is
//     scroll backwards to find where you stopped.
//  2. The rule SURVIVES until you leave the channel. If it vanished the moment
//     you glanced at the room, re-entering mid read would erase your place.
//     So the rule is computed from a lastReadAt frozen at entry, not from the
//     live read mark that your own reading is busy advancing.

type Row = TimelineRow<{
  id: string;
  authorId: string;
  createdAt: number;
  pendingAgent?: boolean;
  deleted?: boolean;
  view: ChatMessageView;
}>;

// Rough first guesses, refined by the height cache after one measured pass. Too
// small is better than too large: the list corrects downward without the content
// appearing to jump away from the reader.
const estimateRow = (row: Row | undefined): number => {
  if (!row) return 40;
  if (row.kind === "day") return 38;
  if (row.kind === "new") return 24;
  const m = row.message.view;
  if (m.deletedAt) return 26;
  if (m.agentStatus === "thinking" || m.agentStatus === "error") return 30;
  // A voice bubble is one padded line around its transcript, plus the control
  // and clock that sit on the same line as the words.
  if (m.voice) {
    const spoken = Math.max(1, Math.ceil(m.content.length / 80));
    return (row.grouped ? 8 : 26) + spoken * 20;
  }
  const lines = Math.max(1, Math.ceil(m.content.length / 92));
  // A huddle digest carries its own header plus the transcript disclosure line.
  if (m.call) return 26 + lines * 21 + 22 + (m.reactions?.length ? 24 : 0) + (m.replyCount ? 26 : 0);
  return (row.grouped ? 4 : 22) + lines * 21 + (m.reactions?.length ? 24 : 0) + (m.replyCount ? 26 : 0);
};

export type ChatMessageListProps = {
  messages: ChatMessageView[];
  /** Frozen at channel entry. See the note above about why this must not be the
   *  live read mark. */
  lastReadAt?: number;
  viewerId: string;
  /** Namespaces the height cache and re-runs the initial landing. Not a real
   *  channel id in the thread panel, which namespaces by its root. */
  channelId: string;
  /** The REAL channel, for the permalink each message's timestamp carries. */
  permalinkChannelId?: string;
  knownHandles?: Set<string>;
  selfHandles?: Set<string>;
  handleNames?: Map<string, string>;
  now: number;
  hasMoreAbove?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** Fires when the newest message is on screen, so the caller can advance the
   *  read mark. */
  onReachedBottom?: () => void;
  /** Is the reader actually looking at this list — tab visible, window focused?
   *  The report is WITHHELD rather than consumed while this is false, so it
   *  fires the moment they come back. Latching it under an unfocused window is
   *  how a message read on return stays bold until something newer arrives. */
  canReportRead?: boolean;
  onOpenThread?: (messageId: string) => void;
  onReact?: (messageId: string, emoji: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onDelete?: (messageId: string) => void;
  onRetryAgent?: (messageId: string) => void;
  onRetrySend?: (messageId: string) => void;
  /** Suppresses day separators and the thread affordance. */
  inThread?: boolean;
  /** A permalink landing (/chat/<channel>?m=<id>): scroll that row into view and
   *  flash it once. Separate from the unread rule — a link is a place someone
   *  sent you, not a place you stopped reading. */
  targetMessageId?: string;
};

export const ChatMessageList = memo(function ChatMessageList({
  messages,
  lastReadAt,
  viewerId,
  channelId,
  permalinkChannelId,
  knownHandles,
  selfHandles,
  handleNames,
  now,
  hasMoreAbove,
  isLoadingOlder,
  onLoadOlder,
  onReachedBottom,
  canReportRead = true,
  onOpenThread,
  onReact,
  onEdit,
  onDelete,
  onRetryAgent,
  onRetrySend,
  inThread,
  targetMessageId,
}: ChatMessageListProps) {
  const rows = useMemo<Row[]>(
    () =>
      buildChatTimeline(
        messages.map((m) => ({
          id: m.id,
          authorId: m.author.id,
          createdAt: m.createdAt,
          pendingAgent: m.agentStatus === "thinking" || m.agentStatus === "streaming",
          deleted: !!m.deletedAt,
          standalone: !!m.call,
          view: m,
        })),
        { now, lastReadAt, viewerId, withoutDays: inThread },
      ) as Row[],
    [messages, lastReadAt, viewerId, now, inThread],
  );

  // Land on the unread rule when there is one. The rule row itself, not the
  // first unread message, so the reader sees the boundary they stopped at.
  const newRuleIndex = useMemo(() => rows.findIndex((r) => r.kind === "new"), [rows]);
  const initialIndex = newRuleIndex >= 0 ? newRuleIndex : null;

  const list = useBottomAnchoredList({
    count: rows.length,
    getItemKey: (i) => rows[i]?.key ?? String(i),
    estimateSize: (i) => estimateRow(rows[i]),
    cacheNamespace: `chat:${channelId}`,
    // A message that changes grouping renders at a different height, so it must
    // not read the height cached under its other shape.
    rowVariantKey: (i) => {
      const r = rows[i];
      if (!r || r.kind !== "message") return "x";
      // The voice status belongs here too: a burst that flips live -> done
      // swaps a pulsing line for a play button and a clock, and reading the
      // height cached under its other shape makes the transcript jump as it
      // lands.
      return `${r.grouped ? "g" : "l"}${r.message.view.agentStatus ?? ""}${r.message.view.deletedAt ? "d" : ""}${r.message.view.voice?.status ?? ""}`;
    },
    paddingStart: 12,
    paddingEnd: 8,
    initialIndex,
    resetKey: channelId,
    hasMoreAbove,
    isLoadingOlder,
    onLoadOlder,
  });

  const { atBottom, nearBottom, userScrolled, lastVisibleIndex } = list;

  // Report "the newest message is on screen" once per arrival at the bottom,
  // never on every scroll tick — the caller turns this into a read mark write.
  //
  // In an effect, not in the render body. The callback dispatches a store write,
  // and doing that during render makes React flush inside its own lifecycle.
  const reportedRef = useRef<string | null>(null);
  const newestKey = rows.length ? rows[rows.length - 1].key : "";
  useEffect(() => {
    if (!atBottom) {
      if (reportedRef.current !== null) reportedRef.current = null;
      return;
    }
    // Not looking: leave the arrival UNREPORTED. Marking the key consumed here
    // is what made a message that landed while the reader was in another app
    // stay unread after they came back to it.
    if (!canReportRead) return;
    if (!newestKey || reportedRef.current === newestKey) return;
    reportedRef.current = newestKey;
    onReachedBottom?.();
  }, [atBottom, canReportRead, newestKey, onReachedBottom]);

  // How many messages sit below the fold. This is the number on the pill, and it
  // is what makes "jump to latest" a decision rather than a leap of faith.
  const belowCount = useMemo(() => {
    if (atBottom || lastVisibleIndex < 0) return 0;
    let n = 0;
    for (let i = lastVisibleIndex + 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.kind === "message" && !r.message.view.deletedAt) n++;
    }
    return n;
  }, [atBottom, lastVisibleIndex, rows]);

  const jump = useCallback(() => {
    list.scrollToBottom({ smooth: !prefersReducedMotion() });
  }, [list]);

  // Your own send always lands you at the bottom. The virtualizer's native
  // follow only acts within scrollEndThreshold of the end, and a burst of sends
  // compounds estimate error until the believed offset drifts out of that band
  // — parked a little above the bottom, your message under the composer, and no
  // pill because nothing was deliberately scrolled. Sending IS intent to be at
  // the bottom, so snap, and let scrollToBottom's retry ladder absorb the late
  // measurements. Keyed on the pending tail: only a stub this tab just wrote is
  // ever pending, so an echo rekey or someone else's message can't re-trigger.
  const tail = rows.length ? rows[rows.length - 1] : undefined;
  const ownSendKey =
    tail && tail.kind === "message" && tail.message.view.pending
      && tail.message.view.author.id === viewerId
      ? tail.key
      : null;
  // Entering a channel is a landing, not a send — the unread rule owns that
  // position, so a pending tail that is merely already there must not snap.
  const ownSendScrolledRef = useRef(ownSendKey);
  const ownSendChannelRef = useRef(channelId);
  if (ownSendChannelRef.current !== channelId) {
    ownSendChannelRef.current = channelId;
    ownSendScrolledRef.current = ownSendKey;
  }
  const { scrollToBottom } = list;
  useEffect(() => {
    if (!ownSendKey || ownSendScrolledRef.current === ownSendKey) return;
    ownSendScrolledRef.current = ownSendKey;
    scrollToBottom({ smooth: !prefersReducedMotion() });
  }, [ownSendKey, scrollToBottom]);

  // Land on a permalinked message. Two steps, because the row may be virtualized
  // out of the DOM: scroll the virtualizer to its index first, then flash the
  // element once it has actually mounted.
  //
  // The dependency list is deliberately narrow — the target id and whether it is
  // in the list at all. `rows` is a fresh array on every render and the list
  // handle is a fresh object, so depending on either re-runs this effect
  // continuously; the cleanup would then cancel the 60ms timer before it ever
  // fired and the flash would never appear. (It didn't, until this.)
  const targetIndex = useMemo(
    () =>
      targetMessageId
        ? rows.findIndex((r) => r.kind === "message" && r.message.id === targetMessageId)
        : -1,
    [rows, targetMessageId],
  );
  const targetFound = targetIndex >= 0;
  const targetIndexRef = useRef(targetIndex);
  targetIndexRef.current = targetIndex;
  const listRef = useRef(list);
  listRef.current = list;
  // Fired once per target: re-flashing would make the message strobe while it is
  // being read.
  const flashedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!targetMessageId || !targetFound || flashedRef.current === targetMessageId) return;
    flashedRef.current = targetMessageId;
    listRef.current.scrollToIndex(targetIndexRef.current, { align: "center" });
    const timer = setTimeout(() => {
      const el = document.getElementById(`chatmsg-${targetMessageId}`);
      if (!el) return;
      el.classList.add("ch-msg-flash");
      setTimeout(() => el.classList.remove("ch-msg-flash"), 1600);
    }, 60);
    return () => clearTimeout(timer);
  }, [targetMessageId, targetFound]);

  const items = list.virtualizer.getVirtualItems();

  return (
    <div className="ch-list-wrap">
      <div className="ch-list" ref={list.containerRef}>
        {isLoadingOlder && (
          <div className="ch-loading-older" role="status">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Loading earlier messages</span>
          </div>
        )}
        <div className="ch-list-sizer" style={{ height: list.totalSize }}>
          {items.map((item) => {
            const row = rows[item.index];
            if (!row) return null;
            // React 19 refuses a key arriving through a spread, so it is lifted
            // out and passed as its own attribute.
            // The virtualizer types its key as `Key`, which includes bigint; the
            // hook's rowProps takes string | number. Our getItemKey only ever
            // returns a string, so the narrowing is honest.
            const { key, ...rowProps } = list.rowProps({
              index: item.index,
              key: item.key as string | number,
              start: item.start,
            });
            return (
              <div key={key} {...rowProps}>
                {row.kind === "day" ? (
                  <ChatDayDivider label={row.label} />
                ) : row.kind === "new" ? (
                  <ChatNewDivider />
                ) : (
                  <ChatMessage
                    message={row.message.view}
                    grouped={row.grouped}
                    channelId={permalinkChannelId}
                    knownHandles={knownHandles}
                    selfHandles={selfHandles}
                    handleNames={handleNames}
                    now={now}
                    mine={row.message.view.author.id === viewerId}
                    inThread={inThread}
                    onOpenThread={onOpenThread}
                    onReact={onReact}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onRetryAgent={onRetryAgent}
                    onRetrySend={onRetrySend}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Only while the reader has deliberately scrolled away. Showing it at rest
          would put a button over the newest message for no reason. */}
      {userScrolled && !nearBottom && (
        <button type="button" className="ch-jump" onClick={jump}>
          <ArrowDown className="w-3 h-3" />
          {belowCount > 0 ? (
            <span>
              {belowCount} new {belowCount === 1 ? "message" : "messages"}
            </span>
          ) : (
            <span>Jump to latest</span>
          )}
        </button>
      )}
    </div>
  );
});
