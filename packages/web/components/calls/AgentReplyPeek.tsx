import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, X } from "lucide-react";
import { SessionFace } from "../identity";
import { cleanNotificationBody } from "../../lib/notificationText";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRoomThreadUnread } from "../../hooks/useRoomThreadUnread";
import { useCallStageOpen } from "../../lib/calls/callStage";
import { useInboxStore } from "../../store/inboxStore";
import type { ThreadRow } from "./roomThreadModel";
import { openTheCall } from "../../lib/calls/openTheCall";
import "./arrival.css";

// AN AGENT ANSWERED IN THE CALL. People are talking and watching faces, so
// the answer is shown where the call already is, never as a card over the
// work: on the stage it rises over the bottom of the video like a line the
// agent says, and with the stage closed it hangs from the call's own pill in
// the header the way a teammate's chat drops from their face (faceChat). It
// stays for the answer's reading time, holds while pointed at, never stacks
// (a newer answer takes its place), and goes when the thread is read.

const LEAVE_MS = 180;
const LINGER_MS = 4000;
const BUBBLE_W = 420;

/** A base for the eye to find it, then a reading pace, capped. */
function showMs(text: string): number {
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.min(45_000, 8_000 + words * 330);
}

/** Each answer shows once per window, whichever surface shows it. */
const shownOnce = new Set<string>();

/** The newest unread agent answer, held on screen for its reading time.
 *  `row` is the newest unread line; a person's line or none clears it. */
function useShownReply(row: ThreadRow | null, enabled: boolean) {
  const [shown, setShown] = useState<ThreadRow | null>(null);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const leaveIn = (ms: number) => {
    clear();
    timer.current = setTimeout(() => {
      setLeaving(true);
      timer.current = setTimeout(() => setShown(null), LEAVE_MS);
    }, ms);
  };
  const dismiss = () => {
    clear();
    setShown(null);
  };
  const id = enabled && row?.agent ? String(row._id) : null;
  useWatchEffect(() => {
    if (!id || !row) return dismiss();
    if (shownOnce.has(id)) return;
    shownOnce.add(id);
    setLeaving(false);
    setShown(row);
    leaveIn(showMs(row.text));
  }, [id]);
  useWatchEffect(() => clear, []);
  return {
    shown: shown?.agent ? shown : null,
    leaving,
    dismiss,
    hold: () => {
      clear();
      setLeaving(false);
    },
    release: () => leaveIn(LINGER_MS),
  };
}

function Reply({
  row,
  variant,
  leaving,
  onOpen,
  onDismiss,
  onHold,
  onRelease,
  style,
}: {
  row: ThreadRow;
  variant: "stage" | "bubble";
  leaving: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  onHold: () => void;
  onRelease: () => void;
  style?: React.CSSProperties;
}) {
  const agent = row.agent!;
  const name = agent.name ?? agent.title;
  const text = cleanNotificationBody(row.text, 600);
  return (
    <div
      className={variant === "bubble" ? "agent-reply dark" : "agent-reply"}
      data-variant={variant}
      data-leaving={leaving || undefined}
      data-flyout={variant === "bubble" || undefined}
      role="status"
      aria-live="polite"
      style={style}
      onPointerEnter={onHold}
      onPointerLeave={onRelease}
    >
      <button type="button" className="agent-reply-open" onClick={onOpen} aria-label={`${name}: ${text}. Open the thread`}>
        <span className="agent-reply-head">
          <SessionFace
            row={{
              _id: agent.conversation_id,
              title: agent.title,
              character_avatar: agent.character_avatar ?? null,
              character_name: agent.character_name ?? null,
            }}
            size={24}
            className="shrink-0"
          />
          <b>{name}</b>
          <span className="agent-reply-go">
            thread <ArrowUpRight className="h-3 w-3" />
          </span>
        </span>
        {text && <span className="agent-reply-text">{text}</span>}
      </button>
      <button type="button" className="agent-reply-close" onClick={onDismiss} aria-label="Dismiss">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** On the stage: over the bottom of the video, thread open or closed. */
export function AgentReplyPeek({ row, onOpen }: { row: ThreadRow | null; onOpen: () => void }) {
  const r = useShownReply(row, true);
  if (!r.shown) return null;
  return (
    <div className="agent-reply-lane">
      <Reply
        key={String(r.shown._id)}
        row={r.shown}
        variant="stage"
        leaving={r.leaving}
        onOpen={() => {
          r.dismiss();
          onOpen();
        }}
        onDismiss={r.dismiss}
        onHold={r.hold}
        onRelease={r.release}
      />
    </div>
  );
}

/** With the stage closed: hanging from the call's pill. Mounted inside the
 *  card (CallCardAccessories), it finds the pill it sits in and portals the
 *  bubble under it, so the header's clipping never cuts it. */
export function CallCardAgentReply() {
  const roomKey = useInboxStore((s) => s.call.roomKey ?? null);
  const stageOpen = useCallStageOpen();
  const { latest } = useRoomThreadUnread(roomKey);
  return <HangingReply row={stageOpen ? null : latest} />;
}

/** The bubble itself, for the newest unread line `row`. */
export function HangingReply({ row }: { row: ThreadRow | null }) {
  const r = useShownReply(row, true);
  const probe = useRef<HTMLSpanElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number; notch: number } | null>(null);

  useLayoutEffect(() => {
    if (!r.shown) return setAt(null);
    const measure = () => {
      const card = probe.current?.closest<HTMLElement>(".engagement-card");
      if (!card || card.getClientRects().length === 0) return setAt(null);
      const b = card.getBoundingClientRect();
      const w = Math.min(BUBBLE_W, window.innerWidth - 16);
      const left = Math.max(8, Math.min(b.left, window.innerWidth - w - 8));
      const notch = Math.max(18, Math.min(b.left + 30 - left, w - 18));
      setAt((p) => (p && p.left === left && p.top === b.bottom + 10 && p.notch === notch ? p : { left, top: b.bottom + 10, notch }));
    };
    measure();
    const iv = setInterval(measure, 200);
    window.addEventListener("resize", measure);
    return () => {
      clearInterval(iv);
      window.removeEventListener("resize", measure);
    };
  }, [r.shown]);

  return (
    <>
      <span ref={probe} hidden />
      {r.shown &&
        at &&
        createPortal(
          <Reply
            key={String(r.shown._id)}
            row={r.shown}
            variant="bubble"
            leaving={r.leaving}
            style={{ left: at.left, top: at.top, width: Math.min(BUBBLE_W, window.innerWidth - 16), "--ar-notch": `${at.notch}px` } as React.CSSProperties}
            onOpen={() => {
              r.dismiss();
              openTheCall(true);
            }}
            onDismiss={r.dismiss}
            onHold={r.hold}
            onRelease={r.release}
          />,
          document.body,
        )}
    </>
  );
}
