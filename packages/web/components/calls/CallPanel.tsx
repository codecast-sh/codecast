import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTrackedStore } from "../../store/inboxStore";
import { CallStage } from "./CallStage";
import { CallFaces } from "./CallFaces";
import { setCallOutlivesWindow, takeOverCall } from "../../lib/calls/callManager";
import { callWindowReport, callWindowSizeOnFailedJoin } from "../../lib/calls/callHandoff";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import {
  closeCallPanel,
  faceTierForSize,
  facesModeForSize,
  getCallWindowSize,
  isCallPanelWindow,
  reportCallPanelState,
  setCallWindowSize,
  type CallWindowSize,
} from "../../lib/desktop";

/**
 * The call, in a window of its own — in whichever of its four shapes.
 *
 * ── What this window IS ───────────────────────────────────────────────────
 * One window, four sizes. `panel` is the stage full bleed, with the controls
 * that were already on it. `circles` is everybody as a row of face circles over
 * your work, `speaker` is one circle of whoever is talking, and `tiny` is that
 * same circle at the size of a menu bar icon. Nothing is rebuilt for any of
 * them: `CallStage` in panel mode is the same surface the
 * dock expands into, and `CallFaces` is the same circles that used to be a
 * window of their own. This file is the window's LIFECYCLE — taking the call
 * over on the way in, holding which size it is in, and handing it back on the
 * way out.
 *
 * ── Why the sizes are not three windows ───────────────────────────────────
 * They were, and it cost a re-join every time somebody changed shape. Electron
 * decides `transparent` and `frame` when a window is CONSTRUCTED, so the small
 * sizes used to need a window built for them, and moving the call there meant
 * joining the room again from a new renderer — media is per-renderer (the
 * LiveKit Room and the mic publication are module singletons in callManager),
 * so it cannot be passed as data.
 *
 * The window is now born see-through and frameless for ALL of them, and the
 * stage paints its own card inside that glass. A size change is then a resize
 * and a different subtree: the room, the mic and the transcript never notice.
 *
 * ── How the call gets here ────────────────────────────────────────────────
 * By joining the room, deliberately, exactly as if the person had clicked join
 * in this window — no ring, because the seat is already theirs. The window it
 * is leaving needs no message: LiveKit signs both windows with the same
 * identity — the user id — so this join is a duplicate identity and the SFU
 * evicts the older participant, which callManager recognizes and tears down
 * quietly. That ordering is why the handoff has no hole in it: this window is
 * CONNECTED before the other one is told to let go.
 *
 * ── What travels with it ──────────────────────────────────────────────────
 * Mic, camera and scribe, off the query string. They are not defaults, they are
 * the state the person was already in: popping out mid-sentence has to leave
 * them talking. The scribe resumes into the SAME transcript, because
 * `transcripts.start` is idempotent per room — the words carry straight across
 * the window boundary.
 *
 * ── How it leaves ─────────────────────────────────────────────────────────
 * The X hides this window, like the palette: the huddle stays here, the
 * microphone stays open, and the main window does not grow a card trapped in
 * its edges. Hanging up is the other door and it is explicit — the control
 * bar's own button ends the call, and this window then closes behind it
 * having declared that the call is over.
 */

/**
 * How long a circle size waits to get the call before it gives up on being a
 * circle. Longer than an ordinary join by a wide margin — this is the failure
 * with nothing to show for itself, not a slow one.
 */
const TAKEOVER_DEADLINE_MS = 12_000;

