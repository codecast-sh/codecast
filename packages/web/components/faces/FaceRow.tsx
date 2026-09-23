// THE FACE ROW: presence, walkie, ringing and calls as the same faces in
// different states (pl-756 F2).
//
// One component draws `FaceRow` (lib/faces/faceRow), the model's row: the
// entries in order as circles, the links between them as bridges, and the
// viewer's own face at the head while they are engaged. Every fact about a
// person is ONE attribute on their circle, `data-state`, from the model's own
// vocabulary, and the stylesheet (faceRow.css) turns it into a ring. Nothing
// here derives a state: a component that decided "is this person in a call"
// for itself would be the twelfth derivation the model exists to replace.
//
// A PERSON IS ONE DOM NODE for as long as they are on the row. Their circle is
// keyed by user id and is never remounted across a state change, a reorder or
// a photo becoming video: the crop hook, the meter ref and the running FLIP all
// hold the same element. faceRowIdentity.test.tsx pins it.
//
// REORDER IS A FLIP, TRANSFORM ONLY. The model moves an entry only when its
// link or its tier changes, so a reorder is news and gets 240ms; every face
// that moved is measured before the commit and after it and travels between
// the two by transform, with the timing the surface morph already uses.
// Reduced motion is no animation, not a fast one.
//
// TWO DENSITIES, ONE ROW: `bar` (the header, 32px) and `float` (the floating
// window, 64px, no chrome, click through except faces and card). The float
// machinery (useFloatingCircles) sizes the window and lifts click through;
// `FloatingFaceRow` is the row with that machinery attached.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { MicOff } from "lucide-react";
import type { FaceEntry, FaceRow as FaceRowModel, FaceState, LinkKind } from "../../lib/faces/faceRow";
import { useCircleFace } from "../../hooks/useCircleFace";
import { CircleFace } from "../calls/FaceCircle";
import { firstName } from "../calls/speakers";
import { getCallTiles, subscribeCallTiles, type ParticipantTile } from "../../lib/calls/callManager";
import { useFaceKey, useWalkieFaces } from "../presence/useFaceKey";
import { FaceActions } from "../presence/FaceActions";
import { useOpenDm } from "../../hooks/useChatSync";
import { useWalkieLevelVar } from "../../hooks/useWalkie";
import { useMicLevelVar } from "../../hooks/useMicLevelVar";
import { useEventListener } from "../../hooks/useEventListener";
import { PresenceBadge } from "../presence/PresenceBadge";
import { presenceAvatarClass, type PresenceVisual } from "../presence/memberPresence";
import { MORPH_EASING, MORPH_MS, canMorph } from "../calls/useSurfaceMorph";
import { useFloatingCircles, type FloatingBridge } from "../calls/useFloatingCircles";
import { FACES_PADDING, NAME_HEIGHT, ROW_GAP } from "../../lib/calls/faceCrop";
import "../calls/faces.css";
import "../calls/walkie.css";
import "../people/people.css";
import "../presence/presence.css";
import "./faceRow.css";

// ── layout ──────────────────────────────────────────────────────────────────

export type FaceDensity = "bar" | "float";

/** The row's measurements per density: the circle, the gap between seats,
 *  the bridge a link draws, and the margin around the row. Mirrored in
 *  faceRow.css (`--face`, `--face-gap`, `--link-w`, the float padding); the
 *  layout test holds the two together. */
export const FACE_ROW_METRICS: Record<FaceDensity, { face: number; gap: number; link: number; pad: number }> = {
  bar: { face: 32, gap: 6, link: 14, pad: 0 },
  float: { face: 64, gap: 10, link: 26, pad: FACES_PADDING },
};

/** The linked pair pulls together: a bridge eats this share of the gap on
 *  each side (faceRow.css `.face-link` margin). */
export const LINK_PULL = 0.35;

/** How wide the row is: the seats, the gaps, and each bridge less the pull. */
export function faceRowWidth(density: FaceDensity, faces: number, links: number): number {
  const m = FACE_ROW_METRICS[density];
  if (faces === 0) return m.pad * 2;
  const bridges = Math.min(links, Math.max(0, faces - 1));
  return m.pad * 2 + faces * m.face + (faces - 1) * m.gap + bridges * (m.link - 2 * LINK_PULL * m.gap);
}

/** The window a floating row needs: its circles and their margin, plus the
 *  name row while the pointer is on a face (the same band the call circles
 *  reserve, NAME_HEIGHT). */
