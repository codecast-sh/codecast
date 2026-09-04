import type { DockSurface } from "../../hooks/useWalkie";
import type { CallWindowSize, VoiceWindowShape } from "../desktop";

/**
 * WHICH SHAPE THE VOICE WINDOW IS, from what is happening. A lookup, not a
 * rule stack, and pure so it can be pinned without a window.
 *
 * The window shows one thing at a time, in this order:
 *
 *   the ring      somebody is calling and this person is not already in a
 *                 call. Nothing outranks a ring: it is the one thing in the
 *                 app that has to reach somebody who is looking elsewhere.
 *   the strip     the walkie holds the room — a burst being spoken or heard.
 *                 Nothing outranks it: a voice arriving is the biggest
 *                 interruption this product makes and it must be seen.
 *   the call      a room this window is in that the walkie does not hold,
 *                 in the call size the person chose — unless they put the
 *                 call away (the X on the stage), in which case it keeps
 *                 running behind whatever the idle shape is.
 *   the team      what the person keeps over their work when nothing is
 *                 happening: the wall (the buddy list) or the faces (the same
 *                 team as circles). The two are exclusive by construction —
 *                 asking for one puts the other away — but if both were ever
 *                 wanted the wall wins, because it is the one you can read.
 *   nothing       hidden.
 *
 * `surface` is `callDockSurface`'s answer — the same lookup the in-app dock
 * used, so the strip and the dock come and go here for exactly the reasons
 * they did there.
 */
export function voiceHostView(input: {
  surface: DockSurface;
  callSize: CallWindowSize;
  /** The person put the call away with the stage's X; it keeps running. */
  hiddenCall: boolean;
  wallWanted: boolean;
  facesWanted: boolean;
  /** An invite is ringing and the person is not in a call of their own. */
  ringing?: boolean;
}): VoiceWindowShape {
  const { surface, callSize, hiddenCall, wallWanted, facesWanted, ringing } = input;
  if (ringing) return "ring";
  if (surface === "walkie") return "walkie";
  if (surface !== "none" && !hiddenCall) return callSize;
  if (wallWanted) return "wall";
  if (facesWanted) return "faces";
  return "idle";
}
