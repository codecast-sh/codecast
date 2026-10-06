"use client";

import { memo } from "react";
import { useConvexAuth } from "convex/react";
import { usePresenceRows } from "../../hooks/useDocPresence";
import { composeDocId } from "../../lib/composerPresence";
import { PresenceAvatar } from "../PresenceFacepile";

// Each other person's face in the transcript's scroll gutter, at the message
// they are reading: "look at this" without a link, and a glance tells you
// whether they have read the agent's last turn before you answer it. The
// place rides their composer presence row (anchor), written at most twice a
// second and only while someone else is here. Click a face to go there.

export const ReadingMarks = memo(function ReadingMarks({
  conversationId,
  locate,
  onJump,
  top,
  bottom,
}: {
  conversationId: string;
  /** Where a message sits in the whole transcript, 0 (top) to 1 (end); null when it is not loaded. */
  locate: (messageId: string) => number | null;
  onJump: (messageId: string) => void;
  top: number;
  bottom: number;
}) {
  const { isAuthenticated } = useConvexAuth();
  const marks = usePresenceRows(composeDocId(conversationId), isAuthenticated)
    .map((row) => ({ row, at: row.anchor ? locate(row.anchor.message_id) : null }))
    .filter((m): m is { row: typeof m.row; at: number } => m.at !== null);
  if (marks.length === 0) return null;
  return (
    <div data-sv-reading-marks aria-label="Where others are reading" className="absolute right-0.5 w-5 z-20 pointer-events-none" style={{ top: top + 8, bottom: bottom + 8 }}>
      {marks.map(({ row, at }) => (
        <button
          key={row.user_id}
          type="button"
          onClick={() => row.anchor && onJump(row.anchor.message_id)}
          title={`${row.user_name} is reading here`}
          className="absolute right-0 -translate-y-1/2 pointer-events-auto rounded-full transition-[top] duration-500 ease-out hover:scale-110"
          style={{ top: `${Math.min(1, Math.max(0, at)) * 100}%` }}
        >
          <PresenceAvatar person={row} size={18} />
        </button>
      ))}
    </div>
  );
});
