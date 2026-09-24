import type { VoiceWindowShape } from "../desktop";

/**
 * WHICH SHAPE THE VOICE WINDOW IS, from what is happening. A lookup, not a
 * rule stack, and pure so it can be pinned without a window.
 *
 * Presence, a burst, a ring and a call are the same row of faces in
 * different states, so the window has one shape for all of them, the float,
 * and the question is only whether to show it:
 *
 *   the stage   the person expanded the call. Opens on an explicit expand
 *               and nothing else, and stays until they put it away.
 *   the float   the row is popped out (a standing arrangement), or something
 *               is happening (a ring, a burst, a call) while the app is
 *               behind another window and the header cannot reach them. The
 *               float then hides again when the engagement ends, unless it
 *               is popped out.
 *   the wall    the buddy list, when the person keeps it over their work and
 *               nothing else is showing.
 *   nothing     hidden. With the app in front the header shows the same row,
 *               and two copies of it would be one too many.
 */
export function voiceHostView(input: {
  /** The row has somebody engaged: a ring either way, a burst, a call. */
  engaged: boolean;
  /** This window is in a call (a room it holds, the walkie's or a huddle's). */
  inCall: boolean;
  /** The person opened the stage, and has not put it away since. */
  expanded: boolean;
  /** The person popped the row out of the header. */
  floating: boolean;
  /** A window the person works in has focus (the voice window is not one). */
  appFocused: boolean;
  wallWanted: boolean;
  /** The person hid the float this engagement (its Hide button); it comes
   *  back for the next one. A popped out row is never dismissed, only put
   *  back in the header. */
  dismissed?: boolean;
}): VoiceWindowShape {
  const { engaged, inCall, expanded, floating, appFocused, wallWanted, dismissed = false } = input;
  if (inCall && expanded) return "panel";
  if (floating) return "float";
  if (engaged && !appFocused && !dismissed) return "float";
  if (wallWanted) return "wall";
  return "idle";
}
