import { useMemo, useRef, useSyncExternalStore } from "react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTrackedStore } from "../../store/inboxStore";
import { CallStage } from "./CallStage";
import { setCallOutlivesWindow, takeOverCall } from "../../lib/calls/callManager";
import { callWindowReport } from "../../lib/calls/callHandoff";
import { getScribeStatus, subscribeScribe } from "../../lib/calls/transcription";
import {
  closeCallPanel,
  isCallPanelWindow,
  reportCallPanelState,
} from "../../lib/desktop";

/**
 * The call, in a window of its own.
 *
 * ── What this window IS ───────────────────────────────────────────────────
 * The stage, full bleed, with the controls that were already on it. Nothing is
 * rebuilt here: `CallStage` in panel mode is the same surface the dock expands
 * into, so the views, the rails, the transcript and the control bar are one
 * implementation with one set of bugs. This file is the window's LIFECYCLE —
 * taking the call over on the way in, and handing it back on the way out.
 *
 * ── How the call gets here ────────────────────────────────────────────────
 * By joining the room, deliberately, exactly as if the person had clicked join
 * in this window — no ring, because the seat is already theirs. Media is a
 * per-renderer thing (the LiveKit Room and the mic publication are module
 * singletons in callManager), so the call cannot be passed between windows as
 * data; it can only be re-established in the window that is taking it.
 *
 * The window it is leaving needs no message. LiveKit signs both windows with
 * the same identity — the user id — so this join is a duplicate identity and
 * the SFU evicts the older participant, which callManager recognizes and tears
 * down quietly. That ordering is the whole reason the handoff has no hole in
 * it: this window is CONNECTED before the other one is told to let go.
 *
 * ── What travels with it ──────────────────────────────────────────────────
 * Mic, camera and scribe, off the query string. They are not defaults, they are
 * the state the person was already in: popping out mid-sentence has to leave
 * them talking. The scribe resumes into the SAME transcript, because
 * `transcripts.start` is idempotent per room — the words carry straight across
 * the window boundary.
 *
 * ── How it leaves ─────────────────────────────────────────────────────────
 * Closing this window is a request to carry on in the main window, not a
 * hang-up: the shell hands the room back and the main window joins it, which
 * evicts this one by the same mechanism, in the same order. Hanging up is the
 * other door and it is explicit — the control bar's own button ends the call,
 * and this window then closes behind it having declared that the call is over,
 * so nothing is handed anywhere.
 */
export function CallPanel() {
  const params = useMemo(
    () => new URLSearchParams(typeof window === "undefined" ? "" : window.location.search),
    [],
  );
  const roomKey = params.get("room");

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
  // Only inside the shell's own panel window. The fallback rung on an older
  // build opens this route as a detached tab window, where no shell hands
  // anything back — there, closing really is the end of the call, and the
  // ordinary unload cleanup is the honest behavior.
  useMountEffect(() => {
    if (!isCallPanelWindow()) return;
    setCallOutlivesWindow(true);
    return () => setCallOutlivesWindow(false);
  });

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
  // own button, or the OS close box, which says nothing on its way out.
  //
  // `roomKey` from the URL is what makes the FIRST report honest: it fires at
  // phase idle, before the join, and a null room there would wipe the room the
  // shell opened this window with. A traffic-light close in that instant is a
  // handback with nothing to hand.
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, getScribeStatus).active;
  useWatchEffect(() => {
    reportCallPanelState(
      callWindowReport({
        phase: call.phase,
        roomKey: call.roomKey,
        windowRoom: roomKey,
        muted: call.muted,
        camera: call.camera,
        scribe,
      }),
    );
  }, [call.phase, call.roomKey, roomKey, call.muted, call.camera, scribe]);

  // The call ended in here — the hang-up button, or the far side leaving the
  // last seat. The window has nothing left to show, so it closes, declaring
  // that the call is over so the shell hands nothing back.
  const wasConnected = useRef(false);
  useWatchEffect(() => {
    if (call.phase === "connected") wasConnected.current = true;
    if (!wasConnected.current || call.phase !== "idle") return;
    setCallOutlivesWindow(false);
    void closeCallPanel({ ended: true });
  }, [call.phase]);

  if (!roomKey) {
    return (
      <div className="dark flex h-screen items-center justify-center bg-sol-base03 px-8 text-center text-[13px] text-sol-text-muted">
        This window opens onto a call, and none was named.
      </div>
    );
  }
  return <CallStage panel />;
}

