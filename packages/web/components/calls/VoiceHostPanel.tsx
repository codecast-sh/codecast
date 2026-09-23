import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { useTrackedStore } from "../../store/inboxStore";
import { useWalkieStatus } from "../../hooks/useWalkie";
import { useFaceRow } from "../../hooks/useFaceRow";
import { useCallsAvailable } from "../../lib/teamFeatures";
import { CallStage } from "./CallStage";
import { FloatingFaceRow } from "../faces/FaceRow";
import { EngagementCard } from "../faces/EngagementCard";
import { PeoplePanel } from "../people/PeoplePanel";
import { voiceHostView } from "../../lib/calls/voiceHostView";
import { soundCallRing } from "../../lib/sounds";
import { CALL_RING_PERIOD_MS } from "@codecast/shared/contracts";
import { acceptInvite, takeOverCall } from "../../lib/calls/callManager";
import { publishVoiceMirror, runVoiceCommand, walkieHoldsRoom } from "../../lib/calls/walkie";
import { callWindowReport } from "../../lib/calls/callHandoff";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import {
  declareVoiceHost,
  onCallPanelOpen,
  onCallPanelShow,
  onCallRingAccept,
  onVoiceCommand,
  reportCallPanelState,
  setCallWindowContentSize,
  setCallWindowDragging,
  setCallWindowInteractive,
  setCallWindowSize,
  setRingAttention,
  voiceShapeForCallSize,
  type CallWindowSize,
  type VoiceWindowShape,
} from "../../lib/desktop";
import "./voiceHost.css";

/**
 * The voice host: the one window that holds the microphone, in every shape.
 *
 * ── What this IS ──────────────────────────────────────────────────────────
 * The persistent call panel window on a shell that keeps one. It is built at
 * boot, hidden, and it never goes away: the walkie's ear lives here (this is
 * the window the door elects), so a teammate's burst plays here, this
 * person's burst is spoken here, and a call, however it starts, joins here.
 * Every other window is a remote for it.
 *
 * ── One row, one shape ────────────────────────────────────────────────────
 * Presence, a burst, a ring and a call are the same row of faces in
 * different states (lib/faces/faceRow), so this window has one shape for
 * all of them: the float, the row and its card over the work, anchored to
 * one corner the shell remembers. What is happening changes what the row
 * draws; it never changes where the window is. The stage is the expanded
 * call and opens only on an explicit expand; the wall is the buddy list.
 * lib/calls/voiceHostView says which, and when the float is up at all: the
 * header shows the same row while the app is in front, so the float shows
 * only for something happening while the app is behind another window, or
 * for as long as the person keeps it popped out.
 *
 * ── The three things it says to the shell ─────────────────────────────────
 * Its shape, whenever the derivation changes. What room it hosts, so every
 * other window knows the call lives here. And, once, that it is the host:
 * from then on rooms arrive as commands rather than in the URL.
 */
