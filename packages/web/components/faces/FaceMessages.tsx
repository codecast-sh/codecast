import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { ArrowUpRight, CornerDownRight } from "lucide-react";
import { dmKeyFor } from "@codecast/shared/chat";
import { useInboxStore, type ChatMessageRow } from "../../store/inboxStore";
import { findDmChannelId } from "../../store/chatSlice";
import { useChannelMessagesSync, useEnsureChatMessage } from "../../hooks/useChatSync";
import { useOpenChatPath } from "../../hooks/useOpenDm";
import { activeTeamIdOf } from "../../lib/activeTeam";
import { isConvexId } from "../../lib/entityLinks";
import { rememberFaceReply, useFaceChatRecent, useFaceChatUnreadIds } from "../../lib/chat/faceChat";
import { timeAgo, viewerHandles, whereOf } from "../../lib/chat/faceChatText";
import { toastPreview } from "../chat/ChatToast";
import { KeyCap } from "../KeyCap";
import { Button } from "../ui/button";
import { hueFor } from "../../lib/avatarInitials";
import "./faceChat.css";

// The conversation with a teammate, inside their card under the face
// (FaceCard): your direct messages with them, both sides, from the store, and
// what they said in channels while this window was watching. Lines that were
// new when the card opened carry a dot. The reply box answers where they last
// spoke, and with nothing from them yet it starts the DM. The card's own
// actions (Talk, Huddle) stay under it.

/** DM lines kept in the card; the chat holds the rest. */
const CARD_LINES = 30;
/** A pause this long starts a new run of lines. */
const RUN_GAP_MS = 5 * 60_000;

type Row = {
  id: string;
  channelId: string;
  threadRootId?: string;
  inThread?: boolean;
  isDm: boolean;
  text: string;
  at: number;
  me: boolean;
  failed?: boolean;
  /** The thread's opening line, once the store holds it. */
  rootText?: string;
};

/** Loads one message the store has not seen (a channel line the rail only
 *  previewed, or the root of its thread). Renders nothing. */
function EnsureMessage({ id }: { id: string }) {
  useEnsureChatMessage(id);
  return null;
}

/** @mentions lifted out of a line: one naming you is marked, the rest just read as names. */
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

/** The DM room with this person, if one exists here (never creates one). */
function useDmChannelId(memberId: string): string | null {
  return useInboxStore((s: any) => {
    const viewer = s.currentUser?._id;
    if (!viewer) return null;
    return findDmChannelId(s.chatChannels, dmKeyFor(activeTeamIdOf(s) ?? "", [viewer, memberId]));
  });
}

/** What the card renders of one channel, as a string: wakes only when a line
 *  in it arrives, changes or settles. */
function channelSig(messages: Record<string, ChatMessageRow> | undefined, channelId: string | null): string {
  if (!channelId || !messages) return "";
  let s = "";
  for (const id in messages) {
    const m = messages[id];
    if (m.channel_id !== channelId || (m.thread_root_id && !m.broadcast)) continue;
    s += `${id}:${m.created_at}:${m.content?.length ?? 0}:${m.deleted_at ? 1 : 0}:${m._failedAt ? 1 : 0},`;
  }
  return s;
}

/** The channel lines from elsewhere as the card reads them: each line, its
 *  thread's root, and that root's text. Wakes when a fetch lands one. */
function threadsSig(messages: Record<string, ChatMessageRow> | undefined, ids: string[]): string {
  let s = "";
  for (const id of ids) {
    const m = messages?.[id];
    const root = m?.thread_root_id ? messages?.[m.thread_root_id] : undefined;
    s += `${id}:${m?.content?.length ?? -1}:${m?.thread_root_id ?? ""}:${root?.content?.length ?? -1},`;
  }
  return s;
}