export function faceRowSize(
  density: FaceDensity,
  faces: number,
  links: number,
  hovered: boolean,
): { width: number; height: number } {
  const m = FACE_ROW_METRICS[density];
  return {
    width: faceRowWidth(density, faces, links),
    height: m.pad * 2 + m.face + (hovered ? ROW_GAP + NAME_HEIGHT : 0),
  };
}

// ── the FLIP ────────────────────────────────────────────────────────────────

/** One face's travel: from where it was to where the layout put it. Null when
 *  it did not move, so a level tick or a mute never starts an animation. */
export function flipKeyframes(
  from: { left: number; top: number },
  to: { left: number; top: number },
): Keyframe[] | null {
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  if (dx === 0 && dy === 0) return null;
  return [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }];
}

/**
 * Watch `orderSig` (who is on the row, in what order, with which bridges) and
 * play the FLIP when it changes. "First" is measured in the render that sees
 * the change, the last moment the old order is still on screen, the same way
 * useSurfaceMorph measures its root; "Last" is read after the commit, and
 * every seat that moved is inverted onto its old spot and released.
 */
function useFlipRow(rootRef: RefObject<HTMLDivElement | null>, orderSig: string): void {
  const seen = useRef(orderSig);
  const first = useRef<Map<string, DOMRect> | null>(null);
  const running = useRef<Animation[]>([]);
  if (seen.current !== orderSig) {
    seen.current = orderSig;
    const root = rootRef.current;
    if (root && canMorph()) {
      const rects = new Map<string, DOMRect>();
      for (const el of root.querySelectorAll<HTMLElement>("[data-face-id]")) {
        rects.set(el.dataset.faceId!, el.getBoundingClientRect());
      }
      first.current = rects;
    }
  }
  useLayoutEffect(() => {
    const from = first.current;
    if (!from) return;
    first.current = null;
    const root = rootRef.current;
    if (!root) return;
    for (const a of running.current) a.cancel();
    running.current = [];
    for (const el of root.querySelectorAll<HTMLElement>("[data-face-id]")) {
      const was = from.get(el.dataset.faceId!);
      if (!was) continue;
      const frames = flipKeyframes(was, el.getBoundingClientRect());
      if (!frames) continue;
      running.current.push(el.animate(frames, { duration: MORPH_MS, easing: MORPH_EASING }));
    }
  });
}

// ── one seat ────────────────────────────────────────────────────────────────

/** The presence dot a plain face wears in its corner; engaged faces wear a
 *  ring instead and get none. */
const PRESENCE_OF: Partial<Record<FaceState, PresenceVisual>> = {
  online: "active",
  idle: "idle",
  away: "away",
  busy: "busy",
  offline: "offline",
};

function useTiles(): ParticipantTile[] {
  return useSyncExternalStore(subscribeCallTiles, getCallTiles, getCallTiles);
}

/** Two meter refs on one seat, so my mic reads the same whether the walkie's
 *  meter (a burst) or the call's (an open mic in a call) is the one running. */
function bothRefs<T extends HTMLElement>(
  a: (el: T | null) => void | (() => void),
  b: (el: T | null) => void | (() => void),
): (el: T | null) => () => void {
  return (el) => {
    const offA = a(el);
    const offB = b(el);
    return () => {
      offA?.();
      offB?.();
    };
  };
}

