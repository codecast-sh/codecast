import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2, Mic, MicOff, PhoneOff, User, Users, X } from "lucide-react";
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
  takeOverCall,
  type ParticipantTile,
} from "../../lib/calls/callManager";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import {
  callHandoffState,
  callWindowReport,
  facesLeaveGesture,
  facesWindowExit,
} from "../../lib/calls/callHandoff";
import {
  closeFacesWindow,
  isFacesWindow,
  openCallPanel,
  reportFacesState,
  setFacesDragging,
  setFacesInteractive,
  setFacesSize,
  type FacesMode,
} from "../../lib/desktop";
import {
  EVERYONE_DIAMETER,
  SPEAKER_DIAMETER,
  facePeople,
  facesToShow,
  facesWindowSize,
  hitsInteractive,
  pickSpeaker,
  type FacePerson,
  type HitRegion,
  type SpeakerPick,
} from "../../lib/calls/faceCrop";
import { useFaceCrop } from "./useFaceCrop";
import { AvatarImg } from "../../lib/avatarCache";
import { firstName } from "./speakers";
import "./faces.css";

/**
 * The call, minimized to the people in it.
 *
 * ── What this window IS ───────────────────────────────────────────────────
 * A circle of somebody's face, floating over whatever you are working in, with
 * everything around it see-through. Two modes: the person talking (one circle),
 * or everybody (a row). It is the smallest honest form of a call — you can see
 * who you are with, you can hear them, and one gesture gives you the room back.
 *
 * ── Why it is a window and not a mode of the panel ────────────────────────
 * Electron decides `transparent` and `frame` when a window is CONSTRUCTED. The
 * call panel cannot become see-through at runtime, so minimizing is a handoff:
 * this window joins the room, LiveKit evicts the panel as a duplicate identity
 * (every window of one person signs as the same user id), and the panel closes
 * behind it. Restoring is the same two moves swapped. Nothing coordinates them
 * — the SFU's ordering guarantees the new window is connected before the old
 * one lets go, so the audio has no hole in it.
 *
 * ── The two things a see-through window has to get right ──────────────────
 * CLICK-THROUGH. The window is a rectangle, the product is a few circles.
 * It ignores the mouse by default, and the renderer — the only side that knows
 * where the circles are — lifts that while the pointer is over one. Get this
 * wrong and an invisible pane eats clicks meant for the person's editor.
 *
 * FRAME DISCIPLINE. Face tracking samples at 3Hz and the crop eases toward it
 * every frame, all of it in refs and one CSS transform per circle. Nothing per
 * frame goes near React: this window sits on top of somebody's real work, and
 * it is the last place in the app that should be re-rendering sixty times a
 * second to move a circle a pixel.
 */
/**
 * How long this window waits to get the call before it gives up and closes.
 *
 * Longer than an ordinary join by a wide margin, and longer than the shell's
 * grace for a window that is still joining — so the shell stops believing this
 * window is on its way in before this window stops trying.
 */
const TAKEOVER_DEADLINE_MS = 12_000;

