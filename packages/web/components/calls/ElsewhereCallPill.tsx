import { Headphones } from "lucide-react";
import { useCallback } from "react";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { useFaceRowSelect } from "../../hooks/useFaceRow";
import { showCallPanel, voiceHostElsewhere } from "../../lib/desktop";
import type { FaceRow } from "../../lib/faces/faceRow";

/**
 * "In a huddle in another window."
 *
 * The face row is per window: it draws THIS window's engagement, and a
 * sibling window holding the huddle is drawn here only as a seat. That is
 * deliberate: one call has one card, and the window hosting the audio owns
 * the hang-up. A window that says nothing at all about a call plainly running
 * reads as broken, so this is where to look, and the click raises that
 * window, which may be hidden the way the palette is.
 *
 * Renders nothing off the desktop (no sibling windows exist), and nothing when
 * the call is right here (the row is already saying it, better). "Here" is
 * the row's engaged room with the voice hosted in this window, so a LiveKit
 * reconnect or my own walkie linger never reads as elsewhere.
 */
export function ElsewhereCallPill({ className = "" }: { className?: string }) {
  const role = useDesktopWindowRole();
  const mine = useFaceRowSelect(useCallback((row: FaceRow) => !!row.room && !voiceHostElsewhere(), []));
  if ((!role.anyInCall && !role.callPanel) || mine) return null;
  return (
    <button
      type="button"
      onClick={() => void showCallPanel()}
      className={`flex items-center gap-1.5 text-[11px] text-sol-violet ${className}`}
      title="Show the huddle window"
    >
      <Headphones className="h-3 w-3 shrink-0" aria-hidden="true" />
      In a huddle in another window
    </button>
  );
}
