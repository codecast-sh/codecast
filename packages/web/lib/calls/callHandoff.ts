import { useInboxStore } from "../../store/inboxStore";
import type { CallWindowSize } from "../desktop";
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
 * gesture that moves a call between windows — popping it out into its own
 * window, handing it back to the main one — reads this.
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

// ── The circle sizes have no chrome, so they need rules of their own ───────
//
// In the circle sizes the call window has no title bar, no close box and no
// dock entry: it is a few circles and a transparent rectangle that lets the
// mouse through. Everything a person can do with it is drawn on the circles
// themselves — so if the circles never arrive, there is nothing on screen to
// act on, and an invisible always-on-top window is sitting over somebody's
// work. The two rules below are what keeps that from happening. They live here
// rather than in the component because they are a decision table, not a
// rendering concern.

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
 * A join that failed drops the window back to the stage.
 *
 * `held` is whether this window ever actually got the call, and it is the
 * distinction everything turns on. Holding it and losing it is an ordinary end
 * — the call finished, or it moved — and the stage's own lifecycle handles
 * that. NEVER holding it is this window looking at its own failure, and in a
 * circle size that failure is invisible: no faces arrive, so there is nothing
 * to click, and what is left on screen is a transparent click-through
 * rectangle floating above everything with a call stranded behind it.
 *
 * Falling back to the stage is the smallest honest answer. The stage has a
 * surface, a close button and an account of what went wrong, so the person can
 * see the failure and decide — closing then hands the call back to the main
 * window by the ordinary route, which is where it still is.
 *
 * `deadlinePassed` covers the failure with nothing to show for itself: a join
 * that neither connects nor errors. Without it that window would float there
 * forever, because no state change is ever coming.
 *
 * Returns the size to move to, or null to stay put.
 */
export function callWindowSizeOnFailedJoin(s: {
  size: CallWindowSize;
  phase: CallWindowPhase;
  held: boolean;
  deadlinePassed: boolean;
}): CallWindowSize | null {
  if (s.size === "panel" || s.held) return null;
  if (s.phase === "error" || s.deadlinePassed) return "panel";
  return null;
}

/**
 * What the Leave control on the circles does — and it always does something,
 * whatever state the window is in. In a window whose join failed it is the only
 * way out a person has there, so it can never be a no-op.
 *
 * `hangUp` is the part that must not fire on the failure path. The seat in
 * `call_members` is keyed by (user, room), so every window of one person shares
 * ONE row: a window that never joined calling `leaveCall` would delete the seat
 * the window that DOES hold the call is sitting in, taking its occupancy, its
 * heartbeat and its transcript authorization with it.
 */
export function callWindowLeaveGesture(held: boolean): WindowExit & { hangUp: boolean } {
  return held
    ? { close: true, ended: true, hangUp: true }
    : { close: true, ended: false, hangUp: false };
}

/**
 * What the call window tells the shell it is hosting.
 *
 * The shell keeps the LAST report as the handback payload, replacing it whole,
 * so every field here has to be right at every moment — including the moments
 * before there is a call to describe.
 */
export type CallWindowReport = {
  room: string | null;
  mic: boolean;
  camera: boolean;
  scribe: boolean;
};

/**
 * `windowRoom` is the room this window was OPENED for, read from its own URL.
 * It is the answer before the join starts and the answer if the join fails,
 * and it is why `room` is never null in a window that has a room in its
 * address: the first report fires at phase `idle`, and reporting null there
 * would overwrite the room the shell seeded the window with. A close in that
 * instant — a moment after the window opened — then hands back nothing, and
 * the call is stranded in a window that is going away.
 */
export function callWindowReport(s: {
  roomKey: string | null;
  windowRoom: string | null;
  muted: boolean;
  camera: boolean;
  scribe: boolean;
}): CallWindowReport {
  return {
    room: s.roomKey ?? s.windowRoom,
    mic: !s.muted,
    camera: !!s.camera,
    scribe: !!s.scribe,
  };
}
