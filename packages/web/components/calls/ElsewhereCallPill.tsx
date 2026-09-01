import { Headphones } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { showCallPanel } from "../../lib/desktop";

/**
 * "In a huddle in another window."
 *
 * The call dock is per window: it reads THIS window's `call.phase`, which is
 * idle even while a sibling window holds the huddle. That is deliberate — one
 * call has one dock, and the window hosting the audio owns the hang-up. A
 * window that says nothing at all about a call plainly running reads as
 * broken, so this is where to look — and the click raises that window, which
 * may be hidden the way the palette is.
 *
 * Renders nothing off the desktop (no sibling windows exist), and nothing when
 * the call is right here (the dock is already saying it, better).
 */
export function ElsewhereCallPill({ className = "" }: { className?: string }) {
  const role = useDesktopWindowRole();
  const mine = useInboxStore((s) => s.call.phase !== "idle");
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
