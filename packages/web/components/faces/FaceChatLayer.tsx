import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { useInboxStore, type ChatMessageRow } from "../../store/inboxStore";
import {
  closeFacePanel,
  faceBubbleFailed,
  faceBubbleShown,
  holdFaceBubble,
  openFacePanel,
  registerFaceChatLayer,
  releaseFaceBubble,
  retractFaceBubble,
  useFaceChat,
  type FaceArrival,
  type FaceBubble,
} from "../../lib/chat/faceChat";
import { memberAvatarUrl, memberDisplayName } from "../../lib/liveEntities";
import { toastPreview } from "../chat/ChatToast";
import { CommentAvatar } from "../comments/CommentAvatar";
import { KeyCap } from "../KeyCap";
import "./faceChat.css";

// The header's half of chat from the face (lib/chat/faceChat): the bubble that
// drops from a teammate's face when they say something, and the panel a click
// on their count opens. Both hang from the seat in the header row, found by
// its data-face-id, and follow it while the row reflows.

/** How long a bubble waits for its face to arrive on the row before the line
 *  goes out as a toast instead. */
const SEAT_WAIT_MS = 900;
const BUBBLE_W = 320;
const PANEL_W = 360;

type Anchor = { x: number; y: number };

function seatIn(bar: HTMLElement | null, id: string): HTMLElement | null {
  if (!bar) return null;
  const seat = bar.querySelector<HTMLElement>(`[data-face-id="${CSS.escape(id)}"]`);
  return seat && seat.getClientRects().length > 0 && !seat.dataset.stacked && !seat.dataset.folded ? seat : null;
}

function anchorOf(seat: HTMLElement): Anchor {
  const face = seat.querySelector<HTMLElement>(".face") ?? seat;
  const r = face.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom };
}

/** Where a box of width `w` hangs so its notch sits under the face: it opens
 *  toward the middle of the window, its notch near the end nearest the face. */
function placement(a: Anchor, w: number) {
  const lead = a.x < window.innerWidth / 2 ? a.x - 34 : a.x - w + 34;
  const left = Math.max(8, Math.min(lead, window.innerWidth - w - 8));
  return { left, top: a.y + 11, notch: Math.max(16, Math.min(a.x - left, w - 16)) };
}

function memberOf(id: string) {
  return useInboxStore.getState().teamMembers.find((m: any) => String(m?._id) === id);
}

function whereOf(channelId: string, isDm: boolean, threadRootId?: string): string {
  if (isDm) return threadRootId ? "thread · direct message" : "direct message";
  const name = (useInboxStore.getState() as any).chatChannels?.[channelId]?.name;
  return `${threadRootId ? "thread in " : "in "}#${name ?? "channel"}`;
}

/** The handles a line could name the viewer by: their GitHub login, their
 *  name, its first word. Lowercase, without the @. */
function viewerHandles(): Set<string> {
  const u: any = useInboxStore.getState().currentUser;
  const out = new Set<string>(["here", "channel", "everyone"]);
  for (const h of [u?.github_username, u?.name, String(u?.name ?? "").split(/\s+/)[0]]) if (h) out.add(String(h).toLowerCase());
  return out;
}

