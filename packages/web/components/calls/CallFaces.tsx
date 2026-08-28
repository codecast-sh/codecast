import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useEventListener } from "../../hooks/useEventListener";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTrackedStore } from "../../store/inboxStore";
import {
  getCallTiles,
  leaveCall,
  setCallOutlivesWindow,
  setMuted,
  subscribeCallTiles,
  type ParticipantTile,
} from "../../lib/calls/callManager";
import { callWindowLeaveGesture } from "../../lib/calls/callHandoff";
import {
  closeCallPanel,
  setCallWindowContentSize,
  setCallWindowDragging,
  setCallWindowInteractive,
  type CallWindowSize,
  type FacesMode,
} from "../../lib/desktop";
import {
  TIER_DIAMETER,
  facePeople,
  facesToShow,
  facesWindowSize,
  hitsInteractive,
  pickSpeaker,
  type FacePerson,
  type FaceTier,
  type HitRegion,
  type SpeakerPick,
} from "../../lib/calls/faceCrop";
import { FaceCircle, FacesChrome } from "./FaceCircle";
import "./faces.css";

/**
 * The call, minimized to the people in it.
 *
 * ── What this IS ──────────────────────────────────────────────────────────
 * The small sizes of the call window: a circle of somebody's face floating
 * over whatever you are working in, with everything around it see-through. A
 * row of them, one of them, or one shrunk to the size of a menu bar icon. It is
 * the smallest honest form of a call — you can see who you are with, you can hear
 * them, and one gesture gives you the room back.
 *
 * ── What it is NOT ────────────────────────────────────────────────────────
 * A window. It used to be one, because Electron decides `transparent` and
 * `frame` when a window is CONSTRUCTED and the stage's window had a frame. The
 * call window is now born see-through for every size, so these circles are a
 * subtree of it — and changing size no longer re-joins the room. Everything
 * about hosting the call (taking it over, reporting it, closing) belongs to
 * `CallPanel`; this draws the circles and says which size to be next.
 *
 * ── The two things a see-through size has to get right ────────────────────
 * CLICK-THROUGH. The window is a rectangle, the product is a few circles.
 * It ignores the mouse by default, and this component — the only side that
 * knows where the circles are — lifts that while the pointer is over one. Get
 * it wrong and an invisible pane eats clicks meant for the person's editor.
 *
 * FRAME DISCIPLINE. Face tracking samples at 3Hz and the crop eases toward it
 * every frame, all of it in refs and one CSS transform per circle. Nothing per
 * frame goes near React: this sits on top of somebody's real work, and it is
 * the last place in the app that should be re-rendering sixty times a second to
 * move a circle a pixel.
 */
