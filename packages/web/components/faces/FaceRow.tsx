import { type FaceDensity, FACE_ROW_METRICS, LINK_PULL, faceRowWidth, faceRowSize, flipKeyframes, CARD_OPEN_MS, CARD_CLOSE_MS, floatingRowSize } from "../../lib/faces/layout";
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
// window, 64px, no chrome, click through except faces and cards). The float
// machinery (useFloatingCircles) sizes the window and lifts click through;
// `FloatingFaceRow` is the row with that machinery attached.
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { ChevronLeft, GripHorizontal, Maximize2, MicOff, Sparkle, X } from "lucide-react";
import { defaultAvatarFor, isAvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { AVATAR_URLS } from "../../lib/orgAvatars";
import { useInboxStore } from "../../store/inboxStore";
import { callRoomOf, type FaceEntry, type FaceRow as FaceRowModel, type FaceState, type LinkKind } from "../../lib/faces/faceRow";
import { useCircleFace } from "../../hooks/useCircleFace";
import { CircleFace } from "../calls/FaceCircle";
import { firstName } from "../calls/speakers";
import { getCallTiles, subscribeCallTiles, type ParticipantTile } from "../../lib/calls/callManager";
import { useFaceKey, useWalkieFaces, type FaceKey } from "../presence/useFaceKey";
import { FaceCard } from "./FaceCard";
import { useWalkieLevelVar } from "../../hooks/useWalkie";
import { useVideoFrame } from "../../lib/calls/videoFrames";
import { useMicLevelVar } from "../../hooks/useMicLevelVar";
import { useEventListener } from "../../hooks/useEventListener";
import { PresenceBadge } from "../presence/PresenceBadge";
import { presenceAvatarClass, type PresenceVisual } from "../presence/memberPresence";
import { MORPH_EASING, MORPH_MS, canMorph } from "../calls/useSurfaceMorph";
import { useFloatingCircles, type FloatingBridge } from "../calls/useFloatingCircles";

import "../calls/faces.css";
import "../calls/walkie.css";
import "../people/people.css";
import "../presence/presence.css";
import "./faceRow.css";

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

/** The avatar key an agent's anchor picked, found by the agent's user id. */
function anchorAvatarOf(anchors: Record<string, any> | undefined, botUserId: string): string | null {
  for (const a of Object.values(anchors ?? {})) {
    if (a && String(a.bot_user_id) === botUserId) return a.bot_avatar ?? null;
  }
  return null;
}

/** On the call's track: me, and everyone linked to me. */
const onTheCall = (e: FaceEntry): boolean => e.tier === "me" || e.tier === "linked";

function FaceSeat({
  entry,
  tile,
  viewerId,
  callsEnabled,
  density,
  cardOpen,
  onHover,
  onToggle,
  onPress,
  registerKey,
  stacked,
  stackDepth = 0,
  onExpand,
  onPointerDown,
  onPointerUp,
}: {
  entry: FaceEntry;
  tile: ParticipantTile | undefined;
  viewerId: string;
  callsEnabled: boolean;
  density: FaceDensity;
  /** This face's card is open (hovered or pinned). */
  cardOpen: boolean;
  onHover: (id: string | null) => void;
  onToggle: (id: string) => void;
  /** A press on the face: whatever the dwell was about to open, it waits. */
  onPress: () => void;
  /** The seat's key, for the card's Talk button: one key per person. */
  registerKey: (id: string, key: FaceKey | null) => void;
  /** Folded into the stack beside a call: the face is part of one control
   *  that spreads the team back out, with no card and no marks of its own. */
  stacked: boolean;
  /** Its place in the stack, from the front: the first face sits on top. */
  stackDepth?: number;
  onExpand: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
}) {
  const diameter = FACE_ROW_METRICS[density].face;
  // An agent's face is its animal, the portrait the org chart and the inbox
  // draw for it: its anchor's own pick, else the animal its name maps to.
  const botAvatar = useInboxStore((s: any) => (entry.bot ? anchorAvatarOf(s.anchors, entry.id) : null));
  const image = entry.bot ? AVATAR_URLS[isAvatarKey(botAvatar) ? botAvatar : defaultAvatarFor(entry.name)] : entry.image;
  const { hostRef, videoRef, track } = useCircleFace({ tile, image, diameter, active: true });
  // No track in this window (the media is in the voice host): the host's
  // relayed frame stands in, so the header still shows the person, not a photo.
  const frame = useVideoFrame(entry.video && !track ? entry.id : null);
  // The face is the key: its card carries Talk, Ring and Message, the room
  // warmed on a dwell. My own face keys nothing; there is nobody to talk to.
  const key = useFaceKey({
    viewerId,
    memberId: entry.id,
    callsEnabled: callsEnabled && !entry.me,
    talking: entry.state === "talking-to-me",
  });
  registerKey(entry.id, entry.me ? null : key);
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

  const presence = PRESENCE_OF[entry.state];
  const canOpen = callsEnabled || !entry.me;

  return (
    <div
      ref={levelRef}
      className="face-slot face-seat"
      data-face-id={entry.id}
      data-card={cardOpen ? "1" : undefined}
      data-hold={key.holding ? "1" : undefined}
      data-ask={entry.ask > 0 ? entry.ask : undefined}
      data-stacked={stacked ? "1" : undefined}
      style={stacked ? { zIndex: 10 - Math.min(stackDepth, 9) } : undefined}
      {...(stacked ? {} : key.warmProps)}
      onMouseEnter={() => onHover(stacked ? null : entry.id)}
      onMouseLeave={() => onHover(null)}
    >
      <button
        ref={hostRef as unknown as RefObject<HTMLButtonElement | null>}
        type="button"
        data-face-hit
        data-state={entry.state}
        data-me={entry.me ? "1" : undefined}
        data-bot={entry.bot ? "1" : undefined}
        data-level={entry.level ?? undefined}
        data-speaking={entry.state === "speaking" ? "true" : undefined}
        data-followed={entry.followed ? "true" : undefined}
        data-walkie-state={entry.me ? undefined : key.state}
        className={`face ${presence ? presenceAvatarClass(presence) : ""}`.trim()}
        aria-label={stacked ? "Show the rest of the team" : entry.me ? `${entry.name} (you)` : entry.name}
        title={stacked ? "Show the rest of the team" : undefined}
        aria-expanded={stacked ? false : canOpen ? cardOpen : undefined}
        aria-haspopup={canOpen && !stacked ? "dialog" : undefined}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (stacked) onExpand();
          else if (canOpen) onToggle(entry.id);
        }}
        onPointerDown={(e) => {
          onPress();
          onPointerDown?.(e);
        }}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <CircleFace videoRef={videoRef} track={track} frame={frame} image={image} name={entry.name} diameter={diameter} />
      </button>
      {/* The marks on the person sit on the circle's EDGE, outside its clip:
          the presence badge, the mute badge, the unread count, the ask. The
          mute badge inside the circle (the call circles' own spot) was cut
          to a D by the circle's clip, and its icon with it. */}
      {entry.muted && (
        <span className="face-mute" aria-label="muted">
          <MicOff className="h-3 w-3" />
        </span>
      )}
      {/* An agent wears its tag where a person wears presence: it is always
          there and never away, so the dot would say nothing. */}
      {entry.bot ? (
        <span className="face-bot" aria-label="agent" title="Agent">
          <Sparkle className="face-bot-glyph" aria-hidden="true" />
        </span>
      ) : (
        presence && <PresenceBadge state={presence} size={density === "bar" ? "sm" : "md"} className="face-pres" />
      )}
      {entry.unread > 0 && (
        <span className="face-unread" aria-label={`${entry.unread} unread`}>
          {entry.unread > 99 ? "99+" : entry.unread}
        </span>
      )}
      {entry.ask > 0 && <span className="face-ask" aria-label={`${entry.ask} waiting on you`} />}
      {/* No "joined" label under the chin: a face is `joining` only in my own
          room, where the card under the row is the joined notice and says so
          in words; a label there sat under the card that covered it. */}
      {/* The name under the chin, the floating circles' own hover. In the
          bar the card carries the name, so nothing hangs under a face there
          that a card could stack on. */}
      {density === "float" && <span className="face-name">{firstName(entry.name)}</span>}
    </div>
  );
}

