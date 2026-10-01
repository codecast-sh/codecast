import { Lock } from "lucide-react";
import type { LiveRoomRow } from "../../hooks/useLiveRooms";

/** The room's name plus the lock glyph. The glyph reports the door's state
 *  honestly, including on a locked room this viewer may still walk into.
 *  Shared by the rail and the /calls rows so the two read alike. */
export function LiveRoomLabel({ row, className = "" }: { row: LiveRoomRow; className?: string }) {
  return (
    <span className={`flex min-w-0 items-center gap-1 ${className}`}>
      {row.locked && <Lock className="h-3 w-3 shrink-0 text-sol-text-dim" aria-label="Locked" />}
      <span className={`min-w-0 truncate ${row.redacted ? "italic text-sol-text-muted" : ""}`}>
        {row.label}
      </span>
    </span>
  );
}