export function CallFaces({
  mode,
  tier,
  held,
  onSetSize,
}: {
  /** How many circles: one, or the whole room. */
  mode: FacesMode;
  /** How big they are. `tiny` is the one size that is not its mode's own tier. */
  tier: FaceTier;
  /** Whether the window ever actually got the call — Leave means two things. */
  held: boolean;
  /** Change the window's size, including back to the stage. */
  onSetSize: (size: CallWindowSize) => void;
}) {
  const [hovered, setHovered] = useState(false);

  // Only what the circles paint. The phase, the camera flag and the rest of the
  // call slice belong to CallPanel now, and subscribing to them here would
  // re-render a window full of video for a fact it does not draw.
  const s = useTrackedStore([
    (st: any) => st.call.roomKey,
    (st: any) => st.call.muted,
    (st: any) => st.call.speaking,
    (st: any) => (st.call.roomKey ? st.callOccupancy[st.call.roomKey] : undefined),
    (st: any) => st.currentUser?._id,
  ]);
  const call = s.call;
  const occupancy: any[] | undefined = call.roomKey ? s.callOccupancy[call.roomKey] : undefined;
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => [] as ParticipantTile[]);
  const cameras = useMemo(() => tiles.filter((t) => t.kind === "camera"), [tiles]);
  const selfId = s.currentUser?._id ? String(s.currentUser._id) : null;

  const faces = useMemo(
    () => facesToShow(facePeople(occupancy ?? [], cameras, selfId)),
    [occupancy, cameras, selfId],
  );
  const cameraOf = useCallback(
    (id: string) => cameras.find((t) => t.identity === id),
    [cameras],
  );

  // ── Whose face the single circle shows ──────────────────────────────────
  //
  // Polled rather than driven by the speaking list, because the decision is
  // about TIME as much as about who is talking: a new voice has to hold the
  // floor before the circle follows it, and that moment arrives on the clock,
  // not on an event. `pickSpeaker` returns the same object when nothing
  // changes, so a poll that changes nothing re-renders nothing.
  const [pick, setPick] = useState<SpeakerPick>({ id: null, since: 0 });
  const speakingRef = useRef<string[]>([]);
  speakingRef.current = call.speaking ?? [];
  useMountEffect(() => {
    const t = setInterval(() => setPick((p) => pickSpeaker(p, speakingRef.current, Date.now())), 250);
    return () => clearInterval(t);
  });
  const shownId = useMemo(() => {
    if (pick.id && faces.some((f) => f.id === pick.id)) return pick.id;
    return faces[0]?.id ?? null;
  }, [pick.id, faces]);

  // ── The window is exactly as big as its circles ─────────────────────────
  //
  // Plus the 8px the speaking ring needs, and nothing else. `hovered` is the
  // one thing that can widen it: the chrome overlays the circles rather than
  // sitting under them, but at the speaker tier four buttons are wider than
  // one face, and a window that clipped its own controls is a call you cannot
  // leave. Away from the pointer it reserves nothing.
  useWatchEffect(() => {
    setCallWindowContentSize(facesWindowSize(mode, faces.length, { tier, hovered }));
  }, [mode, faces.length, tier, hovered]);

  // ── Click-through ───────────────────────────────────────────────────────
  //
  // Measured from the DOM rather than computed from the layout constants: the
  // circles are what the person sees, so the circles are what the hit test has
  // to agree with. Re-measured when the shape of the window changes, never per
  // mouse move — reading a rect per move per circle would force layout at the
  // pointer's rate on the one window that must stay cheap.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const regionsRef = useRef<HitRegion[]>([]);
  // Declared up here because the click-through test below reads it: a drag in
  // progress is the one state in which the window must keep taking the mouse.
  const dragging = useRef(false);
  const interactiveRef = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const measure = useCallback(() => {
    const root = rootRef.current;
    if (!root) return;
    const regions: HitRegion[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-face-hit]"))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) regions.push({ kind: "circle", cx: r.left + r.width / 2, cy: r.top + r.height / 2, r: r.width / 2 });
    }
    const chrome = root.querySelector<HTMLElement>("[data-chrome-hit]");
    if (chrome) {
      const r = chrome.getBoundingClientRect();
      if (r.width > 0) regions.push({ kind: "rect", x: r.left, y: r.top, width: r.width, height: r.height });
    }
    regionsRef.current = regions;
  }, []);
  // The window resizes itself a frame after the mode or the room changes, so
  // measure on both — and once more when the chrome appears, since it is a
  // region of its own that has to take the click that follows the hover.
  useWatchEffect(() => {
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [measure, mode, faces.length, hovered]);
  useEventListener("resize", measure);

  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setHovered(false);
  }, []);

  useEventListener("mousemove", (e: MouseEvent) => {
    // Mid-drag the window is following the cursor, so the pointer never really
    // leaves the circle — but if a fast flick made this test say otherwise, the
    // window would stop taking mouse events and the pointer-up that ends the
    // drag would never arrive. The window would then follow the cursor until
    // the shell's own expiry. So a drag holds interactivity open.
    if (dragging.current) return;
    const hit = hitsInteractive(regionsRef.current, e.clientX, e.clientY);
    if (hit !== interactiveRef.current) {
      interactiveRef.current = hit;
      setCallWindowInteractive(hit);
    }
    setHovered(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    // Over a circle, the chrome stays. Anywhere else in the window it is on its
    // way out — including when the pointer leaves through the transparent
    // margin, which is the last event this window ever sees of that gesture.
    hideTimer.current = hit ? null : setTimeout(hide, 1500);
  });
  useEventListener("mouseleave", hide, document);

  // ── Dragging a circle moves the window ──────────────────────────────────
  const startDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setCallWindowDragging(true);
  }, []);
  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setCallWindowDragging(false);
  }, []);

  // ── The ways out ────────────────────────────────────────────────────────
  //
  // Restoring is a resize now, not a handoff: the same window grows back into
  // the stage with the same room, the same mic and the same transcript. There
  // is nothing to evict and nothing to re-join.

  // Leave always wins, whatever state the window is in.
  //
  // What it MEANS depends on whether this window has the call. Holding it,
  // leaving hangs up. Not holding it — a join that failed — leaving is just
  // closing a window with nothing in it, and it must NOT call `leaveCall`: the
  // seat in `call_members` is shared with whichever window does hold the call,
  // and freeing it would take that window's occupancy, heartbeat and transcript
  // authorization with it.
  const leave = useCallback(() => {
    const gesture = callWindowLeaveGesture(held);
    if (gesture.hangUp) void leaveCall();
    setCallOutlivesWindow(false);
    void closeCallPanel({ ended: gesture.ended });
  }, [held]);

  const diameter = TIER_DIAMETER[tier];
  const speaking = useMemo(() => new Set<string>(call.speaking ?? []), [call.speaking]);

  return (
    <div ref={rootRef} className={`dark faces-window${hovered ? " faces-window--hover" : ""}`}>
      <div data-face-tier={tier} className={`faces-row faces-row--${mode}`} style={mode === "speaker" ? { width: diameter, height: diameter } : undefined}>
        {faces.length === 0 && (
          <div className="face" data-face-hit style={{ width: diameter, height: diameter }} onPointerDown={startDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <span className="face-waiting">joining</span>
          </div>
        )}
        {faces.map((person) => (
          <FaceCircle
            key={person.id}
            person={person}
            tile={cameraOf(person.id)}
            diameter={diameter}
            speaking={speaking.has(person.id)}
            // In speaker mode every face stays mounted and the one talking is
            // faded up: the swap is a crossfade instead of a video being torn
            // down and rebuilt for somebody about to speak again.
            shown={mode === "everyone" || person.id === shownId}
            onPointerDown={startDrag}
            onPointerUp={endDrag}
          />
        ))}
      </div>

      <FacesChrome
        mode={mode}
        muted={call.muted}
        held={held}
        onMode={() => onSetSize(mode === "speaker" ? "circles" : "speaker")}
        onMute={() => void setMuted(!call.muted)}
        onRestore={() => onSetSize("panel")}
        onLeave={leave}
      />
    </div>
  );
}