export function FaceMessages({
  memberId,
  name,
  focus,
  onLeave,
}: {
  memberId: string;
  name: string;
  /** Opened to read them (their count or their bubble): the reply box takes the keys. */
  focus: boolean;
  /** The card closes before a route change. */
  onLeave: () => void;
}) {
  const openChat = useOpenChatPath();
  const viewerId = useInboxStore((s: any) => String(s.currentUser?._id ?? ""));
  const dmId = useDmChannelId(memberId);
  useChannelMessagesSync(dmId && isConvexId(dmId) ? dmId : undefined);
  const dmSig = useInboxStore((s: any) => channelSig(s.chatMessages, dmId));
  const channels = useInboxStore((s: any) => s.chatChannels as Record<string, { kind?: string }>);
  const recent = useFaceChatRecent(memberId);
  const elsewhereIds = useMemo(() => recent.filter((a) => a.channelId !== dmId && !a.isDm).map((a) => a.messageId), [recent, dmId]);
  const elsewhereSig = useInboxStore((s: any) => threadsSig(s.chatMessages, elsewhereIds));
  const unreadIds = useFaceChatUnreadIds(memberId);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Where you had read the DM up to when the card opened: lines after it
  // keep their dot while the card is up, even once it marks them read.
  const [readFloor] = useState(() => {
    const st: any = useInboxStore.getState();
    for (const id in st.chatReads ?? {}) if (st.chatReads[id]?.channel_id === dmId) return st.chatReads[id].last_read_at as number;
    return 0;
  });

  const rows = useMemo(() => {
    const byId = new Map<string, Row>();
    // Their lines elsewhere (and your replies there), as this window saw them.
    for (const a of recent) {
      if (a.channelId === dmId) continue;
      byId.set(a.messageId, {
        id: a.messageId,
        channelId: a.channelId,
        threadRootId: a.threadRootId,
        inThread: a.inThread,
        isDm: a.isDm,
        text: a.preview,
        at: a.at,
        me: !!a.me,
      });
    }
    const messages = useInboxStore.getState().chatMessages as Record<string, ChatMessageRow>;
    const dm: Row[] = [];
    if (dmId) {
      for (const id in messages) {
        const m = messages[id];
        if (m.channel_id !== dmId || (m.thread_root_id && !m.broadcast) || m.deleted_at || !m.content) continue;
        dm.push({
          id,
          channelId: dmId,
          isDm: true,
          text: toastPreview(m.content, 2000),
          at: m.created_at,
          me: String(m.user_id) === viewerId,
          failed: !!m._failedAt,
        });
      }
    }
    dm.sort((a, b) => a.at - b.at);
    for (const r of dm.slice(-CARD_LINES)) byId.set(r.id, r);
    // A channel line the store has loaded reads in full, not as the rail's
    // preview, and a reply learns its thread from its own row.
    for (const r of byId.values()) {
      const m = messages[r.id];
      if (r.isDm || !m) continue;
      if (m.content) r.text = toastPreview(m.content, 2000);
      if (m.thread_root_id) r.threadRootId = String(m.thread_root_id);
      const root = r.threadRootId ? messages[r.threadRootId] : undefined;
      if (root?.content) r.rootText = toastPreview(root.content, 200);
    }
    return [...byId.values()].sort((a, b) => a.at - b.at);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dmSig and elsewhereSig are the real deps on chatMessages
  }, [recent, dmSig, elsewhereSig, dmId, viewerId, channels]);

  // Lines and thread roots the card names but the store lacks.
  const st = useInboxStore.getState().chatMessages as Record<string, ChatMessageRow>;
  const missing = rows.flatMap((r) => (r.isDm ? [] : [r.id, ...(r.threadRootId ? [r.threadRootId] : [])])).filter((id) => !st?.[id]);

  const isNew = (r: Row) => !r.me && (unreadIds.includes(r.id) || (r.isDm && r.at > readFloor));
  const theirLast = [...rows].reverse().find((r) => !r.me);
  const newestDm = [...rows].reverse().find((r) => r.isDm);

  // Reading it here is reading it: the DM's mark moves once the card has
  // been up a moment (a pointer passing over the face reads nothing).
  useWatchEffect(() => {
    if (!dmId || !newestDm || !rows.some((r) => r.isDm && isNew(r))) return;
    const t = setTimeout(() => useInboxStore.getState().markChannelRead(dmId, newestDm.id), focus ? 0 : 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dmId, newestDm?.id, focus]);

  // Newest at the bottom, in view, on open and whenever a line arrives. Keyed
  // on the newest line, not the count: past CARD_LINES a new line pushes the
  // oldest out and the count stays put.
  const newestId = rows[rows.length - 1]?.id;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [newestId]);
  useLayoutEffect(() => {
    if (!focus) return;
    const t = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 120);
    return () => clearTimeout(t);
  }, [focus]);

  // The reply goes where they last spoke; with nothing from them, to the DM.
  const target = theirLast ?? null;
  const toDm = !target || target.isDm;
  const replyWhere = toDm ? "direct message" : whereOf(target.channelId, false, target.threadRootId).replace(/^thread in (.*)$/, "in the $1 thread");
  // A reply in a thread whose root this window never loaded cannot be
  // answered here (it would land in the channel): the thread opens instead.
  const replyHere = !(target?.inThread && !target.threadRootId);

  /** A permalink to a reply opens its thread on that line (app/chat/page.tsx). */
  const openRow = (r: Row) => {
    onLeave();
    openChat(`/chat/${r.channelId}?m=${r.id}`);
  };
  const openChatAt = () => {
    const at = target ?? newestDm;
    if (at) return openRow(at);
    onLeave();
    openChat(`/chat/${useInboxStore.getState().openDmChannel([memberId])}`);
  };

  const send = () => {
    const input = inputRef.current;
    const text = input?.value.trim();
    if (!input || !text) return;
    const st = useInboxStore.getState();
    if (toDm) {
      st.sendChatMessage(dmId ?? st.openDmChannel([memberId]), text);
    } else {
      const id = st.sendChatMessage(target.channelId, text, target.threadRootId ? { threadRootId: target.threadRootId } : undefined);
      rememberFaceReply(memberId, {
        messageId: id,
        channelId: target.channelId,
        channelName: "",
        isDm: false,
        threadRootId: target.threadRootId,
        inThread: target.inThread,
        preview: text,
        at: Date.now(),
        loud: false,
        count: 0,
        me: true,
      });
    }
    input.value = "";
  };

  // A run is one speaker, one place, without a long pause: it sits tight and
  // wears its time once, on its last line.
  const mixed = rows.some((r) => !r.isDm);
  // A place is the DM, a channel, or one thread in it: two threads in #team
  // are two places. A reply whose thread is still loading stands alone.
  const placeOf = (r: Row) => (r.isDm ? "dm" : `${r.channelId}:${r.threadRootId ?? (r.inThread ? r.id : "")}`);
  const joins = (a: Row | undefined, b: Row | undefined) =>
    !!a && !!b && a.me === b.me && b.at - a.at < RUN_GAP_MS && (!mixed || placeOf(a) === placeOf(b));
  return (
    <div className="fc-card-msgs" style={{ "--fc-hue": hueFor(name) } as React.CSSProperties}>
      <div className="fc-card-msgs-head">
        <span>{rows.length ? "Messages" : "No messages yet"}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="fc-open"
          onClick={openChatAt}
          aria-label="Open in chat"
          title="Open in chat"
        >
          <ArrowUpRight />
        </Button>
      </div>
      {missing.map((id) => (
        <EnsureMessage key={id} id={id} />
      ))}
      {rows.length > 0 && (
        <div ref={listRef} className="fc-list">
          {rows.map((r, i) => {
            const prev = rows[i - 1];
            const sep = mixed && (!prev || placeOf(prev) !== placeOf(r));
            const run = !sep && joins(prev, r);
            const tail = !joins(r, rows[i + 1]);
            return (
              <div key={r.id} className="fc-row" data-me={r.me ? "1" : undefined} data-run={run ? "1" : undefined}>
                {sep && <Place row={r} onOpen={() => openRow(r)} />}
                <button type="button" className="fc-msg" onClick={() => openRow(r)} title="Jump to message in chat" data-new={isNew(r) ? "1" : undefined} data-failed={r.failed ? "1" : undefined}>
                  <span className="fc-text">
                    <Preview text={r.text} />
                  </span>
                  {(tail || r.failed) && <span className="fc-at-time">{r.failed ? "not sent" : timeAgo(r.at)}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {!replyHere ? (
        <div className="fc-reply">
          <button type="button" className="fc-reply-thread" onClick={openChatAt}>
            Reply in the thread <ArrowUpRight className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div className="fc-reply">
          <input
            ref={inputRef}
            placeholder={toDm ? `Message ${name.split(/\s+/)[0]}…` : `Reply ${replyWhere}…`}
            aria-label={toDm ? `Message ${name}` : `Reply ${replyWhere}`}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <KeyCap size="xs">↵</KeyCap>
        </div>
      )}
    </div>
  );
}

/** Where a run of lines was said, as the way there: the channel, and for a
 *  thread the line that opened it. Opens that place in chat on that line. */
function Place({ row, onOpen }: { row: Row; onOpen: () => void }) {
  if (row.isDm) return <div className="fc-sep">direct message</div>;
  const channel = whereOf(row.channelId, false).replace(/^in /, "");
  const thread = !!(row.threadRootId || row.inThread);
  return (
    <button type="button" className="fc-sep fc-sep-link" onClick={onOpen} title={thread ? `Open the thread in ${channel}` : `Open ${channel}`}>
      <span className="fc-sep-channel">{channel}</span>
      {thread && (
        <>
          <CornerDownRight className="fc-sep-icon" />
          <span className="fc-sep-root">{row.rootText ?? "thread"}</span>
        </>
      )}
      <ArrowUpRight className="fc-sep-icon fc-sep-go" />
    </button>
  );
}
