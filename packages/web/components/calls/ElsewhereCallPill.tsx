import { Headphones } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";

/**
 * "In a huddle in another window."
 *
 * The call dock is per window: it reads THIS window's `call.phase`, which is
 * idle even while a sibling window holds the huddle. That is deliberate — one
 * call has one dock, and the window hosting the audio owns the hang-up, which
 * is the whole point of the shell's leader election. But a window that says
 * nothing at all about a call plainly running reads as broken, and the first
 * thing a person does about it is try to start a second one.
 *
 * So: a statement, not a control. No join, no mute, no hang-up. Those belong to
 * the window with the microphone, and this one says where to look.
 *
 * Renders nothing off the desktop (no sibling windows exist), and nothing when
 * the call is right here (the dock is already saying it, better).
 */
export function ElsewhereCallPill({ className = "" }: { className?: string }) {
  const role = useDesktopWindowRole();
  const mine = useInboxStore((s) => s.call.phase !== "idle");
  if (!role.anyInCall || mine) return null;
  return (
    <div
      className={`flex items-center gap-1.5 text-[11px] text-sol-violet ${className}`}
      role="status"
    >
      <Headphones className="h-3 w-3 shrink-0" aria-hidden="true" />
      In a huddle in another window
    </div>
  );
}