export function CallPanel() {
  const params = useMemo(
    () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const roomKey = params.get("room");

  // The size the shell opened this window in — it remembers the last one per
  // machine, and seeds it into the URL so the FIRST paint is already the right
  // shape rather than a stage that snaps to circles a frame later.
  const [size, setSize] = useState<CallWindowSize>(() => {
    const seeded = params.get("size");
    return seeded === "circles" || seeded === "speaker" || seeded === "tiny" ? seeded : "panel";
  });

  const s = useTrackedStore([
    (st: any) => st.call.phase,
    (st: any) => st.call.roomKey,
    (st: any) => st.call.muted,
    (st: any) => st.call.camera,
  ]);
  const call = s.call;

  // This window's disappearance is a HANDOFF, not a hang-up: the seat in
  // `call_members` is shared with the window taking the call back, so the
  // unload hook must not free it.
  //
  // Only inside the shell's own call window. The fallback rung on an older
  // build opens this route as a detached tab window, where no shell hands
  // anything back — there, closing really is the end of the call, and the
  // ordinary unload cleanup is the honest behavior.
  useMountEffect(() => {
    if (!isCallPanelWindow()) return;
    setCallOutlivesWindow(true);
    return () => setCallOutlivesWindow(false);
  });

  // Ask the shell which size it actually has this window in. The URL seed is
  // right at the moment the window opens; this is what keeps the two agreeing
  // if the window was already open on another room and only its URL changed.
  useMountEffect(() => {
    void getCallWindowSize().then((actual) => {
      if (actual) setSize(actual);
    });
  });

  /**
   * Change the window's size.
   *
   * Told to the shell FIRST and painted on its answer, because the shell is
   * what the size actually is: it moves the window, floats it, and lets the
   * mouse through. Painting circles in a window that is still an ordinary
   * rectangle would be a lie the person could see.
   *
   * A build without the sizes answers null, and then it says so. The founder's
   * desktop is on a build with the panel and none of this, and a button that
   * quietly did nothing would read as the feature being broken.
   */
  const applySize = useCallback((next: CallWindowSize) => {
    void setCallWindowSize(next).then((landed) => {
      if (landed) return setSize(landed);
      toast("The desktop app needs an update for the small call sizes");
    });
  }, []);

  // Take the call over. Once: a re-run would be a second join of a room this
  // window is already in, which `joinCall` treats as idempotent anyway, but the
  // scribe resume below is not free and should not repeat.
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

  // Keep the shell told what this window is hosting, so a handback carries the
  // same room in the same state whichever way the window closes — this panel's
  // own button, or an OS close, which says nothing on its way out.
  //
  // `roomKey` from the URL is what makes the FIRST report honest: it fires at
  // phase idle, before the join, and a null room there would wipe the room the
  // shell opened this window with. A close in that instant is a handback with
  // nothing to hand.
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus).active;
  useWatchEffect(() => {
    reportCallPanelState(
      callWindowReport({
        roomKey: call.roomKey,
        windowRoom: roomKey,
        muted: call.muted,
        camera: call.camera,
        scribe,
      }),
    );
  }, [call.roomKey, roomKey, call.muted, call.camera, scribe]);

  // The call ended in here — the hang-up button, or the far side leaving the
  // last seat. The window has nothing left to show, so it closes, declaring
  // that the call is over so the shell hands nothing back.
  // Did this window ever actually GET the call? A ref for the callbacks that
  // read it, and state for the circles' Leave control, which says a different
  // thing in each case.
  const held = useRef(false);
  const [heldNow, setHeldNow] = useState(false);
  // Read inside a timeout that is set once and must see the size the window is
  // in when it fires, not the one it was mounted in.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  useWatchEffect(() => {
    if (call.phase === "connected") {
      held.current = true;
      setHeldNow(true);
    }
    if (!held.current || call.phase !== "idle") return;
    setCallOutlivesWindow(false);
    void closeCallPanel({ ended: true });
  }, [call.phase]);

  // A join that never lands, in a size with nothing on screen to act on. In the
  // circle sizes this window is a few circles and a transparent rectangle that
  // lets the mouse through — with no circles it is invisible, always on top,
  // and impossible to click. So a failed join drops it back to the stage, which
  // has a surface, a close button and an account of what went wrong.
  useWatchEffect(() => {
    const next = callWindowSizeOnFailedJoin({
      size,
      phase: call.phase,
      held: held.current,
      deadlinePassed: false,
    });
    if (next) applySize(next);
  }, [size, call.phase, applySize]);

  // The failure with nothing to show for itself: a join that neither connects
  // nor errors. No state change is coming, so a clock has to notice.
  useMountEffect(() => {
    const t = setTimeout(() => {
      const next = callWindowSizeOnFailedJoin({
        size: sizeRef.current,
        phase: "connecting",
        held: held.current,
        deadlinePassed: true,
      });
      if (next) applySize(next);
    }, TAKEOVER_DEADLINE_MS);
    return () => clearTimeout(t);
  });

  if (!roomKey) {
    return (
      <div className="dark flex h-screen items-center justify-center bg-sol-base03 px-8 text-center text-[13px] text-sol-text-muted">
        This window opens onto a call, and none was named.
      </div>
    );
  }
  if (size !== "panel") {
    return (
      <CallFaces
        mode={facesModeForSize(size)}
        tier={faceTierForSize(size)}
        onSetSize={applySize}
        held={heldNow}
      />
    );
  }
  return <CallStage panel onSetSize={applySize} />;
}
