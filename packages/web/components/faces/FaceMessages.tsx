import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight } from "lucide-react";
import { useInboxStore, type ChatMessageRow } from "../../store/inboxStore";
import { useOpenChatPath } from "../../hooks/useOpenDm";
import { useFaceChatRecent, useFaceChatUnreadIds } from "../../lib/chat/faceChat";
import { timeAgo, viewerHandles, whereOf } from "../../lib/chat/faceChatText";
import { toastPreview } from "../chat/ChatToast";
import { KeyCap } from "../KeyCap";
import "./faceChat.css";

// What a teammate has been saying, inside their card under the face
// (FaceCard): their recent lines across channels, the ones that were new when
// the card opened marked, and a reply box that answers where they last spoke.
// The card's own actions (Talk, Huddle, Message) stay under it.

/** Lines shown in the card; the chat holds the rest. */
const CARD_LINES = 10;

type Row = { id: string; channelId: string; threadRootId?: string; isDm: boolean; text: string; at: number; me?: boolean };

/** @mentions lifted out of a line: one naming you is red, the rest just read as names. */
export function Preview({ text }: { text: string }) {
  const parts = text.split(/(@[\w.-]+)/g);
  if (parts.length === 1) return <>{text}</>;
  const mine = viewerHandles();
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className="fc-at" data-me={mine.has(p.slice(1).toLowerCase()) ? "1" : undefined}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </>
  );
}

export function FaceMessages({
  memberId,
  name,
  focus,
  onLeave,
  fallback,
}: {
  memberId: string;
  name: string;
  /** Opened to read them (their count or their bubble): the reply box takes the keys. */
  focus: boolean;
  /** The card closes before a route change. */
  onLeave: () => void;
  /** What the card shows when this window has nothing from them. */
  fallback?: ReactNode;
}) {
  const openChat = useOpenChatPath();
  const messages = useInboxStore((s: any) => s.chatMessages as Record<string, ChatMessageRow>);
  const channels = useInboxStore((s: any) => s.chatChannels as Record<string, { kind?: string }>);
  const recent = useFaceChatRecent(memberId);
  const unreadIds = useFaceChatUnreadIds(memberId);
  const [sent, setSent] = useState<Row[]>([]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Everything this person has said that the window knows: loaded messages
  // from the store, and the rail's previews for channels never opened.
  const rows = useMemo(() => {
    const byId = new Map<string, Row>();
    for (const a of recent) {
      byId.set(a.messageId, { id: a.messageId, channelId: a.channelId, threadRootId: a.threadRootId, isDm: a.isDm, text: a.preview, at: a.at });
    }
    for (const m of Object.values(messages ?? {})) {
      if (m.user_id !== memberId || m.deleted_at || !m.content) continue;
      byId.set(m._id, {
        id: m._id,
        channelId: m.channel_id,
        threadRootId: m.thread_root_id,
        isDm: channels?.[m.channel_id]?.kind === "dm",
        text: toastPreview(m.content, 400),
        at: m.created_at,
      });
    }
    const theirs = [...byId.values()].sort((a, b) => a.at - b.at).slice(-CARD_LINES);
    return [...theirs, ...sent].sort((a, b) => a.at - b.at);
  }, [recent, messages, channels, memberId, sent]);
  const target = [...rows].reverse().find((r) => !r.me);

  // Newest at the bottom, in view, on open and whenever a line arrives.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [rows.length]);
  useLayoutEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 120);
    return () => clearTimeout(t);
  }, [focus]);

  if (!target) return <>{fallback}</>;
  const replyWhere = whereOf(target.channelId, target.isDm, target.threadRootId);

  const send = () => {
    const input = inputRef.current;
    const text = input?.value.trim();
    if (!input || !text) return;
    const id = useInboxStore
      .getState()
      .sendChatMessage(target.channelId, text, target.threadRootId ? { threadRootId: target.threadRootId } : undefined);
    setSent((s) => [...s, { id, channelId: target.channelId, threadRootId: target.threadRootId, isDm: target.isDm, text, at: Date.now(), me: true }]);
    input.value = "";
  };

  let lastWhere = "";
  return (
    <div className="fc-card-msgs">
      <div className="fc-card-msgs-head">
        <span>Messages</span>
        <button
          type="button"
          className="fc-open"
          onClick={() => {
            onLeave();
            openChat(`/chat/${target.channelId}?m=${target.id}`);
          }}
        >
          Open in chat <ArrowUpRight className="h-3 w-3" />
        </button>
      </div>
      <div ref={listRef} className="fc-list">
        {rows.map((r) => {
          const where = whereOf(r.channelId, r.isDm, r.threadRootId);
          const sep = where !== lastWhere;
          lastWhere = where;
          return (
            <div key={r.id}>
              {sep && <div className="fc-sep">{where.replace(/^in /, "")}</div>}
              <div className="fc-msg" data-me={r.me ? "1" : undefined} data-unread={unreadIds.includes(r.id) ? "1" : undefined}>
                <span className="fc-dot" />
                <span className="fc-text">
                  <Preview text={r.text} />
                </span>
                <span className="fc-at-time">{timeAgo(r.at)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="fc-reply">
        <input
          ref={inputRef}
          placeholder={target.isDm ? `Message ${name}…` : `Reply ${replyWhere}…`}
          aria-label={`Reply ${replyWhere}`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <KeyCap size="xs">↵</KeyCap>
      </div>
    </div>
  );
}