export function VoiceHostPanel({ urlRoom, params }: { urlRoom: string | null; params: URLSearchParams }) {
  const role = useDesktopWindowRole();
  const walkie = useWalkieStatus();
  const row = useFaceRow();
  const callsEnabled = useCallsAvailable();
  const s = useTrackedStore([
    (st: any) => st.call.phase,
    (st: any) => st.call.roomKey,
    (st: any) => st.call.muted,
    (st: any) => st.call.camera,
    (st: any) => st.call.sharing,
    (st: any) => st.call.micDenied,
    // The rings, as their ids: the sound is keyed by the invite it is for.
    (st: any) => (st.myCalls?.incoming ?? []).map((i: any) => i._id).join("|"),
    (st: any) => st.currentUser?._id,
    (st: any) => st.currentUser?.status === "busy",
  ]);
  const call = s.call;
  const viewerId = s.currentUser?._id ? String(s.currentUser._id) : "";

  // The stage, opened by the person: the elsewhere pill, an opener that
  // asked for the stage (a room in the URL with no other size named, the
  // older way in). Never by a burst becoming a call, which is the row
  // changing state. Put away by the stage's own X, and forgotten when the
  // call ENDS: only on that transition, because an expand can arrive a
  // moment before the join lands and must survive the idle it arrives in.
  const [expanded, setExpanded] = useState(
    () => !!urlRoom && params.get("ring") !== "1" && !params.get("size"),
  );
  const lastPhase = useRef(call.phase);
  if (lastPhase.current !== call.phase) {
    if (call.phase === "idle" && expanded) setExpanded(false);
    lastPhase.current = call.phase;
  }
  // Shrink and hide are one move here: the stage folds back into the float,
  // and the view decides whether the float shows (voiceHostView).
  const hideCall = useCallback(() => setExpanded(false), []);
  const expand = useCallback(() => setExpanded(true), []);
  // An opener's size still speaks the legacy call sizes; the stage stays the
  // stage and every other size is the float.
  const applySize = useCallback((size: CallWindowSize) => {
    setExpanded(voiceShapeForCallSize(size) === "panel");
  }, []);

  // ── The ways a room reaches this window ───────────────────────────────────
  //
  // Three, and one guard across them: an accept and a takeover are two routes
  // to one join, and both running would be a second join of a room this
  // window is already in. The guard is per room, because this window lives
  // through many calls.
  const joining = useRef<string | null>(null);
  const claim = (room: string) => {
    if (joining.current === room) return false;
    joining.current = room;
    return true;
  };
  useWatchEffect(() => {
    if (call.phase === "idle") joining.current = null;
  }, [call.phase]);

  const inCall = call.phase !== "idle" && !!call.roomKey;
  const ringIn = row.card.kind === "ring-in" ? row.card : null;
  const view: VoiceWindowShape = voiceHostView({
    engaged: row.me !== null,
    inCall,
    expanded,
    floating: role.facesOverlay,
    appFocused: role.appFocused,
    wallWanted: role.peopleWall,
  });

  // The ring, sounded from here: one cycle per period, louder each of the
  // first three, until the invite goes (answered anywhere, declined,
  // cancelled by the caller, or expired). Busy is a silent ring: the card is
  // up, the sound is not. And the dock bounces for as long as the ring is.
  const quiet = s.currentUser?.status === "busy";
  const invite: any = ringIn
    ? (s.myCalls?.incoming ?? []).find((r: any) => r.room_key === ringIn.roomKey && String(r.from_user) === ringIn.from)
    : null;
  const inviteId = invite ? String(invite._id) : null;
  useWatchEffect(() => {
    if (!inviteId) return;
    setRingAttention(true);
    let t: ReturnType<typeof setInterval> | null = null;
    if (!quiet) {
      let cycle = 0;
      soundCallRing(cycle, inviteId);
      t = setInterval(() => soundCallRing(++cycle, inviteId), CALL_RING_PERIOD_MS);
    }
    return () => {
      if (t) clearInterval(t);
      setRingAttention(false);
    };
  }, [inviteId, quiet]);

  // The shape, told to the shell whenever the derivation moves. The shell
  // reveals and hides the window to match; this component never asks for
  // either by name. A build that answers null has no shapes at all, and says
  // so once rather than leaving a window that silently never changes.
  //
  // A LAYOUT effect, deliberately. The float mounts in the same commit and
  // reports how big the window has to be from a passive effect
  // (useFloatingCircles), and React runs a child's passive effect before a
  // parent's, so from a plain effect here the size report reached the shell
  // FIRST, while the window was still in its previous shape. The shell
  // refuses a resize in the idle shape, so the report was dropped and the
  // row came up cut off in the seed sized window until a hover re-sent it.
  // Layout effects run before every passive effect, parent or child, so the
  // ask is on the wire before the report.
  const warned = useRef(false);
  useLayoutEffect(() => {
    void setCallWindowSize(view).then((landed) => {
      if (landed || warned.current) return;
      warned.current = true;
      toast("The desktop app needs an update for the call window's shapes");
    });
  }, [view]);

  // Toasts are the app's and the stage's; a row floating over somebody's
  // editor is no place for one (voiceHost.css reads the class).
  useWatchEffect(() => {
    if (view === "panel") return;
    document.documentElement.classList.add("faces-overlay-window");
    return () => document.documentElement.classList.remove("faces-overlay-window");
  }, [view]);

  useMountEffect(() => {
    // 1. A room in the URL: the shell built this window onto it, the older
    //    way, before this page could declare itself. Taken over exactly as the
    //    per-call panel did, with the state the person was already in.
    if (urlRoom && params.get("ring") !== "1" && claim(urlRoom)) {
      void takeOverCall({
        roomKey: urlRoom,
        mic: params.get("mic") === "1",
        camera: params.get("cam") === "1",
        scribe: params.get("scribe") === "1",
      });
    }
    // 2. A room handed over as a command: an opener in another window, or an
    //    answered ring on its way (the accept follows and is what joins). An
    //    opener that asked for the stage gets the stage; one that asked for
    //    the float, or did not say, gets the row.
    onCallPanelOpen((payload) => {
      if (!payload?.room) return;
      if (payload.size) applySize(payload.size);
      if (payload.ring) return;
      if (!claim(payload.room)) return;
      void takeOverCall({
        roomKey: payload.room,
        mic: !!payload.mic,
        camera: !!payload.camera,
        scribe: !!payload.scribe,
      });
    });
    // 3. The ring window answered (an older shell's). The accept is what
    //    takes the seat.
    onCallRingAccept(({ inviteId, roomKey }) => {
      if (!inviteId || !roomKey || !claim(roomKey)) return;
      void acceptInvite(inviteId, roomKey);
    });
    // And every gesture from every other window: a press, a join, a hang-up.
    // None of them opens the stage: the row shows the call where the person
    // is, and the stage waits for an explicit expand.
    onVoiceCommand(({ cmd, args }) => {
      void runVoiceCommand(cmd, args);
    });
    // The elsewhere pill, in any window: the explicit expand.
    onCallPanelShow(expand);
    // Listeners first, then the declaration: from here rooms are commands.
    declareVoiceHost();
  });

  // ── What the other windows are told ───────────────────────────────────────
  //
  // The room this window hosts, so the rest of the app shows "in a huddle in
  // another window" and raises this one on a click. A seat the walkie holds,
  // a burst being spoken or heard, is not a huddle, and is not reported as
  // one: the row is already the whole of what there is to see.
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus).active;
  const hostedRoom = walkieHoldsRoom(walkie, call.roomKey) ? null : call.roomKey;
  useWatchEffect(() => {
    reportCallPanelState(
      callWindowReport({ roomKey: hostedRoom, windowRoom: null, muted: call.muted, camera: call.camera, scribe }),
    );
  }, [hostedRoom, call.muted, call.camera, scribe]);

  // And the mirror: the walkie's engine publishes on its own moves, but a
  // mute, a camera or the speaker list moves the call slice without the
  // walkie noticing, and a remote's face row draws all three.
  useWatchEffect(() => {
    publishVoiceMirror();
  }, [call.phase, call.roomKey, call.muted, call.camera, call.micDenied, call.speaking]);

  if (view === "panel") {
    return (
      <>
        <CallStage panel onShrink={hideCall} onHide={hideCall} />
        {/* A ring during a call: the row's card, over the stage where the
            person is. Nothing else in the app draws it while a host exists. */}
        {ringIn && (
          <div className="dark voice-stage-ring">
            <EngagementCard card={row.card} density="float" />
          </div>
        )}
      </>
    );
  }
  if (view === "wall") {
    return (
      <div className="voice-wall-window">
        <PeoplePanel host callBehind={inCall} onShowCall={expand} />
      </div>
    );
  }
  if (view === "float") {
    return (
      <div className="dark voice-float-window">
        <FloatingFaceRow row={row} viewerId={viewerId} callsEnabled={callsEnabled} bridge={CALL_WINDOW_BRIDGE}>
          {row.card.kind !== "none" && <EngagementCard card={row.card} density="float" />}
        </FloatingFaceRow>
      </div>
    );
  }
  return null;
}

// The call window's own switches, for the float drawn inside it.
const CALL_WINDOW_BRIDGE = {
  setInteractive: setCallWindowInteractive,
  setContentSize: setCallWindowContentSize,
  setDragging: setCallWindowDragging,
};
