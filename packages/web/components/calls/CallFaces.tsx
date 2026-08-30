import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
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

// Module-level so the hook's callbacks can treat it as a constant: this
// component only ever runs inside the call window, and these are its switches.
const CALL_WINDOW_BRIDGE = {
  setInteractive: setCallWindowInteractive,
  setContentSize: setCallWindowContentSize,
  setDragging: setCallWindowDragging,
};
import {
  TIER_DIAMETER,
  facePeople,
  facesToShow,
  facesWindowSize,
  pickSpeaker,
  type FacePerson,
  type FaceTier,
  type SpeakerPick,
} from "../../lib/calls/faceCrop";
import { FaceCircle, FacesChrome } from "./FaceCircle";
import { useFloatingCircles } from "./useFloatingCircles";
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
 * CLICK-THROUGH AND SIZE live in `useFloatingCircles`, shared with the idle
 * presence overlay: the window ignores the mouse except over a circle, and it
 * is exactly as big as its circles plus what hovering adds.
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

  // The window's size, click-through and drag, shared with the presence
  // overlay. `hovered` is the one thing that can widen the window: at the
  // speaker tier four buttons are wider than one face, and a window that
  // clipped its own controls is a call you cannot leave.
  const { rootRef, hovered, startDrag, endDrag } = useFloatingCircles({
    sizeFor: (hover) => facesWindowSize(mode, faces.length, { tier, hovered: hover }),
    shapeSig: `${mode}|${faces.length}|${tier}`,
    bridge: CALL_WINDOW_BRIDGE,
  });

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

