import { toast } from "sonner";
import { useInboxStore } from "../../store/inboxStore";
import {
  bridge,
  callPanelRoute,
  canPopOutCall,
  isDesktop,
  openCallPanel,
} from "../desktop";
import { popOutVia } from "../popOut";
import { getScribeStatus } from "./transcription";

/**
 * Give the running call a window of its own.
 *
 * The same ladder every popout uses (lib/popOut) with the bottom rung sawn off:
 * a call NEVER opens a browser popup. That rung is what the founder's
 * screenshot caught — a call stage floating in a Chrome window, outside the
 * app, with no app chrome and a microphone permission attached to a window
 * nobody recognizes. So the ladder here is two rungs and a sentence:
 *
 *   1. the shell's call window (builds that have it)
 *   2. a detached tab window on /call-panel (older builds, still a real window)
 *   3. say the app needs updating — never a popup
 *
 * In a browser there is no rung at all, which is why the control is not drawn
 * there (`canPopOutCall`). This function refuses too, rather than trusting
 * every future caller to check.
 *
 * The mic, camera and scribe state travel WITH the room. They are read here,
 * from the window that is hosting the call at the moment of the gesture, so no
 * caller has to assemble the payload and none of them can assemble it
 * differently.
 */
export async function popOutCall(): Promise<void> {
  const { call } = useInboxStore.getState();
  if (!call.roomKey || call.phase === "idle") return;
  if (!canPopOutCall()) return;

  const payload = {
    mic: !call.muted,
    camera: !!call.camera,
    scribe: getScribeStatus().active,
  };
  const room = call.roomKey;
  const shellOpen = bridge("openCallPanel");

  const outcome = await popOutVia(callPanelRoute(room, payload), {
    shellOpen: shellOpen ? () => openCallPanel(room, payload).then(() => undefined) : undefined,
    detach: bridge("detachTab"),
    desktop: isDesktop(),
    // Never reached: `desktop` is true on every path that gets here, and it
    // short-circuits above this. A call has no browser rung by design.
    openPopup: () => false,
  });

  if (outcome === "needs-update") {
    toast.error("The desktop app needs an update for this", {
      description:
        "This build cannot give a call its own window. Update Codecast and the call pops out into a real window.",
    });
  }
}
