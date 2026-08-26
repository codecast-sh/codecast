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
