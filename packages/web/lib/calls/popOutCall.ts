import { toast } from "sonner";
import {
  bridge,
  callPanelRoute,
  canPopOutCall,
  isDesktop,
  openCallPanel,
  type CallWindowSize,
} from "../desktop";
import { popOutVia } from "../popOut";
import { callHandoffState } from "./callHandoff";
import { setCallOutlivesWindow } from "./callManager";

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
 * The mic, camera and scribe state travel WITH the room, read through
 * `callHandoffState` — the one place a call's movable state is assembled, so
 * this gesture and minimizing to the floating faces cannot drift apart and
 * hand a call over in two different states.
 *
 * This window STOPS hosting the media once the panel joins. The seat in
 * call_members is shared, so a leaveRoom from here would hang up the call
 * we just asked to keep. `setCallOutlivesWindow` is what beforeunload and a
 * mislabeled SFU eviction both read, so popping out cannot kill the call.
 */
export async function popOutCall(opts: { size?: CallWindowSize } = {}): Promise<void> {
  const state = callHandoffState();
  if (!state) return;
  if (!canPopOutCall()) return;

  const { room, ...rest } = state;
  const payload = opts.size ? { ...rest, size: opts.size } : rest;
  // A click after the panel handed the call back is a request to go out
  // again, so the suppress the handback planted must not stick.
  clearAutoPopSuppress(room);
  setCallOutlivesWindow(true);

  const shellOpen = bridge("openCallPanel");

  try {
    const outcome = await popOutVia(callPanelRoute(room, payload), {
      shellOpen: shellOpen ? () => openCallPanel(room, payload).then(() => undefined) : undefined,
      detach: bridge("detachTab"),
      desktop: isDesktop(),
      // Never reached: `desktop` is true on every path that gets here, and it
      // short-circuits above this. A call has no browser rung by design.
      openPopup: () => false,
    });

    if (outcome === "needs-update") {
      setCallOutlivesWindow(false);
      toast.error("The desktop app needs an update for this", {
        description:
          "This build cannot give a call its own window. Update Codecast and the call pops out into a real window.",
      });
    }
  } catch (err) {
    setCallOutlivesWindow(false);
    throw err;
  }
}

// ── Auto-pop: a desktop call is a window, not a card inside one ───────────
//
// The in-app MiniWindow is `position: fixed` in the main renderer, clamped to
// that window's edges. Dragging it cannot leave the parent. A call popout
// must already be a real OS window — the call panel — so it can sit on another
// monitor, over a full-screen app, anywhere the work is not.
//
// Closing that panel hands the call back here. Auto-popping the same room
// again would reopen the panel forever. The suppress is that close: it lasts
// until the person asks to pop out, or the call ends.

const autoPopSuppressed = new Set<string>();

/** The panel just closed onto this room. Do not open it again by yourself. */
export function suppressAutoPopOut(room: string): void {
  if (room) autoPopSuppressed.add(room);
}

export function isAutoPopSuppressed(room: string | null | undefined): boolean {
  return !!room && autoPopSuppressed.has(room);
}

/** A gesture asked to pop out, or the call ended. */
export function clearAutoPopSuppress(room?: string | null): void {
  if (room) autoPopSuppressed.delete(room);
  else autoPopSuppressed.clear();
}

/**
 * Should this renderer send the huddle to the call window by itself?
 *
 * Walkie bursts stay. A panel the person just closed stays closed until they
 * ask. Everything else on a desktop that can pop out goes out — a card inside
 * this window cannot leave its edges, and that is not a popout.
 */
export function shouldAutoPopCall(s: {
  canPopOut: boolean;
  phase: string;
  roomKey: string | null;
  walkieHolds: boolean;
  suppressed: boolean;
}): boolean {
  if (!s.canPopOut) return false;
  if (s.phase !== "connected" && s.phase !== "connecting") return false;
  if (!s.roomKey || s.walkieHolds) return false;
  if (s.suppressed) return false;
  return true;
}
