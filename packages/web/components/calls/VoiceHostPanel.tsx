import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { callDockSurface, useWalkieStatus } from "../../hooks/useWalkie";
import { CallStage } from "./CallStage";
import { CallFaces } from "./CallFaces";
import { WalkieBanner } from "./WalkieDock";
import { PresenceFaces } from "../people/PresenceFaces";
import { PeoplePanel } from "../people/PeoplePanel";
import { RingCard, type RingInvite } from "./RingCard";
import { voiceHostView } from "../../lib/calls/voiceHostView";
import { soundCallRing } from "../../lib/sounds";
import { CALL_RING_PERIOD_MS } from "@codecast/shared/contracts";
import {
  acceptInvite,
  declineInvite,
  getCallTiles,
  subscribeCallTiles,
  takeOverCall,
} from "../../lib/calls/callManager";
import { publishVoiceMirror, runVoiceCommand, walkieHoldsRoom } from "../../lib/calls/walkie";
import { callWindowReport } from "../../lib/calls/callHandoff";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import {
  declareVoiceHost,
  faceTierForSize,
  facesModeForSize,
  getVoiceWindowState,
  isCallWindowSize,
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
 * person's burst is spoken here, and a call — however it starts — joins here.
 * Every other window is a remote for it.
 *
 * ── Why the shape is DERIVED ──────────────────────────────────────────────
 * Nothing chooses a shape for this window; what is happening does. The same
 * lookup the in-app dock used (`callDockSurface`) says whether the walkie
 * holds the room, and from that (lib/calls/voiceHostView):
 *
 *   walkie   the strip, tucked in the bottom-right corner of the screen
 *   a call   the call size the person last chose (stage, circles, speaker,
 *            tiny), or the one they picked on the strip
 *   nothing  the team, if they keep it over their work — the wall (the buddy
 *            list) or the faces (the same team as circles); otherwise hidden
 *
 * A burst becoming a call is therefore this window going from `walkie` to a
 * call size: a resize, from the shell's side, of the window that already
 * holds the room. That is the whole of what ends the re-join.
 *
 * ── The three things it says to the shell ─────────────────────────────────
 * Its shape, whenever the derivation changes. What room it hosts, so every
 * other window knows the call lives here. And, once, that it is the host —
 * from then on rooms arrive as commands rather than in the URL.
 */
export function VoiceHostPanel({ urlRoom, params }: { urlRoom: string | null; params: URLSearchParams }) {
  const role = useDesktopWindowRole();
  const walkie = useWalkieStatus();
  const s = useTrackedStore([
    (st: any) => st.call.phase,
    (st: any) => st.call.roomKey,
    (st: any) => st.call.muted,
    (st: any) => st.call.camera,
    (st: any) => st.call.sharing,
    (st: any) => st.call.micDenied,
    // The rings, as their ids: the oldest live one is the card.
    (st: any) => (st.myCalls?.incoming ?? []).map((i: any) => i._id).join("|"),
    (st: any) => st.currentUser?.status === "busy",
  ]);
  const call = s.call;
  const tiles = useSyncExternalStore(subscribeCallTiles, getCallTiles, () => []);
  const remoteVideo = tiles.some((t) => !t.isLocal);

  // The call's own shape: what the person last left a huddle in, per machine,
  // until they pick another on the stage or the strip.
  const [callSize, setCallSize] = useState<CallWindowSize>(() => {
    const seeded = params.get("size");
    return isCallWindowSize(seeded) ? seeded : "panel";
  });
  useMountEffect(() => {
    void getVoiceWindowState().then((state) => {
      if (state && !params.get("size")) setCallSize(state.callSize);
    });
  });

  // A voice room this client stepped into from the walkie keeps the strip's
  // shape until video arrives or the person opens it — "float the faces" and
  // "open the call" on the strip land here. Forgotten with the call.
  const [expanded, setExpanded] = useState(false);
  if (expanded && call.phase === "idle") setExpanded(false);

  // The call, put away with the stage's X: it keeps running behind the wall,
  // the faces or nothing, and comes back when any window asks to show it.
  const [hiddenCall, setHiddenCall] = useState(false);
  if (hiddenCall && call.phase === "idle") setHiddenCall(false);
  const hideCall = useCallback(() => setHiddenCall(true), []);

  const applySize = useCallback((size: CallWindowSize) => {
    setCallSize(size);
    setExpanded(true);
    setHiddenCall(false);
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

  const surface = callDockSurface(walkie, call, {
    expanded,
    video: remoteVideo || !!call.camera || !!call.sharing,
  });
  // SOMEBODY IS CALLING. The oldest live invite is the card; a person already
  // in a call of their own is not rung here (the stage stays; the ring window
  // and the banner say it). A burst being heard is not a call of their own.
  const invite: RingInvite | null = (s.myCalls?.incoming?.[0] as RingInvite | undefined) ?? null;
  const inOwnCall = call.phase !== "idle" && !walkieHoldsRoom(walkie, call.roomKey);
  const ringing = !!invite && !inOwnCall;
  const view: VoiceWindowShape = voiceHostView({
    surface,
    callSize,
    hiddenCall,
    wallWanted: role.peopleWall,
    facesWanted: role.facesOverlay,
    ringing,
  });

  // The ring, sounded from here: one cycle per period, louder each of the
  // first three, until the invite goes — answered anywhere, declined,
  // cancelled by the caller, or expired. Busy is a silent ring: the card is
  // up, the sound is not. And the dock bounces for as long as the card is up.
  const quiet = !!s.currentUser && s.currentUser.status === "busy";
  const inviteId = invite?._id ?? null;
  useEffect(() => {
    if (!ringing || !inviteId) return;
    setRingAttention(true);
    let t: ReturnType<typeof setInterval> | null = null;
    if (!quiet) {
      let cycle = 0;
      soundCallRing(cycle);
      t = setInterval(() => soundCallRing(++cycle), CALL_RING_PERIOD_MS);
    }
    return () => {
      if (t) clearInterval(t);
      setRingAttention(false);
    };
  }, [ringing, inviteId, quiet]);
  const answerRing = useCallback(() => {
    if (!invite) return;
    setExpanded(true);
    setHiddenCall(false);
    if (claim(invite.room_key)) void acceptInvite(String(invite._id), invite.room_key);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- claim is a stable ref helper
  }, [invite]);
  const declineRing = useCallback(() => {
    if (invite) void declineInvite(String(invite._id));
  }, [invite]);

  // The shape, told to the shell whenever the derivation moves. The shell
  // reveals and hides the window to match; this component never asks for
  // either by name. A build that answers null has no shapes at all, and says
  // so once rather than leaving a window that silently never changes.
  const warned = useRef(false);
  useWatchEffect(() => {
    void setCallWindowSize(view).then((landed) => {
      if (landed || warned.current) return;
      warned.current = true;
      toast("The desktop app needs an update for the call window's shapes");
    });
  }, [view]);

  // Toasts are the app's and the stage's; a strip or a circle floating over
  // somebody's editor is no place for one (presenceFaces.css reads the class).
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
      setExpanded(true);
    }
    // 2. A room handed over as a command: an opener in another window, or an
    //    answered ring on its way (the accept follows and is what joins).
    onCallPanelOpen((payload) => {
      if (!payload?.room) return;
      if (payload.size) setCallSize(payload.size);
      setExpanded(true);
      if (payload.ring) return;
      if (!claim(payload.room)) return;
      void takeOverCall({
        roomKey: payload.room,
        mic: !!payload.mic,
        camera: !!payload.camera,
        scribe: !!payload.scribe,
      });
    });
    // 3. The ring window answered. The accept is what takes the seat.
    onCallRingAccept(({ inviteId, roomKey }) => {
      if (!inviteId || !roomKey || !claim(roomKey)) return;
      setExpanded(true);
      void acceptInvite(inviteId, roomKey);
    });
    // And every gesture from every other window: a press, a join, a hang-up.
    onVoiceCommand(({ cmd, args }) => {
      if (cmd === "joinCall" || cmd === "startHuddle" || cmd === "acceptInvite") {
        setExpanded(true);
        setHiddenCall(false);
      }
      void runVoiceCommand(cmd, args);
    });
    // The elsewhere pill, in any window: bring the call back.
    onCallPanelShow(() => setHiddenCall(false));
    // Listeners first, then the declaration: from here rooms are commands.
    declareVoiceHost();
  });

  // ── What the other windows are told ───────────────────────────────────────
  //
  // The room this window hosts, so the rest of the app shows "in a huddle in
  // another window" and raises this one on a click. A seat the walkie holds —
  // a burst being spoken or heard — is not a huddle, and is not reported as
  // one: the strip in the corner is already the whole of what there is to see.
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus).active;
  const hostedRoom = walkieHoldsRoom(walkie, call.roomKey) ? null : call.roomKey;
  useWatchEffect(() => {
    reportCallPanelState(
      callWindowReport({ roomKey: hostedRoom, windowRoom: null, muted: call.muted, camera: call.camera, scribe }),
    );
  }, [hostedRoom, call.muted, call.camera, scribe]);

  // And the mirror: the walkie's engine publishes on its own moves, but a
  // mute or a camera moves the call slice without the walkie noticing.
  useEffect(() => {
    publishVoiceMirror();
  }, [call.phase, call.roomKey, call.muted, call.camera, call.micDenied]);

  // A call running behind the wall or the faces: the pill that brings it back.
  const callBehind = hiddenCall && call.phase !== "idle";
  const showCall = useCallback(() => setHiddenCall(false), []);

  if (view === "ring" && invite) {
    return (
      <div className="dark voice-ring-window">
        <RingCardHost invite={invite} onAnswer={answerRing} onDecline={declineRing} />
      </div>
    );
  }
  if (view === "walkie") return <WalkieStripHost onShape={applySize} />;
  if (view === "wall") {
    return (
      <div className="voice-wall-window">
        <PeoplePanel host callBehind={callBehind} onShowCall={showCall} />
      </div>
    );
  }
  if (view === "faces") {
    return (
      <div className="dark contents">
        <PresenceFaces bridge={CALL_WINDOW_BRIDGE} />
      </div>
    );
  }
  if (view === "idle" || view === "ring") return null;
  if (view !== "panel") {
    return (
      <CallFaces
        mode={facesModeForSize(view)}
        tier={faceTierForSize(view)}
        onSetSize={applySize}
        onHide={hideCall}
        held={call.phase === "connected"}
      />
    );
  }
  return <CallStage panel onSetSize={applySize} onHide={hideCall} />;
}