function FaceSeat({
  entry,
  tile,
  viewerId,
  callsEnabled,
  density,
  onPointerDown,
  onPointerUp,
}: {
  entry: FaceEntry;
  tile: ParticipantTile | undefined;
  viewerId: string;
  callsEnabled: boolean;
  density: FaceDensity;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
}) {
  const diameter = FACE_ROW_METRICS[density].face;
  const { hostRef, videoRef, track } = useCircleFace({ tile, image: entry.image, diameter, active: true });
  const openDm = useOpenDm();
  // The face is the key: Talk, Ring and Message under a click, the room warmed
  // on a dwell. My own face keys nothing; there is nobody to talk to.
  const key = useFaceKey({
    viewerId,
    memberId: entry.id,
    callsEnabled: callsEnabled && !entry.me,
    talking: entry.state === "talking-to-me",
  });
  // THE LEVEL. Theirs is their voice on the walkie's meter, by identity; mine
  // is my microphone on whichever meter is running.
  const voiceRef = useWalkieLevelVar<HTMLDivElement>(entry.level === "voice", entry.id);
  const walkieMicRef = useWalkieLevelVar<HTMLDivElement>(entry.level === "mic");
  const callMicRef = useMicLevelVar<HTMLDivElement>(entry.level === "mic");
  const me = entry.me;
  const levelRef = useMemo(
    () => (me ? bothRefs(walkieMicRef, callMicRef) : voiceRef),
    [me, walkieMicRef, callMicRef, voiceRef],
  );

  const [open, setOpen] = useState(false);
  const seatRef = useRef<HTMLDivElement | null>(null);
  // One ref for the seat: the popover's own element, and the meter's target.
  const seatAndLevelRef = useCallback(
    (el: HTMLDivElement | null) => {
      seatRef.current = el;
      return levelRef(el);
    },
    [levelRef],
  );
  useEventListener("pointerdown", (e: Event) => {
    if (open && seatRef.current && !seatRef.current.contains(e.target as Node)) setOpen(false);
  });

  const presence = PRESENCE_OF[entry.state];
  const canOpen = callsEnabled && !entry.me;

  return (
    <div
      ref={seatAndLevelRef}
      className="face-slot face-seat"
      data-face-id={entry.id}
      data-hold={key.holding ? "1" : undefined}
      data-ask={entry.ask > 0 ? entry.ask : undefined}
    >
      <button
        ref={hostRef as unknown as RefObject<HTMLButtonElement | null>}
        type="button"
        data-face-hit
        data-state={entry.state}
        data-me={entry.me ? "1" : undefined}
        data-level={entry.level ?? undefined}
        data-speaking={entry.state === "speaking" ? "true" : undefined}
        data-followed={entry.followed ? "true" : undefined}
        data-walkie-state={entry.me ? undefined : key.state}
        className={`face ${presence ? presenceAvatarClass(presence) : ""}`.trim()}
        aria-label={entry.me ? `${entry.name} (you)` : `${entry.name}. Click for Talk, Ring and Message.`}
        aria-expanded={canOpen ? open : undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (canOpen) setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        {...(canOpen ? key.warmProps : {})}
      >
        <CircleFace videoRef={videoRef} track={track} image={entry.image} name={entry.name} diameter={diameter} />
        {entry.muted && (
          <span className="face-mute">
            <MicOff className="h-3 w-3" />
          </span>
        )}
      </button>
      {presence && <PresenceBadge state={presence} size={density === "bar" ? "sm" : "md"} className="face-pres" />}
      {entry.unread > 0 && (
        <span className="face-unread" aria-label={`${entry.unread} unread`}>
          {entry.unread > 99 ? "99+" : entry.unread}
        </span>
      )}
      {entry.ask > 0 && <span className="face-ask" aria-label={`${entry.ask} waiting on you`} />}
      {/* "hey he joined", under the face it happened to, for the seconds the model says so. */}
      {entry.state === "joining" && (
        <span className="people-face-joined" role="status">
          joined
        </span>
      )}
      {/* The name, under the chin, while the pointer is on the face. */}
      <span className="face-name">{firstName(entry.name)}</span>
      {open && canOpen && (
        <span className="people-face-actions" data-chrome-hit>
          <span className="people-face-actions-name">{entry.name}</span>
          <FaceActions
            ptt={key.ptt}
            blocked={key.blocked}
            roomKey={key.roomKey}
            ringIds={[entry.id]}
            onMessage={() => {
              setOpen(false);
              openDm([entry.id]);
            }}
            size="sm"
          />
        </span>
      )}
    </div>
  );
}

// ── the row ─────────────────────────────────────────────────────────────────

export function FaceRow({
  row,
  density,
  viewerId,
  callsEnabled = true,
  rootRef,
  onDragStart,
  onDragEnd,
  className = "",
  children,
}: {
  row: FaceRowModel;
  density: FaceDensity;
  viewerId: string;
  callsEnabled?: boolean;
  /** The float machinery's root, when this row is the floating window's. */
  rootRef?: RefObject<HTMLDivElement | null>;
  /** Held on a circle, the floating window follows the cursor. */
  onDragStart?: (e: React.PointerEvent) => void;
  onDragEnd?: (e: React.PointerEvent) => void;
  className?: string;
  /** The engagement card, hung under the row (position: relative here). */
  children?: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const tiles = useTiles();
  const faces = useWalkieFaces();
  const linkTo = new Map<string, LinkKind>(row.links.map((l) => [l.to, l.kind]));
  // Who, in what order, with which bridges: the only changes that move a seat.
  const orderSig = row.entries.map((e) => `${e.id}${linkTo.has(e.id) ? "+" : ""}`).join(",");
  useFlipRow(ownRef, orderSig);

  const cameraOf = (id: string): ParticipantTile | undefined =>
    tiles.find((t) => t.kind === "camera" && t.identity === id);

  return (
    <div
      ref={(el) => {
        ownRef.current = el;
        if (rootRef) rootRef.current = el;
      }}
      className={`face-row ${className}`.trim()}
      data-density={density}
      data-holding={faces.sendingRoomKey ? "1" : undefined}
      role="group"
      aria-label="Team"
    >
      {/* ONE FLAT LIST, every child keyed. A nested array per entry would
          scope each seat's key to its own fragment, and React cannot move a
          keyed element between fragments: the person would remount the
          moment a bridge appeared before them. */}
      {row.entries.flatMap((entry, i) => {
        const kind = i > 0 ? linkTo.get(entry.id) : undefined;
        const seat = (
          <FaceSeat
            key={entry.id}
            entry={entry}
            tile={entry.video ? cameraOf(entry.id) : undefined}
            viewerId={viewerId}
            callsEnabled={callsEnabled}
            density={density}
            onPointerDown={onDragStart}
            onPointerUp={onDragEnd}
          />
        );
        return kind
          ? [<span key={`link:${entry.id}`} className="face-link" data-link-kind={kind} aria-hidden="true" />, seat]
          : [seat];
      })}
      {children}
    </div>
  );
}

/**
 * The row as the floating window's contents: sized to its circles and its
 * card, click through everywhere but the faces and the card, and dragged by
 * a face. The bridge is the window's own, so the same row drives whichever
 * shell window is hosting it.
 *
 * THE CARD IS MEASURED, NOT COMPUTED. The row's own size follows from its
 * metrics, but the card's height is its words (a stage line, a hearing line,
 * two buttons), so a ResizeObserver on the card's slot reports it and the
 * window follows. The slot wraps under the faces (faceRow.css) and exists
 * only while there is a card, so an empty row is exactly its faces.
 */
export function FloatingFaceRow({
  row,
  viewerId,
  callsEnabled = true,
  bridge,
  children,
}: {
  row: FaceRowModel;
  viewerId: string;
  callsEnabled?: boolean;
  bridge: FloatingBridge;
  /** The engagement card, in the slot under the faces. */
  children?: ReactNode;
}) {
  // The float shows the people who are there. An offline face over
  // somebody's work is a photo of an empty chair, and a team of twenty is a
  // row wider than the screen; the header keeps the whole roster.
  const shown = useMemo(
    () => (row.entries.some((e) => e.state === "offline") ? { ...row, entries: row.entries.filter((e) => e.state !== "offline") } : row),
    [row],
  );
  const faces = shown.entries.length;
  const links = shown.links.length;
  const [card, setCard] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const cardSlotRef = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      setCard({ width: 0, height: 0 });
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setCard({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  const { rootRef, hovered, startDrag, endDrag } = useFloatingCircles({
    sizeFor: (hover) => floatingRowSize(faces, links, hover, card),
    shapeSig: `${faces}|${links}|${card.width}x${card.height}`,
    bridge,
  });
  return (
    <FaceRow
      row={shown}
      density="float"
      viewerId={viewerId}
      callsEnabled={callsEnabled}
      rootRef={rootRef}
      onDragStart={startDrag}
      onDragEnd={endDrag}
      className={hovered ? "face-row--hover" : ""}
    >
      {children != null && children !== false && (
        <div ref={cardSlotRef} className="face-row-card">
          {children}
        </div>
      )}
    </FaceRow>
  );
}

/** The gap between the faces and the card's slot; while the pointer is on a
 *  face the name band takes its place (faceRow.css `.face-row-card`). */
export const CARD_GAP = 8;

/** The floating window with a card under the row: as wide as the wider of
 *  the two, as tall as both plus the gap between them. */
export function floatingRowSize(
  faces: number,
  links: number,
  hovered: boolean,
  card: { width: number; height: number },
): { width: number; height: number } {
  const size = faceRowSize("float", faces, links, hovered);
  if (card.height === 0) return size;
  const pad = FACE_ROW_METRICS.float.pad;
  return {
    width: Math.max(size.width, card.width + pad * 2),
    height: size.height + card.height + (hovered ? 0 : CARD_GAP),
  };
}
