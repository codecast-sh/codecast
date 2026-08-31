import { useRef } from "react";
import { useTrackedStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import { useWalkieStatus } from "./useWalkie";
import { walkieHoldsRoom } from "../lib/calls/walkie";
import { canPopOutCall } from "../lib/desktop";
import {
  clearAutoPopSuppress,
  isAutoPopSuppressed,
  popOutCall,
  shouldAutoPopCall,
} from "../lib/calls/popOutCall";

/**
 * A desktop call lives in the call window, not as a card inside another one.
 *
 * The in-app MiniWindow is `position: fixed` in whichever renderer drew it,
 * clamped to that window's edges — you cannot drag it onto another monitor
 * or over a full-screen app. The call panel is a real OS window, so a huddle
 * that starts here (the main window, the buddy list) moves there the moment
 * it is a call. Walkie bursts stay: they are a note, not a huddle, and they
 * must never spawn a window.
 *
 * Closing the panel hands the call back. That close is a request to keep it
 * HERE, so the same room is not auto-popped again (`isAutoPopSuppressed`).
 * Clicking pop-out is what sends it out after that.
 *
 * The handoff itself is the ordinary one (lib/calls/popOutCall): the panel
 * opens, joins, and the eviction that follows takes the call out of here.
 */
export function useHandCallToPanel(): void {
  const walkie = useWalkieStatus();
  const s = useTrackedStore([
    (st: any) => st.call.phase,
    (st: any) => st.call.roomKey,
    (st: any) => st.call.muted,
  ]);
  const call = s.call;
  // The room already handed over, so a re-render (or the seconds between the
  // panel opening and this window being evicted) cannot ask for a second one.
  const handed = useRef<string | null>(null);

  useWatchEffect(() => {
    if (call.phase === "idle") {
      handed.current = null;
      // A finished call is not a closed panel. The next huddle should get a
      // window of its own again.
      clearAutoPopSuppress();
      return;
    }
    if (
      !shouldAutoPopCall({
        canPopOut: canPopOutCall(),
        phase: call.phase,
        roomKey: call.roomKey,
        walkieHolds: !!call.roomKey && walkieHoldsRoom(walkie, call.roomKey),
        suppressed: isAutoPopSuppressed(call.roomKey),
      })
    ) {
      return;
    }
    if (handed.current === call.roomKey) return;
    handed.current = call.roomKey;
    void popOutCall();
    // The fields the rule branches on, not the `call` object: it is a mutative
    // draft whose ref flips on every heartbeat-driven field, and re-running
    // this on those would be churn for a decision none of them can change.
  }, [call.phase, call.roomKey, call.muted, walkie]);
}