// The call window's own switches, for the idle faces drawn inside it.
const CALL_WINDOW_BRIDGE = {
  setInteractive: setCallWindowInteractive,
  setContentSize: setCallWindowContentSize,
  setDragging: setCallWindowDragging,
};

/**
 * The strip, as the whole contents of a see-through window.
 *
 * The card is exactly the one the in-app dock draws (WalkieBanner); this only
 * gives it a box to sit in and keeps the window that size. The window takes
 * every click — the strip is all controls — and drags by its own header,
 * which the stylesheet marks as the drag region (voiceHost.css).
 */
function WalkieStripHost({ onShape }: { onShape: (size: CallWindowSize) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCallWindowContentSize({ width: Math.ceil(r.width), height: Math.ceil(r.height) });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="dark voice-walkie-window">
      <div ref={ref} className="voice-walkie-card">
        <WalkieBanner onShape={onShape} />
      </div>
    </div>
  );
}

/**
 * The ring card as the whole contents of a see-through window pinned over
 * everything: the window is kept exactly the card's size, plus the room its
 * glow needs, off the card's own measure.
 */
function RingCardHost({ invite, onAnswer, onDecline }: { invite: RingInvite; onAnswer: () => void; onDecline: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCallWindowContentSize({ width: Math.ceil(r.width) + 2 * RING_GLOW, height: Math.ceil(r.height) + 2 * RING_GLOW });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [invite._id]);
  return <RingCard ref={ref} invite={invite} onAnswer={onAnswer} onDecline={onDecline} />;
}

/** The margin the card's glow needs on every side (ringCard.css). */
const RING_GLOW = 24;
