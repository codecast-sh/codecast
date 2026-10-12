import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight } from "lucide-react";
import { peopleOf } from "@codecast/shared/team/memberKind";
import { useInboxStore } from "../../store/inboxStore";
import {
  faceBubbleFailed,
  faceBubbleShown,
  holdFaceBubble,
  openFacePanel,
  registerFaceChatLayer,
  releaseFaceBubble,
  retractFaceBubble,
  useFaceChat,
  type FaceBubble,
} from "../../lib/chat/faceChat";
import { memberDisplayName } from "../../lib/liveEntities";
import { hueFor } from "../../lib/avatarInitials";
import { markFaceRead } from "../../lib/faces/faceRow";
import { whereOf } from "../../lib/chat/faceChatText";
import { Preview } from "./FaceMessages";
import "./faceChat.css";

// The header's half of chat from the face (lib/chat/faceChat): the bubble that
// drops from a teammate's face when they say something. It hangs from the seat
// in the header row, found by its data-face-id, and follows it while the row
// reflows. A click on it (or on the count it leaves) opens that person's own
// card with their messages in it (FaceCard, FaceMessages).

/** How long a bubble waits for its face to arrive on the row before the line
 *  goes out as a toast instead. */
const SEAT_WAIT_MS = 900;
const BUBBLE_W = 320;

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

/** The bubble's anchor, tracked while it is up: the row moves faces by
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
      style={{ left, top, width: BUBBLE_W, "--fc-notch": `${notch}px`, "--fc-hue": hueFor(name) } as React.CSSProperties}
      onMouseEnter={holdFaceBubble}
      onMouseLeave={releaseFaceBubble}
      onClick={() => {
        openFacePanel(bubble.authorId);
        markFaceRead(bubble.authorId);
      }}
    >
      <div className="fc-head">
        <b>{name}</b>
        <span className="fc-where">{whereOf(first.channelId, first.isDm, first.threadRootId ?? first.inThread)}</span>
        <span className="fc-time">
          <span>now</span>
          <span>
            open <ArrowUpRight className="h-3 w-3" />
          </span>
        </span>
      </div>
      <div className="fc-lines">
        {bubble.items.map((a) => (
          <div className="fc-line" key={a.messageId}>
            <div>
              <Preview text={a.preview} />
              {a.channelId !== first.channelId && <span className="fc-line-where">{whereOf(a.channelId, a.isDm, a.threadRootId ?? a.inThread)}</span>}
              {a.count > 1 && <span className="fc-line-where">+{a.count - 1} more</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