export function CallFaces() {
  const params = useMemo(
    () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const roomKey = params.get("room");
  const [mode, setMode] = useState<FacesMode>(params.get("mode") === "everyone" ? "everyone" : "speaker");
  const [hovered, setHovered] = useState(false);

  const s = useTrackedStore([
    (st: any) => st.call.phase,
    (st: any) => st.call.roomKey,
    (st: any) => st.call.muted,
    (st: any) => st.call.camera,
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

  // ── Lifecycle: the same shape as the call panel's, for the same reasons ──

  // This window's disappearance is a HANDOFF: the `call_members` seat is shared
  // with the window taking the call, so the unload hook must not free it.
  // Declared at mount because callManager's own unload listener is registered
  // at module load and runs before anything a page adds later.
  useMountEffect(() => {
    if (!isFacesWindow()) return;
    setCallOutlivesWindow(true);
    return () => setCallOutlivesWindow(false);
  });

  const took = useRef(false);
  useWatchEffect(() => {
    if (!roomKey || took.current) return;
    took.current = true;
    void takeOverCall({
      roomKey,
      mic: params.get("mic") === "1",
      camera: params.get("cam") === "1",
      scribe: params.get("scribe") === "1",
    });
  }, [roomKey, params]);

  // Did this window ever actually GET the call? Everything about closing it
  // turns on this, so it is tracked in a ref (read inside callbacks) and in
  // state (the Leave control says a different thing in each case).
  const held = useRef(false);
  const [heldNow, setHeldNow] = useState(false);

  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus).active;
  useWatchEffect(() => {
    reportFacesState({
      // The same five facts the panel reports, assembled in the same place —
      // including the room this window knows from its own URL before it knows
      // anything about a call. Plus the one fact only this window has.
      ...callWindowReport({
        phase: call.phase,
        roomKey: call.roomKey,
        windowRoom: roomKey,
        muted: call.muted,
        camera: call.camera,
        scribe,
      }),
      mode,
    });
  }, [call.phase, call.roomKey, roomKey, call.muted, call.camera, scribe, mode]);

  // ── Closing ─────────────────────────────────────────────────────────────
  //
  // This window has no title bar, no close box and no place in the dock: if it
  // does not close itself, nothing closes it short of quitting the app. So
  // every way this can stop being useful ends here, and `ended` carries the one
  // thing the shell cannot work out for itself:
  //
  //   ended: true   the call is OVER. Hand nothing anywhere.
  //   ended: false  the call is alive and this window is not the one holding
  //                 it — hand it back, and let the shell's arbiter decide
  //                 whether the main window or another call window takes it.
  //
  // Getting that backwards on the failure path is what strands a call: a window
  // whose join failed, closing as though it had hung up, takes a call nobody
  // else has been told about with it.
  const closing = useRef(false);
  const closeWindow = useCallback((ended: boolean) => {
    if (closing.current) return;
    closing.current = true;
    setCallOutlivesWindow(false);
    void closeFacesWindow({ ended });
  }, []);

  useWatchEffect(() => {
    if (call.phase === "connected") {
      held.current = true;
      setHeldNow(true);
    }
    const exit = facesWindowExit({ phase: call.phase, held: held.current, deadlinePassed: false });
    if (exit.close) closeWindow(exit.ended);
  }, [call.phase, closeWindow]);

  // The failure with nothing to show for itself: a join that neither connects
  // nor errors. No state change is coming to close this window, so a clock has
  // to. Bounded deliberately longer than the shell's grace for a window that is
  // still joining, so the shell stops waiting for this window before it stops
  // trying — never the other way round, which would leave a moment where both
  // sides believe the other has the call.
  useMountEffect(() => {
    const t = setTimeout(() => {
      const exit = facesWindowExit({ phase: "connecting", held: held.current, deadlinePassed: true });
      if (exit.close) closeWindow(exit.ended);
    }, TAKEOVER_DEADLINE_MS);
    return () => clearTimeout(t);
  });

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
  useWatchEffect(() => {
    setFacesSize(facesWindowSize(mode, faces.length));
  }, [mode, faces.length]);

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
      setFacesInteractive(hit);
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
    setFacesDragging(true);
  }, []);
  const endDrag = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setFacesDragging(false);
  }, []);

  // ── The ways out ────────────────────────────────────────────────────────
  const restore = useCallback(() => {
    // `callHandoffState` is the one place a call's movable state is read, so
    // restoring the panel and popping out cannot hand it over differently.
    const state = callHandoffState();
    if (!state) return closeWindow(false);
    // The panel joins and evicts this window; the phase watcher above closes it.
    void openCallPanel(state.room, state);
    // Unless this window never had the call. Then there is nothing for the
    // panel to evict, no disconnect will ever arrive, and waiting for one would
    // leave this window on screen forever.
    if (!held.current) closeWindow(false);
  }, [closeWindow]);

  // Leave always wins, whatever state this window is in.
  //
  // What it MEANS depends on whether this window has the call. Holding it,
  // leaving hangs up. Not holding it — a failed join — leaving is just closing
  // a useless window, and it must NOT call `leaveCall`: the seat in
  // `call_members` is shared with the window that does hold the call, and
  // freeing it would take that window's occupancy, heartbeat and transcript
  // authorization with it.
  const leave = useCallback(() => {
    const gesture = facesLeaveGesture(held.current);
    if (gesture.hangUp) void leaveCall();
    closeWindow(gesture.ended);
  }, [closeWindow]);

  const diameter = mode === "speaker" ? SPEAKER_DIAMETER : EVERYONE_DIAMETER;
  const speaking = useMemo(() => new Set<string>(call.speaking ?? []), [call.speaking]);

  if (!roomKey) {
    return (
      <div className="dark faces-window">
        <div className="face" style={{ width: SPEAKER_DIAMETER, height: SPEAKER_DIAMETER }}>
          <span className="face-waiting">no call</span>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`dark faces-window${hovered ? " faces-window--hover" : ""}`}>
      <div className={`faces-row faces-row--${mode}`} style={mode === "speaker" ? { width: diameter, height: diameter } : undefined}>
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
            showName={mode === "everyone"}
            onPointerDown={startDrag}
            onPointerUp={endDrag}
          />
        ))}
      </div>

      {/* The chrome. Four things, because there are exactly four things a
          person wants from a call they have minimized: see everyone or just
          the talker, stop being heard, get the room back, or leave. */}
      <div className="faces-chrome" data-chrome-hit>
        <button
          className="faces-btn"
          onClick={() => setMode((m) => (m === "speaker" ? "everyone" : "speaker"))}
          title={mode === "speaker" ? "Show everyone" : "Show whoever is talking"}
        >
          {mode === "speaker" ? <Users className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
        </button>
        <button
          className={`faces-btn${call.muted ? " faces-btn--alert" : " faces-btn--on"}`}
          onClick={() => void setMuted(!call.muted)}
          title={call.muted ? "Unmute" : "Mute"}
        >
          {call.muted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
        </button>
        <button className="faces-btn" onClick={restore} title="Back to the call window">
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          className="faces-btn faces-btn--alert"
          onClick={leave}
          title={heldNow ? "Leave the call" : "Close this window — the call stays where it is"}
        >
          {heldNow ? <PhoneOff className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

/**
 * One person, as a circle.
 *
 * With a camera, the video is cropped to their face and follows it. Without
 * one, their avatar fills the circle — a camera-off person is still somebody
 * you are talking to, and an empty circle would read as a broken video rather
 * than as a person who has their camera off.
 */
function FaceCircle({
  person,
  tile,
  diameter,
  speaking,
  shown,
  showName,
  onPointerDown,
  onPointerUp,
}: {
  person: FacePerson;
  tile?: ParticipantTile;
  diameter: number;
  speaking: boolean;
  shown: boolean;
  showName: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const track = tile?.track;

  useWatchEffect(() => {
    const el = videoRef.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  // A circle nobody can see does not need a face tracked in it.
  useFaceCrop({ videoRef, active: !!track && shown, diameter, mirror: !!tile?.isLocal });

  return (
    <div
      data-face-hit
      className={`face${shown ? " face--shown" : " face--hidden"}${speaking ? " face--speaking" : ""}`}
      style={{ width: diameter, height: diameter }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title={person.name}
    >
      {track ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          style={{ width: diameter, height: diameter }}
        />
      ) : (
        // Camera off. Their picture fills the circle — the same shape a face
        // would have, so a row of faces does not go ragged when somebody turns
        // their camera off mid-call.
        <AvatarImg
          src={person.image}
          alt=""
          className="face-avatar-img"
          fallback={
            <span className="face-avatar-fallback" style={{ fontSize: Math.max(12, diameter / 2.6) }}>
              {(person.name || "?").charAt(0).toUpperCase()}
            </span>
          }
        />
      )}
      {person.muted && (
        <span className="face-mute">
          <MicOff className="h-3 w-3" />
        </span>
      )}
      {showName && <span className="face-name">{firstName(person.name)}</span>}
    </div>
  );
}