/** @mentions lifted out of a preview: one naming you is red, the rest just read as names. */
function Preview({ text }: { text: string }) {
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

/** The bubble or panel's anchor, tracked while it is up: the row moves faces by
 *  FLIP when someone is pulled into view, and the window can resize. */
function useAnchor(barRef: RefObject<HTMLElement | null>, id: string | null): Anchor | null {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  useLayoutEffect(() => {
    if (!id) return setAnchor(null);
    let alive = true;
    const measure = () => {
      if (!alive) return;
      const seat = seatIn(barRef.current, id);
      const next = seat ? anchorOf(seat) : null;
      setAnchor((prev) =>
        prev && next && Math.abs(prev.x - next.x) < 0.5 && Math.abs(prev.y - next.y) < 0.5 ? prev : next,
      );
    };
    measure();
    const iv = setInterval(measure, 120);
    window.addEventListener("resize", measure);
    return () => {
      alive = false;
      clearInterval(iv);
      window.removeEventListener("resize", measure);
    };
  }, [barRef, id]);
  return anchor;
}

export function FaceChatLayer({ barRef }: { barRef: RefObject<HTMLElement | null> }) {
  const st = useFaceChat();

  useEffect(
    () =>
      registerFaceChatLayer({
        canShow: (id) => {
          const bar = barRef.current;
          if (!bar || bar.getClientRects().length === 0) return false;
          const s: any = useInboxStore.getState();
          if (String(s.currentUser?._id ?? "") === id) return false;
          return peopleOf(s.teamMembers).some((m: any) => String(m._id) === id);
        },
        absorb: (id) => {
          const face = seatIn(barRef.current, id)?.querySelector<HTMLElement>(".face");
          face?.animate(
            [
              { transform: "scale(1)" },
              { transform: "scale(0.9)", offset: 0.3 },
              { transform: "scale(1.08)", offset: 0.65 },
              { transform: "scale(1)" },
            ],
            { duration: 520, easing: "cubic-bezier(.2,.9,.25,1.12)" },
          );
        },
      }),
    [barRef],
  );

  // Pointing at the face that is talking means you want its card: the bubble
  // folds into the count rather than sit on top of the card.
  const bubbleAuthor = st.bubble?.phase === "in" ? st.bubble.authorId : null;
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || !bubbleAuthor) return;
    const onOver = (e: PointerEvent) => {
      const seat = (e.target as Element | null)?.closest?.("[data-face-id]") as HTMLElement | null;
      if (seat?.dataset.faceId === bubbleAuthor) retractFaceBubble();
    };
    bar.addEventListener("pointerover", onOver);
    return () => bar.removeEventListener("pointerover", onOver);
  }, [barRef, bubbleAuthor]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {st.bubble && <Bubble key={st.bubble.key} bubble={st.bubble} barRef={barRef} />}
      {st.panel && (
        <Panel key={st.panel.authorId} authorId={st.panel.authorId} unreadIds={st.panel.unreadIds} recent={st.recent[st.panel.authorId] ?? []} barRef={barRef} />
      )}
    </>,
    document.body,
  );
}

function Bubble({ bubble, barRef }: { bubble: FaceBubble; barRef: RefObject<HTMLElement | null> }) {
  const anchor = useAnchor(barRef, bubble.authorId);
  const name = memberDisplayName(memberOf(bubble.authorId), "Someone");

  // Wait for the face (it may be sliding into the row), then show; a face
  // that never comes sends the lines out as toasts.
  useEffect(() => {
    if (bubble.phase !== "wait") return;
    if (anchor) {
      const t = setTimeout(() => faceBubbleShown(bubble.key), 24);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => faceBubbleFailed(bubble.key), SEAT_WAIT_MS);
    return () => clearTimeout(t);
  }, [bubble.phase, bubble.key, !!anchor]);

  if (!anchor) return null;
  const { left, top, notch } = placement(anchor, BUBBLE_W);
  const first = bubble.items[0];
  const loud = bubble.items.some((a) => a.loud);
  return (
    <div
      className="fc-bubble"
      data-phase={bubble.phase}
      data-loud={loud ? "1" : undefined}
      role="status"
      aria-live="polite"
      style={{ left, top, width: BUBBLE_W, "--fc-notch": `${notch}px` } as React.CSSProperties}
      onMouseEnter={holdFaceBubble}
      onMouseLeave={releaseFaceBubble}
      onClick={() => openFacePanel(bubble.authorId)}
    >
      <div className="fc-head">
        <b>{name}</b>
        <span className="fc-where">{whereOf(first.channelId, first.isDm, first.threadRootId)}</span>
        <span className="fc-time">now</span>
      </div>
      <div className="fc-lines">
        {bubble.items.map((a) => (
          <div className="fc-line" key={a.messageId}>
            <div>
              <Preview text={a.preview} />
              {a.channelId !== first.channelId && <span className="fc-line-where">{whereOf(a.channelId, a.isDm, a.threadRootId)}</span>}
              {a.count > 1 && <span className="fc-line-where">+{a.count - 1} more</span>}
            </div>
          </div>
        ))}
      </div>
      {bubble.dwellMs > 0 && (
        <div
          key={bubble.armedAt}
          className="fc-drain"
          style={{ animationDuration: `${bubble.dwellMs}ms`, animationPlayState: bubble.held ? "paused" : "running" }}
        />
      )}
      <span className="fc-hint">click for more</span>
    </div>
  );
}

type PanelRow = { id: string; channelId: string; threadRootId?: string; isDm: boolean; text: string; at: number; me?: boolean };

