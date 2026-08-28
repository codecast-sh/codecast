import { useRef } from "react";
import { useTrackedStore } from "../store/inboxStore";
import { useWatchEffect } from "./useWatchEffect";
import { useWalkieStatus } from "./useWalkie";
import { walkieHoldsRoom } from "../lib/calls/walkie";
import { isPeopleWindow } from "../lib/desktop";
import { popOutCall } from "../lib/calls/popOutCall";

/**
 * The buddy list never hosts a call: a call starting here moves to the panel.
 *
 * A founder decision, and it is about what each window IS. The buddy list is a
 * 320px column of names you glance at — a call stage crammed into it is neither
 * a buddy list nor a call, and it takes the window over for as long as somebody
 * is talking. The call has its own window; this hands it there the moment one
 * starts, so the buddy list stays a buddy list.
 *
 * The handoff itself is the ordinary one (lib/calls/popOutCall): the panel
 * opens, joins, and the eviction that follows takes the call out of here. So
 * this hook decides ONLY the question "is what just started a call", and hands
 * the mechanics to the code that already does them.
 *
 * ── The line that matters ─────────────────────────────────────────────────
 * A walkie burst joins a room exactly the way a huddle does, and the buddy list
 * is where bursts land. A teammate holding their key opens a room in this
 * window, MUTED, so their words can play — that is listening to a note, not
 * being in a call, and it must never spawn a window. `walkieHoldsRoom` is the
 * codebase's own answer to that question: it is what CallDock already asks to
 * decide whether it is a call dock or the walkie strip. Asking it again here
 * means the two surfaces cannot disagree about what a burst is — and when the
 * walkie is not holding the room (nobody is bursting, or somebody stepped in on
 * purpose), that IS a call, and it goes to the panel.
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
    if (!isPeopleWindow()) return;
    if (call.phase !== "connected" && call.phase !== "connecting") {
      handed.current = null;
      return;
    }
    if (!call.roomKey || walkieHoldsRoom(walkie, call.roomKey)) return;
    if (handed.current === call.roomKey) return;
    handed.current = call.roomKey;
    void popOutCall();
    // The fields the rule branches on, not the `call` object: it is a mutative
    // draft whose ref flips on every heartbeat-driven field, and re-running
    // this on those would be churn for a decision none of them can change.
  }, [call.phase, call.roomKey, call.muted, walkie]);
}
