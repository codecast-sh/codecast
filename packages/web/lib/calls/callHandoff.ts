import { useInboxStore } from "../../store/inboxStore";
import { canMinimizeToFaces, openFacesWindow, type FacesMode } from "../desktop";
import { getScribeStatus } from "./transcription";

/**
 * What a call has to arrive with when it moves to another window.
 *
 * The room, and the three pieces of state a person is already in: mic, camera,
 * scribe. They are not defaults — handing a call over without them is what
 * mutes somebody mid-sentence, or drops a live transcript at a window boundary
 * the speakers never saw.
 *
 * Read here, once, from the window hosting the call, so that no caller
 * assembles the payload and none of them can assemble it differently. Every
 * gesture that moves a call — popping it out into the panel, minimizing it into
 * the floating faces, and whatever comes next — reads this.
 *
 * Null when there is no call to move.
 */
export function callHandoffState(): { room: string; mic: boolean; camera: boolean; scribe: boolean } | null {
  const { call } = useInboxStore.getState();
  if (!call.roomKey || call.phase === "idle") return null;
  return {
    room: call.roomKey,
    mic: !call.muted,
    camera: !!call.camera,
    scribe: getScribeStatus().active,
  };
}

/**
 * Minimize the call to the floating faces.
 *
 * The faces window joins the room and LiveKit evicts whichever window held it
 * (every window of one person signs as the same identity), so this is the whole
 * gesture: open the window, and the call follows. The window being left closes
 * itself when it notices it has been evicted — nobody has to tell it, and the
 * new window is connected before the old one lets go, so the audio is
 * continuous across the move.
 *
 * Desktop only, and absent rather than degraded elsewhere: a transparent
 * always-on-top window is something only the shell can make, and a browser
 * approximation of it would be a window that lies about what it is.
 */
export async function minimizeToFaces(mode?: FacesMode): Promise<void> {
  const state = callHandoffState();
  if (!state || !canMinimizeToFaces()) return;
  await openFacesWindow(state.room, {
    mic: state.mic,
    camera: state.camera,
    scribe: state.scribe,
    mode,
  });
}

// ── When a satellite call window should close, and what closing means ──────
//
// The floating faces window has no title bar, no close box and no dock entry.
// If it does not close itself, nothing closes it short of quitting the app —
// so the rules for when it goes, and for what it tells the shell on the way
// out, decide between a tidy handoff and an unclosable window sitting over
// somebody's work with a call stranded behind it. They are pinned here, out of
// the component, because they are a decision table rather than a rendering
// concern.

export type CallWindowPhase = "idle" | "ringing_out" | "connecting" | "connected" | "error";

/**
 * `close` — this window has stopped being useful and should go.
 * `ended`  — what the shell is told on the way out. TRUE means the call is
 *   over and nothing should be handed anywhere. FALSE means the call is alive
 *   and this window is not the one holding it, so the shell should hand it
 *   back and let its arbiter decide who takes it.
 */
export type WindowExit = { close: boolean; ended: boolean };

const STAY: WindowExit = { close: false, ended: false };

/**
 * Should the faces window close, and is the call over when it does?
 *
 * `held` is whether this window ever actually got the call — the distinction
 * everything turns on. A window that held the call and lost it has watched the
 * call end or move, and says so. A window that NEVER held it is looking at its
 * own failure: the call is still wherever it was, and saying "ended" would
 * take a live call down with a window that never had it.
 *
 * `deadlinePassed` covers the failure with nothing to show for itself — a join
 * that neither connects nor errors. Without it that window would sit there
 * forever, because no state change is ever coming to close it.
 */
export function facesWindowExit(s: {
  phase: CallWindowPhase;
  held: boolean;
  deadlinePassed: boolean;
}): WindowExit {
  if (s.phase === "connected") return STAY;
  if (s.held) return s.phase === "idle" ? { close: true, ended: true } : STAY;
  if (s.phase === "error" || s.deadlinePassed) return { close: true, ended: false };
  return STAY;
}

/**
 * What the Leave control does — and it always does something, whatever state
 * the window is in. In a window whose join failed, Leave is the only way out a
 * person has, so it can never be a no-op.
 *
 * `hangUp` is the part that must not fire on the failure path. The seat in
 * `call_members` is keyed by (user, room), so both windows of one person share
 * ONE row: a window that never joined calling `leaveCall` would delete the seat
 * the window that DOES hold the call is sitting in, taking its occupancy, its
 * heartbeat and its transcript authorization with it.
 */
export function facesLeaveGesture(held: boolean): WindowExit & { hangUp: boolean } {
  return held
    ? { close: true, ended: true, hangUp: true }
    : { close: true, ended: false, hangUp: false };
}