export function FaceRow({
  row,
  density,
  viewerId,
  callsEnabled = true,
  rootRef,
  belowRef,
  boxRef,
  onDragStart,
  onDragEnd,
  onOpenProfile,
  chrome,
  holdCard = false,
  className = "",
  children,
}: {
  row: FaceRowModel;
  density: FaceDensity;
  viewerId: string;
  callsEnabled?: boolean;
  /** The float machinery's root, when this row is the floating window's. */
  rootRef?: RefObject<HTMLDivElement | null>;
  /** The band under the faces (the member card), for whoever sizes a
   *  window from it. */
  belowRef?: (el: HTMLDivElement | null) => void;
  /** The row's own box, for whoever sizes a window from it. */
  boxRef?: (el: HTMLDivElement | null) => void;
  /** Held on a circle, the floating window follows the cursor. */
  onDragStart?: (e: React.PointerEvent) => void;
  onDragEnd?: (e: React.PointerEvent) => void;
  /** The card's profile door. Absent: the card names the person, and that is all. */
  onOpenProfile?: (member: any) => void;
  /** The float's controls: the footer of the card under the row, there
   *  while the pointer is in the window. */
  chrome?: ReactNode;
  /** The float: the open card stays while the pointer is anywhere in the
   *  window, and switches faces as the pointer moves. Leaving a face is not
   *  leaving the card. */
  holdCard?: boolean;
  className?: string;
  /** The engagement card, in the row beside the faces: one line, faces
   *  first, then what is happening and what you can do about it. */
  children?: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement | null>(null);
  const tiles = useTiles();
  const faces = useWalkieFaces();
  const linkTo = new Map<string, LinkKind>(row.links.map((l) => [l.to, l.kind]));
  // Who, in what order, with which bridges: the only changes that move a seat.
  const orderSig = row.entries.map((e) => `${e.id}${linkTo.has(e.id) ? "+" : ""}`).join(",");
  useFlipRow(ownRef, orderSig);

  // THE CALL. Me and everyone linked to me (a call, a ring, a voice either
  // way) sit at the head of the row. The strip, the moment's controls, sits
  // right after the last of them, and its plate runs back behind their faces
  // as one track, so the people on the call read as one object with its
  // controls and the rest of the team sits off it. The track is drawn, not a
  // wrapper: a seat moved into a new parent would remount, and a person is
  // one DOM node for as long as they are on the row.
  const hasStrip = children != null && children !== false;
  const callIds = row.entries.filter(onTheCall).map((e) => e.id);
  const lastCallId = hasStrip ? callIds[callIds.length - 1] : undefined;
  // THE STACK. On a call, everyone off it folds into one overlapped stack
  // after the track: the call is what the row is about now. A press on the
  // stack spreads the team back out as ordinary faces (their cards carry
  // Add to call); the fold closes it again, and so does the next call.
  const callRoom = callRoomOf(row);
  const outsiders = row.entries.length - callIds.length;
  const stackable = !!callRoom && callIds.length > 0 && outsiders >= 2;
  const [spread, setSpread] = useState(false);
  useLayoutEffect(() => setSpread(false), [callRoom]);
  const stacked = stackable && !spread;
  const lastId = row.entries[row.entries.length - 1]?.id;

  const cameraOf = (id: string): ParticipantTile | undefined =>
    tiles.find((t) => t.kind === "camera" && t.identity === id);

  // THE ONE CARD. At most one face has its card open: pointed at (after a
  // dwell) or pinned by a click. The same card either way, so hovering and
  // clicking can never stack two things under one face.
  const [openId, setOpenId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  const close = useCallback(() => {
    clearTimers();
    setOpenId(null);
    setPinned(false);
  }, []);
  const hover = (id: string | null) => {
    if (id) {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = null;
      if (openId === id) return;
      if (pinned) return;
      if (openTimer.current) clearTimeout(openTimer.current);
      // Instant switch when a card is already open; dwell when opening cold.
      if (openId) setOpenId(id);
      else openTimer.current = setTimeout(() => setOpenId(id), CARD_OPEN_MS);
      return;
    }
    if (openTimer.current) clearTimeout(openTimer.current);
    openTimer.current = null;
    if (pinned || holdCard) return;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpenId(null), CARD_CLOSE_MS);
  };
  // The hold let go (the pointer left the window): the card goes with it.
  useLayoutEffect(() => {
    if (!holdCard && openId && !pinned) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the hold's edge
  }, [holdCard]);
  const toggle = (id: string) => {
    if (openId === id && pinned) return close();
    clearTimers();
    setOpenId(id);
    setPinned(true);
  };
  // A pinned card closes on a press anywhere else, and on Escape.
  useEventListener("pointerdown", (e: Event) => {
    if (pinned && ownRef.current && !ownRef.current.contains(e.target as Node)) close();
  });
  useEventListener("keydown", (e: Event) => {
    if (openId && (e as KeyboardEvent).key === "Escape") close();
  });
  // The card is gone when its person leaves the row, or folds into the stack.
  const onRow = !openId || row.entries.some((e) => e.id === openId && !(stacked && !onTheCall(e)));
  useLayoutEffect(() => {
    if (!onRow) close();
  }, [onRow, close]);
  useLayoutEffect(() => clearTimers, []);

  // Where the notch points: the open seat's centre, read from its resting
  // spot (the FLIP moves seats by transform, which offsetLeft ignores).
  const [anchor, setAnchor] = useState(0);
  useLayoutEffect(() => {
    if (!openId) return;
    const seat = ownRef.current?.querySelector<HTMLElement>(`[data-face-id="${openId}"]`);
    if (seat) setAnchor(seat.offsetLeft + seat.offsetWidth / 2);
  }, [openId, orderSig]);

  // Each seat's key, so the card's Talk is the face's own.
  const keys = useRef(new Map<string, FaceKey | null>());
  const registerKey = useCallback((id: string, key: FaceKey | null) => {
    keys.current.set(id, key);
  }, []);

  // The profile door closes the card on its way out; a host with no door
  // (the float window has no router of its own) shows the block as words.
  const openProfile = useMemo(
    () =>
      onOpenProfile
        ? (member: any) => {
            close();
            onOpenProfile(member);
          }
        : undefined,
    [onOpenProfile, close],
  );

  const trackKind = row.links.some((l) => l.kind === "ring") ? "ring" : row.links[0]?.kind;
  const trackRef = useRef<HTMLSpanElement | null>(null);
  const stripEl = useRef<HTMLDivElement | null>(null);
  // Every commit: the strip's width follows its words (a ring becoming a
  // call), and seats arrive and leave. Written straight onto the track, so a
  // measure never costs a render.
  useLayoutEffect(() => {
    const track = trackRef.current;
    const strip = stripEl.current;
    const first = callIds[0] ? ownRef.current?.querySelector<HTMLElement>(`[data-face-id="${callIds[0]}"]`) : null;
    if (!track || !strip || !first) return;
    const h = strip.offsetHeight;
    const left = first.offsetLeft + first.offsetWidth / 2 - h / 2;
    track.style.left = `${left}px`;
    track.style.top = `${strip.offsetTop}px`;
    track.style.height = `${h}px`;
    track.style.width = `${strip.offsetLeft + strip.offsetWidth - left}px`;
  });

  const setRoot = useCallback(
    (el: HTMLDivElement | null) => {
      ownRef.current = el;
      if (rootRef) rootRef.current = el;
      boxRef?.(el);
    },
    [rootRef, boxRef],
  );

  const strip = hasStrip ? (
    <div
      key="strip"
      ref={stripEl}
      className="face-row-strip"
      data-chrome-hit
      data-track={lastCallId ? "1" : undefined}
    >
      {children}
    </div>
  ) : null;

  return (
    <div
      ref={setRoot}
      className={`face-row ${className}`.trim()}
      data-density={density}
      data-holding={faces.sendingRoomKey ? "1" : undefined}
      data-stacked={stacked ? "1" : undefined}
      role="group"
      aria-label="Team"
    >
      {/* ONE FLAT LIST, every child keyed. A nested array per entry would
          scope each seat's key to its own fragment, and React cannot move a
          keyed element between fragments: the person would remount the
          moment a bridge appeared before them. */}
      {lastCallId && <span ref={trackRef} className="face-row-track" data-link-kind={trackKind} aria-hidden="true" />}
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
            cardOpen={openId === entry.id}
            onHover={hover}
            onToggle={toggle}
            onPress={clearTimers}
            registerKey={registerKey}
            stacked={stacked && !onTheCall(entry)}
            stackDepth={i - callIds.length}
            onExpand={() => setSpread(true)}
            onPointerDown={onDragStart}
            onPointerUp={onDragEnd}
          />
        );
        const out = kind
          ? [<span key={`link:${entry.id}`} className="face-link" data-link-kind={kind} aria-hidden="true" />, seat]
          : [seat];
        if (entry.id === lastCallId) out.push(strip!);
        // How many the stack holds, and a second way in.
        if (entry.id === lastId && stacked) {
          out.push(
            <button
              key="stack-count"
              type="button"
              className="face-row-stack-count"
              data-chrome-hit
              title="Show the rest of the team"
              aria-label={`Show the rest of the team (${outsiders})`}
              onClick={(e) => {
                e.stopPropagation();
                setSpread(true);
              }}
            >
              {outsiders}
            </button>,
          );
        }
        // The fold, after the spread team: the way back to the stack.
        if (entry.id === lastId && stackable && spread) {
          out.push(
            <button
              key="fold"
              type="button"
              className="face-row-fold"
              data-chrome-hit
              title="Fold the team back beside the call"
              aria-label="Fold the team back beside the call"
              onClick={(e) => {
                e.stopPropagation();
                setSpread(false);
              }}
            >
              <ChevronLeft aria-hidden="true" />
            </button>,
          );
        }
        return out;
      })}
      {/* The strip: in the row, after the faces it is about (the call's, when
          there is one). Never under them, where a face's own card opens. */}
      {!lastCallId && strip}
      {/* The band under the faces: the one member card while a face is
          pointed at or pinned. In the float it is the one card the pointer
          brings: the pointed face's words, or a legend, over the window's
          own controls as the footer. */}
      {openId || chrome ? (
        <div
          ref={belowRef}
          className="face-row-below"
          data-chrome-hit
          onMouseEnter={() => {
            if (closeTimer.current) clearTimeout(closeTimer.current);
            closeTimer.current = null;
          }}
          onMouseLeave={() => hover(null)}
        >
          {!openId && chrome && (
            <div className="face-row-legend" aria-hidden="true">
              Point at a face for who; click for Talk, Huddle and Message
            </div>
          )}
          {openId && (
            <FaceCard
              memberId={openId}
              viewerId={viewerId}
              callsEnabled={callsEnabled}
              faceKey={keys.current.get(openId) ?? null}
              anchor={anchor}
              density={density}
              onOpenProfile={openProfile}
              onClose={close}
            />
          )}
          {chrome}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The row as the floating window's contents: sized to its circles and the
 * band under them, click through everywhere but the faces and that band, and
 * dragged by a face. The bridge is the window's own, so the same row drives
 * whichever shell window is hosting it.
 *
 * THE BAND IS MEASURED, NOT COMPUTED. The row's own size follows from its
 * metrics, but the cards' heights are their words, so a ResizeObserver on the
 * band reports it and the window follows. The band exists only while there
 * is a card, so an empty row is exactly its faces.
 */
export function FloatingFaceRow({
  row,
  viewerId,
  callsEnabled = true,
  bridge,
  onOpenProfile,
  chrome,
  children,
}: {
  row: FaceRowModel;
  viewerId: string;
  callsEnabled?: boolean;
  bridge: FloatingBridge;
  /** The card's profile door; the float has no router, so its host hands
   *  the path to the main window. */
  onOpenProfile?: (member: any) => void;
  /** The float's own controls: a grip to move it, the stage when a call is
   *  up, and a way to put it away. Absent: no chrome (a rig, a test). */
  chrome?: FloatChrome;
  /** The engagement card, in the band under the faces. */
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
  // Two measured boxes: the row itself (faces, bridges, the strip and the
  // call's track) and the member card's band under it. Each is what the
  // stylesheet drew, so each is read, not computed.
  const [card, belowRef] = useMeasured();
  const [box, boxRef] = useMeasured();
  const { rootRef, hovered, startDrag, endDrag } = useFloatingCircles({
    sizeFor: () => floatingRowSize(faces, links, card, box),
    shapeSig: `${faces}|${links}|${card.width}x${card.height}|${box.width}x${box.height}`,
    bridge,
  });
  return (
    <FaceRow
      row={shown}
      density="float"
      viewerId={viewerId}
      callsEnabled={callsEnabled}
      rootRef={rootRef}
      belowRef={belowRef}
      boxRef={boxRef}
      onDragStart={startDrag}
      onDragEnd={endDrag}
      onOpenProfile={onOpenProfile}
      holdCard={hovered}
      chrome={
        chrome && hovered ? (
          <div className="faces-chrome face-row-chrome" data-chrome-hit role="toolbar" aria-label="Floating faces">
            {/* The grip: held, the window follows the cursor (a face drags
                it too, but a grip says so). */}
            <button
              type="button"
              className="faces-btn face-row-grip"
              data-chrome-btn="move"
              title="Hold to move"
              onPointerDown={startDrag}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <GripHorizontal className="h-4 w-4" />
              <span className="faces-btn-word">Move</span>
            </button>
            {chrome.inCall && chrome.onExpand && (
              <button type="button" className="faces-btn" data-chrome-btn="open" onClick={chrome.onExpand} title="Open the call window">
                <Maximize2 className="h-4 w-4" />
                <span className="faces-btn-word">Open</span>
              </button>
            )}
            <button type="button" className="faces-btn" data-chrome-btn="close" onClick={chrome.onClose} title={chrome.closeTitle}>
              <X className="h-4 w-4" />
              <span className="faces-btn-word">{chrome.closeWord}</span>
            </button>
          </div>
        ) : null
      }
    >
      {children}
    </FaceRow>
  );
}

/** What the float's chrome offers. `closeWord` is "Close" for a row the
 *  person popped out (it goes back to the header) and "Hide" for one that
 *  came out on its own for a ring or a call (it stays away until the next). */
export type FloatChrome = {
  inCall: boolean;
  onExpand?: () => void;
  onClose: () => void;
  closeWord: string;
  closeTitle: string;
};

/** A box's size, read by a ResizeObserver: a ref to hand the element in,
 *  and the latest size. Zero once the element is gone. */
function useMeasured(): [{ width: number; height: number }, (el: HTMLDivElement | null) => void] {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      setSize({ width: 0, height: 0 });
      return;
    }
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
    };
    measure();
    if (typeof ResizeObserver !== "undefined") {
      observer.current = new ResizeObserver(measure);
      observer.current.observe(el);
    }
  }, []);
  return [size, ref];
}