function Panel({
  authorId,
  unreadIds,
  recent,
  barRef,
}: {
  authorId: string;
  unreadIds: readonly string[];
  recent: readonly FaceArrival[];
  barRef: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const anchor = useAnchor(barRef, authorId);
  const messages = useInboxStore((s: any) => s.chatMessages as Record<string, ChatMessageRow>);
  const channels = useInboxStore((s: any) => s.chatChannels as Record<string, { kind?: string }>);
  const member = memberOf(authorId);
  const name = memberDisplayName(member, "Someone");
  const [sent, setSent] = useState<PanelRow[]>([]);
  const [shown, setShown] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Everything this person has said that the window knows: loaded messages
  // from the store, and the rail's previews for channels never opened.
  const rows = useMemo(() => {
    const byId = new Map<string, PanelRow>();
    for (const a of recent) {
      byId.set(a.messageId, { id: a.messageId, channelId: a.channelId, threadRootId: a.threadRootId, isDm: a.isDm, text: a.preview, at: a.at });
    }
    for (const m of Object.values(messages ?? {})) {
      if (m.user_id !== authorId || m.deleted_at || !m.content) continue;
      byId.set(m._id, {
        id: m._id,
        channelId: m.channel_id,
        threadRootId: m.thread_root_id,
        isDm: channels?.[m.channel_id]?.kind === "dm",
        text: toastPreview(m.content, 400),
        at: m.created_at,
      });
    }
    const theirs = [...byId.values()].sort((a, b) => a.at - b.at).slice(-14);
    return [...theirs, ...sent].sort((a, b) => a.at - b.at);
  }, [recent, messages, channels, authorId, sent]);
  const target = [...rows].reverse().find((r) => !r.me);

  useEffect(() => {
    const t = setTimeout(() => setShown(true), 20);
    const f = setTimeout(() => inputRef.current?.focus({ preventScroll: true }), 260);
    return () => {
      clearTimeout(t);
      clearTimeout(f);
    };
  }, []);
  // Newest at the bottom, in view: on open (the list mounts once the face is
  // found) and whenever a line arrives.
  const placed = !!anchor;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [rows.length, placed]);

  // Escape, or a press anywhere but the panel and the face's own count, closes it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeFacePanel();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (boxRef.current?.contains(t as Node)) return;
      if (t?.closest?.(`[data-face-id="${CSS.escape(authorId)}"] .face-unread`)) return;
      closeFacePanel();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [authorId]);

  if (!anchor) return null;
  const { left, top, notch } = placement(anchor, PANEL_W);
  const replyWhere = target ? whereOf(target.channelId, target.isDm, target.threadRootId) : null;

  const send = () => {
    const input = inputRef.current;
    const text = input?.value.trim();
    if (!input || !text || !target) return;
    const id = useInboxStore
      .getState()
      .sendChatMessage(target.channelId, text, target.threadRootId ? { threadRootId: target.threadRootId } : undefined);
    setSent((s) => [...s, { id, channelId: target.channelId, threadRootId: target.threadRootId, isDm: target.isDm, text, at: Date.now(), me: true }]);
    input.value = "";
  };
  const openInChat = () => {
    if (!target) return;
    closeFacePanel();
    router.push(`/chat/${target.channelId}?m=${target.id}`);
  };

  let lastWhere = "";
  return (
    <div
      ref={boxRef}
      className="fc-panel"
      data-shown={shown ? "1" : undefined}
      role="dialog"
      aria-label={`Messages from ${name}`}
      style={{ left, top, width: PANEL_W, "--fc-notch": `${notch}px` } as React.CSSProperties}
    >
      <div className="fc-panel-head">
        <CommentAvatar name={name} image={memberAvatarUrl(member)} size={32} letters={2} />
        <b>{name}</b>
        {target && (
          <button type="button" className="fc-open" onClick={openInChat}>
            Open in chat <ArrowUpRight className="h-3 w-3" />
          </button>
        )}
      </div>
      <div ref={listRef} className="fc-list">
        {rows.length === 0 && <div className="fc-empty">Nothing from {name} in this window yet.</div>}
        {rows.map((r, i) => {
          const where = whereOf(r.channelId, r.isDm, r.threadRootId);
          const sep = where !== lastWhere;
          lastWhere = where;
          const delay = `${Math.max(0, i - (rows.length - 9)) * 30 + 60}ms`;
          return (
            <div key={r.id} className="fc-group" style={{ "--fc-d": delay } as React.CSSProperties}>
              {sep && <div className="fc-sep">{where.replace(/^in /, "")}</div>}
              <div className="fc-msg" data-me={r.me ? "1" : undefined} data-unread={unreadIds.includes(r.id) ? "1" : undefined}>
                <span className="fc-dot" />
                <span className="fc-text"><Preview text={r.text} /></span>
                <span className="fc-at-time">{timeAgo(r.at)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {target && (
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
      )}
    </div>
  );
}

function timeAgo(at: number): string {
  const s = (Date.now() - at) / 1000;
  if (s < 45) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
